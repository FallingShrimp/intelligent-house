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

/** 僵尸血量：100 + 25×等级（台灯召唤为 0 级，死亡后补员等级 +1） */
const Z_BASE_HP = 100
const Z_HP_PER_LEVEL = 25
/** 僵尸伤害成长：所有攻击伤害 +0.25×等级 */
const Z_DMG_PER_LEVEL = 0.25
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
const MAX_ZOMBIES = 3
const ZOMBIE_TTL_DEAD = 2.0
const ZOMBIE_SPAWN = { x: -4.55, z: 1.9 }

/** 增益卡牌标签池（初始抽取权重均 30；「出现[X]卡牌的概率提高」卡牌使对应标签权重 +10） */
const TAG_POOL = ['通用', '生命', '防御', '暴击', '专精-无锋剑', '专精-苍弓', '专精-圣金源盾', '专精-星尘溶液', '专精-AK47']

// 重击剑气（远程弹道）
const WAVE_SPEED = 12     // m/s
const WAVE_TTL_S = 1.2    // 飞行寿命（约 14m 射程）
const WAVE_RADIUS = 0.9   // 命中判定半径

// 苍弓（球状闪电 / 巨型激光）
const ORB_SPEED = 16      // 球状闪电飞行速度 m/s
const ORB_TTL_S = 6       // 球状闪电持续时间 s（自发射起计，含附着 tick 期）
const ORB_TICK_S = 0.1    // 球状闪电附着 tick 间隔
const BEAM_TICK_S = 0.2   // 巨型激光 tick 间隔
const ORB_HIT_Z = 0.55    // 球状闪电命中僵尸：采样点到弹道距离阈值
const ORB_HIT_P = 0.6     // 球状闪电命中玩家：中心点（1.0 高）距离阈值
const BEAM_RANGE = 20     // 激光射程 m
const BEAM_HIT_Z = 0.55   // 激光命中僵尸：采样点到射线垂距阈值
const BEAM_HIT_P = 0.6    // 激光命中玩家：中心点垂距阈值

// 僵尸碰撞圆柱（包裹全部模型：模型横向半宽 ~0.45 / 头顶 ~1.87，含动态手臂余量取 R0.55）
const Z_HIT_R = 0.55
const Z_HIT_H = 1.9
/** 圆柱碰撞采样点（相对僵尸脚下中心，y 为绝对高度）：3 层 ×（圆心 + 四向边缘），任一点命中即判中 */
const Z_HIT_SAMPLES: [number, number, number][] = []
for (const sy of [0.15, Z_HIT_H / 2, Z_HIT_H - 0.15]) {
	Z_HIT_SAMPLES.push(
		[0, sy, 0], [Z_HIT_R, sy, 0], [-Z_HIT_R, sy, 0], [0, sy, Z_HIT_R], [0, sy, -Z_HIT_R],
	)
}

export type ZState =
	| 'enter' | 'chase' | 'windup' | 'recover' | 'stunned' | 'dead'
	| 'sweep' | 'lungeWind' | 'lungeDash' | 'roar'

/** 飞行中的重击剑气（PB 权威弹道） */
interface Wave {
	owner: string
	x: number; y: number; z: number
	/** 飞行方向（3D 单位向量 = 发射时摄像机准星朝向） */
	dx: number; dy: number; dz: number
	/** 剑气面基：c = 面内横轴，n = 面法线（随机 roll 绕飞行轴旋转，碰撞箱跟随） */
	cx: number; cy: number; cz: number
	nx: number; ny: number; nz: number
	/** 发射时锁定的伤害值（atk × 300% × 有效蓄力 × 伤害倍率） */
	dmg: number
	t: number
	reg: number
	hits: string[]
}

/** 飞行 / 附着中的球状闪电（苍弓普攻弹道） */
interface Orb {
	owner: string
	id: number
	x: number; y: number; z: number
	/** 飞行方向（3D 单位向量 = 发射时准星朝向）；附着后不再推进 */
	dx: number; dy: number; dz: number
	/** 附着目标 key（`z<id>` / 玩家 uuid）；null = 飞行中 */
	target: string | null
	/** 下次附着 tick 结算时刻（epoch 秒） */
	tickAt: number
	/** 发射起累计存活秒数（含附着期，ORB_TTL_S 到期消失） */
	t: number
}

/** 玩家词条键：一切可被三选一增益的数值统一挂在 MpPlayer.stats 中管理 */
type StatKey =
	| 'atk' | 'maxHp' | 'maxSt' | 'parryPct' | 'blockMaxS' | 'dmgMul'
	| 'chargeSpd' | 'chargeMax' | 'thorn' | 'lifesteal' | 'multiWave'
	| 'impact' | 'stability' | 'critRate' | 'critDmg' | 'huaqi' | 'def'

/** 词条初始值（与三选一档位一一对应，见 World.PICK_OPTIONS） */
const STAT_DEFAULTS: Record<StatKey, number> = {
	atk: 10, maxHp: P_MAX_HP, maxSt: P_MAX_ST, parryPct: 0.5, blockMaxS: 1.0,
	dmgMul: 1, chargeSpd: 1, chargeMax: 1.0, thorn: 0, lifesteal: 0,
	multiWave: 0, impact: 1, stability: 1, critRate: 0.05, critDmg: 1.0,
	huaqi: 0.3, def: 10,
}

/** 词条数据格式：决定展示方式与取整规则（PERCENT ×100 取整防浮漂） */
export enum DataFormat {
	INT = 'INT',
	VALUE = 'VALUE',
	PERCENT = 'PERCENT',
	FREQUENCY = 'FREQUENCY',
	ANGLE = 'ANGLE',
}

/** 词条定义：format 决定格式化，name 为展示名，after 为值变更后的钩子（如上限变化回补当前值） */
interface StatDef {
	format: DataFormat
	name: string
	/** 词条值变更后触发（p = 词条所属玩家，old = 变更前的值） */
	after?: (p: MpPlayer, old: number) => void
}

/** 玩家词条数据库（键 = statStore 即 MpPlayer.stats 的键） */
const STAT_DEFS: Record<StatKey, StatDef> = {
	atk: { format: DataFormat.VALUE, name: '攻击力' },
	maxHp: {
		format: DataFormat.VALUE, name: '生命上限',
		after: (p, old) => { if (old > 0) p.hp = Math.round((p.hp / old) * p.stats.maxHp) }, // 当前生命按比例回补
	},
	maxSt: {
		format: DataFormat.VALUE, name: '体力上限',
		after: (p, old) => { if (old > 0) p.stamina = Math.round((p.stamina / old) * p.stats.maxSt) },
	},
	parryPct: { format: DataFormat.PERCENT, name: '完美格挡窗口', after: (p) => { p.stats.parryPct = Math.min(1, p.stats.parryPct) } },
	blockMaxS: { format: DataFormat.VALUE, name: '格挡最大持续' },
	dmgMul: { format: DataFormat.PERCENT, name: '伤害倍率' },
	chargeSpd: { format: DataFormat.PERCENT, name: '蓄力速度' },
	chargeMax: { format: DataFormat.VALUE, name: '蓄力上限' },
	thorn: { format: DataFormat.PERCENT, name: '荆棘' },
	lifesteal: { format: DataFormat.VALUE, name: '吸血' },
	multiWave: { format: DataFormat.INT, name: '连续剑气' },
	impact: { format: DataFormat.PERCENT, name: '冲击力' },
	stability: { format: DataFormat.PERCENT, name: '稳定性' },
	critRate: { format: DataFormat.PERCENT, name: '暴击率', after: (p) => { p.stats.critRate = Math.min(1, p.stats.critRate) } },
	critDmg: { format: DataFormat.PERCENT, name: '暴击伤害' },
	huaqi: { format: DataFormat.PERCENT, name: '化气' },
	def: { format: DataFormat.VALUE, name: '防御' },
}

/** 三选一增益选项（表驱动） */
interface PickOption {
	label: string
	key: StatKey
	add: number
	/** 卡牌标签列表（rollCards 第③步筛卡依据） */
	labels: string[]
}

/** 伤害符号：治疗 / 被闪避·格挡 / 正常 / 暴击 */
export enum DamageSign {
	Heal = -1,
	Blocked = 0,
	Normal = 1,
	Crit = 2,
}

/** 伤害对象：伤害不再是一个裸数字，携带来源 / 符号 / 冲击值走统一结算 */
export interface DamageSource {
	from: string          // 'p:<uuid>' | 'z:<id>' | 'sys'
	amount: number        // 绝对值，>0
	sign: DamageSign
	impact: number        // 受击者扣除的体力基值（T2b 冲击力/稳定性公式挂点）
}

/** 卡牌稀有度：决定抽取权重与 PF 展示样式 */
export enum CardQuality {
	WASTE = 'WASTE',
	NORMAL = 'NORMAL',
	RARE = 'RARE',
	EPIC = 'EPIC',
	LEGENDARY = 'LEGENDARY',
	INFINITY = 'INFINITY',
}

