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
 * - 近战格斗（combat.ts / zombie.ts / sword.ts）：PB 权威联机对战——僵尸 AI 状态机
 *   与伤害裁决全部在 PB（world.ts，10Hz world 快照 + 瞬时 event），PF 只做本地
 *   剑动画 / 意图上报（mp_action）/ 快照插值渲染；远程玩家渲染为彩色圆柱体
 *   （RemotePlayers.ts）；左键优先攻击、无目标回落交互；HUD 经 CombatUiHooks 推给 App.vue
 * - 对外提供 applyDeviceState()，由 App.vue watch Pinia store 调用
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { playSfx, setBeamLoop } from './audio'
import type {
	Action,
	DeviceId,
	DeviceState,
	MpEventPayload,
	NetPlayerState,
	PickCardOption,
	SceneState,
	WorldPayload,
	ZNetState,
} from '../protocol/messages'
import { pbClient } from '../ws/client'
import { PlayerCombat, WEAPON_NAMES, type CombatHud, type FloatKind } from './combat'
import { buildDevices, type DeviceRigs } from './devices'
import { buildRoom, type RoomRig } from './room'
import { RemotePlayers } from './RemotePlayers'
import { TweenSystem } from './tween'
import { NetZombie } from './zombie'

export type ViewMode = 'fixed' | 'walk'

/** 格斗系统对 UI 层的回调（HUD 推送 / 飘字 / 全屏闪光） */
export interface CombatUiHooks {
	onHud(hud: CombatHud): void
	onFloat(text: string, sxPct: number, syPct: number, kind: FloatKind): void
	onFlash(kind: 'hurt' | 'parry'): void
}

/** 升级三选一状态（pick_phase / 我的选择变化时经 onPick 推给 App.vue） */
export interface PickState {
	active: boolean
	/** 我抽到的 3 张增益卡牌（非 fp / 未进入选择时为 null） */
	options: PickCardOption[] | null
	/** 我是否已选 */
	done: boolean
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
const MP_INPUT_PERIOD = 0.1   // 联机输入上报周期 s（10Hz）

// 剑气面内挥摆复用对象（避免每帧分配，见 updateWaves）
const _waveSwingQ = new THREE.Quaternion()
const _waveZAxis = new THREE.Vector3(0, 0, 1)

// 苍弓（与 PB world.ts 对齐的视觉参数）
const ORB_SPEED = 16        // 球状闪电飞行速度 m/s（与 PB ORB_SPEED 一致）
const ORB_FALLBACK_TTL = 8  // orb 视觉兜底寿命 s（正常由 orb_stop 事件驱动消失）
const BEAM_RANGE = 20       // 激光长度 m（与 PB BEAM_RANGE 一致）
const BEAM_BURST_S = 0.3    // 爆发光束闪光时长 s
const _beamDir = new THREE.Vector3()
const _beamUp = new THREE.Vector3(0, 1, 0)

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
	private onDeathState?: (dead: boolean, canRespawn: boolean) => void
	private onRoster?: (players: NetPlayerState[]) => void
	private onPick?: (st: PickState) => void
	private onScene?: (scene: SceneState) => void
	private onLevelUp?: (level: number) => void
	private meDead = false
	private charging = false // 重击蓄力中（按住左键，移动冻结）
	private pickSt: PickState = { active: false, options: null, done: false }
	private lastPickKey = ''

	// ---------------- 场景交互状态 ----------------
	private raycaster = new THREE.Raycaster()
	private interactables: THREE.Object3D[] = []
	private pointerDownPos: { x: number; y: number } | null = null
	private hoverThrottle = 0
	private doorLocked = true       // 后端同步的锁状态（开门仅解锁时允许）
	private doorOpen = false        // 门板开合（本地视觉状态）
	private waterEmpty = false      // 水杯是否已喝空（本地状态）
	private waterRefillAt = 0       // 续水时刻（loop 秒钟）

	// ---------------- 格斗 / 联机状态 ----------------
	private combatHooks?: CombatUiHooks
	private combat: PlayerCombat
	private zombies: NetZombie[] = []
	private remotePlayers = new RemotePlayers()
	private lastMpSent = 0              // 上次输入上报时刻（loop 秒钟）
	private pendingPerfect: number | null = null // 完美格挡音效延迟判定（等 zstun 判体力耗尽）

