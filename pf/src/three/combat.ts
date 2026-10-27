/**
 * 第一人称近战格斗（联机版）：PB 权威裁决 + PF 本地表现
 *
 * - AI / 伤害 / 体力 / 眩晕全部由 PB world.ts 结算；PF 只做：
 *   1) 本地剑视模型动画与手感（点击立即起挥）
 *   2) 动作意图上报（mp_action：attack / parry_start / parry_stop）
 *   3) PB 下发的 hp / 体力 / 眩晕 / 追击窗口渲染（HUD）
 *   4) 伤害 / 格挡事件 → 飘字 / 音效 / 闪光（SceneManager 分发）
 * - 三段连击循环：向左挥 90% → 向右挥 90% → 从上往下劈 150%（基础 10）
 * - 反击戳刺 300% / 追击上劈 120% 的判定在 PB；PF 依据本地可见状态
 *   （僵尸眩晕窗口 / chase_left）选择对应的本地动画
 */
import * as THREE from 'three'
import { pbClient } from '../ws/client'
import type { NetPlayerState, NetZombieState } from '../protocol/messages'
import { playSfx } from './audio'
import { buildSword } from './sword'
import type { NetZombie } from './zombie'

/** 飘字类型（对应 PB DamageSign） */
export type FloatKind = 'normal' | 'crit' | 'heal' | 'blocked'

export interface CombatHooks {
	onHud(): void
	onToast(text: string): void
	onFloat(text: string, sxPct: number, syPct: number, kind: FloatKind): void
	onFlash(kind: 'hurt' | 'parry'): void
	/** 空中戳刺：镜头 slerp 转向目标（dir = 指向目标的单位向量） */
	onStabAim(dir: THREE.Vector3): void
}

export interface RemoteCenter {
	uuid: string
	x: number
	y: number
	z: number
}

export interface CombatHud {
	hp: number
	maxHp: number
	stamina: number
	maxStamina: number
	blocking: boolean
	blockAge01: number
	blockPerfect: boolean
	blockCd01: number
	stunnedFor: number
	chaseLeft: number
	incomingSkill: 'normal' | 'sweep' | 'lunge' | null
	/** 重击蓄力进度 0~1（未蓄力为 null；UI 准星扇环） */
	charge: number | null
	target: { hp: number; maxHp: number; stamina: number; maxStamina: number; vulnMul: number } | null
}

const BLOCK_CD_S = 0.5
const REACH = 3.0
const REACH_ANGLE = 0.55
const COUNTER_REACH = 3.4

// ---------------- 剑术动作关键帧（与单机版一致） ----------------

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
	tickAt: number
	tag: string
	keys: SwingKey[]
}

