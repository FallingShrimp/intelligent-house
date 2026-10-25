/**
 * 第一人称近战格斗系统：Minecraft 钻石剑视模型 + 三段连击 + 格挡 / 反击
 *
 * - 左键连击（循环）：向左挥 90% → 向右挥 90% → 从上往下劈 150%，基础伤害 10
 * - 右键按住格挡：最长 1s，结束后冷却 0.5s
 *   · 前 30%（0.3s）= 完美格挡：玩家无伤，僵尸 −20 体力并踉跄
 *   · 后 70% = 不完美格挡：25% 概率失败受伤 10，成功则玩家 −10 体力
 * - 僵尸眩晕后 1s 内左键 → 反击戳刺 300%，随后可追击上劈 120% 最多 3 次
 *   （追击窗口 2s，超时关闭）
 * - 玩家体力耗尽 → 眩晕 3s（期间无法行动，硬吃伤害）；血量归零 → 原地重生
 * - 体力在停用 1.5s 后以 10/s 回复
 */
import * as THREE from 'three'
import { playSfx } from './audio'
import { buildSword } from './sword'
import type { Zombie, ZombieTelegraph } from './zombie'

export interface CombatHooks {
	onHud(): void
	onToast(text: string): void
	onFloat(text: string, sxPct: number, syPct: number, crit: boolean): void
	onFlash(kind: 'hurt' | 'parry'): void
	onRespawn(): void
}

export interface CombatHud {
	hp: number
	maxHp: number
	stamina: number
	maxStamina: number
	blocking: boolean
	blockAge01: number      // 当次格挡进度 0..1
	blockPerfect: boolean   // 处于完美窗口（前 30%）
	blockCd01: number       // 冷却进度 0..1（1 = 就绪）
	stunnedFor: number      // 剩余眩晕秒数
	chaseLeft: number       // 剩余追击次数
	incomingSkill: ZombieTelegraph // 僵尸技能预警（normal 金 / sweep 白 / lunge 紫）
	target: { hp: number; maxHp: number; stamina: number; maxStamina: number; vulnMul: number } | null
}

const BASE_DMG = 10
const MAX_HP = 100
const MAX_STAMINA = 100
const STAMINA_REGEN = 10          // 体力回复速率 /s
const STAMINA_REGEN_DELAY = 1.5   // 停用多久后开始回复
const BLOCK_MAX_S = 1.0
const BLOCK_PERFECT_S = 0.3
const BLOCK_CD_S = 0.5
const PLAYER_STUN_S = 3
const GUARD_BREAK_S = 0.55      // 横扫破防硬直（无法格挡/攻击）
const SWEEP_BLOCK_STAMINA = 15  // 横扫破防额外体力扣除
const ROAR_STAMINA = 25         // 嘶吼冲击波体力扣除
const SWEEP_TRACK_S = 8         // 连续格挡统计窗口
const COUNTER_WINDOW_S = 1.0      // 僵尸眩晕后反击窗口（与 zombie.ts 约定一致）
const CHASE_WINDOW_S = 2.0
const REACH = 3.0                 // 普攻命中距离
const REACH_ANGLE = 0.55          // 普攻命中半角 rad
const COUNTER_REACH = 3.4         // 反击距离（稍宽）

// ---------------- 剑术动作（关键帧：位置 / 欧拉角，首尾回到待机姿势） ----------------

const BASE_P: [number, number, number] = [0.36, -0.32, -0.62]
const BASE_R: [number, number, number] = [-0.5, -0.4, 0.18]
const BLOCK_P = new THREE.Vector3(0.06, -0.14, -0.52)
const BLOCK_R: [number, number, number] = [-0.35, -0.9, 1.35]

interface SwingKey {
	t: number
	p: [number, number, number]
	r: [number, number, number]
}
interface SwingDef {
	dur: number
	tickAt: number     // 伤害判定时刻（s）
	dmgMul: number
	keys: SwingKey[]
}