	constructor(
		host: HTMLElement,
		onModeChange?: (mode: ViewMode) => void,
		onFlyChange?: (flying: boolean) => void,
		onUiCommand?: (deviceId: DeviceId, action: Action) => void,
		onToast?: (msg: string) => void,
		onLockChange?: (locked: boolean) => void,
		combatHooks?: CombatUiHooks,
		onDeathState?: (dead: boolean, canRespawn: boolean) => void,
		onRoster?: (players: NetPlayerState[]) => void,
		onPick?: (st: PickState) => void,
		onScene?: (scene: SceneState) => void,
		onLevelUp?: (level: number) => void,
	) {
		this.onModeChange = onModeChange
		this.onFlyChange = onFlyChange
		this.onUiCommand = onUiCommand
		this.onToast = onToast
		this.onLockChange = onLockChange
		this.combatHooks = combatHooks
		this.onDeathState = onDeathState
		this.onRoster = onRoster
		this.onPick = onPick
		this.onScene = onScene
		this.onLevelUp = onLevelUp

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

		// ---------------- 格斗系统（钻石剑视模型挂在相机上，PB 权威裁决） ----------------
		this.combat = new PlayerCombat({
			onHud: () => this.combatHooks?.onHud(this.combat.getHud(this.zombies, this.camera)),
			onToast: (t) => this.onToast?.(t),
			onFloat: (text, sx, sy, kind) => this.combatHooks?.onFloat(text, sx, sy, kind),
			onFlash: (k) => this.combatHooks?.onFlash(k),
			onStabAim: (dir) => this.beginStabAim(dir),
		})
		this.combat.attach(this.camera)

		// ---------------- 联机对战（PB world 快照渲染 + 事件表现） ----------------
		this.scene.add(this.remotePlayers.group)
		pbClient.onWorld = (w) => this.applyWorld(w)
		pbClient.onMpEvent = (e) => this.handleMpEvent(e)

		// ---------------- 静态房间与设备 ----------------
		this.room = buildRoom(this.scene)
		this.rigs = buildDevices(this.scene, this.room, this.tweens)
		this.interactables = [...this.rigs.interactables, this.room.water, this.room.lamp]

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
		// 切视角一律取消蓄力（防残留冻结移动）
		if (this.charging) {
			this.charging = false
			this.combat.endCharge()
		}
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
		this.remotePlayers.dispose()
		for (const w of this.wavesVis) {
			this.scene.remove(w.mesh)
			w.geo.dispose() // 双平面共享同一几何体，dispose 一次
			w.mat.dispose()
		}
		this.wavesVis.length = 0
		for (const id of [...this.orbsVis.keys()]) this.removeOrb(id)
		for (const b of this.burstBeams) {
			b.mesh.removeFromParent()
			b.geo.dispose()
			b.mat.dispose()
		}
		this.burstBeams.length = 0
		if (this.beamMesh) {
			this.beamMesh.removeFromParent()
			this.beamGeo?.dispose()
			this.beamMat?.dispose()
			this.beamMesh = null
		}
		this.orbHaloTex?.dispose()
		this.orbHaloTex = null
		this.beamLoopOn = false
		setBeamLoop(false)
		pbClient.onWorld = undefined
		pbClient.onMpEvent = undefined
		if (this.pendingPerfect !== null) window.clearTimeout(this.pendingPerfect)
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
		// 漫游模式下点击画面 → 锁定鼠标（ESC 退出由浏览器处理）；三选一期间不锁定（需点击选项）
		if (this.mode === 'walk' && !this.disposed && !this.pickSt.active) {
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
			// 按住右键 → 格挡（仅第一人称锁定时；蓄力中不可格挡）
			if (this.mode === 'walk' && this.lockCtl.isLocked && !this.charging) this.combat.startBlock(this.lastTime)
			return
		}
		if (e.button !== 0) return
		this.pointerDownPos = { x: e.clientX, y: e.clientY }
		// 第一人称锁定：按下左键开始蓄力重击（松开判定：<1s 普攻，≥1s 剑气）
		if (this.mode === 'walk' && this.lockCtl.isLocked && this.combat.startCharge(this.lastTime)) {
			this.charging = true
		}
	}

