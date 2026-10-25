/**
 * 联机对战权威世界模拟（PB 为唯一事实源）
 *
 * 玩家：uuid 标识，DisplayName + 连接时随机分配的颜色；进入第一人称（mode=fp）
 * 即加入房间，退出第一人称或断开即离开房间。玩家间有友伤，格挡 / 体力机制
 * 与打僵尸完全一致（三段连击 9/9/15、完美格挡 0.3s 窗口、不完美 25% 失败）。
 *
 * 僵尸：全部玩家共享同一批僵尸（任意房间内玩家点击室内台灯触发，每次召唤
 * 1 只，上限 3 只）。AI 状态机自 PF 移植：enter → chase → windup(1.0s 前摇) → strike
 * → recover；体力耗尽眩晕 5s（易伤 1.15~1.85 眩晕瞬间掷定）；技能横扫 /
 * 突进 / 嘶吼触发条件与单机版一致。眩晕后 1s 内任一玩家攻击 → 反击 300% 并
 * 开启全局追击窗口（120% × 3 次，2s）。
 *
 * 时间基准：世界内部统一使用 epoch 秒（Date.now()/1000），tick 由 index.ts 驱动。
 */

// ---------------- 常量（与 PF 单机版对齐） ----------------

const Z_MAX_HP = 300
const Z_MAX_ST = 100
const Z_CHASE_SPEED = 0.95
const Z_ENTER_SPEED = 1.0
const Z_ATTACK_RANGE = 1.7
const Z_STRIKE_RANGE = 2.15
const Z_WINDUP_S = 1.0        // PB 无音频时长信息，固定 1.0s 前摇
const Z_RECOVER_S = 1.1
const Z_STUN_S = 5.0
const Z_ATTACK_COST = 10
const SWEEP_COST = 15
const SWEEP_CD = 8
const SWEEP_RANGE = 2.2
const LUNGE_COST = 20
const LUNGE_CD = 10
const LUNGE_MIN = 2.5
const LUNGE_MAX = 5.0
const LUNGE_SPEED = 8.0
const LUNGE_HIT_R = 1.2
const LUNGE_TIMEOUT = 1.2
const ROAR_CD = 25
const ROAR_MAX_USES = 2
const ROAR_HEAL = 30
const ROAR_RADIUS = 3.0
const COUNTER_WINDOW_S = 1.0
const CHASE_WINDOW_S = 2.0
const COMBO_MUL = [0.9, 0.9, 1.5]  // 三段倍率（伤害 = atk × 倍率 × 伤害增益）
const P_MAX_HP = 100
const P_MAX_ST = 100
const P_STUN_S = 3
const P_REGEN = 10
const P_REGEN_DELAY = 1.5
const BLOCK_MAX_S = 1.0
const BLOCK_CD_S = 0.5
const GUARD_BREAK_S = 0.55
const SWEEP_BLOCK_STAMINA = 15
const ROAR_STAMINA = 25
const SWEEP_TRACK_S = 8
const REACH = 3.0
const REACH_ANGLE = 0.55
const COUNTER_REACH = 3.4
const ATTACK_MIN_INTERVAL = 0.3 // 服务端攻击最小间隔（防刷）
const MAX_ZOMBIES = 3
const ZOMBIE_TTL_DEAD = 2.0
const ZOMBIE_SPAWN = { x: -4.55, z: 1.9 }

// 重击剑气（远程弹道）
const WAVE_DMG = 30         // 基础 30（= 3×atk 基准，随攻击力与伤害增益缩放）
const WAVE_SPEED = 12     // m/s
const WAVE_TTL_S = 1.2    // 飞行寿命（约 14m 射程）
const WAVE_RADIUS = 0.9   // 命中判定半径

export type ZState =
	| 'enter' | 'chase' | 'windup' | 'recover' | 'stunned' | 'dead'
	| 'sweep' | 'lungeWind' | 'lungeDash' | 'roar'

export interface MpPlayer {
	uuid: string
	name: string
	color: string
	wsId: string
	x: number; y: number; z: number
	yaw: number
	dirX: number; dirZ: number
	mode: 'fp' | 'free'
	anim: string | null
	hp: number
	stamina: number
	stunUntil: number
	guardBreakUntil: number
	blocking: boolean
	blockStart: number
	blockCdUntil: number
	lastStaminaUse: number
	lastAttack: number
	combo: number
	kills: number
	/** 击杀增益（三选一累积） */
	atk: number          // 剑基础伤害（初始 10）
	maxHp: number        // 血量上限（初始 100）
	parryPct: number     // 完美格挡窗口 = 格挡最大时长 × 该比例（初始 0.5）
	maxSt: number        // 体力上限（初始 100）
	blockMaxS: number    // 格挡最大持续（初始 1.0s）
	dmgMul: number       // 全局伤害倍率（初始 1）
	chargeSpd: number    // 重击蓄力速度倍率（蓄力时长 = 1 / chargeSpd，初始 1）
	/** 三选一选择状态（进行中时非空）：随机 3 个选项索引 + 已选 */
	pick: { options: number[]; choice: number | null } | null
	/** 下落攻击判定：由 10Hz 位置差分推导的垂直速度 m/s */
	vy: number
	lastY: number
	lastInputAt: number
	blockTimes: number[]
}