/** 向左挥（90%）：引至右侧 → 扫向左侧 */
const SWING_L: SwingDef = {
	dur: 0.34, tickAt: 0.15, dmgMul: 0.9,
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [0.56, -0.22, -0.55], r: [-0.55, -0.35, 0.95] },
		{ t: 0.75, p: [-0.18, -0.34, -0.66], r: [-0.45, -0.5, -1.15] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
/** 向右挥（90%）：镜像 */
const SWING_R: SwingDef = {
	dur: 0.34, tickAt: 0.15, dmgMul: 0.9,
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [-0.2, -0.3, -0.62], r: [-0.5, -0.45, -0.9] },
		{ t: 0.75, p: [0.6, -0.24, -0.55], r: [-0.55, -0.35, 1.05] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
/** 从上往下劈（150%）：高举过肩 → 劈落 */
const SWING_CHOP: SwingDef = {
	dur: 0.4, tickAt: 0.22, dmgMul: 1.5,
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.4, p: [0.3, 0.12, -0.5], r: [-1.7, -0.3, 0.1] },
		{ t: 0.8, p: [0.3, -0.55, -0.7], r: [0.6, -0.45, 0.2] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
const COMBO = [SWING_L, SWING_R, SWING_CHOP]

/** 反击戳刺（300%）：收剑 → 直刺（刃指前方） */
const SWING_THRUST: SwingDef = {
	dur: 0.36, tickAt: 0.2, dmgMul: 3.0,
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [0.5, -0.28, -0.25], r: [-1.1, -0.5, 0.1] },
		{ t: 0.7, p: [0.06, -0.12, -0.95], r: [-1.5, -0.15, 0] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
/** 追击上劈（120%）：更快版本的劈砍 */
const SWING_CHASE: SwingDef = {
	dur: 0.3, tickAt: 0.14, dmgMul: 1.2,
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [0.28, 0.1, -0.5], r: [-1.65, -0.3, 0.1] },
		{ t: 0.75, p: [0.3, -0.55, -0.72], r: [0.65, -0.45, 0.2] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}

interface Ghost {
	obj: THREE.Object3D
	mat: THREE.MeshBasicMaterial
	life: number
	ttl: number
}

export class PlayerCombat {
	hp = MAX_HP
	stamina = MAX_STAMINA
	blocking = false
	chaseLeft = 0

	private blockStart = 0
	private blockCdUntil = 0
	private guardBreakUntil = 0   // 横扫破防硬直截止
	private blockTimes: number[] = [] // 成功格挡时间戳（横扫预约统计）
	private stunnedUntil = 0
	private lastStaminaUse = -10
	private combo = -1            // 上一段连击索引（0/1/2 循环）
	private buffered: number | null = null
	private cur: SwingDef | null = null
	private curT = 0
	private tickDone = false
	private chaseUntil = 0
	private ghosts: Ghost[] = []
	private lastGhost = -1
	private hudEmit = 0
	private now = 0
	private sword: THREE.Group | null = null
	private disposed = false

	// 复用临时对象（每帧调用，避免 GC 抖动）
	private tmpV = new THREE.Vector3()
	private tmpF = new THREE.Vector3()
	private tmpD = new THREE.Vector3()

	private hooks: CombatHooks

	constructor(hooks: CombatHooks) {
		this.hooks = hooks
	}

	// ---------------- 视模型挂载 ----------------

	attach(camera: THREE.Camera) {
		this.sword = buildSword()
		this.sword.scale.setScalar(0.55)
		this.sword.position.set(...BASE_P)
		this.sword.rotation.set(...BASE_R)
		camera.add(this.sword)
	}

	setVisible(v: boolean) {
		if (this.sword) this.sword.visible = v
	}

	// ---------------- 输入 ----------------

	/**
	 * 左键：眩晕中吞掉点击；反击窗口 / 追击 / 三段连击优先，
	 * 无可命中目标时返回 false 交给场景交互（开门 / 电视 / 空调 / 喝水）。
	 */
	onLeftClick(now: number, zombies: Zombie[], camera: THREE.PerspectiveCamera): boolean {
		if (this.stunnedUntil > now) return true
		if (now < this.guardBreakUntil) return true // 破防硬直：无法攻击
		if (this.blocking) this.endBlock(now)

		// 反击：僵尸眩晕后 1s 窗口内
		const counterTarget = this.findCounterTarget(zombies, camera, now)
		if (counterTarget) {
			this.startSwing(SWING_THRUST, now)
			this.chaseLeft = 3
			this.chaseUntil = now + CHASE_WINDOW_S
			this.hooks.onToast('反击！')
			return true
		}

		// 追击：反击后的连打窗口
		if (this.chaseLeft > 0 && now <= this.chaseUntil && this.pickTarget(zombies, camera)) {
			this.startSwing(SWING_CHASE, now)
			this.chaseLeft--
			return true
		}

		const target = this.pickTarget(zombies, camera)
		if (!target && !this.cur) return false // 无目标 → 场景交互

		if (this.cur) {
			// 挥砍中点击 → 缓存下一段连击
			if (this.curT / this.cur.dur > 0.4) this.buffered = (this.combo + 1) % 3
			return true
		}
		this.combo = (this.combo + 1) % 3
		this.startSwing(COMBO[this.combo], now)
		return true
	}

	/** 无交互目标时的空挥（保持手感） */
	whiffSwing(now: number) {
		if (this.cur || this.stunnedUntil > now) return
		this.combo = (this.combo + 1) % 3
		this.startSwing(COMBO[this.combo], now)
	}

	startBlock(now: number): boolean {
		if (this.stunnedUntil > now || this.blocking || now < this.blockCdUntil) return false
		if (now < this.guardBreakUntil) return false // 破防硬直：无法格挡
		this.blocking = true
		this.blockStart = now
		this.emitHud(true)
		return true
	}

	endBlock(now: number) {
		if (!this.blocking) return
		this.blocking = false
		this.blockCdUntil = now + BLOCK_CD_S
		this.emitHud(true)
	}

	// ---------------- 僵尸攻击结算（SceneManager 回调） ----------------

	/**
	 * 僵尸普攻落手结算。
	 * 返回 true 表示 8s 内已成功格挡 2 次（SceneManager 应为该僵尸预约横扫）。
	 */
	resolveStrike(z: Zombie, now: number, camera: THREE.PerspectiveCamera): boolean {
		if (this.hp <= 0) return false
		if (this.stunnedUntil > now) {
			this.hurt(10, now) // 眩晕中硬吃
			return false
		}
		if (this.blocking) {
			const age = now - this.blockStart
			if (age <= BLOCK_PERFECT_S) {
				// 完美格挡：僵尸 -20 体力 + 踉跄（若本次格挡令僵尸体力耗尽则换音效）
				z.drainStamina(20)
				z.stagger(0.5)
				playSfx(z.stamina <= 0 ? 'swordParry' : 'perfectParry')
				this.hooks.onFlash('parry')
				this.hooks.onToast('完美格挡！僵尸 −20 体力')
				this.floatAtZombie(z, '−20 体力', true, camera)
				return this.registerBlockSuccess(now)
			} else if (Math.random() < 0.25) {
				playSfx('unexactParry')
				this.hurt(10, now)
				this.hooks.onToast('格挡失败！')
				return false
			} else {
				playSfx('unexactParry')
				this.useStamina(10, now)
				this.hooks.onToast('格挡成功（−10 体力）')
				return this.registerBlockSuccess(now)
			}
		} else {
			this.hurt(10, now)
			return false
		}
	}

	// ---------------- 僵尸技能结算（SceneManager 回调） ----------------

	/**
	 * 记录一次成功格挡（完美 / 不完美成功）。
	 * 8s 内累计 2 次 → 返回 true，SceneManager 据此为僵尸预约横扫。
	 */
	registerBlockSuccess(now: number): boolean {
		this.blockTimes.push(now)
		while (this.blockTimes.length > 0 && now - this.blockTimes[0] > SWEEP_TRACK_S) this.blockTimes.shift()
		return this.blockTimes.length >= 2
	}

	/** 横扫命中（无法格挡）：12 伤害；正在格挡则额外破防（-15 体力 + 硬直） */
	handleSweepHit(z: Zombie, now: number, camera: THREE.PerspectiveCamera) {
		const wasBlocking = this.blocking
		this.hurt(12, now)
		this.floatAtZombie(z, '−12', true, camera)
		if (wasBlocking) {
			this.blocking = false
			this.guardBreakUntil = now + GUARD_BREAK_S
			this.useStamina(SWEEP_BLOCK_STAMINA, now)
			this.hooks.onToast('横扫破防！格挡被击碎')
			playSfx('kick')
		}
	}

	/** 突进命中：14 伤害 + 击退 + 打断挥剑 / 格挡（击退由 SceneManager 施加） */
	handleLungeHit(z: Zombie, now: number, camera: THREE.PerspectiveCamera) {
		this.hurt(14, now)
		this.floatAtZombie(z, '−14', true, camera)
		this.interruptAction(now)
	}

	/** 嘶吼冲击波命中（不掉血）：-25 体力 + 减速由 SceneManager 施加 */
	handleRoarHit(z: Zombie, now: number, camera: THREE.PerspectiveCamera) {
		this.useStamina(ROAR_STAMINA, now)
		this.hooks.onFlash('hurt')
		this.hooks.onToast('被嘶吼震慑！−25 体力')
		this.floatAtZombie(z, '−25 体力', false, camera)
	}

	/** 打断当前动作（突进命中用）：取消挥剑与格挡 */
	interruptAction(now: number) {
		if (this.cur) {
			this.cur = null
			this.buffered = null
		}
		if (this.blocking) {
			this.blocking = false
			this.blockCdUntil = now + BLOCK_CD_S
		}
		this.emitHud(true)
	}

	// ---------------- 帧更新 ----------------

	update(dt: number, now: number, camera: THREE.PerspectiveCamera, zombies: Zombie[], active: boolean) {
		if (this.disposed) return
		this.now = now
		if (!active || !this.sword) return

		// 格挡最长持续时间
		if (this.blocking && now - this.blockStart >= BLOCK_MAX_S) this.endBlock(now)

		// 体力回复
		if (
			!this.blocking && this.stamina < MAX_STAMINA &&
			this.stunnedUntil < now && now - this.lastStaminaUse > STAMINA_REGEN_DELAY
		) {
			this.stamina = Math.min(MAX_STAMINA, this.stamina + STAMINA_REGEN * dt)
		}

		// 追击窗口过期
		if (this.chaseLeft > 0 && now > this.chaseUntil) this.chaseLeft = 0

		// 挥砍推进 + 伤害判定
		if (this.cur) {
			this.curT += dt
			if (!this.tickDone && this.curT >= this.cur.tickAt) {
				this.tickDone = true
				const target = this.pickTarget(zombies, camera)
				if (target) this.applyDamage(target, this.cur.dmgMul, camera)
			}
			if (this.curT >= this.cur.dur) {
				this.cur = null
				if (this.buffered !== null) {
					this.combo = this.buffered
					this.buffered = null
					this.startSwing(COMBO[this.combo], now)
				}
			}
		}

		this.updateGhosts(dt)
		this.updatePose(dt, now)

		if (now - this.hudEmit > 0.1) this.emitHud()
	}

	getHud(zombies: Zombie[], camera: THREE.PerspectiveCamera): CombatHud {
		const now = this.now
		const t = this.aimTarget(zombies, camera, 10, 0.4)
		const blockAge = this.blocking ? Math.min(1, (now - this.blockStart) / BLOCK_MAX_S) : 0
		const cd = now >= this.blockCdUntil ? 1 : 1 - (this.blockCdUntil - now) / BLOCK_CD_S
		return {
			hp: Math.round(this.hp),
			maxHp: MAX_HP,
			stamina: Math.round(this.stamina),
			maxStamina: MAX_STAMINA,
			blocking: this.blocking,
			blockAge01: blockAge,
			blockPerfect: this.blocking && now - this.blockStart <= BLOCK_PERFECT_S,
			blockCd01: Math.max(0, Math.min(1, cd)),
			stunnedFor: Math.max(0, this.stunnedUntil - now),
			chaseLeft: this.chaseLeft,
			incomingSkill: zombies.map((z) => z.telegraph).find(Boolean) ?? null,
			target: t
				? { hp: t.hp, maxHp: t.maxHp, stamina: t.stamina, maxStamina: t.maxStamina, vulnMul: t.vulnMul }
				: null,
		}
	}

	dispose() {
		this.disposed = true
		for (const g of this.ghosts) {
			g.obj.removeFromParent()
			g.mat.dispose()
		}
		this.ghosts = []
		if (this.sword) {
			this.sword.traverse((o) => {
				const m = o as THREE.Mesh
				if (m.isMesh) {
					m.geometry.dispose()
						; (m.material as THREE.Material).dispose()
				}
			})
			this.sword.removeFromParent()
			this.sword = null
		}
	}

	// ---------------- 私有：命中 / 伤害 ----------------

	/** 普攻目标：距离 + 视角夹角筛选最近者；跨西墙仅门洞范围可命中 */
	private pickTarget(zombies: Zombie[], camera: THREE.PerspectiveCamera): Zombie | null {
		return this.findTarget(zombies, camera, REACH, REACH_ANGLE, 0)
	}

	/** HUD 准星目标：更远的软锁定（只用于状态栏显示） */
	private aimTarget(zombies: Zombie[], camera: THREE.PerspectiveCamera, reach: number, angle: number): Zombie | null {
		return this.findTarget(zombies, camera, reach, angle, 0)
	}

	/** 反击目标：眩晕窗口内的最近僵尸 */
	private findCounterTarget(zombies: Zombie[], camera: THREE.PerspectiveCamera, now: number): Zombie | null {
		let best: Zombie | null = null
		let bestD = Infinity
		for (const z of zombies) {
			if (z.state !== 'stunned' || now - z.stunnedAt > COUNTER_WINDOW_S) continue
			const c = z.centerPos
			const d = c.distanceTo(camera.position)
			if (d > COUNTER_REACH) continue
			if (d < bestD) {
				bestD = d
				best = z
			}
		}
		return best
	}

	private findTarget(
		zombies: Zombie[],
		camera: THREE.PerspectiveCamera,
		reach: number,
		angle: number,
		_min: number,
	): Zombie | null {
		camera.getWorldDirection(this.tmpF)
		let best: Zombie | null = null
		let bestD = Infinity
		const cp = camera.position
		for (const z of zombies) {
			if (z.dead) continue
			const c = z.centerPos
			const d = c.distanceTo(cp)
			if (d > reach) continue
			// 隔西墙不命中：玩家与僵尸分居墙两侧时仅门洞范围（z 1.35–2.45）可命中
			if (cp.x > -3.5 !== c.x > -3.5 && (c.z < 1.35 || c.z > 2.45)) continue
			this.tmpD.copy(c).sub(cp).normalize()
			if (this.tmpD.angleTo(this.tmpF) > angle) continue
			if (d < bestD) {
				bestD = d
				best = z
			}
		}
		return best
	}

	private applyDamage(z: Zombie, mul: number, camera: THREE.PerspectiveCamera) {
		const dmg = Math.round(BASE_DMG * mul)
		z.takeDamage(dmg, camera.position)
		const crit = mul >= 1.2
		this.floatAtZombie(z, `−${dmg}`, crit, camera)
	}

	private floatAtZombie(z: Zombie, text: string, crit: boolean, camera: THREE.PerspectiveCamera) {
		const p = this.tmpV.copy(z.headPos).project(camera)
		if (p.z > 1) return // 在相机背后
		const sx = (p.x * 0.5 + 0.5) * 100
		const sy = (-p.y * 0.5 + 0.5) * 100
		this.hooks.onFloat(text, sx, sy, crit)
	}

	// ---------------- 私有：玩家状态 ----------------

	private hurt(n: number, now: number) {
		this.hp = Math.max(0, this.hp - n)
		playSfx('kick')
		this.hooks.onFlash('hurt')
		if (this.hp <= 0) {
			this.hp = MAX_HP
			this.stamina = MAX_STAMINA
			this.stunnedUntil = now + 1.2
			this.blocking = false
			this.hooks.onToast('你倒下了…已原地重生')
			this.hooks.onRespawn()
		}
		this.emitHud(true)
	}

	private useStamina(n: number, now: number) {
		this.stamina = Math.max(0, this.stamina - n)
		this.lastStaminaUse = now
		if (this.stamina <= 0) {
			this.stunnedUntil = now + PLAYER_STUN_S
			this.blocking = false
			this.hooks.onToast('体力耗尽，眩晕 3 秒！')
		}
		this.emitHud(true)
	}

	private startSwing(def: SwingDef, now: number) {
		this.cur = def
		this.curT = 0
		this.tickDone = false
		this.lastGhost = now
		// 音效：普通三段 / 反击 / 追击
		if (def === SWING_THRUST) playSfx('counter')
		else if (def === SWING_CHASE) playSfx('counter2')
		else playSfx('swing')
		this.emitHud(true)
	}

	private emitHud(force = false) {
		if (force) this.hudEmit = this.now
		this.hooks.onHud()
	}

	// ---------------- 私有：剑姿态与剑光 ----------------

	private updatePose(dt: number, now: number) {
		const sword = this.sword
		if (!sword) return
		if (this.cur) {
			const { p, r } = sampleSwing(this.cur, Math.min(1, this.curT / this.cur.dur))
			sword.position.set(p[0], p[1], p[2])
			sword.rotation.set(r[0], r[1], r[2])
			// 剑光残影
			const x = this.curT / this.cur.dur
			if (x > 0.25 && x < 0.9 && now - this.lastGhost > 0.035) {
				this.lastGhost = now
				this.spawnGhost()
			}
		} else if (this.blocking) {
			const k = Math.min(1, dt * 14)
			sword.position.lerp(BLOCK_P, k)
			sword.rotation.x += (BLOCK_R[0] - sword.rotation.x) * k
			sword.rotation.y += (BLOCK_R[1] - sword.rotation.y) * k
			sword.rotation.z += (BLOCK_R[2] - sword.rotation.z) * k
		} else {
			// 待机呼吸浮动（平滑回归，避免动作结束后跳变）
			const bob = Math.sin(now * 2.2) * 0.009
			const k = Math.min(1, dt * 10)
			this.tmpV.set(BASE_P[0], BASE_P[1] + bob, BASE_P[2])
			sword.position.lerp(this.tmpV, k)
			sword.rotation.x += (BASE_R[0] + Math.sin(now * 1.7) * 0.015 - sword.rotation.x) * k
			sword.rotation.y += (BASE_R[1] - sword.rotation.y) * k
			sword.rotation.z += (BASE_R[2] - sword.rotation.z) * k
		}
	}

	private spawnGhost() {
		const sword = this.sword
		if (!sword) return
		const g = sword.clone(true)
		const mat = new THREE.MeshBasicMaterial({
			color: 0x5ff7e0,
			transparent: true,
			opacity: 0.38,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		})
		g.traverse((o) => {
			const m = o as THREE.Mesh
			if (m.isMesh) {
				m.material = mat
				m.castShadow = false
			}
		})
		sword.parent?.add(g)
		this.ghosts.push({ obj: g, mat, life: 0.16, ttl: 0.16 })
	}

	private updateGhosts(dt: number) {
		for (let i = this.ghosts.length - 1; i >= 0; i--) {
			const g = this.ghosts[i]
			g.life -= dt
			if (g.life <= 0) {
				g.obj.removeFromParent()
				g.mat.dispose()
				this.ghosts.splice(i, 1)
			} else {
				g.mat.opacity = 0.38 * (g.life / g.ttl)
			}
		}
	}
}

// ---------------- 关键帧采样 ----------------

const sampleP: [number, number, number] = [0, 0, 0]
const sampleR: [number, number, number] = [0, 0, 0]
function sampleSwing(def: SwingDef, x: number): { p: [number, number, number]; r: [number, number, number] } {
	const keys = def.keys
	let i = 0
	while (i < keys.length - 2 && x > keys[i + 1].t) i++
	const a = keys[i]
	const b = keys[i + 1]
	const u = Math.max(0, Math.min(1, (x - a.t) / (b.t - a.t || 1)))
	const s = u * u * (3 - 2 * u) // smoothstep
	for (let j = 0; j < 3; j++) {
		sampleP[j] = a.p[j] + (b.p[j] - a.p[j]) * s
		sampleR[j] = a.r[j] + (b.r[j] - a.r[j]) * s
	}
	return { p: sampleP, r: sampleR }
}