	private handlePointerUp = (e: PointerEvent) => {
		if (e.button === 2) {
			if (this.mode === 'walk') this.combat.endBlock(this.lastTime)
			return
		}
		if (e.button !== 0 || !this.pointerDownPos || this.disposed) return
		const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y)
		this.pointerDownPos = null
		if (moved > CLICK_MOVE_PX) {
			// 拖拽视角非点击：取消蓄力
			if (this.charging) {
				this.charging = false
				this.combat.endCharge()
			}
			return
		}
		// 第一人称锁定：蓄力判定释放（≥蓄力时长剑气，否则取消蓄力回落普攻/交互）
		if (this.mode === 'walk' && this.lockCtl.isLocked) {
			if (this.charging) {
				this.charging = false
				// 武器结算重击（剑未蓄满自动回落 false；蓄满停手已由 maxChargeReached 自动触发）
				if (this.combat.heavyAttack(this.combat.chargeHold(this.lastTime), this.lastTime)) return
			}
			// 队友复活：准星指向 3m 内的尸体 → revive 意图（优先于攻击 / 交互）
			const corpse = this.pickCorpse()
			if (corpse) {
				pbClient.sendMpAction({ kind: 'revive', target: corpse.uuid })
				this.onToast?.(`正在复活 ${corpse.name}`)
				return
			}
			// 交互物先拾取（远程武器不吞台灯 / 开门：经 ctx 传入武器判断）
			const tag = this.pickInteractable()
			const consumed = this.combat.normalAttack(
				this.lastTime, this.zombies, this.remotePlayers.centers(), this.camera,
				!this.flying && this.camera.position.y <= EYE_HEIGHT + 1e-4,
				tag,
			)
			if (consumed) return
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

	/**
	 * 准星指向的最近尸体（水平距离 ≤3m、视线夹角内）：revive 意图目标。
	 * 与 PB reviveBy 的距离/存活校验对齐（最终仍由 PB 权威裁决）。
	 */
	private pickCorpse(): { uuid: string; name: string } | null {
		if (this.combat.dead) return null // 自己是尸体时不能复活别人
		const corpses = this.remotePlayers.corpses()
		if (!corpses.length) return null
		const dir = new THREE.Vector3()
		this.camera.getWorldDirection(dir)
		const cp = this.camera.position
		let best: { uuid: string; name: string } | null = null
		let bestD = Infinity
		for (const c of corpses) {
			const dH = Math.hypot(c.x - cp.x, c.z - cp.z)
			if (dH > 3) continue
			const to = new THREE.Vector3(c.x - cp.x, c.y - cp.y, c.z - cp.z).normalize()
			if (to.angleTo(dir) > 0.55) continue
			if (dH < bestD) {
				bestD = dH
				best = { uuid: c.uuid, name: c.name }
			}
		}
		return best
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
				break
			}
			case 'lamp': {
				// 台灯召唤僵尸（PB 权威：fp 存活玩家每次点击 +1，上限 3 只）
				if (this.mode !== 'walk') {
					this.onToast?.('进入第一人称（V 键）才能使用台灯')
					break
				}
				pbClient.sendMpAction({ kind: 'lamp' })
				this.onToast?.('台灯闪烁——僵尸被召唤了！')
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

	// ---------------- 联机对战：PB 快照 / 事件 → 本地表现 ----------------

	/** 上报输入状态（10Hz）：位置 / 朝向 / 模式 / 当前动作标签 */
	private sendMpInput() {
		const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
		const dir = new THREE.Vector3()
		this.camera.getWorldDirection(dir)
		const len = Math.hypot(dir.x, dir.z) || 1
		pbClient.sendMpInput({
			p: [r3(this.camera.position.x), r3(this.camera.position.y), r3(this.camera.position.z)],
			yaw: r3(euler.y),
			dir: [r3(dir.x / len), r3(dir.z / len)],
			dir3: [r3(dir.x), r3(dir.y), r3(dir.z)], // 相机 3D 前向（剑气飞行方向）
			mode: this.mode === 'walk' ? 'fp' : 'free',
			anim: this.combat.currentAnimTag(),
		})
	}

	// ---------------- 重击剑气视觉（PB 事件驱动，本地飞行渲染） ----------------

	/** 剑气月牙贴图（模块级缓存） */
	private waveTex: THREE.CanvasTexture | null = null
	private wavesVis: { mesh: THREE.Group; geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; dir: THREE.Vector3; t: number; quat: THREE.Quaternion }[] = []

	// ---- 苍弓视觉：球状闪电 / 爆发光束 / 本地持续激光 ----
	/** 飞行 / 附着中的球状闪电（orb / orb_stop 事件驱动） */
	private orbsVis = new Map<number, {
		group: THREE.Group
		core: THREE.Mesh
		coreMat: THREE.MeshBasicMaterial
		halo: THREE.Sprite
		pos: THREE.Vector3
		dir: THREE.Vector3
		target: string | null
		t: number
	}>()
	private orbHaloTex: THREE.CanvasTexture | null = null
	/** 爆发光束闪光（beam_burst 事件，0.3s 淡出） */
	private burstBeams: { mesh: THREE.Mesh; geo: THREE.CylinderGeometry; mat: THREE.MeshBasicMaterial; t: number }[] = []
	/** 本地持续激光细束（蓄力态驱动渲染，单实例复用） */
	private beamMesh: THREE.Mesh | null = null
	private beamGeo: THREE.CylinderGeometry | null = null
	private beamMat: THREE.MeshBasicMaterial | null = null
	private beamLoopOn = false
	/** 爆发屏幕微震（FOV 脉冲，仅发射者自己） */
	private fovKick = 0

	private getWaveTex(): THREE.CanvasTexture {
		if (this.waveTex) return this.waveTex
		const c = document.createElement('canvas')
		c.width = 256
		c.height = 128
		const ctx = c.getContext('2d')!
		ctx.translate(128, 64)
		// 外层青色大弧 → 内层亮白弧（additive 叠出发光感）
		for (const [r, w, col] of [
			[86, 26, 'rgba(80, 230, 210, 0.55)'],
			[86, 13, 'rgba(190, 255, 246, 0.95)'],
			[86, 5, 'rgba(255, 255, 255, 1)'],
		] as const) {
			ctx.beginPath()
			ctx.arc(0, 40, r, Math.PI * 1.15, Math.PI * 1.85)
			ctx.lineWidth = w
			ctx.strokeStyle = col
			ctx.lineCap = 'round'
			ctx.stroke()
		}
		const tex = new THREE.CanvasTexture(c)
		tex.colorSpace = THREE.SRGBColorSpace
		this.waveTex = tex
		return tex
	}

	/** 生成剑气实体（wave 事件到达时调用，含发射者自己）：3D 飞行 + 绕飞行轴 roll 旋转 */
	private spawnWave(x: number, y: number, z: number, dx: number, dy: number, dz: number, roll: number) {
		playSfx('roar') // 剑气破空声（各端本地播放，含发射者）
		const mat = new THREE.MeshBasicMaterial({
			map: this.getWaveTex(), transparent: true, opacity: 0.95,
			blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
		})
		// 双平面十字交叉（共享几何体/材质）：单平面侧视为 0 厚度看不清，
		// 交叉后任意视角均有投影宽度，重叠处 additive 叠亮更醒目
		const geo = new THREE.PlaneGeometry(2.8, 1.4)
		const group = new THREE.Group()
		group.add(new THREE.Mesh(geo, mat))
		const cross = new THREE.Mesh(geo, mat)
		cross.rotation.y = Math.PI / 2 // 绕飞行轴（局部 +Y）转 90° 与主面交叉
		group.add(cross)
		group.position.set(x, y, z)
		// 基向量与 PB waveBasis 同公式：u=飞行方向（贴图 +V 凸缘），c=面内横轴（随 roll 旋转），n=面法线
		const u = new THREE.Vector3(dx, dy, dz).normalize()
		const c0 = new THREE.Vector3(-u.z, 0, u.x)
		if (c0.lengthSq() < 1e-4) c0.set(1, 0, 0)
		c0.normalize()
		const n0 = new THREE.Vector3().crossVectors(u, c0).normalize()
		const c = c0.multiplyScalar(Math.cos(roll)).addScaledVector(n0, Math.sin(roll)).normalize()
		// 贴图平面局部 +Y → 飞行方向、+X → 面内横轴、+Z → 面法线（makeBasis 右手系）
		const zAxis = new THREE.Vector3().crossVectors(c, u)
		const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(c, u.clone(), zAxis))
		this.scene.add(group)
		this.wavesVis.push({ mesh: group, geo, mat, pos: new THREE.Vector3(x, y, z), dir: u, t: 0, quat })
	}

	private updateWaves(dt: number) {
		for (let i = this.wavesVis.length - 1; i >= 0; i--) {
			const w = this.wavesVis[i]
			w.t += dt
			if (w.t >= 1.2) {
				this.scene.remove(w.mesh)
				w.geo.dispose() // 双平面共享同一几何体，dispose 一次
				w.mat.dispose()
				this.wavesVis.splice(i, 1)
				continue
			}
			w.pos.addScaledVector(w.dir, 12 * dt)
			w.mesh.position.copy(w.pos)
			// 面内挥摆（绕面法线，即局部 Z）
			w.mesh.quaternion.copy(w.quat).multiply(_waveSwingQ.setFromAxisAngle(_waveZAxis, Math.sin(w.t * 14) * 0.12))
			w.mat.opacity = Math.max(0, 0.95 * (1 - (w.t / 1.2) ** 3))
		}
	}

	// ---------------- 苍弓视觉（PB 事件驱动 + 蓄力态驱动） ----------------

	/** 球状闪电光晕贴图（径向渐变，缓存） */
	private getOrbHaloTex(): THREE.CanvasTexture {
		if (this.orbHaloTex) return this.orbHaloTex
		const c = document.createElement('canvas')
		c.width = c.height = 64
		const ctx = c.getContext('2d')!
		const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
		g.addColorStop(0, 'rgba(200, 255, 252, 1)')
		g.addColorStop(0.35, 'rgba(110, 230, 255, 0.55)')
		g.addColorStop(1, 'rgba(110, 160, 255, 0)')
		ctx.fillStyle = g
		ctx.fillRect(0, 0, 64, 64)
		const tex = new THREE.CanvasTexture(c)
		tex.colorSpace = THREE.SRGBColorSpace
		this.orbHaloTex = tex
		return tex
	}

	/** 生成球状闪电实体（orb 事件到达时调用，含发射者自己）：飞行 16 m/s 与 PB 同速 */
	private spawnOrb(x: number, y: number, z: number, dx: number, dy: number, dz: number, id: number) {
		playSfx('orbShot')
		const geo = new THREE.SphereGeometry(0.14, 12, 10)
		const mat = new THREE.MeshBasicMaterial({
			color: 0x7df9ff, transparent: true, opacity: 0.95,
			blending: THREE.AdditiveBlending, depthWrite: false,
		})
		const core = new THREE.Mesh(geo, mat)
		const halo = new THREE.Sprite(new THREE.SpriteMaterial({
			map: this.getOrbHaloTex(), transparent: true, opacity: 0.9,
			blending: THREE.AdditiveBlending, depthWrite: false,
		}))
		halo.scale.setScalar(0.55)
		const group = new THREE.Group()
		group.add(core)
		group.add(halo)
		group.position.set(x, y, z)
		this.scene.add(group)
		this.orbsVis.set(id, {
			group, core, coreMat: mat, halo,
			pos: new THREE.Vector3(x, y, z),
			dir: new THREE.Vector3(dx, dy, dz).normalize(),
			target: null, t: 0,
		})
	}

	/** 附着目标世界中心（'z<id>' = 僵尸胸口 / 玩家 uuid = 圆柱中心 1.0m） */
	private orbTargetCenter(target: string): THREE.Vector3 | null {
		if (target.startsWith('z')) {
			const z = this.zombies.find((x) => x.id === Number(target.slice(1)))
			return z ? z.centerPos : null
		}
		const c = this.remotePlayers.centers().find((c) => c.uuid === target)
		return c ? new THREE.Vector3(c.x, c.y, c.z) : null
	}

	private removeOrb(id: number) {
		const o = this.orbsVis.get(id)
		if (!o) return
		this.orbsVis.delete(id)
		o.group.removeFromParent()
		o.core.geometry.dispose()
		o.coreMat.dispose()
		; (o.halo.material as THREE.SpriteMaterial).dispose()
	}

	private updateOrbs(dt: number) {
		for (const [id, o] of this.orbsVis) {
			o.t += dt
			if (o.t > ORB_FALLBACK_TTL) {
				this.removeOrb(id)
				continue
			}
			if (o.target === null) {
				o.pos.addScaledVector(o.dir, ORB_SPEED * dt)
			} else {
				const c = this.orbTargetCenter(o.target)
				if (c) o.pos.lerp(c, Math.min(1, dt * 20)) // 附着跟随（插值平滑）
			}
			o.group.position.copy(o.pos)
			// 脉动 + 缩放（附着后缩小、闪烁加快）
			const pulse = 1 + Math.sin(o.t * (o.target ? 34 : 22)) * 0.15
			o.core.scale.setScalar((o.target ? 0.75 : 1) * pulse)
			o.halo.scale.setScalar((o.target ? 0.42 : 0.55) * pulse)
		}
	}

	/** 爆发光束（beam_burst 事件）：粗光束沿弹道 0.3s 闪光淡出 */
	private spawnBurstBeam(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
		const geo = new THREE.CylinderGeometry(0.14, 0.14, BEAM_RANGE, 10, 1, true)
		const mat = new THREE.MeshBasicMaterial({
			color: 0xbffcff, transparent: true, opacity: 1,
			blending: THREE.AdditiveBlending, depthWrite: false,
		})
		const mesh = new THREE.Mesh(geo, mat)
		const dir = new THREE.Vector3(dx, dy, dz).normalize()
		mesh.position.set(x, y, z).addScaledVector(dir, BEAM_RANGE / 2)
		mesh.quaternion.setFromUnitVectors(_beamUp, dir)
		this.scene.add(mesh)
		this.burstBeams.push({ mesh, geo, mat, t: 0 })
	}

	private updateBurstBeams(dt: number) {
		for (let i = this.burstBeams.length - 1; i >= 0; i--) {
			const b = this.burstBeams[i]
			b.t += dt
			if (b.t >= BEAM_BURST_S) {
				b.mesh.removeFromParent()
				b.geo.dispose()
				b.mat.dispose()
				this.burstBeams.splice(i, 1)
				continue
			}
			const x = b.t / BEAM_BURST_S
			b.mat.opacity = 1 - x
			b.mesh.scale.set(1 + x * 1.2, 1, 1 + x * 1.2)
		}
	}

	/** 本地持续激光细束（弓蓄力态驱动：从相机沿准星渲染，粗细 / 亮度随蓄力增强） */
	private updateLocalBeam() {
		if (!this.beamMesh) {
			this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true)
			this.beamMat = new THREE.MeshBasicMaterial({
				color: 0x9be8ff, transparent: true, opacity: 0.35,
				blending: THREE.AdditiveBlending, depthWrite: false,
			})
			this.beamMesh = new THREE.Mesh(this.beamGeo, this.beamMat)
			this.beamMesh.visible = false
			this.scene.add(this.beamMesh)
		}
		const active = this.mode === 'walk' && this.combat.weaponId === 'bow' && this.combat.chargeStart >= 0
		this.beamMesh.visible = active
		if (!active) return
		const charge01 = Math.min(1, this.combat.chargeHold(this.lastTime) / this.combat.chargeDur)
		this.camera.getWorldDirection(_beamDir)
		const r = 0.035 + charge01 * 0.045
		this.beamMesh.scale.set(r, BEAM_RANGE, r)
		this.beamMesh.position.copy(this.camera.position).addScaledVector(_beamDir, BEAM_RANGE / 2 + 0.3)
		this.beamMesh.quaternion.setFromUnitVectors(_beamUp, _beamDir)
		this.beamMat!.opacity = 0.28 + charge01 * 0.35
	}