export interface MpZombie {
	id: number
	x: number; y: number; z: number
	yaw: number
	hp: number
	stamina: number
	state: ZState
	stT: number          // 当前状态已持续秒数
	windupDur: number    // 前摇总时长（windup/sweep/lungeWind/roar）
	vulnMul: number
	stunStart: number
	deadAt: number
	target: boolean      // 快照用：是否有追击目标
	// 内部
	requestSweep: boolean
	sweepCdUntil: number
	lungeCdUntil: number
	roarCdUntil: number
	roarUses: number
	recExtra: number
	dashToX: number; dashToZ: number
	dashT: number
	lungeHits: Set<string>
	parryTimes: number[]
}

export type MpEvent =
	| { kind: 'join'; uuid: string; name: string; color: string }
	| { kind: 'leave'; uuid: string; name: string }
	| { kind: 'dmg_z'; id: number; amount: number; crit: boolean; by: string }
	| { kind: 'dmg_p'; uuid: string; amount: number; by: string; interrupt: boolean }
	| { kind: 'parry'; uuid: string; perfect: boolean; fail: boolean; drain: number; byZombie: boolean }
	| { kind: 'zstun'; id: number; mul: number }
	| { kind: 'zdie'; id: number }
	| { kind: 'knockback'; uuid: string; dx: number; dz: number; speed: number }
	| { kind: 'slow'; uuid: string; dur: number }
	| { kind: 'guardbreak'; uuid: string; dur: number }
	| { kind: 'respawn'; uuid: string; pos: [number, number, number] }
	| { kind: 'counter_open' }
	| { kind: 'roar_interrupt'; id: number }
	| { kind: 'wave'; by: string; x: number; y: number; z: number; dx: number; dz: number }

export interface WorldSnapshot {
	t: number
	chase_left: number
	pick_phase: boolean
	players: {
		uuid: string; name: string; color: string
		p: [number, number, number]; yaw: number
		fp: boolean
		hp: number; st: number
		max_hp: number; max_st: number; atk: number; dmg_mul: number
		stun_for: number
		blocking: boolean
		anim: string | null
		kills: number
		max_block: number; parry_pct: number; charge_dur: number
		pick: { options: number[]; done: boolean } | null
	}[]
	zombies: {
		id: number
		p: [number, number, number]; yaw: number
		hp: number; st: number
		state: ZState; st_t: number; windup_dur: number
		vuln: number
		target: boolean
	}[]
}

export class World {
	players = new Map<string, MpPlayer>()   // key = uuid
	zombies: MpZombie[] = []
	/** 飞行中的重击剑气（PB 权威弹道，命中裁决 30 伤害） */
	waves: { owner: string; x: number; y: number; z: number; dx: number; dz: number; t: number; reg: number; hits: string[] }[] = []
	chaseLeft = 0
	chaseUntil = 0
	private events: MpEvent[] = []
	private byWs = new Map<string, string>() // wsId → uuid
	private zSeq = 0

	// ---------------- 玩家生命周期 ----------------

	join(wsId: string, name: string): { uuid: string; color: string } {
		// 同一连接重复 hello：先清理旧身份
		this.leave(wsId)
		const uuid = crypto.randomUUID()
		const color = this.pickColor()
		const p: MpPlayer = {
			uuid, name, color, wsId,
			x: -1.6, y: 1.6, z: 2.4,
			yaw: 0, dirX: 0, dirZ: -1,
			mode: 'free', anim: null,
			hp: P_MAX_HP, stamina: P_MAX_ST,
			stunUntil: 0, guardBreakUntil: 0,
			blocking: false, blockStart: 0, blockCdUntil: 0,
			lastStaminaUse: -10, lastAttack: 0, combo: -1,
			kills: 0,
			atk: 10, maxHp: P_MAX_HP, parryPct: 0.5, maxSt: P_MAX_ST,
			blockMaxS: 1.0, dmgMul: 1, chargeSpd: 1,
			pick: null,
			vy: 0, lastY: 1.6, lastInputAt: 0,
			blockTimes: [],
		}
		this.players.set(uuid, p)
		this.byWs.set(wsId, uuid)
		this.events.push({ kind: 'join', uuid, name, color })
		return { uuid, color }
	}

	leave(wsId: string): void {
		const uuid = this.byWs.get(wsId)
		if (!uuid) return
		this.byWs.delete(wsId)
		const p = this.players.get(uuid)
		if (!p) return
		this.players.delete(uuid)
		this.events.push({ kind: 'leave', uuid, name: p.name })
	}

	setInput(uuid: string, d: {
		p: [number, number, number]; yaw: number; dir: [number, number]
		mode: 'fp' | 'free'; anim?: string | null
	}): void {
		const p = this.players.get(uuid)
		if (!p) return
		// 垂直速度差分（下落攻击判定）：输入间隔 20ms~1s 才可信
		const nowIn = this.now()
		if (p.lastInputAt > 0) {
			const dt = (nowIn - p.lastInputAt) / 1000
			if (dt >= 0.02 && dt <= 1) {
				p.vy = Math.max(-20, Math.min(20, (d.p[1] - p.lastY) / dt))
			}
		}
		p.lastY = d.p[1]
		p.lastInputAt = nowIn
		p.x = d.p[0]; p.y = d.p[1]; p.z = d.p[2]
		p.yaw = d.yaw
		p.dirX = d.dir[0]; p.dirZ = d.dir[1]
		p.mode = d.mode
		p.anim = d.anim ?? null
	}

