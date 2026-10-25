/**
 * 3D 场景管理器（单文件封装）
 *
 * 职责：
 * - WebGL 渲染器 / 场景 / 相机 / 阴影
 * - 视角切换：V 键在「固定视角（OrbitControls）」与「第一人称漫游
 *   （PointerLockControls + WASD）」间切换；第一人称下双击空格起飞，
 *   空格上升 / Ctrl 下降，再双击空格降落
 * - 统一渲染循环：推进补间、设备逐帧动画、渲染
 * - 鼠标左键场景交互：开门（仅解锁）/ 开关电视 / 开关空调 / 喝水
 *   （电视、空调经 ui_command 走 PB 状态机同步；门校验后端 locked 状态，
 *    门板开合与水位为本地视觉动画——协议中无对应状态字段）
 * - 近战格斗（combat.ts / zombie.ts / sword.ts）：钻石剑三段连击、右键格挡、
 *   开门在门廊生成僵尸（追击 / 1s 前摇攻击 / 眩晕 / 死亡），左键优先攻击、
 *   无目标回落交互；HUD 经 CombatUiHooks 推给 App.vue
 * - 对外提供 applyDeviceState()，由 App.vue watch Pinia store 调用
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { playSfx } from './audio'
import type { Action, DeviceId, DeviceState } from '../protocol/messages'
import { PlayerCombat, type CombatHud } from './combat'
import { buildDevices, type DeviceRigs } from './devices'
import { buildRoom, type RoomRig } from './room'
import { TweenSystem } from './tween'
import { Zombie } from './zombie'

export type ViewMode = 'fixed' | 'walk'

/** 格斗系统对 UI 层的回调（HUD 推送 / 飘字 / 全屏闪光） */
export interface CombatUiHooks {
	onHud(hud: CombatHud): void
	onFloat(text: string, sxPct: number, syPct: number, crit: boolean): void
	onFlash(kind: 'hurt' | 'parry'): void
}

/** 漫游参数（惯性运动模型） */
const MAX_SPEED = 3.0         // 水平最大速度 m/s
const ACCEL_H = 20            // 水平加速度 m/s²（快速起步，带一点惯性）
const FRICTION_IDLE = 10      // 无输入水平阻尼 1/s（指数衰减，快速刹停）
const FRICTION_MOVE = 2.5     // 有输入时的轻微阻尼（限制无限加速）
const SPRINT_SPEED = 5.0      // 疾跑最大速度 m/s（双击并按住 W 触发）
const SPRINT_ACCEL = 28       // 疾跑加速度 m/s²
const FOV_SPRINT = 68         // 疾跑视场角（速度感，基准 60）
const JUMP_IMPULSE = 4.2      // 单击空格起跳初速度 m/s（约 0.9m 跳高）

/** 门洞 / 门廊通行边界（与 room.ts 西墙门洞 z 1.45–2.35、门廊范围对齐） */
const DOOR_GATE_Z0 = 1.55     // 门洞通行 z 下限（向内收边，避免蹭框）
const DOOR_GATE_Z1 = 2.25     // 门洞通行 z 上限
const DOOR_GATE_Y = 2.0       // 低于门楣才允许穿行（飞行中不会从门楣上方穿墙）
const PORCH_X_MIN = -5.5      // 门廊尽头（后墙内侧）
const PORCH_Z0 = 1.3          // 门廊 z 范围
const PORCH_Z1 = 2.5
const PORCH_CEIL = 2.35       // 门廊顶（低于屋顶，防飞出门廊顶棚）
const EYE_HEIGHT = 1.6        // 视线高度
const WALK_SPAWN = new THREE.Vector3(-1.6, EYE_HEIGHT, 2.4)
const FIXED_CAM_POS = new THREE.Vector3(6.6, 4.8, 8.2)
const ORBIT_TARGET = new THREE.Vector3(0, 1.05, -0.2)