	/** world 快照应用：远程玩家增删 / 僵尸状态机渲染 / 自己的权威数值 */
	private applyWorld(w: WorldPayload) {
		// 场景属性 + 共享词条（经验 / 等级 / 幸运 / 经验倍率）推送
		this.onScene?.(w.scene)
		// 自己的圆柱体不渲染（避免遮挡第一人称视角），数据仍经 mine 用于 HUD
		this.remotePlayers.applySnapshot(w.players, pbClient.you?.uuid ?? null)
		this.onRoster?.(w.players)

		const seen = new Set<number>()
		for (const s of w.zombies) {
			seen.add(s.id)
			let z = this.zombies.find((x) => x.id === s.id)
			if (!z) {
				// 快照尾巴里的尸体不再重建（PF 死亡动画 1.7s 早于 PB 2s 清理）
				if (s.state === 'dead') continue
				z = new NetZombie(s.id, s, (from, to) => this.onZombieStateChange(from, to))
				this.scene.add(z.group)
				this.zombies.push(z)
			}
			z.applyState(s)
		}
		for (let i = this.zombies.length - 1; i >= 0; i--) {
			if (!seen.has(this.zombies[i].id)) {
				this.zombies[i].dispose()
				this.zombies.splice(i, 1)
			}
		}

		const me = pbClient.you
		const mine = me ? w.players.find((p) => p.uuid === me.uuid) : null
		if (mine) {
			this.combat.setNet(mine, w.chase_left)
			// 死亡覆盖层：能否手动复活由快照推导（PB 侧 mp_action respawn 仍做权威校验）
			// 规则：无存活僵尸（含所有玩家死亡清场）→ 可手动复活；有队友存活且僵尸仍在
			// → 禁止手动复活，必须等队友走近点击尸体（revive）复活
			const zombiesAlive = w.zombies.some((z) => z.state !== 'dead')
			const aliveOthers = w.players.filter((p) => p.fp && p.uuid !== me!.uuid && p.hp > 0).length
			const canRespawn = !zombiesAlive || aliveOthers === 0
			const dead = mine.hp <= 0
			// 死亡期间每次快照都回调（canRespawn 随僵尸被消灭 / 队友阵亡而解锁）
			if (dead || dead !== this.meDead) {
				this.meDead = dead
				this.onDeathState?.(dead, canRespawn)
			}
		}

		// 三选一状态推送（变化时）：进入选择时释放指针锁定，让玩家能点击选项
		const pickSt: PickState = {
			active: w.pick_phase,
			options: mine?.pick?.options ?? null,
			done: mine?.pick?.done ?? false,
		}
		const key = `${pickSt.active}|${pickSt.options?.join(',') ?? ''}|${pickSt.done}`
		if (key !== this.lastPickKey) {
			this.lastPickKey = key
			this.pickSt = pickSt
			if (pickSt.active && this.mode === 'walk' && this.lockCtl.isLocked) this.lockCtl.unlock()
			this.onPick?.(pickSt)
		}
	}