	action(uuid: string, d: { kind: 'attack' | 'parry_start' | 'parry_stop' | 'respawn' | 'wave' | 'pick' | 'revive' | 'lamp'; segment?: number; hold?: number; idx?: number; target?: string }): void {
		const p = this.players.get(uuid)
		if (!p) return
		const now = this.now()
		if (d.kind === 'respawn') {
			this.requestRespawn(p, now)
			return
		}
		// 三选一暂停：战斗动作全部拒绝（等待全员选择）
		if (this.pickPhase) return
		// 死亡玩家除复活请求外的一切动作均无效
		if (p.hp <= 0) return
		// 台灯召唤僵尸：房间内（fp）存活玩家每次点击召唤 1 只（上限内）
		if (d.kind === 'lamp') {
			if (p.mode === 'fp') this.maybeSpawnZombie()
			return
		}
		if (d.kind === 'parry_start') {
			if (p.stunUntil > now || p.blocking || now < p.blockCdUntil || now < p.guardBreakUntil) return
			p.blocking = true
			p.blockStart = now
			return
		}
		if (d.kind === 'parry_stop') {
			if (!p.blocking) return
			p.blocking = false
			p.blockCdUntil = now + BLOCK_CD_S
			return
		}
		if (d.kind === 'wave') {
			this.fireWave(p, now, d.hold)
			return
		}
		this.playerAttack(p, d.segment ?? 0, now)
	}

	// ---------------- 重击剑气（远程弹道，PB 权威裁决） ----------------

	/** 区域：0 门廊（四面是墙） / 1 室内 / 2 南侧坝坝（与室内开放连通） */
	private region(x: number, z: number): number {
		if (x < -3.5) return 0
		return z > 3.0 ? 2 : 1
	}

	private fireWave(p: MpPlayer, now: number, hold?: number): void {
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		// 方向取最近上报的视线前向；无输入时退化为 yaw 推导
		let dx = p.dirX
		let dz = p.dirZ
		const len = Math.hypot(dx, dz)
		if (len < 0.01) {
			dx = Math.sin(p.yaw)
			dz = -Math.cos(p.yaw)
		} else {
			dx /= len
			dz /= len
		}
		const x = p.x + dx * 0.5
		const z = p.z + dz * 0.5
		this.waves.push({ owner: p.uuid, x, y: 1.3, z, dx, dz, t: 0, reg: this.region(x, z), hits: [] })
		this.events.push({ kind: 'wave', by: p.uuid, x, y: 1.3, z, dx, dz })
		// 蓄力消耗：每秒 10 体力（发射时一次结算，随 hold 上限保护）
		this.useStamina(p, 10 * Math.min(5, hold ?? 1), now)
	}

	private tickWaves(dt: number, now: number): void {
		for (let i = this.waves.length - 1; i >= 0; i--) {
			const w = this.waves[i]
			w.t += dt
			w.x += w.dx * WAVE_SPEED * dt
			w.z += w.dz * WAVE_SPEED * dt
			const reg = this.region(w.x, w.z)
			// 撞墙：跨入/跨出门廊（四面墙）；室内 ↔ 坝坝开放连通不拦
			if (reg !== w.reg) {
				if (reg === 0 || w.reg === 0) {
					this.waves.splice(i, 1)
					continue
				}
				w.reg = reg
			}
			const by = this.players.get(w.owner)
			if (!by) {
				this.waves.splice(i, 1)
				continue
			}
			// 命中：半径内所有未命中过的存活目标（僵尸优先，无限穿透，同一目标只结算一次）
			const candidates: { key: string; z: MpZombie | null; p: MpPlayer | null; d: number }[] = []
			for (const z of this.zombies) {
				if (z.state === 'dead') continue
				const key = `z${z.id}`
				if (w.hits.includes(key)) continue
				candidates.push({ key, z, p: null, d: Math.hypot(z.x - w.x, z.z - w.z) })
			}
			for (const o of this.players.values()) {
				if (o.uuid === w.owner || o.mode !== 'fp' || o.hp <= 0) continue
				if (w.hits.includes(o.uuid)) continue
				candidates.push({ key: o.uuid, z: null, p: o, d: Math.hypot(o.x - w.x, o.z - w.z) })
			}
			candidates.sort((a, b) => a.d - b.d)
			for (const c of candidates) {
				if (c.d >= WAVE_RADIUS) break
				w.hits.push(c.key)
				if (c.z) this.damageZombie(c.z, WAVE_DMG * by.atk / 10 * by.dmgMul, by, now)
				else if (c.p) this.damagePlayer(c.p, WAVE_DMG * by.atk / 10 * by.dmgMul, by, now, false, true)
			}
			if (w.t > WAVE_TTL_S) this.waves.splice(i, 1)
		}
	}

	// ---------------- 玩家攻击裁决 ----------------

	private playerAttack(p: MpPlayer, segment: number, now: number): void {
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		if (now - p.lastAttack < ATTACK_MIN_INTERVAL) return
		p.lastAttack = now

		// 目标选择：僵尸优先逻辑与单机一致——按距离取最近（僵尸与玩家同池）
		const tgt = this.findMeleeTarget(p)
		if (!tgt) return // 空挥

		// 下落攻击：垂直速度 < -2 m/s（跳劈 / 俯冲）时伤害 ×200%
		const airMul = p.vy < -2 ? 2 : 1

		// 反击：僵尸眩晕窗口内
		if (tgt.zombie && tgt.zombie.state === 'stunned' &&
			now - tgt.zombie.stunStart <= COUNTER_WINDOW_S && tgt.dist <= COUNTER_REACH) {
			this.damageZombie(tgt.zombie, p.atk * 3 * p.dmgMul * airMul, p, now)
			this.chaseLeft = 3
			this.chaseUntil = now + CHASE_WINDOW_S
			this.events.push({ kind: 'counter_open' })
			return
		}
		// 追击：全局追击窗口
		if (this.chaseLeft > 0 && now <= this.chaseUntil) {
			this.chaseLeft--
			if (tgt.zombie) this.damageZombie(tgt.zombie, p.atk * 1.2 * p.dmgMul * airMul, p, now)
			else this.damagePlayer(tgt.player!, p.atk * 1.2 * p.dmgMul * airMul, p, now, false)
			return
		}
		const segMul = COMBO_MUL[((segment % 3) + 3) % 3]
		const dmg = p.atk * segMul * p.dmgMul * airMul
		if (tgt.zombie) this.damageZombie(tgt.zombie, dmg, p, now)
		else this.damagePlayer(tgt.player!, dmg, p, now, false)
	}