/** 飞行参数（第一人称双击空格起飞） */
const DOUBLE_TAP_MS = 300       // 双击判定间隔
const TAKEOFF_IMPULSE = 5.0     // 起飞瞬间施加的较大初速度 m/s
const FLY_ACCEL_UP = 6.0        // 按住空格的上升加速度 m/s²（慢慢加速）
const FLY_ACCEL_DOWN = 8.0      // 按住 Ctrl 的下降加速度 m/s²
const FLY_MAX_UP = 3.0          // 正常巡航上升速度上限 m/s（冲量超速部分自然衰减）
const FLY_MAX_DOWN = 3.5        // 下降速度上限 m/s
const OVERSPEED_DECEL = 8.0     // 超过巡航上限时的衰减减速度 m/s²
const V_DRAG = 3.0              // 飞行无输入时的垂直阻尼 1/s（悬停）
const FLY_Y_MIN = 0.5           // 最低飞行高度
const FLY_Y_MAX = 7.0           // 最高飞行高度（可越过屋顶俯瞰）
const GRAVITY = 9.8             // 降落自由落体重力 m/s²

/** 闪避（Shift + WASD 方向） */
const DASH_SPEED = 8.5          // 闪避瞬间爆发速度 m/s（靠摩擦自然衰减）
const DASH_CD = 0.6             // 闪避冷却 s

/** 场景交互参数 */
const CLICK_MOVE_PX = 6       // 按下-抬起位移小于该值视为点击（区分拖拽视角）
const WATER_REFILL_S = 30     // 喝完水后自动续满间隔（秒）
const MAX_ZOMBIES = 3         // 场上僵尸上限（开门生成）

export class SceneManager {
	private renderer: THREE.WebGLRenderer
	private scene: THREE.Scene
	private camera: THREE.PerspectiveCamera
	private orbit: OrbitControls
	private lockCtl: PointerLockControls
	private room: RoomRig
	private rigs: DeviceRigs
	private tweens = new TweenSystem()

	private mode: ViewMode = 'fixed'
	private flying = false          // 第一人称飞行状态（双击空格切换）
	private lastSpaceTap = 0        // 上次按下空格时刻（双击检测）
	private lastWTap = 0            // 上次按下 W 时刻（双击检测）
	private sprinting = false       // 疾跑状态（双击并按住 W）
	private keys = new Set<string>()
	private vel = new THREE.Vector3() // 世界系速度（水平惯性 + 垂直速度），由 dt 积分
	private slowUntil = 0           // 嘶吼减速截止时刻（loop 秒钟）
	private lastTime = 0
	private disposed = false
	private onModeChange?: (mode: ViewMode) => void
	private onFlyChange?: (flying: boolean) => void
	private onUiCommand?: (deviceId: DeviceId, action: Action) => void
	private onToast?: (msg: string) => void
	private onLockChange?: (locked: boolean) => void

	// ---------------- 场景交互状态 ----------------
	private raycaster = new THREE.Raycaster()
	private interactables: THREE.Object3D[] = []
	private pointerDownPos: { x: number; y: number } | null = null
	private hoverThrottle = 0
	private doorLocked = true       // 后端同步的锁状态（开门仅解锁时允许）
	private doorOpen = false        // 门板开合（本地视觉状态）
	private waterEmpty = false      // 水杯是否已喝空（本地状态）
	private waterRefillAt = 0       // 续水时刻（loop 秒钟）

	// ---------------- 格斗系统状态 ----------------
	private combatHooks?: CombatUiHooks
	private combat: PlayerCombat
	private zombies: Zombie[] = []