	/** 僵尸状态切换 → 前摇预警音效（金=普攻 / 白=横扫 / 紫=突进 / 红圈=嘶吼） */
	private onZombieStateChange(_from: ZNetState, to: ZNetState) {
		if (to === 'windup') playSfx('flashAlert')
		else if (to === 'sweep') playSfx('sweep')
		else if (to === 'lungeWind') playSfx('lunge')
		else if (to === 'roar') playSfx('roar')
	}

	/** PB 战斗事件分发：音效 / 飘字 / 闪光 / 击退 / 减速 / 复位 */
	private handleMpEvent(e: MpEventPayload) {
		const me = pbClient.you?.uuid
		switch (e.kind) {
			case 'join':
				if (e.uuid !== me) this.onToast?.(`${e.name} 加入了房间`)
				break
			case 'leave':
				if (e.uuid !== me) this.onToast?.(`${e.name} 离开了房间`)
				break
			case 'dmg_z': {
				const z = this.zombies.find((x) => x.id === e.id)
				if (z) {
					z.flash()
					// 飘字按 DamageSign 分型：暴击大字感叹 / 治疗绿色 / 格挡灰字 / 普通白字
					const amount = Math.round(e.amount)
					if (e.sign === 2) this.combat.pushFloat(z.headPos, `${amount}!`, 'crit')
					else if (e.sign === -1) this.combat.pushFloat(z.headPos, `+${amount}`, 'heal')
					else if (e.sign === 0) this.combat.pushFloat(z.headPos, '格挡', 'blocked')
					else this.combat.pushFloat(z.headPos, `${amount}`, 'normal')
				}
				break
			}
			case 'dmg_p': {
				const amount = Math.round(e.amount)
				if (e.uuid === me) {
					playSfx('kick')
					this.combatHooks?.onFlash('hurt')
					const pos = this.camera.position.clone()
					pos.y += 0.3
					if (e.sign === -1) this.combat.pushFloat(pos, `+${amount}`, 'heal')
					else if (e.sign === 0) this.combat.pushFloat(pos, '格挡', 'blocked')
					else this.combat.pushFloat(pos, `-${amount}${e.sign === 2 ? '!' : ''}`, e.sign === 2 ? 'crit' : 'normal')
				} else {
					this.remotePlayers.flash(e.uuid)
					this.remotePlayers.bleed(e.uuid)
					const c = this.remotePlayers.centers().find((c) => c.uuid === e.uuid)
					if (c) {
						if (e.sign === -1) this.combat.pushFloat(new THREE.Vector3(c.x, 2.0, c.z), `+${amount}`, 'heal')
						else if (e.sign === 0) this.combat.pushFloat(new THREE.Vector3(c.x, 2.0, c.z), '格挡', 'blocked')
						else this.combat.pushFloat(new THREE.Vector3(c.x, 2.0, c.z), `-${amount}${e.sign === 2 ? '!' : ''}`, e.sign === 2 ? 'crit' : 'normal')
					}
				}
				break
			}
			case 'wave': {
				// 重击剑气：各端本地渲染飞行视觉（伤害由 PB 弹道裁决）
				this.spawnWave(e.x, e.y, e.z, e.dx, e.dy, e.dz, e.roll)
				break
			}
			case 'orb': {
				// 苍弓射球：各端本地渲染飞行视觉（伤害由 PB 裁决）
				this.spawnOrb(e.x, e.y, e.z, e.dx, e.dy, e.dz, e.id)
				break
			}
			case 'orb_stop': {
				// 球状闪电停止前进：附着目标跟随 / null 消失
				const o = this.orbsVis.get(e.id)
				if (!o) break
				if (e.target === null) this.removeOrb(e.id)
				else o.target = e.target
				break
			}
			case 'beam_burst': {
				// 苍弓蓄满爆发：粗光束闪光（伤害由 PB 射线裁决）
				this.spawnBurstBeam(e.x, e.y, e.z, e.dx, e.dy, e.dz)
				playSfx('beamBurst')
				if (e.by === me) {
					// 发射者自己：屏幕微震 + 强制对齐本地蓄力态（PB tick 先于本地镜像的边缘时序）
					if (this.combat.chargeStart >= 0) this.combat.chargeStart = -1
					this.fovKick = BEAM_BURST_S
				}
				break
			}
			case 'parry': {
				if (e.uuid !== me) break
				if (e.fail) {
					playSfx('unexactParry')
					this.combatHooks?.onFlash('hurt')
				} else {
					// 格挡成功（普通 / 完美）：PB 权威立即退出格挡姿态（普通格挡进入冷却）
					this.combat.onParryJudged(e.perfect)
					if (e.perfect) {
						if (e.byZombie) {
							// 僵尸被完美格挡：60ms 内 zstun 到达 → 本次格挡耗尽僵尸体力（sword-parry）
							if (this.pendingPerfect !== null) window.clearTimeout(this.pendingPerfect)
							this.pendingPerfect = window.setTimeout(() => {
								this.pendingPerfect = null
								playSfx('perfectParry')
								this.combatHooks?.onFlash('parry')
							}, 60)
						} else {
							playSfx('perfectParry')
							this.combatHooks?.onFlash('parry')
						}
					} else {
						playSfx('unexactParry')
					}
				}
				break
			}
			case 'level_up':
				// 场景升级：全员 LEVEL UP 橙色横幅（3s 动画，提示期可继续攻击）
				this.onLevelUp?.(e.level)
				break
			case 'zstun':
				if (this.pendingPerfect !== null) {
					window.clearTimeout(this.pendingPerfect)
					this.pendingPerfect = null
					playSfx('swordParry')
				}
				this.onToast?.(`僵尸眩晕！易伤 ×${e.mul.toFixed(2)} —— 1 秒内左键反击！`)
				break
			case 'zdie':
				this.onToast?.('僵尸被击倒了！')
				break
			case 'counter_open':
				this.onToast?.('追击窗口开启！连续左键追击！')
				break
			case 'roar_interrupt':
				this.onToast?.('嘶吼被打断！')
				break
			case 'knockback':
				if (e.uuid === me) {
					this.vel.x += e.dx * e.speed
					this.vel.z += e.dz * e.speed
					this.combat.interruptAction()
				}
				break
			case 'slow':
				if (e.uuid === me) this.slowUntil = this.lastTime + e.dur
				break
			case 'guardbreak':
				if (e.uuid === me) {
					this.combat.applyGuardBreak(e.dur)
					this.combatHooks?.onFlash('hurt')
				}
				break
			case 'respawn':
				if (e.uuid === me) {
					// 复活落点由 PB 下发：手动复活 = 出生点 / 队友复活 = 原地起立
					this.camera.position.set(e.pos[0], e.pos[1], e.pos[2])
					this.vel.set(0, 0, 0)
					if (this.flying) {
						this.flying = false
						this.onFlyChange?.(false)
					}
					this.onToast?.('你已复活')
				}
				break
		}
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
		// 第一人称锁定时 Q / E 切换上一把 / 下一把武器（蓄力中不可切换，PB 快照回写为准）
		if ((e.code === 'KeyQ' || e.code === 'KeyE') && !e.repeat && this.mode === 'walk' && this.lockCtl.isLocked && !this.charging) {
			const target = this.combat.cycleWeapon(e.code === 'KeyE' ? 1 : -1)
			pbClient.sendMpAction({ kind: 'weapon', weapon: target })
			this.onToast?.(`切换武器：${WEAPON_NAMES[target]}`)
			return
		}
		this.keys.add(e.code)
		// 第一人称下 Shift → 朝 WSAD 按住的方向闪避（爆发速度 + dash 音效）
		// 注：keys.add 必须先于 Shift 分支——同帧先 Shift 后按方向键时方向需已入 keys
		if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat && this.mode === 'walk') {
			this.dash(this.lastTime)
		}
	}

	/** 闪避：沿当前 WASD 输入方向瞬间赋予爆发速度（需按住方向键，0.6s 冷却） */
	private lastDash = 0
	/** 闪避速度豁免截止：期间水平软上限不生效（否则 8.5 m/s 爆发速度被钳回 3.0 等于没闪） */
	private dashFreeUntil = 0
	/**
	 * 闪避（支持外部触发）：invincible=true 时本次闪避附带无敌帧
	 * （上报 'dash' 意图，PB 0.3s 完全免伤；键盘 Shift 触发不带无敌，行为不变）。
	 */
	dash(now: number, invincible = false) {
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
		this.dashFreeUntil = now + 0.25
		if (invincible) pbClient.sendMpAction({ kind: 'dash' })
		playSfx('dash')
	}

	// ---------------- 空中戳刺镜头（camera slerp 转向目标） ----------------

	/** 戳刺镜头状态：目标四元数 + 截止时刻（期间压掉 PointerLockControls 鼠标输入） */
	private stabLerp: { quat: THREE.Quaternion; until: number } | null = null

	private beginStabAim(dir: THREE.Vector3) {
		const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0))
		this.stabLerp = { quat: new THREE.Quaternion().setFromRotationMatrix(m), until: this.lastTime + 0.4 }
	}

	/** 每帧推进戳刺镜头；结束（超时或落地）恢复 pointerSpeed=1 */
	private updateStabLerp(dt: number) {
		if (!this.stabLerp) return
		const grounded = this.camera.position.y <= EYE_HEIGHT + 1e-4
		if (this.lastTime >= this.stabLerp.until || grounded) {
			this.stabLerp = null
			this.lockCtl.pointerSpeed = 1
			return
		}
		this.lockCtl.pointerSpeed = 0
		this.camera.quaternion.slerp(this.stabLerp.quat, Math.min(1, dt * 10))
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
		if (this.combat.dead) {
			this.vel.set(0, 0, 0) // 死亡：冻结移动，等待死亡覆盖层复活
			return
		}
		const p = this.camera.position

		// ---- 水平：WASD 沿相机水平朝向加速（惯性积累） ----
		// 蓄力重击期间移动减速 50%（仍可移动），并打断疾跑
		const chargeSlow = this.charging ? 0.5 : 1
		if (this.charging) this.sprinting = false
		const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
		const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
		const hasInput = forward !== 0 || strafe !== 0
		// 疾跑仅在按住 W 前进时维持
		if (this.sprinting && forward <= 0) this.sprinting = false
		const slow = this.lastTime < this.slowUntil ? 0.5 : 1 // 嘶吼减速
		const maxSpeed = (this.sprinting ? SPRINT_SPEED : MAX_SPEED) * slow * chargeSlow
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
		// 水平速度软上限（疾跑上限更高；闪避爆发速度 0.25s 内豁免）
		const hSpeed = Math.hypot(this.vel.x, this.vel.z)
		if (hSpeed > maxSpeed && this.lastTime > this.dashFreeUntil) {
			const k = maxSpeed / hSpeed
			this.vel.x *= k
			this.vel.z *= k
		}
		p.x += this.vel.x * dt
		p.z += this.vel.z * dt

		// 疾跑视场角动态变化（速度感）+ 爆发微震（FOV 脉冲）
		const targetFov = (this.sprinting ? FOV_SPRINT : 60)
			+ (this.fovKick > 0 ? Math.sin((1 - this.fovKick / BEAM_BURST_S) * Math.PI) * 3.5 : 0)
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
		// 西墙门洞（z 1.45–2.35）在开门状态下可穿行至门外门廊，其余情况夹在室内；
		// 南面开放：z>3 后进入室外坝坝（宽平台，x ±5.5、z 到南缘 8.6）
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
		} else if (p.z > 3.0) {
			const cx = THREE.MathUtils.clamp(p.x, -5.5, 5.5)
			if (cx !== p.x) {
				p.x = cx
				this.vel.x = 0
			}
		} else {
			const cx = THREE.MathUtils.clamp(p.x, inDoorGate ? PORCH_X_MIN : -3.5, 3.5)
			if (cx !== p.x) {
				p.x = cx
				this.vel.x = 0
			}
		}
		const cz = THREE.MathUtils.clamp(p.z, -2.5, 8.6)
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
			this.updateStabLerp(dt)
			// 格斗系统（本地剑动画 + 意图上报；伤害 / 眩晕 / 追击窗口由 PB 快照驱动）
			const active = this.lockCtl.isLocked
			this.combat.update(dt, time, this.camera, active)
			// 联机输入上报（10Hz）：位置 / 朝向 / 模式 / 动作标签
			if (pbClient.you && time - this.lastMpSent >= MP_INPUT_PERIOD) {
				this.lastMpSent = time
				this.sendMpInput()
			}
		} else {
			// 切出第一人称：中止戳刺镜头并恢复鼠标灵敏度
			if (this.stabLerp) {
				this.stabLerp = null
				this.lockCtl.pointerSpeed = 1
			}
			this.orbit.update()
		}

		// 远程玩家与僵尸插值渲染（固定视角下同样可见）
		this.remotePlayers.update(dt)
		this.updateWaves(dt)
		this.updateOrbs(dt)
		this.updateBurstBeams(dt)
		this.updateLocalBeam()
		// 持续激光循环音状态沿（弓蓄力期间开启）
		const wantBeamLoop = this.mode === 'walk' && this.combat.weaponId === 'bow' && this.combat.chargeStart >= 0
		if (wantBeamLoop !== this.beamLoopOn) {
			this.beamLoopOn = wantBeamLoop
			setBeamLoop(wantBeamLoop)
		}
		if (this.fovKick > 0) this.fovKick = Math.max(0, this.fovKick - dt)
		for (const z of this.zombies) z.update(dt, time)
		for (let i = this.zombies.length - 1; i >= 0; i--) {
			if (this.zombies[i].removeMe) {
				this.scene.remove(this.zombies[i].group)
				this.zombies.splice(i, 1)
			}
		}

		// 设备过渡动画与逐帧效果（补间、风口摆动、紧急红闪等）
		this.rigs.update(dt, time)
		this.renderer.render(this.scene, this.camera)
	}
}

/** 输入上报数值截断（3 位小数，减小包体） */
function r3(n: number): number {
	return Math.round(n * 1000) / 1000
}