	private findMeleeTarget(p: MpPlayer): { zombie: MpZombie | null; player: MpPlayer | null; dist: number } | null {
		let bestZ: MpZombie | null = null
		let bestZd = Infinity
		for (const z of this.zombies) {
			if (z.state === 'dead') continue
			const c = { x: z.x, y: 1.05, z: z.z }
			const r = this.meleeCheck(p, c)
			if (r.ok && r.dist < bestZd) { bestZd = r.dist; bestZ = z }
		}
		let bestP: MpPlayer | null = null
		let bestPd = Infinity
		for (const o of this.players.values()) {
			if (o.uuid === p.uuid || o.mode !== 'fp') continue
			const c = { x: o.x, y: 1.0, z: o.z }
			const r = this.meleeCheck(p, c)
			if (r.ok && r.dist < bestPd) { bestPd = r.dist; bestP = o }
		}
		if (bestZ && bestZd <= bestPd) return { zombie: bestZ, player: null, dist: bestZd }
		if (bestP) return { zombie: null, player: bestP, dist: bestPd }
		return null
	}

	/** 距离 + 视角半角 + 隔墙判定（与单机 findTarget 一致） */
	private meleeCheck(p: MpPlayer, c: { x: number; y: number; z: number }): { ok: boolean; dist: number } {
		const dx = c.x - p.x
		const dy = c.y - p.y
		const dz = c.z - p.z
		const dist = Math.hypot(dx, dz)
		if (dist > REACH) return { ok: false, dist }
		if (p.x > -3.5 !== c.x > -3.5 && (c.z < 1.35 || c.z > 2.45)) return { ok: false, dist }
		const len = Math.hypot(dx, dz) || 1
		const dot = (dx / len) * p.dirX + (dz / len) * p.dirZ
		if (dot < Math.cos(REACH_ANGLE)) return { ok: false, dist }
		if (Math.abs(dy) > 2.2) return { ok: false, dist }
		return { ok: true, dist }
	}

	// ---------------- 伤害结算 ----------------

	private damageZombie(z: MpZombie, amount: number, by: MpPlayer, _now: number): void {
		if (z.state === 'dead') return
		// 嘶吼前摇中受到 ≥15 伤害 → 打断
		if (z.state === 'roar' && amount >= 15) {
			z.state = 'recover'
			z.stT = 0
			z.recExtra = 0.55
			this.events.push({ kind: 'roar_interrupt', id: z.id })
		}
		const dmg = z.vulnMul > 0 ? Math.round(amount * z.vulnMul) : amount
		z.hp = Math.max(0, z.hp - dmg)
		// 受击小击退
		const dx = z.x - by.x
		const dz = z.z - by.z
		const d = Math.hypot(dx, dz) || 1
		z.x += (dx / d) * 0.12
		z.z += (dz / d) * 0.12
		this.events.push({ kind: 'dmg_z', id: z.id, amount: dmg, crit: amount >= 12, by: by.uuid })
		if (z.hp <= 0) {
			z.state = 'dead'
			z.deadAt = this.now()
			by.kills++
			this.events.push({ kind: 'zdie', id: z.id })
			this.startPickPhase()
		}
	}

	// ---------------- 击杀三选一（全员选完才恢复） ----------------

	/** 增益选项定义（索引即协议值） */
	static readonly PICK_OPTIONS = [
		'攻击力 +5', '血量上限 +20', '完美格挡窗口 +2%',
		'体力上限 +10', '格挡最大持续 +0.25s', '所有伤害 +10%', '重击蓄力速度 +15%',
	]

	/** 僵尸被击败：房间内所有第一人称玩家进入三选一（每人独立随机抽 3 项） */
	private startPickPhase(): void {
		const inRoom = [...this.players.values()].filter((q) => q.mode === 'fp')
		if (!inRoom.length) return
		const pool = [0, 1, 2, 3, 4, 5, 6]
		for (const p of inRoom) {
			const shuffled = [...pool].sort(() => Math.random() - 0.5)
			p.pick = { options: shuffled.slice(0, 3), choice: null }
		}
	}

	/** 全员是否已选完 */
	private pickDone(): boolean {
		for (const p of this.players.values()) {
			if (p.mode === 'fp' && p.pick && p.pick.choice === null) return false
		}
		return true
	}

	/** 应用增益并结束选择阶段 */
	private applyPicks(): void {
		for (const p of this.players.values()) {
			const pick = p.pick
			if (!pick || pick.choice === null) continue
			const oldMaxHp = p.maxHp
			const oldMaxSt = p.maxSt
			switch (pick.choice) {
				case 0: p.atk += 5; break
				case 1:
					p.maxHp += 20
					p.hp = Math.round((p.hp / oldMaxHp) * p.maxHp) // 血量百分比不变
					break
				case 2: p.parryPct = Math.min(1, p.parryPct + 0.02); break
				case 3:
					p.maxSt += 10
					p.stamina = Math.round((p.stamina / oldMaxSt) * p.maxSt)
					break
				case 4: p.blockMaxS += 0.25; break
				case 5: p.dmgMul = Math.round((p.dmgMul + 0.1) * 100) / 100; break
				case 6: p.chargeSpd = Math.round((p.chargeSpd + 0.15) * 100) / 100; break
			}
			p.pick = null
		}
	}