/** 稀有度参数：初始抽取权重 + 幸运加权（实际权重 = max(1, 初始 + 场景幸运 × 加权)） */
export const QUALITY_META: Record<CardQuality, { init: number; luckAdj: number }> = {
	[CardQuality.WASTE]: { init: 50, luckAdj: -5 },
	[CardQuality.NORMAL]: { init: 100, luckAdj: -3 },
	[CardQuality.RARE]: { init: 60, luckAdj: 0 },
	[CardQuality.EPIC]: { init: 20, luckAdj: 3 },
	[CardQuality.LEGENDARY]: { init: 8, luckAdj: 4 },
	[CardQuality.INFINITY]: { init: 1, luckAdj: 5 },
}

/** 增益卡牌：labels 为标签列表（决定抽取路径），apply 为选中后的结算（词条卡 / 场景词条卡 / 标签权重卡） */
export interface GameCard {
	id: string
	label: string
	labels: string[]
	quality: CardQuality
	apply: (world: World, p: MpPlayer) => void
}

/** 快照中的卡牌选项（PF 渲染投影，不含 apply 函数） */
export interface PickCardView {
	id: string
	label: string
	quality: CardQuality
	labels: string[]
}

/** 武器 ID：无锋剑 / 苍弓 */
export type WeaponId = 'sword' | 'bow'

export interface MpPlayer {
	uuid: string
	name: string
	color: string
	wsId: string
	x: number; y: number; z: number
	yaw: number
	dirX: number; dirZ: number
	/** 摄像机 3D 前向（mp_input dir3，剑气飞行方向） */
	lookX: number; lookY: number; lookZ: number
	mode: 'fp' | 'free'
	anim: string | null
	hp: number
	stamina: number
	stunUntil: number
	/** 体力耗尽眩晕截止（tick 中到期 → 体力回满） */
	exhaustUntil: number
	guardBreakUntil: number
	blocking: boolean
	blockStart: number
	blockCdUntil: number
	lastStaminaUse: number
	lastAttack: number
	combo: number
	kills: number
	/** 词条表：攻击力 / 上限 / 格挡 / 荆棘 / 吸血 / 暴击等全部增益数值 */
	stats: Record<StatKey, number>
	/** 当前武器（Q/E 切换，mp_action weapon） */
	weapon: WeaponId
	/** 重击蓄力开始时刻 epoch 秒（苍弓激光；-1 = 未蓄力） */
	chargeStartAt: number
	/** 连发剑气队列：剩余发数 + 下一发时刻（间隔 0.1s） */
	waveQueue: number
	waveNextAt: number
	/** 苍弓持续激光下一 tick 时刻（epoch 秒；chargeStartAt >= 0 时每 0.2s 结算） */
	beamNextAt: number
	/** 闪避无敌帧截止（外部触发带无敌的闪避上报 'dash' 后 0.3s 免伤） */
	dashInvulnUntil: number
	/** 升级选择状态（进行中时非空）：抽到的 3 张增益卡牌 + 已选索引 */
	pick: { options: GameCard[]; choice: number | null } | null
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
	/** 血量上限（100 + 25×等级），快照 max_hp 供 PF 血条比例 */
	maxHp: number
	stamina: number
	/** 僵尸等级（第几代）：台灯召唤 = 0，死亡补员 = 上一只等级 +1 */
	level: number
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
	| { kind: 'dmg_z'; id: number; amount: number; sign: DamageSign; by: string }
	| { kind: 'dmg_p'; uuid: string; amount: number; sign: DamageSign; by: string; interrupt: boolean }
	| { kind: 'parry'; uuid: string; perfect: boolean; fail: boolean; drain: number; byZombie: boolean }
	| { kind: 'zstun'; id: number; mul: number }
	| { kind: 'zdie'; id: number }
	/** 场景升级（经验达阈值）：全员 LEVEL UP 提示，提示期结束进入升级（三选一）阶段 */
	| { kind: 'level_up'; level: number }
	| { kind: 'knockback'; uuid: string; dx: number; dz: number; speed: number }
	| { kind: 'slow'; uuid: string; dur: number }
	| { kind: 'guardbreak'; uuid: string; dur: number }
	| { kind: 'respawn'; uuid: string; pos: [number, number, number] }
	| { kind: 'counter_open' }
	| { kind: 'roar_interrupt'; id: number }
	| { kind: 'wave'; by: string; x: number; y: number; z: number; dx: number; dy: number; dz: number; roll: number }
	/** 苍弓射球：by 玩家从 (x,y,z) 沿 3D (dx,dy,dz) 发射球状闪电（PF 本地渲染飞行视觉，伤害由 PB 裁决） */
	| { kind: 'orb'; by: string; id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number }
	/** 球状闪电停止前进：target = 附着目标 key（PF 跟随目标渲染）；null = 球消失（PF 移除视觉） */
	| { kind: 'orb_stop'; id: number; x: number; y: number; z: number; target: string | null }
	/** 苍弓蓄满爆发：一道 40 伤激光沿 (dx,dy,dz)（PF 播爆发特效 + 微震，伤害由 PB 射线裁决） */
	| { kind: 'beam_burst'; by: string; x: number; y: number; z: number; dx: number; dy: number; dz: number }

export interface WorldSnapshot {
	t: number
	chase_left: number
	pick_phase: boolean
	/** 场景共享词条与属性（幸运 / 经验倍率为词条，经验 / 等级为属性） */
	scene: { exp: number; level: number; luck: number; exp_mul: number }
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
		thorn_pct: number; lifesteal: number; multi_wave: number
		impact: number; stability: number
		crit_rate: number; crit_dmg: number
		weapon: WeaponId
		pick: { options: PickCardView[]; done: boolean } | null
	}[]
	zombies: {
		id: number
		p: [number, number, number]; yaw: number
		hp: number; st: number
		/** 僵尸等级（第几代） */
		level: number
		state: ZState; st_t: number; windup_dur: number
		vuln: number
		target: boolean
	}[]
}