	constructor(
		host: HTMLElement,
		onModeChange?: (mode: ViewMode) => void,
		onFlyChange?: (flying: boolean) => void,
		onUiCommand?: (deviceId: DeviceId, action: Action) => void,
		onToast?: (msg: string) => void,
		onLockChange?: (locked: boolean) => void,
		combatHooks?: CombatUiHooks,
	) {
		this.onModeChange = onModeChange
		this.onFlyChange = onFlyChange
		this.onUiCommand = onUiCommand
		this.onToast = onToast
		this.onLockChange = onLockChange
		this.combatHooks = combatHooks

		// ---------------- 渲染器 ----------------
		this.renderer = new THREE.WebGLRenderer({ antialias: true })
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
		this.renderer.setSize(host.clientWidth, host.clientHeight)
		this.renderer.shadowMap.enabled = true
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping
		this.renderer.toneMappingExposure = 1.1
		host.appendChild(this.renderer.domElement)

		// ---------------- 场景与相机 ----------------
		this.scene = new THREE.Scene()
		this.scene.background = new THREE.Color(0x9db8cc)
		this.scene.fog = new THREE.Fog(0x9db8cc, 16, 34)

		this.camera = new THREE.PerspectiveCamera(
			60,
			host.clientWidth / host.clientHeight,
			0.05,
			100,
		)
		this.camera.position.copy(FIXED_CAM_POS)
		this.camera.lookAt(ORBIT_TARGET)
		// 相机加入场景：第一人称剑视模型作为相机子物体需参与渲染
		this.scene.add(this.camera)

		// ---------------- 格斗系统（钻石剑视模型挂在相机上） ----------------
		this.combat = new PlayerCombat({
			onHud: () => this.combatHooks?.onHud(this.combat.getHud(this.zombies, this.camera)),
			onToast: (t) => this.onToast?.(t),
			onFloat: (text, sx, sy, crit) => this.combatHooks?.onFloat(text, sx, sy, crit),
			onFlash: (k) => this.combatHooks?.onFlash(k),
			onRespawn: () => {
				this.camera.position.copy(WALK_SPAWN)
				this.vel.set(0, 0, 0)
				if (this.flying) {
					this.flying = false
					this.onFlyChange?.(false)
				}
			},
		})
		this.combat.attach(this.camera)

		// ---------------- 静态房间与设备 ----------------
		this.room = buildRoom(this.scene)
		this.rigs = buildDevices(this.scene, this.room, this.tweens)
		this.interactables = [...this.rigs.interactables, this.room.water]

		// ---------------- 控制器（两种视角互斥启用） ----------------
		this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
		this.orbit.target.copy(ORBIT_TARGET)
		this.orbit.enableDamping = true
		this.orbit.dampingFactor = 0.08
		this.orbit.minDistance = 3
		this.orbit.maxDistance = 18
		this.orbit.maxPolarAngle = Math.PI * 0.49

		this.lockCtl = new PointerLockControls(this.camera, this.renderer.domElement)
		// 指针锁定状态变化 → 通知 UI 显示/隐藏准星（App.vue）
		this.lockCtl.addEventListener('lock', () => this.onLockChange?.(true))
		this.lockCtl.addEventListener('unlock', () => this.onLockChange?.(false))

		// ---------------- 事件 ----------------
		window.addEventListener('resize', this.handleResize)
		window.addEventListener('keydown', this.handleKeyDown)
		window.addEventListener('keyup', this.handleKeyUp)
		window.addEventListener('blur', this.handleBlur)
		this.renderer.domElement.addEventListener('click', this.handleClick)
		this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
		this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp)
		this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
		this.renderer.domElement.addEventListener('contextmenu', this.handleContextMenu)