	/** 是否处于三选一暂停阶段 */
	get pickPhase(): boolean {
		for (const p of this.players.values()) {
			if (p.mode === 'fp' && p.pick) return true
		}
		return false
	}

	/** 三选一选择（PF 上报选项索引） */
	pickChoose(uuid: string, idx: number): void {
		const p = this.players.get(uuid)
		if (!p?.pick || p.pick.choice !== null) return
		if (!p.pick.options.includes(idx)) return
		p.pick.choice = idx
		if (this.pickDone()) this.applyPicks()
	}

	/**
	 * 队友复活：存活玩家点击尸体（距离 ≤3m）。三选一暂停期间不可用。
	 * 返回错误信息（null = 成功）。
	 */
	reviveBy(byUuid: string, targetUuid: string): string | null {
		if (this.pickPhase) return '选择增益后才能复活队友'
		const by = this.players.get(byUuid)
		const t = this.players.get(targetUuid)
		if (!by || !t) return '目标不存在'
		if (by.mode !== 'fp' || by.hp <= 0) return '你当前无法复活他人'
		if (t.mode !== 'fp' || t.hp > 0) return '目标不是尸体'
		if (Math.hypot(t.x - by.x, t.z - by.z) > 3) return '距离尸体太远'
		const now = this.now()
		t.hp = t.maxHp
		t.stamina = t.maxSt
		t.blocking = false
		t.blockStart = 0
		t.combo = -1
		t.stunUntil = now + 1.2 // 复活保护
		this.events.push({ kind: 'respawn', uuid: t.uuid, pos: [t.x, t.y, t.z] })
		return null
	}