export class World {
	players = new Map<string, MpPlayer>()   // key = uuid
	zombies: MpZombie[] = []
	/** 飞行中的重击剑气（PB 权威弹道，扇形碰撞箱随随机 roll 旋转） */
	waves: Wave[] = []
	/** 飞行 / 附着中的球状闪电（苍弓普攻弹道） */
	orbs: Orb[] = []
	private orbSeq = 0
	chaseLeft = 0
	chaseUntil = 0
	/** 瞬时事件队列（同模块武器实例也会推入，如 counter_open / orb） */
	events: MpEvent[] = []
	private byWs = new Map<string, string>() // wsId → uuid
	private zSeq = 0
	// ---- 场景共享词条（幸运 / 经验倍率）与场景属性（经验 / 等级，非词条） ----
	/** 幸运（VALUE，初始 1）：影响卡牌稀有度抽取权重 */
	luck = 1
	/** 经验倍率（PERCENT，初始 1 = 100%）：僵尸死亡经验结算倍率 */
	expMul = 1
	/** 场景当前经验值（VALUE，初始 0） */
	exp = 0
	/** 场景等级（INT，初始 0） */
	level = 0
	/** 标签抽取权重：标签池初始均 30（「出现[X]卡牌的概率提高」卡牌 +10）；「强化」固定 15 不在池内（无对应概率卡，不会被改动） */
	tagWeights: Record<string, number> = { ...Object.fromEntries(TAG_POOL.map((t) => [t, 30])), 强化: 15 }
	/** 升级提示期截止（level_up 后 3s 进入升级选择；提示期玩家可继续攻击） */
	private pickStartAt = 0
	/** 武器裁决实例（同模块 BaseWeapon 实现：双手剑 / 苍弓，可访问下方公开的裁决方法） */
	private weapons: Record<WeaponId, BaseWeapon> = { sword: new SwordWeapon(this), bow: new BowWeapon(this) }

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
			lookX: 0, lookY: 0, lookZ: -1,
			mode: 'free', anim: null,
			hp: P_MAX_HP, stamina: P_MAX_ST,
			stunUntil: 0, exhaustUntil: 0, guardBreakUntil: 0,
			blocking: false, blockStart: 0, blockCdUntil: 0,
			lastStaminaUse: -10, lastAttack: 0, combo: -1,
			kills: 0,
			stats: { ...STAT_DEFAULTS },
			weapon: 'sword', chargeStartAt: -1,
			waveQueue: 0, waveNextAt: 0, beamNextAt: 0,
			dashInvulnUntil: 0,
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
		dir3: [number, number, number]
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
		// 摄像机 3D 前向（剑气飞行方向）：合法向量才更新
		const ll = Math.hypot(d.dir3[0], d.dir3[1], d.dir3[2])
		if (ll >= 0.01) {
			p.lookX = d.dir3[0] / ll
			p.lookY = d.dir3[1] / ll
			p.lookZ = d.dir3[2] / ll
		}
	}

	action(uuid: string, d: { kind: 'attack' | 'parry_start' | 'parry_stop' | 'respawn' | 'wave' | 'pick' | 'revive' | 'lamp' | 'weapon' | 'shoot' | 'charge_start' | 'charge_stop' | 'dash'; segment?: number; hold?: number; idx?: number; target?: string; weapon?: WeaponId }): void {
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
		// 闪避（PF 外部触发且带无敌参数时上报）：短暂无敌帧（0.3s 完全免伤）
		if (d.kind === 'dash') {
			p.dashInvulnUntil = now + 0.3
			return
		}
		// 武器切换：蓄力中拒绝，其余即时生效（快照回写为准）
		if (d.kind === 'weapon') {
			if (!d.weapon || p.chargeStartAt >= 0) return
			p.weapon = d.weapon
			return
		}
		// 格挡起手：由当前武器的 parry 行为决定（无锋剑举盾格挡，苍弓不可格挡）
		if (d.kind === 'parry_start') {
			this.weapons[p.weapon].parry(p, now)
			return
		}
		if (d.kind === 'parry_stop') {
			if (!p.blocking) return
			p.blocking = false
			p.blockCdUntil = now + BLOCK_CD_S
			return
		}
		// 武器动作路由：wave = 蓄满松手（hold 为按住秒数）；charge_* = 苍弓重击生命周期
		const weapon = this.weapons[p.weapon]
		if (d.kind === 'wave') {
			weapon.heavyAttack(p, d.hold ?? 1, now)
			return
		}
		if (d.kind === 'charge_start') {
			weapon.startCharge(p, now)
			return
		}
		if (d.kind === 'charge_stop') {
			weapon.stopCharge(p, now)
			return
		}
		// attack（剑近战）/ shoot（弓射球）：普攻裁决由当前武器实现
		weapon.normalAttack(p, d.segment ?? 0, now)
	}

	// ---------------- 重击剑气（远程弹道，PB 权威裁决） ----------------

	/** 区域：0 门廊（四面是墙） / 1 室内 / 2 南侧坝坝（与室内开放连通） */
	private region(x: number, z: number): number {
		if (x < -3.5) return 0
		return z > 3.0 ? 2 : 1
	}

	/** 剑气飞行方向：摄像机准星 3D 前向；无输入时退化为水平朝向（武器实例可访问） */
	waveDir(p: MpPlayer): [number, number, number] {
		const len = Math.hypot(p.lookX, p.lookY, p.lookZ)
		if (len >= 0.01) return [p.lookX / len, p.lookY / len, p.lookZ / len]
		const hl = Math.hypot(p.dirX, p.dirZ)
		if (hl >= 0.01) return [p.dirX / hl, 0, p.dirZ / hl]
		return [Math.sin(p.yaw), 0, -Math.cos(p.yaw)]
	}

	/** 剑气伤害 = 攻击力 × 300% × 有效蓄力时长 × 全局伤害倍率（双手剑武器实例可访问） */
	chargeWaveDmg(p: MpPlayer, effHold: number): number {
		return p.stats.atk * 3 * effHold * p.stats.dmgMul
	}

	/** 发射一发剑气：方向取当前准星 3D 朝向，绕飞行轴随机 roll 旋转碰撞箱与视觉（武器实例可访问） */
	emitWave(p: MpPlayer, now: number, dmg: number): void {
		const [dx, dy, dz] = this.waveDir(p)
		const roll = Math.random() * Math.PI * 2
		const { c, n } = waveBasis(dx, dy, dz, roll)
		const x = p.x + dx * 0.5
		const y = p.y + dy * 0.5
		const z = p.z + dz * 0.5
		this.waves.push({
			owner: p.uuid, x, y, z, dx, dy, dz,
			cx: c[0], cy: c[1], cz: c[2], nx: n[0], ny: n[1], nz: n[2],
			dmg, t: 0, reg: this.region(x, z), hits: [],
		})
		this.events.push({ kind: 'wave', by: p.uuid, x, y, z, dx, dy, dz, roll })
	}

	private tickWaves(dt: number, now: number): void {
		for (let i = this.waves.length - 1; i >= 0; i--) {
			const w = this.waves[i]
			w.t += dt
			const step = WAVE_SPEED * dt
			w.x += w.dx * step
			w.y += w.dy * step
			w.z += w.dz * step
			const reg = this.region(w.x, w.z)
			// 撞墙：跨入/跨出门廊（四面墙）；室内 ↔ 坝坝开放连通不拦
			if (reg !== w.reg) {
				if (reg === 0 || w.reg === 0) {
					this.waves.splice(i, 1)
					continue
				}
				w.reg = reg
			}
			// 撞地 / 天花板（室内 2.8m、门廊 2.45m；室外无顶）
			if (w.y <= 0.06 || (reg === 1 && w.y >= 2.72) || (reg === 0 && w.y >= 2.4)) {
				this.waves.splice(i, 1)
				continue
			}
			const by = this.players.get(w.owner)
			if (!by) {
				this.waves.splice(i, 1)
				continue
			}
			// 命中：扇形碰撞箱（随 roll 旋转）内所有未命中过的存活目标（无限穿透，同一目标只结算一次）
			const targets: { key: string; z: MpZombie | null; p: MpPlayer | null; hit: boolean }[] = []
			for (const z of this.zombies) {
				if (z.state === 'dead') continue
				const key = `z${z.id}`
				if (w.hits.includes(key)) continue
				targets.push({ key, z, p: null, hit: zombieWaveHit(w, z.x, z.z) })
			}
			for (const o of this.players.values()) {
				if (o.uuid === w.owner || o.mode !== 'fp' || o.hp <= 0) continue
				if (w.hits.includes(o.uuid)) continue
				targets.push({ key: o.uuid, z: null, p: o, hit: waveHit(w, o.x, 1.0, o.z) })
			}
			for (const t of targets) {
				if (!t.hit) continue
				w.hits.push(t.key)
				// 剑气暴击：每个目标独立掷点（与近战同一公式）
				const crit = Math.random() < by.stats.critRate
				const waveDmg: DamageSource = {
					from: `p:${by.uuid}`,
					amount: crit ? w.dmg * (1 + by.stats.critDmg) : w.dmg,
					sign: crit ? DamageSign.Crit : DamageSign.Normal,
					impact: 11,
				}
				if (t.z) this.damageZombie(t.z, waveDmg, by, now)
				else if (t.p) this.damagePlayer(t.p, waveDmg, by, now, false, true)
			}
			if (w.t > WAVE_TTL_S) this.waves.splice(i, 1)
		}
	}

	// ---------------- 苍弓（球状闪电 / 巨型激光，由 BowWeapon 实例调用） ----------------

	/** 发射一发球状闪电：方向 = 准星 3D 前向，首中即停附着（武器实例可访问） */
	emitOrb(p: MpPlayer, _now: number): void {
		const [dx, dy, dz] = this.waveDir(p)
		const x = p.x + dx * 0.5
		const y = p.y + dy * 0.5
		const z = p.z + dz * 0.5
		const orb: Orb = { owner: p.uuid, id: ++this.orbSeq, x, y, z, dx, dy, dz, target: null, tickAt: 0, t: 0 }
		this.orbs.push(orb)
		this.events.push({ kind: 'orb', by: p.uuid, id: orb.id, x, y, z, dx, dy, dz })
	}

	/** 球状闪电停止/消失事件：target = 附着 key；null = 球消失（PF 移除视觉） */
	private emitOrbStop(id: number, x: number, y: number, z: number, target: string | null): void {
		this.events.push({ kind: 'orb_stop', id, x, y, z, target })
	}

	/** 解析附着目标（key = `z<id>` / 玩家 uuid）：死亡 / 离场返回 null */
	private orbTarget(key: string): { z: MpZombie | null; p: MpPlayer | null; cx: number; cy: number; cz: number } | null {
		if (key.startsWith('z')) {
			const id = Number(key.slice(1))
			const z = this.zombies.find((zz) => zz.id === id)
			if (!z || z.state === 'dead') return null
			return { z, p: null, cx: z.x, cy: 1.05, cz: z.z } // 僵尸躯干中心
		}
		const p = this.players.get(key)
		if (!p || p.mode !== 'fp' || p.hp <= 0) return null
		return { z: null, p, cx: p.x, cy: 1.0, cz: p.z }
	}

	/** 球状闪电单次伤害结算：3 × dmgMul / impact 1（Q1 不吃 atk；Q7 不暴击、吃吸血走统一结算） */
	private orbHit(by: MpPlayer, tgt: { z: MpZombie | null; p: MpPlayer | null }, now: number): void {
		const dmg: DamageSource = { from: `p:${by.uuid}`, amount: 3 * by.stats.dmgMul, sign: DamageSign.Normal, impact: 1 }
		if (tgt.z) this.damageZombie(tgt.z, dmg, by, now)
		else if (tgt.p) this.damagePlayer(tgt.p, dmg, by, now, false, true)
	}

	/** 首中即停（无穿透）：僵尸采样点 / 玩家中心到本帧飞行线段距离达标 → 返回目标 key */
	private orbFirstHit(o: Orb, nx: number, ny: number, nz: number): string | null {
		for (const z of this.zombies) {
			if (z.state === 'dead') continue
			for (const [ox, oy, oz] of Z_HIT_SAMPLES) {
				if (pointSegDist(o.x, o.y, o.z, nx, ny, nz, z.x + ox, oy, z.z + oz) <= ORB_HIT_Z) return `z${z.id}`
			}
		}
		for (const p of this.players.values()) {
			if (p.uuid === o.owner || p.mode !== 'fp' || p.hp <= 0) continue
			if (pointSegDist(o.x, o.y, o.z, nx, ny, nz, p.x, 1.0, p.z) <= ORB_HIT_P) return p.uuid
		}
		return null
	}

	private tickOrbs(dt: number, now: number): void {
		for (let i = this.orbs.length - 1; i >= 0; i--) {
			const o = this.orbs[i]
			o.t += dt
			const by = this.players.get(o.owner)
			// 主人离场 / 持续 6s 到期 → 消失
			if (!by || o.t > ORB_TTL_S) {
				this.orbs.splice(i, 1)
				this.emitOrbStop(o.id, o.x, o.y, o.z, null)
				continue
			}
			if (o.target !== null) {
				// 附着：跟随目标中心，每 0.1s 结算（目标死亡 / 离场 → 消失）
				const tgt = this.orbTarget(o.target)
				if (!tgt) {
					this.orbs.splice(i, 1)
					this.emitOrbStop(o.id, o.x, o.y, o.z, null)
					continue
				}
				o.x = tgt.cx; o.y = tgt.cy; o.z = tgt.cz
				if (now >= o.tickAt) {
					o.tickAt = now + ORB_TICK_S
					this.orbHit(by, tgt, now)
				}
				continue
			}
			// 飞行：直线推进 + 线段扫掠判定（防高速隧穿）
			const step = ORB_SPEED * dt
			const nx = o.x + o.dx * step
			const ny = o.y + o.dy * step
			const nz = o.z + o.dz * step
			const reg0 = this.region(o.x, o.z)
			const reg = this.region(nx, nz)
			// 撞墙：跨入/跨出门廊（四面墙）；室内 ↔ 坝坝开放连通不拦（与剑气一致）
			if (reg !== reg0 && (reg === 0 || reg0 === 0)) {
				this.orbs.splice(i, 1)
				this.emitOrbStop(o.id, nx, ny, nz, null)
				continue
			}
			// 撞地 / 天花板（室内 2.8m、门廊 2.45m；室外无顶）
			if (ny <= 0.06 || (reg === 1 && ny >= 2.72) || (reg === 0 && ny >= 2.4)) {
				this.orbs.splice(i, 1)
				this.emitOrbStop(o.id, nx, ny, nz, null)
				continue
			}
			const hit = this.orbFirstHit(o, nx, ny, nz)
			o.x = nx; o.y = ny; o.z = nz
			if (hit) {
				// 首中即停：附着目标并立刻结算第一跳，之后每 0.1s
				o.target = hit
				o.tickAt = now + ORB_TICK_S
				this.emitOrbStop(o.id, o.x, o.y, o.z, o.target)
				const tgt = this.orbTarget(hit)
				if (tgt) this.orbHit(by, tgt, now)
			}
		}
	}

	/** 巨型激光射线结算：射线上所有命中目标（穿透）+ 隔门廊墙拦截（武器实例可访问） */
	beamDamage(p: MpPlayer, amount: number, impact: number, now: number): void {
		const [dx, dy, dz] = this.waveDir(p)
		for (const z of this.zombies) {
			if (z.state === 'dead') continue
			if (p.x > -3.5 !== z.x > -3.5 && (z.z < 1.35 || z.z > 2.45)) continue // 隔门廊墙
			if (!Z_HIT_SAMPLES.some(([ox, oy, oz]) => beamHit(p.x, p.y, p.z, dx, dy, dz, z.x + ox, oy, z.z + oz, BEAM_HIT_Z))) continue
			this.damageZombie(z, { from: `p:${p.uuid}`, amount, sign: DamageSign.Normal, impact }, p, now)
		}
		for (const o of this.players.values()) {
			if (o.uuid === p.uuid || o.mode !== 'fp' || o.hp <= 0) continue
			if (p.x > -3.5 !== o.x > -3.5 && (o.z < 1.35 || o.z > 2.45)) continue
			if (!beamHit(p.x, p.y, p.z, dx, dy, dz, o.x, 1.0, o.z, BEAM_HIT_P)) continue
			// isWave=true：命中玩家走 impact 扣体力路径（与剑气一致）
			this.damagePlayer(o, { from: `p:${p.uuid}`, amount, sign: DamageSign.Normal, impact }, p, now, false, true)
		}
	}

	// ---------------- 玩家攻击裁决（由武器实例实现，见文件底部 BaseWeapon 体系） ----------------

	/** 玩家攻击构造 DamageSource：掷暴击（命中 critRate → 伤害 ×(1+critDmg)）；impact 默认 3（普攻/反击/追击同值，武器实例可访问） */
	playerHit(p: MpPlayer, amount: number, impact = 3): DamageSource {
		const crit = Math.random() < p.stats.critRate
		return {
			from: `p:${p.uuid}`,
			amount: crit ? amount * (1 + p.stats.critDmg) : amount,
			sign: crit ? DamageSign.Crit : DamageSign.Normal,
			impact,
		}
	}

	/** 目标选择：僵尸优先逻辑与单机一致——按距离取最近（武器实例可访问） */
	findMeleeTarget(p: MpPlayer): { zombie: MpZombie | null; player: MpPlayer | null; dist: number } | null {
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

	// ---------------- 伤害结算（武器实例可访问） ----------------

	damageZombie(z: MpZombie, dmg: DamageSource, by: MpPlayer, _now: number): void {
		if (z.state === 'dead') return
		// 嘶吼前摇中受到 ≥15 伤害 → 打断
		if (z.state === 'roar' && dmg.amount >= 15) {
			z.state = 'recover'
			z.stT = 0
			z.recExtra = 0.55
			this.events.push({ kind: 'roar_interrupt', id: z.id })
		}
		const amount = z.vulnMul > 0 ? Math.round(dmg.amount * z.vulnMul) : dmg.amount
		z.hp = Math.max(0, z.hp - amount)
		// 受击小击退
		const dx = z.x - by.x
		const dz = z.z - by.z
		const d = Math.hypot(dx, dz) || 1
		z.x += (dx / d) * 0.12
		z.z += (dz / d) * 0.12
		this.events.push({ kind: 'dmg_z', id: z.id, amount, sign: dmg.sign, by: by.uuid })
		// 吸血：造成伤害回复固定血量
		if (by.stats.lifesteal > 0 && by.hp > 0) by.hp = Math.min(by.stats.maxHp, by.hp + by.stats.lifesteal)
		if (z.hp <= 0) {
			z.state = 'dead'
			z.deadAt = this.now()
			by.kills++
			this.events.push({ kind: 'zdie', id: z.id })
			// 经验结算（场景属性）：达到阈值即场景升级，提示期结束后全员进入升级选择
			this.gainExp(z.level)
			// 门处自动补员下一世代僵尸（等级 +1：血量 / 伤害随等级成长）
			this.spawnZombie(z.level + 1)
		}
	}

	// ---------------- 击杀三选一（全员选完才恢复） ----------------

	/** 增益选项定义（表驱动，索引即协议值；label 与 PF BuffPickModal.LABELS 对齐） */
	static readonly PICK_OPTIONS: PickOption[] = [
		{ label: '攻击力 +5', key: 'atk', add: 5, labels: ['通用'] },
		{ label: '血量上限 +20', key: 'maxHp', add: 20, labels: ['生命'] },
		{ label: '完美格挡窗口 +2%', key: 'parryPct', add: 0.02, labels: ['防御'] },
		{ label: '体力上限 +10', key: 'maxSt', add: 10, labels: ['防御', '通用'] },
		{ label: '格挡最大持续 +0.25s', key: 'blockMaxS', add: 0.25, labels: ['防御'] },
		{ label: '所有伤害 +10%', key: 'dmgMul', add: 0.1, labels: ['通用'] },
		{ label: '重击蓄力速度 +15%', key: 'chargeSpd', add: 0.15, labels: ['专精-无锋剑'] },
		{ label: '荆棘 +15%', key: 'thorn', add: 0.15, labels: ['生命', '防御'] },
		{ label: '吸血 +2', key: 'lifesteal', add: 2, labels: ['生命'] },
		{ label: '连续剑气 +1', key: 'multiWave', add: 1, labels: ['专精-无锋剑'] },
		{ label: '蓄力上限 +0.25s', key: 'chargeMax', add: 0.25, labels: ['通用'] },
		{ label: '冲击力 +15%', key: 'impact', add: 0.15, labels: ['防御', '通用'] },
		{ label: '稳定性 +15%', key: 'stability', add: 0.15, labels: ['防御'] },
		{ label: '暴击率 +5%', key: 'critRate', add: 0.05, labels: ['暴击'] },
		{ label: '暴击伤害 +25%', key: 'critDmg', add: 0.25, labels: ['暴击'] },
		{ label: '化气 +10%', key: 'huaqi', add: 0.1, labels: ['防御', '生命'] },
		{ label: '防御 +30', key: 'def', add: 30, labels: ['防御'] },
	]

	/** 僵尸被击败：房间内所有第一人称玩家进入升级（三选一，每人独立抽 3 张卡牌） */
	private startPickPhase(): void {
		const inRoom = [...this.players.values()].filter((q) => q.mode === 'fp')
		if (!inRoom.length) return
		for (const p of inRoom) {
			p.pick = { options: this.rollCards(), choice: null }
		}
	}

	/** 抽 3 张增益卡牌：①权重抽标签 → ②幸运加权抽稀有度 → ③筛含该标签的卡随机（不加权） */
	private rollCards(): GameCard[] {
		const cards: GameCard[] = []
		for (let i = 0; i < 3; i++) {
			const tag = this.weightedTag()
			const quality = this.rollQuality()
			// 筛选：卡牌标签列表含指定标签即算符合；稀有度无卡时回退该标签任意稀有度，再回退全卡池
			const exact = CARD_DB.filter((c) => c.quality === quality && c.labels.includes(tag))
			const byTag = exact.length ? exact : CARD_DB.filter((c) => c.labels.includes(tag))
			const pool = byTag.length ? byTag : CARD_DB
			cards.push(pool[Math.floor(Math.random() * pool.length)])
		}
		return cards
	}

	/** 按标签权重抽 1 个标签（权重越大越容易被抽到） */
	private weightedTag(): string {
		const entries = Object.entries(this.tagWeights).filter(([, w]) => w > 0)
		const total = entries.reduce((s, [, w]) => s + w, 0)
		let r = Math.random() * total
		for (const [tag, w] of entries) {
			r -= w
			if (r <= 0) return tag
		}
		return entries[entries.length - 1]?.[0] ?? TAG_POOL[0]
	}

	/** 按幸运加权抽 1 个稀有度：权重 = max(1, 初始权重 + 场景幸运 × 幸运加权) */
	private rollQuality(): CardQuality {
		const entries = Object.entries(QUALITY_META) as [CardQuality, { init: number; luckAdj: number }][]
		const weights = entries.map(([, m]) => Math.max(1, m.init + this.luck * m.luckAdj))
		const total = weights.reduce((s, w) => s + w, 0)
		let r = Math.random() * total
		for (let i = 0; i < entries.length; i++) {
			r -= weights[i]
			if (r <= 0) return entries[i][0]
		}
		return CardQuality.NORMAL
	}

	/** 全员是否已选完 */
	private pickDone(): boolean {
		for (const p of this.players.values()) {
			if (p.mode === 'fp' && p.pick && p.pick.choice === null) return false
		}
		return true
	}

	/** 应用所选卡牌并结束升级阶段（钩子回补当前生命 / 体力，概率词条封顶由 STAT_DEFS.after 处理） */
	private applyPicks(): void {
		for (const p of this.players.values()) {
			const pick = p.pick
			if (!pick || pick.choice === null) continue
			pick.options[pick.choice]?.apply(this, p)
			p.pick = null
		}
	}

	/** 是否处于升级（三选一）暂停阶段 */
	get pickPhase(): boolean {
		for (const p of this.players.values()) {
			if (p.mode === 'fp' && p.pick) return true
		}
		return false
	}

	/** 升级选择（PF 上报选项索引 0-2） */
	pickChoose(uuid: string, idx: number): void {
		const p = this.players.get(uuid)
		if (!p?.pick || p.pick.choice !== null) return
		if (idx < 0 || idx >= p.pick.options.length) return
		p.pick.choice = idx
		if (this.pickDone()) this.applyPicks()
	}

	/** 词条变更统一入口：按 DataFormat 取整（PERCENT ×100 防浮漂）并触发词条钩子 */
	applyStatChange(p: MpPlayer, key: StatKey, add: number): void {
		const def = STAT_DEFS[key]
		const old = p.stats[key]
		p.stats[key] = def.format === DataFormat.PERCENT
			? Math.round((old + add) * 100) / 100
			: old + add
		def.after?.(p, old)
	}

	/** 僵尸死亡经验结算：场景经验 += (100 + 50×僵尸等级) × 经验倍率；达阈值 → 消耗并场景升级 */
	private gainExp(zLevel: number): void {
		this.exp = Math.round((this.exp + (100 + 50 * zLevel) * this.expMul) * 100) / 100
		const threshold = 100 + this.level * 75
		if (this.exp < threshold) return
		this.exp = Math.round((this.exp - threshold) * 100) / 100
		this.level++
		// 全员 LEVEL UP 提示（PF 动画 2.5s），提示期结束（3s）后进入升级选择，期间可继续攻击
		this.events.push({ kind: 'level_up', level: this.level })
		this.pickStartAt = this.now() + 3.0
	}

	/**
	 * 队友复活：存活玩家点击尸体（距离 ≤3m）。三选一暂停期间不可用。
	 * 返回错误信息（null = 成功）。
	 */
	reviveBy(byUuid: string, targetUuid: string): string | null {
		if (this.pickPhase) return '升级选择完成后才能复活队友'
		const by = this.players.get(byUuid)
		const t = this.players.get(targetUuid)
		if (!by || !t) return '目标不存在'
		if (by.mode !== 'fp' || by.hp <= 0) return '你当前无法复活他人'
		if (t.mode !== 'fp' || t.hp > 0) return '目标不是尸体'
		if (Math.hypot(t.x - by.x, t.z - by.z) > 3) return '距离尸体太远'
		const now = this.now()
		t.hp = t.stats.maxHp
		t.stamina = t.stats.maxSt
		t.exhaustUntil = 0
		t.blocking = false
		t.blockStart = 0
		t.combo = -1
		t.stunUntil = now + 1.2 // 复活保护
		this.events.push({ kind: 'respawn', uuid: t.uuid, pos: [t.x, t.y, t.z] })
		return null
	}

	/** 对玩家造成伤害：闪避无敌帧 / 格挡评估 → 扣血 → 死亡重生（PVP 与僵尸攻击共用；武器实例可访问） */
	damagePlayer(v: MpPlayer, dmg: DamageSource, by: MpPlayer | null, now: number, fromZombie: boolean, isWave = false): void {
		if (v.hp <= 0) return
		// 闪避无敌帧：完全免伤（dmg_p sign=Blocked 供 PF 飘「格挡」字样）
		if (now < v.dashInvulnUntil) {
			this.events.push({ kind: 'dmg_p', uuid: v.uuid, amount: 0, sign: DamageSign.Blocked, by: dmg.from, interrupt: false })
			return
		}
		if (v.stunUntil > now) {
			if (isWave) this.useStamina(v, dmg.impact, now, by) // 被剑气命中扣体力
			this.hurtPlayer(v, dmg, now, by)
			return
		}
		if (v.blocking) {
			const age = now - v.blockStart
			if (age <= v.stats.blockMaxS * v.stats.parryPct) {
				// 完美格挡：攻击者 -20 体力（玩家攻击者进入 0.5s 硬直），格挡者无伤
				if (!fromZombie && by) {
					this.useStamina(by, 20, now, v) // 反噬量随格挡者冲击力 / 攻击者稳定性缩放
					by.guardBreakUntil = now + 0.5
					this.events.push({ kind: 'guardbreak', uuid: by.uuid, dur: 0.5 })
				}
				this.perfectParryHeal(v, dmg)
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: true, fail: false, drain: 20, byZombie: fromZombie })
				this.registerBlock(v, now)
				this.endBlockSuccess(v, now, true) // 退出格挡且不进冷却（可立即再格挡）
				return
			}
			if (Math.random() < 0.25) {
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: true, drain: 0, byZombie: fromZombie })
				if (isWave) this.useStamina(v, dmg.impact, now, by) // 被剑气命中扣体力
				this.hurtPlayer(v, dmg, now, by)
				return
			}
			const drained = this.useStamina(v, dmg.impact, now, by)
			this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: false, drain: Math.round(drained * 100) / 100, byZombie: fromZombie })
			this.registerBlock(v, now)
			this.endBlockSuccess(v, now, false) // 退出格挡并进入冷却
			return
		}
		if (isWave) this.useStamina(v, dmg.impact, now, by) // 被剑气命中扣体力
		this.hurtPlayer(v, dmg, now, by)
	}

	/** 成功格挡统一收尾：立即退出格挡状态；完美格挡不进冷却，普通格挡进入冷却 */
	private endBlockSuccess(v: MpPlayer, now: number, perfect: boolean): void {
		v.blocking = false
		v.blockStart = 0
		if (!perfect) v.blockCdUntil = now + BLOCK_CD_S
	}

	/** 僵尸攻击玩家（含完美格挡对僵尸的反噬：-20 体力 + 踉跄） */
	private damagePlayerByZombie(z: MpZombie, v: MpPlayer, dmg: DamageSource, now: number): void {
		if (v.hp <= 0) return
		// 闪避无敌帧：完全免伤
		if (now < v.dashInvulnUntil) {
			this.events.push({ kind: 'dmg_p', uuid: v.uuid, amount: 0, sign: DamageSign.Blocked, by: dmg.from, interrupt: false })
			return
		}
		if (v.stunUntil > now) {
			this.hurtPlayer(v, dmg, now, null, z)
			return
		}
		if (v.blocking) {
			const age = now - v.blockStart
			if (age <= v.stats.blockMaxS * v.stats.parryPct) {
				z.stamina = Math.max(0, z.stamina - 20)
				const drained = z.stamina <= 0
				if (z.state === 'recover') z.recExtra += 0.5 // 踉跄：延长后摇
				this.perfectParryHeal(v, dmg)
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: true, fail: false, drain: 20, byZombie: true })
				if (drained) this.zombieStun(z, now)
				this.registerBlock(v, now)
				this.endBlockSuccess(v, now, true) // 完美格挡：退出且不进冷却
				return
			}
			if (Math.random() < 0.25) {
				this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: true, drain: 0, byZombie: true })
				this.hurtPlayer(v, dmg, now, null, z)
				return
			}
			this.useStamina(v, dmg.impact, now, z)
			this.events.push({ kind: 'parry', uuid: v.uuid, perfect: false, fail: false, drain: 10, byZombie: true })
			this.registerBlock(v, now)
			this.endBlockSuccess(v, now, false) // 普通格挡：退出并进入冷却
			return
		}
		this.hurtPlayer(v, dmg, now, null)
	}

	/** 化气：完美格挡回复「格挡伤害 × 化气」（封顶 maxHp；dmg_p sign=Heal 供 PF 绿色飘字，满血不飘） */
	private perfectParryHeal(v: MpPlayer, dmg: DamageSource): void {
		const healed = Math.min(v.stats.maxHp - v.hp, Math.round(dmg.amount * v.stats.huaqi * 100) / 100)
		if (healed <= 0) return
		v.hp += healed
		this.events.push({ kind: 'dmg_p', uuid: v.uuid, amount: healed, sign: DamageSign.Heal, by: 'sys', interrupt: false })
	}

	/** 玩家掉血落地结算：防御缩放 / 荆棘反伤 / 吸血回复 / 死亡清理 */
	private hurtPlayer(v: MpPlayer, dmg: DamageSource, now: number, byPlayer: MpPlayer | null, byZombie: MpZombie | null = null): void {
		// 防御：最终伤害 = 原始 × 500 / (490 + def)（初始 10 → ×1 基准；低于放大 / 高于减免）
		dmg.amount = Math.round(((dmg.amount * 500) / (490 + v.stats.def)) * 100) / 100
		v.hp = Math.max(0, v.hp - dmg.amount)
		this.events.push({ kind: 'dmg_p', uuid: v.uuid, amount: dmg.amount, sign: dmg.sign, by: byPlayer?.uuid ?? dmg.from, interrupt: false })
		// 荆棘：伤害发出者受到「伤害 × 荆棘」等量反伤（直伤，不触发对方格挡 / 再反伤）
		const refl = Math.round(dmg.amount * v.stats.thorn)
		if (refl > 0) {
			const thornDmg: DamageSource = { from: `p:${v.uuid}`, amount: refl, sign: DamageSign.Normal, impact: 0 }
			if (byZombie) this.damageZombie(byZombie, thornDmg, v, now)
			else if (byPlayer) this.reflectDamage(byPlayer, thornDmg)
		}
		// 吸血：伤害发出者（玩家）回复固定血量
		if (byPlayer && byPlayer.stats.lifesteal > 0 && byPlayer.hp > 0) {
			byPlayer.hp = Math.min(byPlayer.stats.maxHp, byPlayer.hp + byPlayer.stats.lifesteal)
		}
		if (v.hp <= 0) {
			// 死亡：保持死亡状态等待玩家手动复活（PF 死亡覆盖层 → mp_action respawn）
			v.stunUntil = 0
			v.exhaustUntil = 0
			v.waveQueue = 0
			v.blocking = false
			v.blockStart = 0
		}
	}

	/** 荆棘反伤直伤：不触发格挡 / 荆棘 / 吸血（避免递归） */
	private reflectDamage(t: MpPlayer, dmg: DamageSource): void {
		if (t.hp <= 0) return
		t.hp = Math.max(0, t.hp - dmg.amount)
		this.events.push({ kind: 'dmg_p', uuid: t.uuid, amount: dmg.amount, sign: dmg.sign, by: dmg.from, interrupt: false })
		if (t.hp <= 0) {
			t.stunUntil = 0
			t.exhaustUntil = 0
			t.waveQueue = 0
			t.blocking = false
			t.blockStart = 0
		}
	}

	/** 复活请求裁决：房间内无存活僵尸 / 其他玩家全部死亡 / 房间内只有自己，满足其一才可复活 */
	private requestRespawn(p: MpPlayer, now: number): void {
		if (p.hp > 0) return
		const inRoom = [...this.players.values()].filter((q) => q.mode === 'fp')
		const zombiesAlive = this.zombies.some((z) => z.state !== 'dead')
		const aliveOthers = inRoom.filter((q) => q.uuid !== p.uuid && q.hp > 0).length
		if (inRoom.length > 1 && zombiesAlive && aliveOthers > 0) return
		p.hp = p.stats.maxHp
		p.stamina = p.stats.maxSt
		p.stunUntil = now + 1.2
		p.exhaustUntil = 0
		p.blocking = false
		p.blockStart = 0
		p.combo = -1
		p.x = -1.6; p.y = 1.6; p.z = 2.4 // 手动复活回出生点（pos 下发供 PF 相机复位）
		this.events.push({ kind: 'respawn', uuid: p.uuid, pos: [p.x, p.y, p.z] })
	}

	/** 扣体力：扣除量 = 基值 × 攻击者冲击力 / 受击者稳定性（僵尸无词条恒 1；无攻击者冲击力按 100%；武器实例可访问） */
	useStamina(p: MpPlayer, n: number, now: number, attacker?: MpPlayer | MpZombie | null): number {
		const ai = attacker && 'stats' in attacker ? attacker.stats.impact : 1
		const cost = (n * ai) / p.stats.stability
		p.stamina = Math.max(0, p.stamina - cost)
		p.lastStaminaUse = now
		if (p.stamina <= 0) {
			p.stunUntil = now + P_STUN_S
			p.exhaustUntil = p.stunUntil // 体力耗尽眩晕：结束后体力回满（tick 结算）
			p.blocking = false
		}
		return cost
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
		this.spawnZombie(0) // 台灯召唤：0 级僵尸
	}

	/** 生成僵尸（门外出生点，enter 走进门内）：等级决定血量与伤害成长 */
	private spawnZombie(level: number): void {
		this.zombies.push({
			id: ++this.zSeq,
			x: ZOMBIE_SPAWN.x, y: 0, z: ZOMBIE_SPAWN.z,
			yaw: Math.PI / 2,
			hp: Z_BASE_HP + Z_HP_PER_LEVEL * level,
			maxHp: Z_BASE_HP + Z_HP_PER_LEVEL * level,
			stamina: Z_MAX_ST,
			level,
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

	/** 僵尸动作成本：受攻击目标玩家的冲击力加成（僵尸稳定性恒 1，与 useStamina 公式对齐） */
	private spendZ(z: MpZombie, n: number, now: number, attacker?: MpPlayer | null): boolean {
		z.stamina = Math.max(0, z.stamina - n * (attacker ? attacker.stats.impact : 1))
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
						this.damagePlayerByZombie(z, v, { from: `z:${z.id}`, amount: 10 + z.level * Z_DMG_PER_LEVEL, sign: DamageSign.Normal, impact: 10 }, now)
					}
					if (!this.spendZ(z, Z_ATTACK_COST, now, p)) {
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
							// 横扫可被格挡：走统一僵尸伤害路径（普通格挡扣体 impact 15 / 完美格挡反噬踉跄）
							this.damagePlayerByZombie(z, v, { from: `z:${z.id}`, amount: 12 + z.level * Z_DMG_PER_LEVEL, sign: DamageSign.Normal, impact: SWEEP_BLOCK_STAMINA }, now)
						}
					}
					if (!this.spendZ(z, SWEEP_COST, now, p)) {
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
						// 突进可被格挡：未格挡（掉血）才击退
						const hpBefore = v.hp
						this.damagePlayerByZombie(z, v, { from: `z:${z.id}`, amount: 14 + z.level * Z_DMG_PER_LEVEL, sign: DamageSign.Normal, impact: 10 }, now)
						if (v.hp < hpBefore) {
							const vd = Math.hypot(v.x - z.x, v.z - z.z) || 1
							this.events.push({ kind: 'knockback', uuid: v.uuid, dx: (v.x - z.x) / vd, dz: (v.z - z.z) / vd, speed: 6.5 })
						}
					}
				}
				if (hit || remain <= 0.05 || z.dashT >= LUNGE_TIMEOUT) {
					if (!this.spendZ(z, LUNGE_COST, now, p)) {
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
							if (v.blocking) {
								// 嘶吼可被格挡：格挡中免体力损失与减速（按普通/完美走格挡冷却规则）
								const perfect = now - v.blockStart <= v.stats.blockMaxS * v.stats.parryPct
								this.events.push({ kind: 'parry', uuid: v.uuid, perfect, fail: false, drain: 0, byZombie: true })
								this.registerBlock(v, now)
								this.endBlockSuccess(v, now, perfect)
							} else {
								this.useStamina(v, ROAR_STAMINA, now, z)
								this.events.push({ kind: 'slow', uuid: v.uuid, dur: 1.0 })
							}
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
		// 升级提示期结束 → 进入升级（三选一）阶段（提示期玩家可继续攻击）
		if (this.pickStartAt > 0 && now >= this.pickStartAt) {
			this.pickStartAt = 0
			this.startPickPhase()
		}
		// 空场清理：房间内没有第一人称玩家时清除所有僵尸
		this.clearZombiesIfEmpty()
		// 玩家：体力耗尽眩晕结束回满 / 武器持续行为与蓄满自动触发 / 体力回复
		for (const p of this.players.values()) {
			// 体力耗尽眩晕到期 → 体力恢复到 100%
			if (p.exhaustUntil > 0 && now >= p.exhaustUntil) {
				p.exhaustUntil = 0
				if (p.hp > 0) p.stamina = p.stats.maxSt
			}
			// 武器持续行为（连发剑气队列 / 激光 tick 等）
			const weapon = this.weapons[p.weapon]
			weapon.tick?.(p, dt, now)
			// 蓄力中止：死亡 / 眩晕（含连发剑气队列，由各武器 tick 自行清理）
			if (p.chargeStartAt >= 0 && (p.hp <= 0 || p.stunUntil > now)) p.chargeStartAt = -1
			// 蓄满自动触发：maxChargeReached → 立刻 heavyAttack 并停止蓄力
			if (p.chargeStartAt >= 0 && weapon.maxChargeReached(p, now)) {
				weapon.heavyAttack(p, now - p.chargeStartAt, now)
			}
			if (
				!p.blocking && p.stamina < p.stats.maxSt &&
				p.stunUntil < now && now - p.lastStaminaUse > P_REGEN_DELAY
			) {
				p.stamina = Math.min(p.stats.maxSt, p.stamina + P_REGEN * dt)
			}
		}
		// 僵尸 AI
		for (const z of this.zombies) this.tickZombie(z, dt, now)
		// 尸体清理
		this.zombies = this.zombies.filter((z) => !(z.state === 'dead' && now - z.deadAt > ZOMBIE_TTL_DEAD))
		// 重击剑气弹道
		this.tickWaves(dt, now)
		// 苍弓球状闪电弹道
		this.tickOrbs(dt, now)
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
			scene: {
				exp: round2(this.exp),
				level: this.level,
				luck: round2(this.luck),
				exp_mul: round2(this.expMul),
			},
			players: [...this.players.values()].map((p) => ({
				uuid: p.uuid, name: p.name, color: p.color,
				p: [round2(p.x), round2(p.y), round2(p.z)],
				yaw: round2(p.yaw),
				fp: p.mode === 'fp',
				hp: Math.round(p.hp), st: Math.round(p.stamina),
				max_hp: p.stats.maxHp, max_st: p.stats.maxSt, atk: p.stats.atk, dmg_mul: p.stats.dmgMul,
				stun_for: Math.max(0, round2(p.stunUntil - now)),
				blocking: p.blocking,
				anim: p.anim,
				kills: p.kills,
				max_block: p.stats.blockMaxS, parry_pct: p.stats.parryPct, charge_dur: round2(p.stats.chargeMax / p.stats.chargeSpd),
				thorn_pct: p.stats.thorn, lifesteal: p.stats.lifesteal, multi_wave: p.stats.multiWave,
				impact: p.stats.impact, stability: p.stats.stability,
				crit_rate: p.stats.critRate, crit_dmg: p.stats.critDmg,
				huaqi: round2(p.stats.huaqi),
				def: p.stats.def,
				weapon: p.weapon,
				pick: p.pick ? { options: p.pick.options, done: p.pick.choice !== null } : null,
			})),
			zombies: this.zombies.map((z) => ({
				id: z.id,
				p: [round2(z.x), round2(z.y), round2(z.z)],
				yaw: round2(z.yaw),
				hp: Math.round(z.hp), st: Math.round(z.stamina),
				level: z.level,
				max_hp: Math.round(z.maxHp),
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

// ---------------- 增益卡牌数据库 ----------------

/**
 * 全量卡牌池（rollCards 抽取来源）：
 * - 17 张玩家词条卡（PICK_OPTIONS 表驱动，apply 走 applyStatChange 钩子，标签见各选项 labels）
 * - 幸运 / 经验倍率 2 张场景词条卡（标签「强化」）
 * - 9 张标签权重卡（「出现[X]卡牌的概率提高」，对应标签权重 +10，标签「强化」）
 * 「强化」标签权重固定 15 且无对应概率卡（场景词条 / 标签权重卡专属标签）。
 */
const CARD_DB: GameCard[] = [
	...World.PICK_OPTIONS.map<GameCard>((o) => ({
		id: `stat_${o.key}`,
		label: o.label,
		labels: o.labels,
		quality: CardQuality.NORMAL,
		apply: (w, p) => w.applyStatChange(p, o.key, o.add),
	})),
	{
		id: 'luck_1',
		label: '幸运 +1',
		labels: ['强化'],
		quality: CardQuality.NORMAL,
		apply: (w) => { w.luck += 1 },
	},
	{
		id: 'exp_mul_13',
		label: '经验倍率 +13%',
		labels: ['强化'],
		quality: CardQuality.NORMAL,
		apply: (w) => { w.expMul = Math.round((w.expMul + 0.13) * 100) / 100 },
	},
	...TAG_POOL.map<GameCard>((tag) => ({
		id: `tag_${tag}`,
		label: `出现[${tag}]卡牌的概率提高`,
		labels: ['强化'],
		quality: CardQuality.NORMAL,
		apply: (w) => { w.tagWeights[tag] = (w.tagWeights[tag] ?? 30) + 10 },
	})),
]

// ---------------- 武器系统（BaseWeapon 抽象 + 双手剑 / 苍弓） ----------------

/**
 * 武器抽象：普攻 / 蓄力 / 重击 / 蓄满自动触发的裁决入口。
 * 实例与 World 同模块（world.ts），可直接访问 World 公开的裁决方法
 * （playerHit / findMeleeTarget / damageZombie / damagePlayer / useStamina /
 * emitWave / chargeWaveDmg / waveDir / events）。
 */
abstract class BaseWeapon {
	abstract weaponName: string
	/** 普攻最小间隔（秒）：两次普攻之间的冷却 */
	abstract attackTime: number
	/** 普攻裁决（PF 点击上报 attack / shoot） */
	abstract normalAttack(p: MpPlayer, segment: number, now: number): void
	/** 格挡起手（PF 上报 parry_start；不支持格挡的武器空实现） */
	parry(_p: MpPlayer, _now: number): void { /* 默认不可格挡 */ }
	/** 开始重击蓄力（PF 按住上报 charge_start） */
	abstract startCharge(p: MpPlayer, now: number): void
	/** 提前松手（未蓄满，PF 上报 charge_stop） */
	abstract stopCharge(p: MpPlayer, now: number): void
	/** 重击蓄力完成（蓄满松手 wave / tick 轮询蓄满自动触发；实现内自行清理 chargeStartAt） */
	abstract heavyAttack(p: MpPlayer, timeCharged: number, now: number): void
	/** tick 轮询：蓄力达到上限返回 true → World 立刻调 heavyAttack 并停止蓄力 */
	abstract maxChargeReached(p: MpPlayer, now: number): boolean
	/** 持续行为钩子（连发剑气队列 / 激光 tick），可选 */
	tick?(p: MpPlayer, dt: number, now: number): void
}

/** 无锋剑（原双手剑）：现攻击逻辑解耦（三段近战 + 反击 / 追击裁决 + 蓄力剑气 + 连发队列），行为不变 */
class SwordWeapon extends BaseWeapon {
	weaponName = '无锋剑'
	attackTime = 0.3
	constructor(private world: World) { super() }

	/** 举盾格挡：眩晕 / 已格挡 / 格挡冷却 / 破防中拒绝，否则进入格挡（blocking=true 记录起手时刻） */
	parry(p: MpPlayer, now: number): void {
		if (p.stunUntil > now || p.blocking || now < p.blockCdUntil || now < p.guardBreakUntil) return
		p.blocking = true
		p.blockStart = now
	}

	normalAttack(p: MpPlayer, segment: number, now: number): void {
		const w = this.world
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		if (now - p.lastAttack < this.attackTime) return
		p.lastAttack = now

		// 目标选择：僵尸优先逻辑与单机一致——按距离取最近（僵尸与玩家同池）
		const tgt = w.findMeleeTarget(p)
		if (!tgt) return // 空挥

		// 反击：僵尸眩晕窗口内
		if (tgt.zombie && tgt.zombie.state === 'stunned' &&
			now - tgt.zombie.stunStart <= COUNTER_WINDOW_S && tgt.dist <= COUNTER_REACH) {
			w.damageZombie(tgt.zombie, w.playerHit(p, p.stats.atk * 3 * p.stats.dmgMul), p, now)
			w.chaseLeft = 3
			w.chaseUntil = now + CHASE_WINDOW_S
			w.events.push({ kind: 'counter_open' })
			return
		}
		// 追击：全局追击窗口
		if (w.chaseLeft > 0 && now <= w.chaseUntil) {
			w.chaseLeft--
			if (tgt.zombie) w.damageZombie(tgt.zombie, w.playerHit(p, p.stats.atk * 1.2 * p.stats.dmgMul), p, now)
			else w.damagePlayer(tgt.player!, w.playerHit(p, p.stats.atk * 1.2 * p.stats.dmgMul), p, now, false)
			return
		}
		const segMul = COMBO_MUL[((segment % 3) + 3) % 3]
		// segment 3 = 空中戳刺（伤害同首段，冲击力 25）；其余普攻段冲击力 3
		const dmg = w.playerHit(p, p.stats.atk * segMul * p.stats.dmgMul, segment === 3 ? 25 : 3)
		if (tgt.zombie) w.damageZombie(tgt.zombie, dmg, p, now)
		else w.damagePlayer(tgt.player!, dmg, p, now, false)
	}

	/** 剑的蓄力是纯 PF 本地概念（PB 只在 wave 上报时用 hold 结算），无需跟踪 */
	startCharge(_p: MpPlayer, _now: number): void { /* 剑：无 PB 侧蓄力状态 */ }
	stopCharge(_p: MpPlayer, _now: number): void { /* 剑：无 PB 侧蓄力状态 */ }

	/** 重击剑气：effHold = min(hold × chargeSpd, chargeMax)，伤害与体力结算与解耦前完全一致 */
	heavyAttack(p: MpPlayer, timeCharged: number, now: number): void {
		const w = this.world
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		// 有效蓄力时长：按住秒数 × 蓄力速度，钳到蓄力上限（伤害 = atk × 300% × effHold）
		const effHold = Math.min(timeCharged * p.stats.chargeSpd, p.stats.chargeMax)
		w.emitWave(p, now, w.chargeWaveDmg(p, effHold))
		// 蓄力消耗：每秒 10 体力（发射时一次结算，effHold 已被 chargeMax 钳制）
		w.useStamina(p, 10 * effHold, now)
		// 连续剑气：蓄力发射后每 0.1s 追发一发（眩晕 / 死亡时由 tick 中止）
		if (p.stats.multiWave > 0 && p.stunUntil <= now) {
			p.waveQueue = p.stats.multiWave
			p.waveNextAt = now + 0.1
		}
	}

	/** 蓄满不自动释放（松手才发剑气，与解耦前一致） */
	maxChargeReached(_p: MpPlayer, _now: number): boolean { return false }

	/** 连续剑气：每 0.1s 追发一发（眩晕 / 死亡中止），伤害等同满蓄力 */
	tick(p: MpPlayer, _dt: number, now: number): void {
		if (p.waveQueue <= 0 || now < p.waveNextAt) return
		if (p.hp <= 0 || p.stunUntil > now) {
			p.waveQueue = 0
			return
		}
		const w = this.world
		w.emitWave(p, now, w.chargeWaveDmg(p, p.stats.chargeMax))
		p.waveQueue--
		p.waveNextAt = now + 0.1
	}
}

/** 苍弓：普攻射球状闪电（首中附着，0.1s/3 伤持续 6s）+ 按住重击持续激光（0.2s/15 伤），蓄满爆发 40 伤 */
class BowWeapon extends BaseWeapon {
	weaponName = '苍弓'
	attackTime = 0.3
	constructor(private world: World) { super() }

	/** 苍弓不可格挡 */

	/** 射球状闪电（'shoot' 上报触发）：方向 = 准星 3D 前向 */
	normalAttack(p: MpPlayer, _segment: number, now: number): void {
		const w = this.world
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		if (now - p.lastAttack < this.attackTime) return
		p.lastAttack = now
		w.emitOrb(p, now)
	}

	/** 按住开始蓄力（持续激光由 tick 结算；眩晕 / 破防拒绝，与剑气一致） */
	startCharge(p: MpPlayer, now: number): void {
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		p.chargeStartAt = now
		p.beamNextAt = 0 // 立即射出第一段激光
	}

	/** 提前松手：激光停止，无爆发 */
	stopCharge(p: MpPlayer, _now: number): void {
		p.chargeStartAt = -1
	}

	/** 蓄满爆发：一道 40 × dmgMul 伤激光（射线判定同持续激光）后立刻停止 */
	heavyAttack(p: MpPlayer, _timeCharged: number, now: number): void {
		const w = this.world
		p.chargeStartAt = -1
		if (p.stunUntil > now || now < p.guardBreakUntil) return
		const [dx, dy, dz] = w.waveDir(p)
		w.events.push({ kind: 'beam_burst', by: p.uuid, x: p.x, y: p.y, z: p.z, dx, dy, dz })
		w.beamDamage(p, 40 * p.stats.dmgMul, 11, now)
	}

	/** 蓄力达到上限（chargeDur = chargeMax / chargeSpd，与剑同公式）→ World tick 自动触发爆发 */
	maxChargeReached(p: MpPlayer, now: number): boolean {
		return p.chargeStartAt >= 0 && now - p.chargeStartAt >= p.stats.chargeMax / p.stats.chargeSpd
	}

	/** 持续激光：蓄力中每 0.2s 对准星射线目标结算 15 × dmgMul 伤 / impact 3（穿透 + 隔墙拦截） */
	tick(p: MpPlayer, _dt: number, now: number): void {
		if (p.chargeStartAt < 0 || p.hp <= 0 || p.stunUntil > now || now < p.guardBreakUntil) return
		if (now < p.beamNextAt) return
		p.beamNextAt = now + BEAM_TICK_S
		this.world.beamDamage(p, 15 * p.stats.dmgMul, 3, now)
	}
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}

/**
 * 剑气面基：u = 飞行方向，c = 面内横轴，n = 面法线。
 * roll 绕飞行轴 u 旋转剑气面（碰撞箱与 PF 视觉共用同一公式，保证一致）。
 * 参考横轴 = cross(u, 世界上方向)，u 近垂直时退化为世界 X。
 */
function waveBasis(ux: number, uy: number, uz: number, roll: number): {
	c: [number, number, number]
	n: [number, number, number]
} {
	let c0x = -uz
	let c0y = 0
	let c0z = ux
	if (Math.hypot(c0x, c0z) < 0.01) {
		c0x = 1; c0y = 0; c0z = 0
	} else {
		const l = Math.hypot(c0x, c0z)
		c0x /= l; c0z /= l
	}
	// n0 = u × c0
	const n0x = uy * c0z - uz * c0y
	const n0y = uz * c0x - ux * c0z
	const n0z = ux * c0y - uy * c0x
	const cos = Math.cos(roll)
	const sin = Math.sin(roll)
	// c = c0·cos + n0·sin；n = u × c
	const cx = c0x * cos + n0x * sin
	const cy = c0y * cos + n0y * sin
	const cz = c0z * cos + n0z * sin
	const nx = uy * cz - uz * cy
	const ny = uz * cx - ux * cz
	const nz = ux * cy - uy * cx
	return { c: [cx, cy, cz], n: [nx, ny, nz] }
}

/**
 * 剑气扇形命中测试（跟随 roll 旋转）：剑气面内以飞行方向为轴 ±66°、
 * 半径 WAVE_RADIUS 的实心扇区，面外 ±0.45 厚度（目标点：玩家 1.0 高）。
 */
function waveHit(w: Wave, tx: number, ty: number, tz: number): boolean {
	const vx = tx - w.x
	const vy = ty - w.y
	const vz = tz - w.z
	const a = vx * w.dx + vy * w.dy + vz * w.dz // 沿飞行轴分量
	if (a < -0.3) return false // 已掠过
	// 垂直于飞行轴的分量 → 面外 / 面内横轴投影
	const rx = vx - a * w.dx
	const ry = vy - a * w.dy
	const rz = vz - a * w.dz
	const h = rx * w.nx + ry * w.ny + rz * w.nz
	if (Math.abs(h) > 0.45) return false
	const c = rx * w.cx + ry * w.cy + rz * w.cz
	if (Math.hypot(a, c) > WAVE_RADIUS) return false
	return Math.abs(Math.atan2(c, a)) <= 1.15
}

/**
 * 僵尸圆柱碰撞箱命中：碰撞箱 = 包裹全部僵尸模型的圆柱（R=Z_HIT_R、高=Z_HIT_H），
 * 用 3 层 × 5 点采样近似（任一点落入剑气扇形体即命中）。避免单点判定漏判——
 * roll 随机旋转后剑面可能近乎水平/竖直，僵尸中心单点易落在面外厚度或扇区外，
 * 表现为「视觉上月牙盖住僵尸却判未中」。
 */
function zombieWaveHit(w: Wave, zx: number, zz: number): boolean {
	for (const [ox, oy, oz] of Z_HIT_SAMPLES) {
		if (waveHit(w, zx + ox, oy, zz + oz)) return true
	}
	return false
}

/** 点到线段距离（球状闪电扫掠命中判定用，防高速隧穿） */
function pointSegDist(ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): number {
	const abx = bx - ax
	const aby = by - ay
	const abz = bz - az
	const apx = px - ax
	const apy = py - ay
	const apz = pz - az
	const len2 = abx * abx + aby * aby + abz * abz
	const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0
	return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t)
}

/**
 * 激光射线命中测试：目标点到射线垂距 ≤ hitR，且投影沿正方向、垂足距离 ≤ BEAM_RANGE
 * （穿透判定——射线上所有达标目标都结算，由 beamDamage 逐目标调用）
 */
function beamHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tx: number, ty: number, tz: number, hitR: number): boolean {
	const vx = tx - ox
	const vy = ty - oy
	const vz = tz - oz
	const a = vx * dx + vy * dy + vz * dz // 沿射线投影
	if (a < 0 || a > BEAM_RANGE) return false
	return Math.hypot(vx - a * dx, vy - a * dy, vz - a * dz) <= hitR
}

function hslHue(color: string): number | null {
	const m = /hsl\((\d+)/.exec(color)
	return m ? Number(m[1]) : null
}