		this.renderer.setAnimationLoop(this.loop)
	}

	// ---------------- 对外接口 ----------------

	/** 应用设备状态（animate=false 用于全量快照首次同步，瞬时落位） */
	applyDeviceState(state: DeviceState, animate = true) {
		this.rigs.apply(state, animate)
		// 缓存门锁状态：左键开门仅在后端报告解锁时允许
		if (state.device_type === 'door_lock') this.doorLocked = state.locked
	}

	/** 切换视角模式 */
	setMode(mode: ViewMode) {
		if (this.mode === mode || this.disposed) return
		this.mode = mode
		if (mode === 'walk') {
			// 进入漫游：相机移到室内人眼高度
			this.orbit.enabled = false
			this.camera.position.copy(WALK_SPAWN)
			this.camera.lookAt(0, 1.35, -0.8)
			this.vel.set(0, 0, 0)
		} else {
			// 回到固定视角：退出指针锁定，复位观察机位
			this.lockCtl.unlock()
			this.releaseKeyCapture()
			this.camera.position.copy(FIXED_CAM_POS)
			this.orbit.target.copy(ORBIT_TARGET)
			this.orbit.enabled = true
			this.orbit.update()
		}
		// 切换视角一律退出飞行并复位高度
		if (this.flying) {
			this.flying = false
			this.vel.set(0, 0, 0)
			this.onFlyChange?.(false)
		}
		// 格斗系统仅第一人称可见；切走时结束格挡
		this.combat.setVisible(mode === 'walk')
		this.combat.endBlock(this.lastTime)
		this.onModeChange?.(mode)
	}

	dispose() {
		this.disposed = true
		this.releaseKeyCapture()
		this.renderer.setAnimationLoop(null)
		window.removeEventListener('resize', this.handleResize)
		window.removeEventListener('keydown', this.handleKeyDown)
		window.removeEventListener('keyup', this.handleKeyUp)
		window.removeEventListener('blur', this.handleBlur)
		this.renderer.domElement.removeEventListener('click', this.handleClick)
		this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
		this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp)
		this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove)
		this.renderer.domElement.removeEventListener('contextmenu', this.handleContextMenu)
		for (const z of this.zombies) this.scene.remove(z.group)
		this.zombies = []
		this.combat.dispose()
		this.orbit.dispose()
		this.lockCtl.dispose()
		this.rigs.dispose()
		this.room.dispose()
		this.tweens.dispose()
		this.renderer.dispose()
		this.renderer.domElement.remove()
	}

	// ---------------- 内部实现 ----------------

	private handleClick = () => {
		// 漫游模式下点击画面 → 锁定鼠标（ESC 退出由浏览器处理）
		if (this.mode === 'walk' && !this.disposed) {
			this.lockCtl.lock()
			this.setupKeyCapture()
		}
	}

	// ---------------- Ctrl+W 关闭标签页防护 ----------------

	/** Keyboard Lock API 需要的类型形态（避免 TS lib 版本差异） */
	private get keyboardApi(): { lock(keys: string[]): Promise<void>; unlock(): void } | undefined {
		return (navigator as unknown as { keyboard?: { lock(keys: string[]): Promise<void>; unlock(): void } })
			.keyboard
	}

	/**
	 * 进入全屏并启用 Keyboard Lock，捕获 WASD/Ctrl/空格等保留键组合，
	 * 使 Ctrl+W（关闭标签页）在 Chrome 下可被 preventDefault。
	 * 非全屏时 keyboard.lock 静默无效，故先请求全屏（点击即用户手势，允许触发）。
	 */
	private setupKeyCapture() {
		const kb = this.keyboardApi
		if (!kb) return // Firefox 等无此 API，依赖 handleKeyDown 的 preventDefault 兜底
		const applyLock = () => kb.lock(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight']).catch(() => { })
		if (document.fullscreenElement) {
			applyLock()
		} else {
			document.documentElement.requestFullscreen().then(applyLock).catch(() => { })
		}
	}

	/** 退出第一人称时释放按键捕获 */
	private releaseKeyCapture() {
		this.keyboardApi?.unlock()
	}

	// ---------------- 鼠标：左键攻击/交互，右键格挡 ----------------

	private handleContextMenu = (e: MouseEvent) => {
		// 右键格挡：阻止浏览器菜单（固定视角下 OrbitControls 自行处理）
		if (this.mode === 'walk') e.preventDefault()
	}

	private handlePointerDown = (e: PointerEvent) => {
		if (e.button === 2) {
			// 按住右键 → 格挡（仅第一人称锁定时）
			if (this.mode === 'walk' && this.lockCtl.isLocked) this.combat.startBlock(this.lastTime)
			return
		}
		if (e.button !== 0) return
		this.pointerDownPos = { x: e.clientX, y: e.clientY }
	}

	private handlePointerUp = (e: PointerEvent) => {
		if (e.button === 2) {
			if (this.mode === 'walk') this.combat.endBlock(this.lastTime)
			return
		}
		if (e.button !== 0 || !this.pointerDownPos || this.disposed) return
		const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y)
		this.pointerDownPos = null
		if (moved > CLICK_MOVE_PX) return // 拖拽视角，非点击
		// 第一人称锁定：左键优先攻击（反击 > 追击 > 三段连击），无目标时回落到场景交互
		if (this.mode === 'walk' && this.lockCtl.isLocked) {
			const consumed = this.combat.onLeftClick(this.lastTime, this.zombies, this.camera)
			if (consumed) return
			const tag = this.pickInteractable()
			if (tag) {
				this.interact(tag)
				return
			}
			this.combat.whiffSwing(this.lastTime) // 空挥保持手感
			return
		}
		const tag = this.pickInteractable(e)
		if (tag) this.interact(tag)
	}

	private handlePointerMove = (e: PointerEvent) => {
		if (this.disposed) return
		const now = performance.now()
		if (now - this.hoverThrottle < 80) return
		this.hoverThrottle = now
		if (this.mode === 'walk' && this.lockCtl.isLocked) {
			this.renderer.domElement.style.cursor = ''
			return
		}
		this.renderer.domElement.style.cursor = this.pickInteractable(e) ? 'pointer' : ''
	}

	/** 射线拾取可交互对象标签：第一人称锁定时取屏幕中心，否则取指针位置 */
	private pickInteractable(e?: PointerEvent): string | null {
		const ndc = new THREE.Vector2()
		if (this.mode === 'walk' && this.lockCtl.isLocked) {
			ndc.set(0, 0)
		} else if (e) {
			const rect = this.renderer.domElement.getBoundingClientRect()
			ndc.set(
				((e.clientX - rect.left) / rect.width) * 2 - 1,
				-((e.clientY - rect.top) / rect.height) * 2 + 1,
			)
		} else {
			return null
		}
		this.raycaster.setFromCamera(ndc, this.camera)
		const hits = this.raycaster.intersectObjects(this.interactables, true)
		for (const h of hits) {
			let obj: THREE.Object3D | null = h.object
			while (obj) {
				if (obj.userData.interact) return obj.userData.interact as string
				obj = obj.parent
			}
		}
		return null
	}

	/** 执行交互：电视 / 空调经 ui_command 由 PB 状态机同步；门校验后端 locked；喝水为本地动画 */
	private interact(tag: string) {
		switch (tag) {
			case 'tv':
				this.onUiCommand?.('tv', 'toggle')
				break
			case 'ac':
				this.onUiCommand?.('air_conditioner', 'toggle')
				break
			case 'door': {
				if (this.doorLocked) {
					this.onToast?.('门已上锁，请先在面板解锁')
					break
				}
				this.doorOpen = !this.doorOpen
				this.rigs.setDoorOpen(this.doorOpen)
				this.onToast?.(this.doorOpen ? '开门' : '关门')
				// 每次开门：门后小房间（门廊）里钻出一只僵尸
				if (this.doorOpen) this.spawnZombie()
				break
			}
			case 'water': {
				if (this.waterEmpty) {
					this.onToast?.('杯子空了，稍等自动续水')
					break
				}
				this.waterEmpty = true
				this.waterRefillAt = this.lastTime + WATER_REFILL_S
				this.tweens.start('water.level', 1, 0, 0.8, (v) => {
					this.room.water.scale.y = v
				})
				this.onToast?.('喝水～ 30 秒后自动续满')
				break
			}
		}
	}

	/** 开门时在门廊生成僵尸（上限 3 只同时在场） */
	private spawnZombie() {
		if (this.zombies.filter((z) => !z.dead).length >= MAX_ZOMBIES) {
			this.onToast?.('门外已经站满了僵尸……')
			return
		}
		const z = new Zombie({
			onStrike: (zb) => {
				// 返回 true：玩家 8s 内成功格挡 2 次 → 为该僵尸预约横扫（破格挡技）
				if (this.combat.resolveStrike(zb, this.lastTime, this.camera)) {
					zb.requestSweep = true
					this.onToast?.('僵尸盯上了你的格挡——横扫将至！')
				}
			},
			onSweep: (zb) => this.combat.handleSweepHit(zb, this.lastTime, this.camera),
			onLunge: (zb, dirX, dirZ) => {
				this.combat.handleLungeHit(zb, this.lastTime, this.camera)
				// 击退：沿突进方向施加速度脉冲（靠摩擦自然滑出约 2m）
				this.vel.x += dirX * 6.5
				this.vel.z += dirZ * 6.5
			},
			onRoar: (zb) => {
				this.combat.handleRoarHit(zb, this.lastTime, this.camera)
				this.slowUntil = this.lastTime + 1.0 // 嘶吼减速 1s
			},
			onRoarInterrupt: () => this.onToast?.('嘶吼被打断！'),
			onStun: () => this.onToast?.('僵尸眩晕了！1 秒内左键反击！'),
			onDeath: () => this.onToast?.('僵尸被击倒了！'),
		})
		z.group.position.set(-4.55, 0, 1.9) // 门廊内（门后小房间）
		this.scene.add(z.group)
		this.zombies.push(z)
		this.onToast?.('门后传来低吼——一只僵尸钻了出来！')
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		// 阻止 Ctrl/Cmd+W 关闭标签页（飞行下降 Ctrl + 前进 W 的组合会触发）。
		// 普通标签页中该键为浏览器保留键，preventDefault 需配合全屏 + Keyboard Lock
		// 才生效（见 setupKeyCapture），此拦截对 Electron/PWA 等环境有效。
		if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyW' || e.code === 'KeyT' || e.code === 'KeyN')) {
			e.preventDefault()
			e.stopPropagation()
		}
		// V 切换固定视角 / 第一人称漫游
		if (e.code === 'KeyV' && !e.repeat) {
			this.setMode(this.mode === 'fixed' ? 'walk' : 'fixed')
			return
		}
		// 第一人称下双击 W → 疾跑（按住 W 期间维持）
		if (e.code === 'KeyW' && !e.repeat && this.mode === 'walk') {
			const now = performance.now()
			if (now - this.lastWTap <= DOUBLE_TAP_MS) {
				this.lastWTap = 0
				this.sprinting = true
			} else {
				this.lastWTap = now
			}
		}
		// 第一人称下空格：单击起跳（地面），双击起飞 / 降落
		if (e.code === 'Space' && !e.repeat && this.mode === 'walk') {
			const now = performance.now()
			if (now - this.lastSpaceTap <= DOUBLE_TAP_MS) {
				this.lastSpaceTap = 0
				this.flying = !this.flying
				if (this.flying) {
					// 起飞瞬间：施加一个较大的向上冲量（不小于当前跳跃/上升速度）
					this.vel.y = Math.max(this.vel.y, TAKEOFF_IMPULSE)
				}
				// 降落时保留当前垂直速度，交给重力自由落体
				this.onFlyChange?.(this.flying)
			} else {
				this.lastSpaceTap = now
				// 单击：仅在地面时起跳（飞行中按下由上升推力接管）
				const p = this.camera.position
				if (!this.flying && p.y <= EYE_HEIGHT + 1e-4) {
					this.vel.y = JUMP_IMPULSE
				}
			}
		}
		// 第一人称下 Shift → 朝 WSAD 按住的方向闪避（爆发速度 + dash 音效）
		if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat && this.mode === 'walk') {
			this.tryDash(this.lastTime)
		}
		this.keys.add(e.code)
	}

	/** 闪避：沿当前 WASD 输入方向瞬间赋予爆发速度（需按住方向键，0.6s 冷却） */
	private lastDash = 0
	private tryDash(now: number) {
		if (now - this.lastDash < DASH_CD) return
		const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
		const s = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
		if (f === 0 && s === 0) return // 未按住 WSAD，无方向可闪避
		const dir = new THREE.Vector3()
		this.camera.getWorldDirection(dir)
		dir.y = 0
		dir.normalize()
		const right = new THREE.Vector3(-dir.z, 0, dir.x)
		dir.multiplyScalar(f).addScaledVector(right, s).normalize()
		this.vel.x = dir.x * DASH_SPEED
		this.vel.z = dir.z * DASH_SPEED
		this.lastDash = now
		playSfx('dash')
	}

	private handleKeyUp = (e: KeyboardEvent) => {
		if (e.code === 'KeyW') this.sprinting = false // 松开 W 结束疾跑
		this.keys.delete(e.code)
	}

	private handleBlur = () => {
		this.keys.clear()
		this.sprinting = false
	}

	private handleResize = () => {
		const host = this.renderer.domElement.parentElement
		if (!host) return
		this.camera.aspect = host.clientWidth / host.clientHeight
		this.camera.updateProjectionMatrix()
		this.renderer.setSize(host.clientWidth, host.clientHeight)
	}

	/**
	 * 漫游 / 飞行移动（基于 dt 的速度惯性模型）：
	 * - 水平 WASD：加速度积累速度 → 无输入指数摩擦刹停，带自然惯性
	 * - 起飞：双击空格瞬间施加较大向上冲量，随后按住空格缓慢加速上升
	 * - 降落：再次双击空格关闭推力，自由落体回落至视线高度
	 */
	private updateWalk(dt: number) {
		if (!this.lockCtl.isLocked) {
			this.vel.set(0, 0, 0) // 解锁时清空速度，避免恢复锁定时突进
			return
		}
		const p = this.camera.position

		// ---- 水平：WASD 沿相机水平朝向加速（惯性积累） ----
		const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
		const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
		const hasInput = forward !== 0 || strafe !== 0
		// 疾跑仅在按住 W 前进时维持
		if (this.sprinting && forward <= 0) this.sprinting = false
		const slow = this.lastTime < this.slowUntil ? 0.5 : 1 // 嘶吼减速
		const maxSpeed = (this.sprinting ? SPRINT_SPEED : MAX_SPEED) * slow
		const accel = (this.sprinting ? SPRINT_ACCEL : ACCEL_H) * slow
		if (hasInput) {
			const dir = new THREE.Vector3()
			this.camera.getWorldDirection(dir)
			dir.y = 0
			dir.normalize()
			// 相机右方向 = 朝向 × 上
			const right = new THREE.Vector3(-dir.z, 0, dir.x)
			dir.multiplyScalar(forward).addScaledVector(right, strafe).normalize()
			this.vel.addScaledVector(dir, accel * dt)
		}
		// 摩擦阻尼：有输入轻微阻尼限制无限加速，无输入快速刹停
		const damp = Math.exp(-(hasInput ? FRICTION_MOVE : FRICTION_IDLE) * dt)
		this.vel.x *= damp
		this.vel.z *= damp
		// 水平速度软上限（疾跑上限更高）
		const hSpeed = Math.hypot(this.vel.x, this.vel.z)
		if (hSpeed > maxSpeed) {
			const k = maxSpeed / hSpeed
			this.vel.x *= k
			this.vel.z *= k
		}
		p.x += this.vel.x * dt
		p.z += this.vel.z * dt

		// 疾跑视场角动态变化（速度感）
		const targetFov = this.sprinting ? FOV_SPRINT : 60
		if (Math.abs(this.camera.fov - targetFov) > 0.01) {
			this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8)
			this.camera.updateProjectionMatrix()
		}

		// ---- 垂直 ----
		if (this.flying) {
			const up = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('ControlLeft') ? 1 : 0)
			if (up > 0) {
				// 按住空格缓慢加速；起飞冲量带来的超速部分自然衰减回巡航上限
				this.vel.y += FLY_ACCEL_UP * dt
				if (this.vel.y > FLY_MAX_UP) {
					this.vel.y = Math.max(FLY_MAX_UP, this.vel.y - OVERSPEED_DECEL * dt)
				}
			} else if (up < 0) {
				this.vel.y = Math.max(this.vel.y - FLY_ACCEL_DOWN * dt, -FLY_MAX_DOWN)
			} else {
				this.vel.y *= Math.exp(-V_DRAG * dt) // 无输入：垂直阻尼悬停
			}
		} else if (p.y > EYE_HEIGHT + 1e-4 || this.vel.y > 1e-4) {
			// 非飞行悬空（触发降落）：自由落体
			this.vel.y -= GRAVITY * dt
		}
		p.y += this.vel.y * dt

		// ---- 边界与限位（撞界时对应速度分量清零，避免贴墙蓄力） ----
		// 西墙门洞（z 1.45–2.35）在开门状态下可穿行至门外门廊，其余情况夹在室内
		const inDoorGate =
			this.doorOpen && p.z > DOOR_GATE_Z0 && p.z < DOOR_GATE_Z1 && p.y < DOOR_GATE_Y
		if (p.x < -3.5) {
			// 已在门廊内：限制在门廊范围（防从门廊穿墙回屋 / 走出门廊）
			const pz = THREE.MathUtils.clamp(p.z, PORCH_Z0, PORCH_Z1)
			if (pz !== p.z) {
				p.z = pz
				this.vel.z = 0
			}
			if (p.x < PORCH_X_MIN) {
				p.x = PORCH_X_MIN
				this.vel.x = 0
			}
			if (p.y > PORCH_CEIL) {
				p.y = PORCH_CEIL
				this.vel.y = Math.min(this.vel.y, 0)
			}
		} else {
			const cx = THREE.MathUtils.clamp(p.x, inDoorGate ? PORCH_X_MIN : -3.5, 3.5)
			if (cx !== p.x) {
				p.x = cx
				this.vel.x = 0
			}
		}
		const cz = THREE.MathUtils.clamp(p.z, -2.5, 4.2)
		if (cz !== p.z) {
			p.z = cz
			this.vel.z = 0
		}
		if (!this.flying) {
			if (p.y <= EYE_HEIGHT) {
				p.y = EYE_HEIGHT
				this.vel.y = 0 // 落地
			}
		} else {
			if (p.y < FLY_Y_MIN) {
				p.y = FLY_Y_MIN
				this.vel.y = Math.max(this.vel.y, 0)
			}
			if (p.y > FLY_Y_MAX) {
				p.y = FLY_Y_MAX
				this.vel.y = Math.min(this.vel.y, 0)
			}
		}
	}

	private loop = (timeMs: number) => {
		if (this.disposed) return
		const time = timeMs / 1000
		const dt = Math.min(0.1, this.lastTime === 0 ? 0.016 : time - this.lastTime)
		this.lastTime = time

		// 水杯自动续水（喝水为本地状态，30s 后水位回升）
		if (this.waterEmpty && time >= this.waterRefillAt) {
			this.waterEmpty = false
			this.tweens.start('water.level', 0, 1, 0.6, (v) => {
				this.room.water.scale.y = v
			})
		}

		if (this.mode === 'walk') {
			this.updateWalk(dt)
			// 格斗系统与僵尸 AI（鼠标未锁定时暂停，避免玩家挂机挨打）
			const active = this.lockCtl.isLocked
			this.combat.update(dt, time, this.camera, this.zombies, active)
			for (const z of this.zombies) {
				z.update(dt, time, this.camera.position, this.zombies, active)
			}
			for (let i = this.zombies.length - 1; i >= 0; i--) {
				if (this.zombies[i].removeMe) {
					this.scene.remove(this.zombies[i].group)
					this.zombies.splice(i, 1)
				}
			}
		} else {
			this.orbit.update()
		}

		// 设备过渡动画与逐帧效果（补间、风口摆动、紧急红闪等）
		this.rigs.update(dt, time)
		this.renderer.render(this.scene, this.camera)
	}
}