const SWING_L: SwingDef = {
	dur: 0.34, tickAt: 0.15, tag: 'swing0',
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [0.56, -0.22, -0.55], r: [-0.55, -0.35, 0.95] },
		{ t: 0.75, p: [-0.18, -0.34, -0.66], r: [-0.45, -0.5, -1.15] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
const SWING_R: SwingDef = {
	dur: 0.34, tickAt: 0.15, tag: 'swing1',
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [-0.2, -0.3, -0.62], r: [-0.5, -0.45, -0.9] },
		{ t: 0.75, p: [0.6, -0.24, -0.55], r: [-0.55, -0.35, 1.05] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
const SWING_CHOP: SwingDef = {
	dur: 0.4, tickAt: 0.22, tag: 'swing2',
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.4, p: [0.3, 0.12, -0.5], r: [-1.7, -0.3, 0.1] },
		{ t: 0.8, p: [0.3, -0.55, -0.7], r: [0.6, -0.45, 0.2] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
const COMBO = [SWING_L, SWING_R, SWING_CHOP]

const SWING_THRUST: SwingDef = {
	dur: 0.36, tickAt: 0.2, tag: 'counter',
	keys: [
		{ t: 0, p: BASE_P, r: BASE_R },
		{ t: 0.35, p: [0.5, -0.28, -0.25], r: [-1.1, -0.5, 0.1] },
		{ t: 0.7, p: [0.06, -0.12, -0.95], r: [-1.5, -0.15, 0] },
		{ t: 1, p: BASE_P, r: BASE_R },
	],
}
const SWING_CHASE: SwingDef = {
	dur: 0.3, tickAt: 0.14, tag: 'chase',
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

interface FloatReq {
	pos: THREE.Vector3
	text: string
	kind: FloatKind
}

export class PlayerCombat {
	// PB 权威数值（world 快照写入；上限/时长类随三选一增益经 setNet 更新）
	hp = 100
	maxHp = 100         // 血量上限（增益「血量上限 +20」累积）
	stamina = 100
	maxSt = 100         // 体力上限（增益「体力上限 +10」累积）
	stunFor = 0          // 剩余眩晕秒
	chaseLeft = 0        // 全局追击剩余次数
	blocking = false
	blockMaxS = 1.0      // 格挡最大持续 s（增益 +0.25s）
	parryPct = 0.5       // 完美格挡窗口 = blockMaxS × parryPct（增益 +2%）
	chargeDur = 1.0      // 重击蓄力时长 s（蓄力速度增益 → 时长缩短）

	private stunUntilLocal = 0  // loop 秒钟基准的眩晕截止（快照 stun_for 折算）
	private guardBreakUntil = 0
	private blockStart = 0
	private blockCdUntil = 0
	private combo = -1
	private buffered: number | null = null
	private cur: SwingDef | null = null
	private curT = 0
	private ghosts: Ghost[] = []
	private lastGhost = -1
	private hudEmit = 0
	private now = 0
	private sword: THREE.Group | null = null
	private chargeStart = -1   // >=0 表示蓄力重击中（按住左键）
	private chargeNotified = false // 蓄满提示音已播
	private stabPitch: number | null = null // 空中戳刺俯仰（anim 上报 stab|<pitch>）
	private disposed = false
	private floats: FloatReq[] = []

	private tmpV = new THREE.Vector3()
	private tmpF = new THREE.Vector3()
	private tmpD = new THREE.Vector3()

	private hooks: CombatHooks

	constructor(hooks: CombatHooks) {
		this.hooks = hooks
	}

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

	// ---------------- PB 快照 / 事件入口 ----------------

	/** world 快照：写入本玩家权威数值（stun_for 为剩余秒；上限 / 窗口 / 蓄力随增益更新） */
	setNet(mine: NetPlayerState, chaseLeft: number) {
		this.hp = mine.hp
		this.stamina = mine.st
		this.stunFor = mine.stun_for
		if (mine.stun_for > 0) this.stunUntilLocal = this.now + mine.stun_for
		this.chaseLeft = chaseLeft
		this.maxHp = mine.max_hp
		this.maxSt = mine.max_st
		this.blockMaxS = mine.max_block
		this.parryPct = mine.parry_pct
		this.chargeDur = mine.charge_dur
		// 死亡（hp=0）：强制结束本地格挡，等待玩家点击「复活」
		if (mine.hp <= 0 && this.blocking) {
			this.blocking = false
			this.blockCdUntil = this.now + BLOCK_CD_S
		}
		this.emitHud(true)
	}

	/** 是否死亡（PB 快照 hp=0；等待玩家在死亡覆盖层点击复活） */
	get dead(): boolean {
		return this.hp <= 0
	}

	/** 嘶吼 / 横扫破防等事件：强制结束格挡并硬直 */
	applyGuardBreak(dur: number) {
		this.blocking = false
		this.guardBreakUntil = this.now + dur
		this.emitHud(true)
	}

	/** 突进命中等：打断当前挥剑与格挡 */
	interruptAction() {
		if (this.cur) {
			this.cur = null
			this.buffered = null
			this.stabPitch = null
		}
		if (this.blocking) {
			this.blocking = false
			this.blockCdUntil = this.now + BLOCK_CD_S
		}
		this.emitHud(true)
	}

	/** 世界坐标飘字请求（dmg_z / dmg_p 事件），update 中投影到屏幕 */
	pushFloat(pos: THREE.Vector3, text: string, kind: FloatKind = 'normal') {
		this.floats.push({ pos: pos.clone(), text, kind })
	}

	// ---------------- 输入（本地动画 + 意图上报） ----------------

	/**
	 * 左键：眩晕 / 破防中吞掉点击；反击 / 追击 / 空中戳刺 / 三段连击按本地可见状态
	 * 选择动画并上报 attack 意图（伤害由 PB 裁决）。无目标返回 false 交给场景交互。
	 */
	onLeftClick(now: number, zombies: NetZombie[], remotes: RemoteCenter[], camera: THREE.PerspectiveCamera, onGround: boolean): boolean {
		if (this.hp <= 0) return true // 死亡：吞掉点击（复活经死亡覆盖层按钮）
		if (this.stunUntilLocal > now) return true
		if (now < this.guardBreakUntil) return true
		if (this.blocking) this.endBlock(now)

		// 反击：僵尸眩晕后 1s 窗口内（PB 同规则裁决）
		const counterTarget = zombies.find(
			(z) => z.state === 'stunned' && z.centerPos.distanceTo(camera.position) <= COUNTER_REACH,
		)
		if (counterTarget) {
			this.startSwing(SWING_THRUST, now)
			pbClient.sendMpAction({ kind: 'attack', segment: 0 })
			this.hooks.onToast('反击！')
			return true
		}

		// 追击：反击后的全局连打窗口
		if (this.chaseLeft > 0 && this.findTarget(zombies, remotes, camera)) {
			this.startSwing(SWING_CHASE, now)
			pbClient.sendMpAction({ kind: 'attack', segment: 0 })
			return true
		}

		// 空中戳刺：滞空左键 → 3.4m 内最近目标，复用戳刺动画 + 镜头转向目标
		if (!onGround && !this.cur) {
			const stab = this.findStabTarget(zombies, remotes, camera)
			if (stab) {
				this.startSwing(SWING_THRUST, now)
				// segment 3 = 空中戳刺标识（PB：伤害同首段，冲击力 25）
				pbClient.sendMpAction({ kind: 'attack', segment: 3 })
				this.stabPitch = Math.asin(THREE.MathUtils.clamp(stab.dir.y, -1, 1))
				this.hooks.onStabAim(stab.dir)
				return true
			}
			// 无目标：落到下方普通挥砍逻辑
		}

		const hasTarget = this.findTarget(zombies, remotes, camera) !== null
		if (!hasTarget && !this.cur) return false // 无目标 → 场景交互

		if (this.cur) {
			if (this.curT / this.cur.dur > 0.4) this.buffered = (this.combo + 1) % 3
			return true
		}
		this.combo = (this.combo + 1) % 3
		this.startSwing(COMBO[this.combo], now)
		pbClient.sendMpAction({ kind: 'attack', segment: this.combo })
		return true
	}

	/** 空中戳刺目标：僵尸 + 远程玩家中心，取最近且 ≤3.4m（返回指向目标的单位向量） */
	private findStabTarget(zombies: NetZombie[], remotes: RemoteCenter[], camera: THREE.PerspectiveCamera): { dir: THREE.Vector3 } | null {
		let best: THREE.Vector3 | null = null
		let bd = COUNTER_REACH
		for (const z of zombies) {
			if (z.dead) continue
			const d = this.tmpD.copy(z.centerPos).sub(camera.position)
			if (d.length() < bd) { bd = d.length(); best = d.clone() }
		}
		for (const r of remotes) {
			const d = this.tmpD.set(r.x, r.y, r.z).sub(camera.position)
			if (d.length() < bd) { bd = d.length(); best = d.clone() }
		}
		return best ? { dir: best.normalize() } : null
	}

	/** 无交互目标时的空挥（保持手感，同样上报意图） */
	whiffSwing(now: number) {
		if (this.cur || this.stunUntilLocal > now) return
		this.combo = (this.combo + 1) % 3
		this.startSwing(COMBO[this.combo], now)
		pbClient.sendMpAction({ kind: 'attack', segment: this.combo })
	}

	startBlock(now: number): boolean {
		if (this.hp <= 0) return false
		if (this.stunUntilLocal > now || this.blocking || now < this.blockCdUntil) return false
		if (now < this.guardBreakUntil) return false
		this.blocking = true
		this.blockStart = now
		pbClient.sendMpAction({ kind: 'parry_start' })
		this.emitHud(true)
		return true
	}

	endBlock(now: number) {
		if (!this.blocking) return
		this.blocking = false
		this.blockCdUntil = now + BLOCK_CD_S
		pbClient.sendMpAction({ kind: 'parry_stop' })
		this.emitHud(true)
	}

	/** 当前动作标签（mp_input.anim，供远程玩家渲染简单动作；空中戳刺带俯仰 stab|<pitch>） */
	currentAnimTag(): string | null {
		if (this.cur) return this.stabPitch !== null ? `stab|${this.stabPitch.toFixed(2)}` : this.cur.tag
		if (this.chargeStart >= 0) return 'charge'
		if (this.blocking) return 'block'
		return null
	}

	// ---------------- 重击蓄力 ----------------

	/** 是否可行动（未死亡 / 未眩晕 / 未破防） */
	canAct(now: number): boolean {
		return this.hp > 0 && this.stunUntilLocal <= now && now >= this.guardBreakUntil
	}

	/** 按下左键：开始蓄力（成功后 SceneManager 冻结移动） */
	beginCharge(now: number): boolean {
		if (!this.canAct(now) || this.blocking) return false
		this.chargeStart = now
		this.chargeNotified = false
		return true
	}

	/** 已蓄力时长 s（未蓄力返回 0） */
	chargeHold(now: number): number {
		return this.chargeStart < 0 ? 0 : now - this.chargeStart
	}

	/** 取消蓄力（松开未满 / 拖拽 / 状态打断） */
	endCharge(): void {
		this.chargeStart = -1
	}

	/** 蓄满释放：上劈动画 + 发射剑气意图（未蓄满返回 false；hold 供 PB 结算蓄力体力消耗） */
	fireWave(now: number): boolean {
		if (this.chargeStart < 0 || now - this.chargeStart < this.chargeDur) {
			this.chargeStart = -1
			return false
		}
		const hold = now - this.chargeStart
		this.chargeStart = -1
		this.combo = -1 // 剑气不算三段连击
		this.startSwing(SWING_CHASE, now)
		pbClient.sendMpAction({ kind: 'wave', hold: Math.round(hold * 10) / 10 })
		return true
	}

	// ---------------- 帧更新 ----------------

	update(dt: number, now: number, camera: THREE.PerspectiveCamera, active: boolean) {
		if (this.disposed) return
		this.now = now
		if (!active || !this.sword) return

		// 格挡最长持续时间
		if (this.blocking && now - this.blockStart >= this.blockMaxS) this.endBlock(now)
		// 蓄力中状态失效（死亡 / 眩晕 / 破防）→ 自动取消
		if (this.chargeStart >= 0 && !this.canAct(now)) this.chargeStart = -1
		// 蓄满瞬间提示音（每次蓄力只播一次）
		if (this.chargeStart >= 0 && !this.chargeNotified && now - this.chargeStart >= this.chargeDur) {
			this.chargeNotified = true
			playSfx('flashAlert')
		}

		// 挥砍推进（伤害判定在 PB，这里只推进动画与缓存连段）
		if (this.cur) {
			this.curT += dt
			if (this.curT >= this.cur.dur) {
				this.cur = null
				this.stabPitch = null
				if (this.buffered !== null) {
					this.combo = this.buffered
					this.buffered = null
					this.startSwing(COMBO[this.combo], now, true)
					pbClient.sendMpAction({ kind: 'attack', segment: this.combo })
				}
			}
		}

		// 飘字投影
		for (const f of this.floats) {
			const p = this.tmpV.copy(f.pos).project(camera)
			if (p.z > 1) continue
			const sx = (p.x * 0.5 + 0.5) * 100
			const sy = (-p.y * 0.5 + 0.5) * 100
			this.hooks.onFloat(f.text, sx, sy, f.kind)
		}
		this.floats.length = 0

		this.updateGhosts(dt)
		this.updatePose(dt, now)

		// 蓄力重击姿态：剑举过头顶微微发抖（覆盖待机 / 格挡姿态）
		if (this.chargeStart >= 0 && !this.cur && this.sword) {
			const shake = Math.sin(now * 24) * 0.012
			this.sword.position.set(BASE_P[0] + shake, BASE_P[1] + 0.34, BASE_P[2] - 0.08)
			this.sword.rotation.set(BASE_R[0] - 2.3 + shake * 2, BASE_R[1], BASE_R[2] + 0.15)
		}

		if (now - this.hudEmit > 0.1) this.emitHud()
	}

	getHud(zombies: NetZombie[], camera: THREE.PerspectiveCamera): CombatHud {
		const now = this.now
		const t = this.aimTarget(zombies, camera)
		const blockAge = this.blocking ? Math.min(1, (now - this.blockStart) / this.blockMaxS) : 0
		const cd = now >= this.blockCdUntil ? 1 : 1 - (this.blockCdUntil - now) / BLOCK_CD_S
		const incoming = zombies.find((z) => !z.dead && (z.state === 'windup' || z.state === 'sweep' || z.state === 'lungeWind'))
		return {
			hp: Math.round(this.hp),
			maxHp: Math.round(this.maxHp),
			stamina: Math.round(this.stamina),
			maxStamina: Math.round(this.maxSt),
			blocking: this.blocking,
			blockAge01: blockAge,
			blockPerfect: this.blocking && now - this.blockStart <= this.blockMaxS * this.parryPct,
			blockCd01: Math.max(0, Math.min(1, cd)),
			stunnedFor: Math.max(0, this.stunUntilLocal - now),
			chaseLeft: this.chaseLeft,
			charge: this.chargeStart >= 0 ? Math.min(1, (now - this.chargeStart) / this.chargeDur) : null,
			incomingSkill: incoming
				? incoming.state === 'sweep' ? 'sweep' : incoming.state === 'lungeWind' ? 'lunge' : 'normal'
				: null,
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

	// ---------------- 私有 ----------------

	/** 普攻目标（本地预判，PB 同规则裁决）：僵尸 + 远程玩家同池取最近 */
	private findTarget(zombies: NetZombie[], remotes: RemoteCenter[], camera: THREE.PerspectiveCamera): RemoteCenter | null {
		const pool: RemoteCenter[] = zombies.filter((z) => !z.dead).map((z) => {
			const c = z.centerPos
			return { uuid: `z${z.id}`, x: c.x, y: c.y, z: c.z }
		})
		pool.push(...remotes)
		camera.getWorldDirection(this.tmpF)
		let best: RemoteCenter | null = null
		let bestD = Infinity
		const cp = camera.position
		for (const c of pool) {
			const d = Math.hypot(c.x - cp.x, c.y - cp.y, c.z - cp.z)
			if (d > REACH) continue
			if (cp.x > -3.5 !== c.x > -3.5 && (c.z < 1.35 || c.z > 2.45)) continue
			this.tmpD.set(c.x - cp.x, c.y - cp.y, c.z - cp.z).normalize()
			if (this.tmpD.angleTo(this.tmpF) > REACH_ANGLE) continue
			if (d < bestD) {
				bestD = d
				best = c
			}
		}
		return best
	}

	/** HUD 准星软锁定目标（仅僵尸状态栏） */
	private aimTarget(zombies: NetZombie[], camera: THREE.PerspectiveCamera): NetZombie | null {
		camera.getWorldDirection(this.tmpF)
		let best: NetZombie | null = null
		let bestD = Infinity
		const cp = camera.position
		for (const z of zombies) {
			if (z.dead) continue
			const c = z.centerPos
			const d = c.distanceTo(cp)
			if (d > 10) continue
			this.tmpD.copy(c).sub(cp).normalize()
			if (this.tmpD.angleTo(this.tmpF) > 0.4) continue
			if (d < bestD) {
				bestD = d
				best = z
			}
		}
		return best
	}

	private startSwing(def: SwingDef, now: number, silent = false) {
		this.cur = def
		this.curT = 0
		this.lastGhost = now
		if (!silent) {
			if (def === SWING_THRUST) playSfx('counter')
			else if (def === SWING_CHASE) playSfx('counter2')
			else playSfx('swing')
		}
		this.emitHud(true)
	}

	private emitHud(force = false) {
		if (force) this.hudEmit = this.now
		this.hooks.onHud()
	}

	private updatePose(dt: number, now: number) {
		const sword = this.sword
		if (!sword) return
		if (this.cur) {
			const { p, r } = sampleSwing(this.cur, Math.min(1, this.curT / this.cur.dur))
			sword.position.set(p[0], p[1], p[2])
			sword.rotation.set(r[0], r[1], r[2])
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
	const s = u * u * (3 - 2 * u)
	for (let j = 0; j < 3; j++) {
		sampleP[j] = a.p[j] + (b.p[j] - a.p[j]) * s
		sampleR[j] = a.r[j] + (b.r[j] - a.r[j]) * s
	}
	return { p: sampleP, r: sampleR }
}

/** NetZombieState 未直接引用，保留类型依赖（快照状态经 NetZombie 传递） */
export type { NetZombieState }