	/** 对玩家造成伤害：格挡评估 → 扣血 → 死亡重生（PVP 与僵尸攻击共用） */
	private damagePlayer(v: MpPlayer, amount: number, by: MpPlayer | null, now: number, fromZombie: boolean, isWave = false): void {
		if (v.hp <= 0) return
		if (v.stunUntil > now) {
			if (isWave) this.useStamina(v, 10, now) // 被剑气命中扣体力
			this.hurtPlayer(v, amount, now, false, by)
			return
		}
		if (v.blocking) {
			const age = now - v.blockStart
			if (age <= v.blockMaxS * v.parryPct) {
				// 完美格挡：攻击者 -20 体力（玩家攻击者进入 0.5s 硬直），格挡者无伤
				if (!fromZombie && by) {
					this.useStamina(by, 20, now)
					by.guardBreakUntil = now + 0.5
					this.events.push({ kind: 'guardbreak', uuid: by.uuid, dur: 0.5 })
				}
				// 完美格挡剑气：格挡者恢复 30 血量（上限 100）
				if (isWave) v.hp = Math.min(v.maxHp, v.hp + 30)
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: true, fail: false, drain: 20, byZombie: fromZombie })
				this.registerBlock(v, now)
				return
			}
			if (Math.random() < 0.25) {
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: true, drain: 0, byZombie: fromZombie })
				if (isWave) this.useStamina(v, 10, now) // 被剑气命中扣体力
				this.hurtPlayer(v, amount, now, false, by)
				return
			}
			this.useStamina(v, 10, now)
			this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: false, drain: 10, byZombie: fromZombie })
			this.registerBlock(v, now)
			return
		}
		if (isWave) this.useStamina(v, 10, now) // 被剑气命中扣体力
		this.hurtPlayer(v, amount, now, false, by)
	}

	/** 僵尸攻击玩家（含完美格挡对僵尸的反噬：-20 体力 + 踉跄） */
	private damagePlayerByZombie(z: MpZombie, v: MpPlayer, amount: number, now: number): void {
		if (v.hp <= 0) return
		if (v.stunUntil > now) {
			this.hurtPlayer(v, amount, now, false, null)
			return
		}
		if (v.blocking) {
			const age = now - v.blockStart
			if (age <= v.blockMaxS * v.parryPct) {
				z.stamina = Math.max(0, z.stamina - 20)
				const drained = z.stamina <= 0
				if (z.state === 'recover') z.recExtra += 0.5 // 踉跄：延长后摇
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: true, fail: false, drain: 20, byZombie: true })
				if (drained) this.zombieStun(z, now)
				this.registerBlock(v, now)
				return
			}
			if (Math.random() < 0.25) {
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: true, drain: 0, byZombie: true })
				this.hurtPlayer(v, amount, now, false, null)
				return
			}
			this.useStamina(v, 10, now)
			this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: false, drain: 10, byZombie: true })
			this.registerBlock(v, now)
			return
		}
		this.hurtPlayer(v, amount, now, false, null)
	}

	private hurtPlayer(v: MpPlayer, amount: number, now: number, _interrupt: boolean, _by: MpPlayer | null): void {
		v.hp = Math.max(0, v.hp - amount)
		this.events.push({ kind: 'dmg_p', uuid: v.uuid, amount, by: _by?.uuid ?? '', interrupt: false })
		if (v.hp <= 0) {
			// 死亡：保持死亡状态等待玩家手动复活（PF 死亡覆盖层 → mp_action respawn）
			v.stunUntil = 0
			v.blocking = false
			v.blockStart = 0
		}
	}

	/** 复活请求裁决：房间内无存活僵尸 / 其他玩家全部死亡 / 房间内只有自己，满足其一才可复活 */
	private requestRespawn(p: MpPlayer, now: number): void {
		if (p.hp > 0) return
		const inRoom = [...this.players.values()].filter((q) => q.mode === 'fp')
		const zombiesAlive = this.zombies.some((z) => z.state !== 'dead')
		const aliveOthers = inRoom.filter((q) => q.uuid !== p.uuid && q.hp > 0).length
		if (inRoom.length > 1 && zombiesAlive && aliveOthers > 0) return
		p.hp = p.maxHp
		p.stamina = p.maxSt
		p.stunUntil = now + 1.2
		p.blocking = false
		p.blockStart = 0
		p.combo = -1
		p.x = -1.6; p.y = 1.6; p.z = 2.4 // 手动复活回出生点（pos 下发供 PF 相机复位）
		this.events.push({ kind: 'respawn', uuid: p.uuid, pos: [p.x, p.y, p.z] })
	}

	private useStamina(p: MpPlayer, n: number, now: number): void {
		p.stamina = Math.max(0, p.stamina - n)
		p.lastStaminaUse = now
		if (p.stamina <= 0) {
			p.stunUntil = now + P_STUN_S
			p.blocking = false
		}
	}

	/** 记录成功格挡（8s 内 2 次 → 为攻击来源僵尸预约横扫） */
	private registerBlock(v: MpPlayer, now: number): void {
		v.blockTimes.push(now)
		while (v.blockTimes.length > 0 && now - v.blockTimes[0] > SWEEP_TRACK_S) v.blockTimes.shift()
		if (v.blockTimes.length >= 2) {
			// 预约距离最近的活僵尸
			let best: MpZombie | null = null
			let bd = Infinity
			for (const z of this.zombies) {
				if (z.state === 'dead') continue
				const d = Math.hypot(z.x - v.x, z.z - v.z)
				if (d < bd) { bd = d; best = z }
			}
			if (best) best.requestSweep = true
			v.blockTimes = []
		}
	}

	// ---------------- 僵尸 AI（自 PF 单机版移植，PB 权威） ----------------

	private maybeSpawnZombie(): void {
		const alive = this.zombies.filter((z) => z.state !== 'dead').length
		if (alive >= MAX_ZOMBIES) return
		this.zombies.push({
			id: ++this.zSeq,
			x: ZOMBIE_SPAWN.x, y: 0, z: ZOMBIE_SPAWN.z,
			yaw: Math.PI / 2,
			hp: Z_MAX_HP, stamina: Z_MAX_ST,
			state: 'enter', stT: 0, windupDur: Z_WINDUP_S,
			vulnMul: 0, stunStart: 0, deadAt: 0, target: false,
			requestSweep: false,
			sweepCdUntil: 0, lungeCdUntil: 0, roarCdUntil: 0, roarUses: 0,
			recExtra: 0, dashToX: 0, dashToZ: 0, dashT: 0,
			lungeHits: new Set(), parryTimes: [],
		})
	}

	private zombieStun(z: MpZombie, now: number): void {
		z.state = 'stunned'
		z.stT = 0
		z.stunStart = now
		z.vulnMul = Math.round((1.15 + Math.random() * 0.7) * 100) / 100
		this.events.push({ kind: 'zstun', id: z.id, mul: z.vulnMul })
	}

	private spendZ(z: MpZombie, n: number, now: number): boolean {
		z.stamina = Math.max(0, z.stamina - n)
		if (z.stamina <= 0) {
			this.zombieStun(z, now)
			return true
		}
		return false
	}

	private nearestPlayer(z: MpZombie): MpPlayer | null {
		let best: MpPlayer | null = null
		let bd = Infinity
		for (const p of this.players.values()) {
			if (p.mode !== 'fp' || p.hp <= 0) continue
			const d = Math.hypot(p.x - z.x, p.z - z.z)
			if (d < bd) { bd = d; best = p }
		}
		return best
	}

	private tickZombie(z: MpZombie, dt: number, now: number): void {
		if (z.state === 'dead') return
		z.stT += dt

		if (z.state === 'stunned') {
			if (z.stT >= Z_STUN_S) {
				z.stamina = Z_MAX_ST
				z.vulnMul = 0
				z.state = 'chase'
				z.stT = 0
			}
			return
		}

		const p = this.nearestPlayer(z)
		z.target = p !== null
		const dx = p ? p.x - z.x : 0
		const dz = p ? p.z - z.z : 0
		const dist = Math.hypot(dx, dz)

		// 嘶吼触发（chase / windup / recover 中，濒临眩晕保命）
		if (
			(z.state === 'chase' || z.state === 'windup' || z.state === 'recover') &&
			z.stamina < 35 && z.roarUses < ROAR_MAX_USES && now >= z.roarCdUntil
		) {
			z.state = 'roar'
			z.stT = 0
			z.windupDur = 0.8
		}

		switch (z.state) {
			case 'enter': {
				this.zMove(z, -2.6, 1.9, dt, Z_ENTER_SPEED)
				if (z.x >= -3.05) { z.state = 'chase'; z.stT = 0 }
				break
			}
			case 'chase': {
				if (!p) break
				if (z.requestSweep && dist <= SWEEP_RANGE && now >= z.sweepCdUntil) {
					z.requestSweep = false
					z.state = 'sweep'
					z.stT = 0
					z.windupDur = 1.2
					break
				}
				if (
					dist >= LUNGE_MIN && dist <= LUNGE_MAX && now >= z.lungeCdUntil &&
					Math.random() < 1 - Math.exp(-1.6 * dt)
				) {
					z.state = 'lungeWind'
					z.stT = 0
					z.windupDur = 0.6
					break
				}
				if (dist <= Z_ATTACK_RANGE) {
					z.state = 'windup'
					z.stT = 0
					z.windupDur = Z_WINDUP_S
				} else if (dist > 1.15) {
					this.zMove(z, p.x, p.z, dt, Z_CHASE_SPEED)
				} else {
					this.zFace(z, dx, dz, dt)
				}
				break
			}
			case 'windup': {
				if (p) this.zFace(z, dx, dz, dt)
				if (z.stT >= z.windupDur) {
					// 落手：对当前最近玩家结算
					const v = this.nearestPlayer(z)
					if (v && Math.hypot(v.x - z.x, v.z - z.z) <= Z_STRIKE_RANGE && Math.abs(v.y - 1.0) < 2.2) {
						this.damagePlayerByZombie(z, v, 10, now)
					}
					if (!this.spendZ(z, Z_ATTACK_COST, now)) {
						z.state = 'recover'; z.stT = 0; z.recExtra = 0
					}
				}
				break
			}
			case 'sweep': {
				if (p) this.zFace(z, dx, dz, dt)
				if (z.stT >= z.windupDur) {
					// 180° 扇形：所有房间内玩家
					let diff = p ? Math.abs(Math.atan2(dx, dz) - z.yaw) : 0
					if (p) { while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2) }
					for (const v of this.players.values()) {
						if (v.mode !== 'fp' || v.hp <= 0) continue
						const vd = Math.hypot(v.x - z.x, v.z - v.z)
						const vdx = v.x - z.x
						const vdz = v.z - z.z
						let va = Math.abs(Math.atan2(vdx, vdz) - z.yaw)
						while (va > Math.PI) va = Math.abs(va - Math.PI * 2)
						if (va <= Math.PI / 2 + 0.15 && vd <= SWEEP_RANGE && v.y - 1.0 < 1.8) {
							const wasBlocking = v.blocking
							this.hurtPlayer(v, 12, now, false, null)
							if (wasBlocking) {
								v.blocking = false
								v.guardBreakUntil = now + GUARD_BREAK_S
								this.useStamina(v, SWEEP_BLOCK_STAMINA, now)
								this.events.push({ kind: 'guardbreak', uuid: v.uuid, dur: GUARD_BREAK_S })
							}
						}
					}
					if (!this.spendZ(z, SWEEP_COST, now)) {
						z.sweepCdUntil = now + SWEEP_CD
						z.state = 'recover'; z.stT = 0; z.recExtra = 0
					}
				}
				break
			}
			case 'lungeWind': {
				if (p) this.zFace(z, dx, dz, dt)
				if (z.stT >= z.windupDur) {
					z.dashToX = p ? p.x : z.x
					z.dashToZ = p ? p.z : z.z
					z.dashT = 0
					z.lungeHits = new Set()
					z.state = 'lungeDash'
					z.stT = 0
				}
				break
			}
			case 'lungeDash': {
				z.dashT += dt
				const rdx = z.dashToX - z.x
				const rdz = z.dashToZ - z.z
				const remain = Math.hypot(rdx, rdz)
				const step = Math.min(LUNGE_SPEED * dt, remain)
				if (remain > 1e-3) {
					z.x += (rdx / remain) * step
					z.z += (rdz / remain) * step
				}
				let hit = false
				for (const v of this.players.values()) {
					if (v.mode !== 'fp' || v.hp <= 0 || z.lungeHits.has(v.uuid)) continue
					if (Math.hypot(v.x - z.x, v.z - z.z) <= LUNGE_HIT_R && Math.abs(v.y - 1.0) < 2.2) {
						z.lungeHits.add(v.uuid)
						hit = true
						const vd = Math.hypot(v.x - z.x, v.z - z.z) || 1
						this.hurtPlayer(v, 14, now, true, null)
						this.events.push({ kind: 'knockback', uuid: v.uuid, dx: (v.x - z.x) / vd, dz: (v.z - z.z) / vd, speed: 6.5 })
						if (v.blocking) {
							v.blocking = false
							v.blockCdUntil = now + BLOCK_CD_S
						}
					}
				}
				if (hit || remain <= 0.05 || z.dashT >= LUNGE_TIMEOUT) {
					if (!this.spendZ(z, LUNGE_COST, now)) {
						z.lungeCdUntil = now + LUNGE_CD
						z.state = 'recover'; z.stT = 0; z.recExtra = hit ? 0 : 0.55
					}
				}
				break
			}
			case 'roar': {
				if (p) this.zFace(z, dx, dz, dt)
				if (z.stT >= z.windupDur) {
					for (const v of this.players.values()) {
						if (v.mode !== 'fp' || v.hp <= 0) continue
						if (Math.hypot(v.x - z.x, v.z - z.z) <= ROAR_RADIUS) {
							this.useStamina(v, ROAR_STAMINA, now)
							this.events.push({ kind: 'slow', uuid: v.uuid, dur: 1.0 })
						}
					}
					z.stamina = Math.min(Z_MAX_ST, z.stamina + ROAR_HEAL)
					z.roarUses++
					z.roarCdUntil = now + ROAR_CD
					z.state = 'recover'; z.stT = 0; z.recExtra = 0
				}
				break
			}
			case 'recover': {
				if (z.stT >= Z_RECOVER_S + z.recExtra) {
					z.recExtra = 0
					z.state = 'chase'
					z.stT = 0
				}
				break
			}
		}

		// 同伴分离
		for (const o of this.zombies) {
			if (o === z || o.state === 'dead') continue
			const ddx = z.x - o.x
			const ddz = z.z - o.z
			const dd = Math.hypot(ddx, ddz)
			if (dd > 1e-3 && dd < 0.7) {
				z.x += (ddx / dd) * dt * 0.6
				z.z += (ddz / dd) * dt * 0.6
			}
		}
		this.zClamp(z)
	}

	private zMove(z: MpZombie, tx: number, tz: number, dt: number, speed: number): void {
		const dx = tx - z.x
		const dz = tz - z.z
		const d = Math.hypot(dx, dz)
		if (d < 0.05) return
		const step = Math.min(speed * dt, d)
		z.x += (dx / d) * step
		z.z += (dz / d) * step
		this.zFace(z, dx, dz, dt)
	}

	private zFace(z: MpZombie, dx: number, dz: number, dt: number): void {
		const target = Math.atan2(dx, dz)
		let diff = target - z.yaw
		while (diff > Math.PI) diff -= Math.PI * 2
		while (diff < -Math.PI) diff += Math.PI * 2
		z.yaw += diff * Math.min(1, dt * 8)
	}

	private zClamp(z: MpZombie): void {
		if (z.x < -3.5) {
			z.z = Math.min(2.5, Math.max(1.3, z.z))
			z.x = Math.max(z.x, -5.45)
		} else if (z.z > 3.0) {
			// 南侧坝坝（室外测试平台）：可追出，限平台范围
			z.x = Math.min(5.4, Math.max(-5.4, z.x))
			z.z = Math.min(8.6, z.z)
		} else {
			z.x = Math.min(3.4, Math.max(-3.4, z.x))
			z.z = Math.min(2.9, Math.max(-2.6, z.z))
		}
	}

	// ---------------- 主循环 ----------------

	/** 房间内没有任何存活的玩家（全灭或无人）→ 清除所有僵尸 */
	private clearZombiesIfEmpty(): void {
		for (const p of this.players.values()) {
			if (p.mode === 'fp' && p.hp > 0) return
		}
		if (this.zombies.length) this.zombies.length = 0
	}

	now(): number {
		return Date.now() / 1000
	}

	tick(dt: number): void {
		const now = this.now()
		// 三选一暂停：冻结全部模拟（僵尸 AI / 体力 / 剑气 / 清场），等待全员选择
		if (this.pickPhase) return
		// 空场清理：房间内没有第一人称玩家时清除所有僵尸
		this.clearZombiesIfEmpty()
		// 玩家体力回复
		for (const p of this.players.values()) {
			if (
				!p.blocking && p.stamina < p.maxSt &&
				p.stunUntil < now && now - p.lastStaminaUse > P_REGEN_DELAY
			) {
				p.stamina = Math.min(p.maxSt, p.stamina + P_REGEN * dt)
			}
		}
		// 僵尸 AI
		for (const z of this.zombies) this.tickZombie(z, dt, now)
		// 尸体清理
		this.zombies = this.zombies.filter((z) => !(z.state === 'dead' && now - z.deadAt > ZOMBIE_TTL_DEAD))
		// 重击剑气弹道
		this.tickWaves(dt, now)
		// 全局追击窗口过期
		if (this.chaseLeft > 0 && now > this.chaseUntil) this.chaseLeft = 0
	}

	drainEvents(): MpEvent[] {
		const out = this.events
		this.events = []
		return out
	}

	snapshot(): WorldSnapshot {
		const now = this.now()
		return {
			t: Date.now(),
			chase_left: this.chaseLeft,
			pick_phase: this.pickPhase,
			players: [...this.players.values()].map((p) => ({
				uuid: p.uuid, name: p.name, color: p.color,
				p: [round2(p.x), round2(p.y), round2(p.z)],
				yaw: round2(p.yaw),
				fp: p.mode === 'fp',
				hp: Math.round(p.hp), st: Math.round(p.stamina),
				max_hp: p.maxHp, max_st: p.maxSt, atk: p.atk, dmg_mul: p.dmgMul,
				stun_for: Math.max(0, round2(p.stunUntil - now)),
				blocking: p.blocking,
				anim: p.anim,
				kills: p.kills,
				max_block: p.blockMaxS, parry_pct: p.parryPct, charge_dur: round2(1 / p.chargeSpd),
				pick: p.pick ? { options: p.pick.options, done: p.pick.choice !== null } : null,
			})),
			zombies: this.zombies.map((z) => ({
				id: z.id,
				p: [round2(z.x), round2(z.y), round2(z.z)],
				yaw: round2(z.yaw),
				hp: Math.round(z.hp), st: Math.round(z.stamina),
				state: z.state, st_t: round2(z.stT), windup_dur: z.windupDur,
				vuln: z.vulnMul,
				target: z.target,
			})),
		}
	}

	private pickColor(): string {
		// 随机色相，避开与现有玩家过近的色相（最小间隔 40°）
		const used = [...this.players.values()].map((p) => hslHue(p.color))
		for (let i = 0; i < 24; i++) {
			const h = Math.floor(Math.random() * 360)
			if (used.every((u) => u === null || Math.min(Math.abs(u - h), 360 - Math.abs(u - h)) >= 40)) {
				return `hsl(${h}, 75%, 55%)`
			}
		}
		return `hsl(${Math.floor(Math.random() * 360)}, 75%, 55%)`
	}
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}

function hslHue(color: string): number | null {
	const m = /hsl\((\d+)/.exec(color)
	return m ? Number(m[1]) : null
}
