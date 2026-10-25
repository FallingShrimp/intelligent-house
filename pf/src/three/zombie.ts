/**
 * Minecraft 风格僵尸（方块人模型）+ 简易 AI 状态机
 *
 * enter（从门廊穿过门洞）→ chase（追击玩家）→ windup（抬手前摇，flash-alert 音效）
 * → 攻击（10 伤害，耗自身 10 体力）→ recover → 循环
 * 体力耗尽 → stunned 5s（前 1s 为玩家反击窗口）→ 体力回满继续
 * HP 归零 → dead（倒地淡出）
 *
 * 技能（预警语言：金=可格挡普攻 / 白=不可格挡横扫 / 紫=位移突进 / 红圈=范围嘶吼）：
 * - 横扫 sweep：combat 侧观察到玩家 8s 内成功格挡 2 次 → 置位 requestSweep，
 *   近身时替换普攻：180° 扇形 12 伤害，无法格挡（破防：-15 体力 + 硬直）
 * - 突进 lunge：玩家距离 2.5–5m 且冷却就绪时概率触发，蓄力后直线冲刺锁定落点，
 *   命中 14 伤害 + 击退打断；冲空则自身僵直 1s（输出窗口）
 * - 嘶吼 roar：体力 < 35 且冷却就绪（每场最多 2 次）：0.8s 前摇（可被 ≥15 伤害打断）
 *   → 3m 冲击波：玩家 -25 体力 + 减速 1s，自身回 30 体力推迟眩晕
 *
 * 边界与 SceneManager 门洞/门廊数值对齐（z 1.45–2.35 门洞，x<-3.5 为门廊）。
 */
import * as THREE from 'three'
import { getSfxDuration, playSfx, type SfxName } from './audio'

export type ZombieState =
  | 'enter' | 'chase' | 'windup' | 'recover' | 'stunned' | 'dead'
  | 'sweep' | 'lungeWind' | 'lungeDash' | 'roar'

/** 僵尸技能预警类型（驱动准星四角星颜色） */
export type ZombieTelegraph = 'normal' | 'sweep' | 'lunge' | null

export interface ZombieHooks {
  onStrike(z: Zombie): void            // 普攻落手
  onSweep(z: Zombie): void             // 横扫落手
  onLunge(z: Zombie, dirX: number, dirZ: number): void // 突进命中（dirX/Z 为击退方向）
  onRoar(z: Zombie): void              // 嘶吼冲击波命中
  onRoarInterrupt(z: Zombie): void     // 嘶吼被打断
  onStun(z: Zombie): void
  onDeath(z: Zombie): void
}

const CHASE_SPEED = 0.95      // 追击速度 m/s
const ATTACK_RANGE = 1.7      // 进入攻击距离
const STRIKE_RANGE = 2.15     // 前摇结束时仍在此范围内才命中
const WINDUP_S = 1.0          // 抬手前摇时长（实际以 flash-alert 音效时长为准，见 strikeAt）
const RECOVER_S = 1.1         // 攻击后摇
const STUN_S = 5.0            // 眩晕时长
const ATTACK_COST = 10        // 每次攻击消耗体力

// 技能参数
const SWEEP_COST = 15         // 横扫体力消耗
const SWEEP_CD = 8            // 横扫冷却 s
const SWEEP_RANGE = 2.2       // 横扫判定半径
const LUNGE_COST = 20         // 突进体力消耗
const LUNGE_CD = 10           // 突进冷却 s
const LUNGE_MIN = 2.5         // 突进触发最小距离
const LUNGE_MAX = 5.0         // 突进触发最大距离
const LUNGE_SPEED = 8.0       // 突进冲刺速度 m/s
const LUNGE_HIT_R = 1.2       // 突进命中半径
const LUNGE_TIMEOUT = 1.2     // 突进最长冲刺时间 s
const ROAR_CD = 25            // 嘶吼冷却 s
const ROAR_MAX_USES = 2       // 每场最多嘶吼次数
const ROAR_HEAL = 30          // 嘶吼回体力
const ROAR_RADIUS = 3.0       // 嘶吼冲击波半径

export class Zombie {
  readonly group = new THREE.Group()
  hp = 500
  readonly maxHp = 500
  stamina = 100
  readonly maxStamina = 100
  state: ZombieState = 'enter'
  stunnedAt = 0
  vulnMul = 0               // 眩晕易伤倍率（1.15~1.85，眩晕开始瞬间掷定，非眩晕时为 0）
  requestSweep = false      // combat 侧检测到玩家连续格挡后置位 → 近身时替换普攻
  removeMe = false
  get dead(): boolean {
    return this.state === 'dead'
  }

  /** 当前技能预警类型（供 HUD 四角星变色） */
  get telegraph(): ZombieTelegraph {
    if (this.state === 'windup') return 'normal'
    if (this.state === 'sweep') return 'sweep'
    if (this.state === 'lungeWind') return 'lunge'
    return null
  }

  private windT = 0
  private strikeAt = WINDUP_S  // 本次前摇的落手判定时刻（= flash-alert 音效时长，声音结束即伤害）
  private recT = 0
  private walkT = 0
  private deathT = 0
  private spawnT = 0
  private flashT = 0
  private yaw = Math.PI / 2
  private mats: THREE.MeshStandardMaterial[] = []
  private armL!: THREE.Group
  private armR!: THREE.Group
  private legL!: THREE.Group
  private legR!: THREE.Group
  private body!: THREE.Mesh
  private ring!: THREE.Mesh             // 嘶吼地面预警圈
  // 技能冷却 / 状态
  private sweepCdUntil = 0
  private lungeCdUntil = 0
  private roarCdUntil = 0
  private roarUses = 0
  private dashTo = new THREE.Vector3()  // 突进锁定落点
  private dashT = 0                     // 突进已冲刺时间
  private recExtra = 0                  // 突进落空 / 嘶吼被打断的额外僵直

  private hooks: ZombieHooks

  constructor(hooks: ZombieHooks) {
    this.hooks = hooks
    this.build()
    this.group.scale.y = 0 // 出生时从地面钻出
  }

  // ---------------- 模型 ----------------

  private build() {
    const mkMat = (color: string) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
      this.mats.push(m)
      return m
    }
    const skin = mkMat('#4f8f3f')
    const shirt = mkMat('#2f7d7d')
    const pants = mkMat('#3a3a6e')
    const dark = mkMat('#1d3a17')
    const box = (w: number, h: number, d: number, m: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      mesh.castShadow = true
      return mesh
    }

    // 腿（髋部枢轴，行走摆动）
    const mkLeg = (x: number) => {
      const pivot = new THREE.Group()
      pivot.position.set(x, 0.72, 0)
      const leg = box(0.24, 0.72, 0.24, pants)
      leg.position.y = -0.36
      pivot.add(leg)
      this.group.add(pivot)
      return pivot
    }
    this.legL = mkLeg(-0.13)
    this.legR = mkLeg(0.13)

    // 躯干
    this.body = box(0.5, 0.72, 0.26, shirt)
    this.body.position.y = 1.08
    this.group.add(this.body)

    // 手臂（肩部枢轴，僵尸经典前伸姿势）
    const mkArm = (x: number) => {
      const pivot = new THREE.Group()
      pivot.position.set(x, 1.4, 0)
      const arm = box(0.22, 0.72, 0.22, skin)
      arm.position.y = -0.32
      pivot.add(arm)
      pivot.rotation.x = -1.35
      this.group.add(pivot)
      return pivot
    }
    this.armL = mkArm(-0.36)
    this.armR = mkArm(0.36)

    // 头（脸朝 +Z）+ 眼嘴
    const head = box(0.5, 0.5, 0.5, skin)
    head.position.y = 1.72
    this.group.add(head)
    for (const x of [-0.12, 0.12]) {
      const eye = box(0.09, 0.09, 0.02, dark)
      eye.position.set(x, 0.06, 0.26)
      eye.castShadow = false
      head.add(eye)
    }
    const mouth = box(0.2, 0.05, 0.02, dark)
    mouth.position.set(0, -0.14, 0.26)
    mouth.castShadow = false
    head.add(mouth)

    // 嘶吼地面预警圈（红色，默认隐藏）
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(ROAR_RADIUS - 0.28, ROAR_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.03
    this.ring.visible = false
    this.group.add(this.ring)

    this.group.scale.setScalar(0.95)
  }

  // ---------------- 位置 / 状态查询 ----------------

  get headPos(): THREE.Vector3 {
    return new THREE.Vector3(this.group.position.x, this.group.position.y + 1.63, this.group.position.z)
  }

  get centerPos(): THREE.Vector3 {
    return new THREE.Vector3(this.group.position.x, this.group.position.y + 1.05, this.group.position.z)
  }

  // ---------------- 战斗接口 ----------------

  takeDamage(n: number, fromPos?: THREE.Vector3) {
    if (this.dead) return
    // 眩晕易伤：眩晕期间受到伤害乘以定死的随机倍率（+15%~85%）
    const dmg = this.vulnMul > 0 ? Math.round(n * this.vulnMul) : n
    this.hp = Math.max(0, this.hp - dmg)
    this.flashT = 0.12
    // 嘶吼前摇中受到 ≥15 伤害 → 打断（踉跄后摇，奖励主动进攻）
    if (this.state === 'roar' && dmg >= 15) {
      this.hideRoarRing()
      this.state = 'recover'
      this.recT = 0
      this.recExtra = 0.55
      this.hooks.onRoarInterrupt(this)
    }
    if (fromPos) {
      const pos = this.group.position
      const dx = pos.x - fromPos.x
      const dz = pos.z - fromPos.z
      const d = Math.hypot(dx, dz) || 1
      pos.x += (dx / d) * 0.12
      pos.z += (dz / d) * 0.12
    }
    if (this.hp <= 0) {
      this.state = 'dead'
      this.hooks.onDeath(this)
    }
  }

  drainStamina(n: number) {
    this.stamina = Math.max(0, this.stamina - n)
  }

  /** 被完美格挡后的踉跄：延长后摇 */
  stagger(extra: number) {
    if (this.state === 'recover') this.recT = Math.max(0, this.recT - extra)
  }

  // ---------------- 帧更新 ----------------

  update(dt: number, now: number, playerPos: THREE.Vector3, zombies: Zombie[], active: boolean) {
    // 出生：从地面钻出
    if (this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.45)
      this.group.scale.y = 0.95 * this.spawnT
    }

    // 受击红闪
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt)
      const on = this.flashT > 0
      for (const m of this.mats) {
        m.emissive.setHex(on ? 0xff3b30 : 0x000000)
        m.emissiveIntensity = on ? 0.7 : 0
      }
    }

    // 死亡：后仰倒地 → 淡出
    if (this.state === 'dead') {
      this.hideRoarRing()
      this.deathT += dt
      const fall = Math.min(1, this.deathT / 0.5)
      this.group.rotation.x = -fall * 1.45
      this.group.position.y = -fall * 0.06
      if (this.deathT > 1.0) {
        const op = Math.max(0, 1 - (this.deathT - 1.0) / 0.6)
        for (const m of this.mats) {
          m.transparent = true
          m.opacity = op
        }
      }
      if (this.deathT > 1.7) this.removeMe = true
      return
    }

    if (!active) return

    // 眩晕：前倾摇晃，前 1s 为反击窗口（由 combat 检查 stunnedAt）
    if (this.state === 'stunned') {
      if (now - this.stunnedAt >= STUN_S) {
        this.stamina = this.maxStamina
        this.vulnMul = 0 // 眩晕结束，易伤消失
        this.state = 'chase'
      } else {
        this.body.rotation.x = 0.3
        this.body.rotation.z = Math.sin(now * 5) * 0.1
        this.armL.rotation.x = -0.3
        this.armR.rotation.x = -0.3
        this.group.rotation.z = Math.sin(now * 6) * 0.05
        return
      }
    }
    this.body.rotation.set(0, 0, 0)
    this.group.rotation.z = 0

    const pos = this.group.position
    const dx = playerPos.x - pos.x
    const dz = playerPos.z - pos.z
    const dist = Math.hypot(dx, dz)

    // 嘶吼触发：濒临眩晕时保命，优先于一切行动（chase / windup / recover 均可打断自身）
    if (
      (this.state === 'chase' || this.state === 'windup' || this.state === 'recover') &&
      this.stamina < 35 && this.roarUses < ROAR_MAX_USES && now >= this.roarCdUntil
    ) {
      this.state = 'roar'
      this.windT = 0
      this.strikeAt = this.skillDur('roar', 0.8)
      playSfx('roar')
    }

    switch (this.state) {
      case 'enter': {
        // 穿过门洞进入室内
        this.moveToward(-2.6, 1.9, dt, 1.0)
        if (pos.x >= -3.05) this.state = 'chase'
        break
      }
      case 'chase': {
        // 技能优先级：横扫（combat 预约）> 突进（中距离概率触发）> 普攻
        if (this.requestSweep && dist <= SWEEP_RANGE && now >= this.sweepCdUntil) {
          this.requestSweep = false
          this.startSkill('sweep', now)
          break
        }
        if (
          dist >= LUNGE_MIN && dist <= LUNGE_MAX && now >= this.lungeCdUntil &&
          Math.random() < 1 - Math.exp(-1.6 * dt) // 约 1.6 次/s 的期望触发率，避免瞬时必发
        ) {
          this.startSkill('lunge', now)
          break
        }
        if (dist <= ATTACK_RANGE) {
          this.state = 'windup'
          this.windT = 0
          // 攻击预警音：前摇时长对齐音效时长，声音结束的瞬间落手结算伤害
          playSfx('flashAlert')
          this.strikeAt = Math.max(getSfxDuration('flashAlert') ?? WINDUP_S, 0.5)
        } else if (dist > 1.15) {
          this.moveToward(playerPos.x, playerPos.z, dt, CHASE_SPEED)
        } else {
          this.faceTo(dx, dz, dt)
        }
        break
      }
      case 'windup': {
        this.windT += dt
        this.faceTo(dx, dz, dt)
        // 抬手前摇：双臂高举 + 微颤（可读的攻击预警）
        const raise = Math.min(1, this.windT / this.strikeAt)
        const tremble = Math.sin(now * 30) * 0.03
        this.armL.rotation.x = -1.35 - raise * 1.1 + tremble
        this.armR.rotation.x = -1.35 - raise * 1.1 - tremble
        this.body.rotation.x = -raise * 0.15
        if (this.windT >= this.strikeAt) {
          // 落手判定
          this.armL.rotation.x = -0.7
          this.armR.rotation.x = -0.7
          if (dist <= STRIKE_RANGE && Math.abs(playerPos.y - 1.0) < 2.2) {
            this.hooks.onStrike(this)
          }
          if (this.spendStamina(ATTACK_COST, now)) return
          this.state = 'recover'
          this.recT = 0
          this.recExtra = 0
        }
        break
      }
      case 'sweep': {
        // 横扫前摇：双臂横向张开
        this.windT += dt
        this.faceTo(dx, dz, dt)
        const p = Math.min(1, this.windT / this.strikeAt)
        this.armL.rotation.x = -1.35
        this.armR.rotation.x = -1.35
        this.armL.rotation.z = p * 1.25
        this.armR.rotation.z = -p * 1.25
        this.body.rotation.y = Math.sin(p * Math.PI) * 0.35
        if (this.windT >= this.strikeAt) {
          this.armL.rotation.z = 0
          this.armR.rotation.z = 0
          this.body.rotation.y = 0
          // 180° 扇形判定：面向玩家方向 ±90°（无法格挡，由 combat 结算破防）
          let diff = Math.abs(Math.atan2(dx, dz) - this.yaw)
          while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2)
          if (diff <= Math.PI / 2 + 0.15 && dist <= SWEEP_RANGE && playerPos.y - 1.0 < 1.8) {
            this.hooks.onSweep(this)
          }
          if (this.spendStamina(SWEEP_COST, now)) return
          this.sweepCdUntil = now + SWEEP_CD
          this.state = 'recover'
          this.recT = 0
          this.recExtra = 0
        }
        break
      }
      case 'lungeWind': {
        // 蓄力：压低身体蹲伏
        this.windT += dt
        this.faceTo(dx, dz, dt)
        const p = Math.min(1, this.windT / this.strikeAt)
        this.body.rotation.x = 0.5 * p
        this.legL.rotation.x = 0.65 * p
        this.legR.rotation.x = 0.65 * p
        this.armL.rotation.x = -0.2 * p
        this.armR.rotation.x = -0.2 * p
        if (this.windT >= this.strikeAt) {
          // 锁定当前位置为冲刺落点，直线冲刺
          this.dashTo.set(playerPos.x, 0, playerPos.z)
          this.dashT = 0
          this.state = 'lungeDash'
        }
        break
      }
      case 'lungeDash': {
        // 冲刺：超高速直线移动，途中接触即命中
        this.dashT += dt
        this.faceTo(dx, dz, dt)
        const rdx = this.dashTo.x - pos.x
        const rdz = this.dashTo.z - pos.z
        const remain = Math.hypot(rdx, rdz)
        const step = Math.min(LUNGE_SPEED * dt, remain)
        if (remain > 1e-3) {
          pos.x += (rdx / remain) * step
          pos.z += (rdz / remain) * step
        }
        // 冲刺姿态：双臂前伸 + 前倾
        this.armL.rotation.x = -1.6
        this.armR.rotation.x = -1.6
        this.body.rotation.x = 0.35
        const hitPlayer = Math.hypot(dx, dz) <= LUNGE_HIT_R && Math.abs(playerPos.y - 1.0) < 2.2
        if (hitPlayer) {
          this.hooks.onLunge(this, dx / (Math.hypot(dx, dz) || 1), dz / (Math.hypot(dx, dz) || 1))
        }
        if (hitPlayer || remain <= 0.05 || this.dashT >= LUNGE_TIMEOUT) {
          // 命中或冲空：耗体力，冲空给玩家 1s 输出窗口（额外僵直）
          if (this.spendStamina(LUNGE_COST, now)) return
          this.lungeCdUntil = now + LUNGE_CD
          this.state = 'recover'
          this.recT = 0
          this.recExtra = hitPlayer ? 0 : 0.55
        }
        break
      }
      case 'roar': {
        // 嘶吼前摇：后仰张嘴 + 地面红圈扩张
        this.windT += dt
        this.faceTo(dx, dz, dt)
        const p = Math.min(1, this.windT / this.strikeAt)
        this.body.rotation.x = -0.45 * p
        this.armL.rotation.x = 0.45 * p
        this.armR.rotation.x = 0.45 * p
        this.ring.visible = true
        const rm = this.ring.material as THREE.MeshBasicMaterial
        rm.opacity = 0.25 + 0.5 * p
        this.ring.scale.setScalar(0.35 + 0.65 * p)
        if (this.windT >= this.strikeAt) {
          this.hideRoarRing()
          if (dist <= ROAR_RADIUS) this.hooks.onRoar(this)
          // 自身回体力推迟眩晕
          this.stamina = Math.min(this.maxStamina, this.stamina + ROAR_HEAL)
          this.roarUses++
          this.roarCdUntil = now + ROAR_CD
          this.state = 'recover'
          this.recT = 0
          this.recExtra = 0
        }
        break
      }
      case 'recover': {
        this.recT += dt
        if (this.recT >= RECOVER_S + this.recExtra) {
          this.recExtra = 0
          this.state = 'chase'
        }
        break
      }
    }

    // 行走摆腿 / 摆臂
    if (this.state === 'chase' || this.state === 'enter') {
      this.legL.rotation.x = Math.sin(this.walkT * 7) * 0.55
      this.legR.rotation.x = -Math.sin(this.walkT * 7) * 0.55
      this.armL.rotation.x = -1.35 + Math.sin(this.walkT * 7) * 0.1
      this.armR.rotation.x = -1.35 - Math.sin(this.walkT * 7) * 0.1
    }

    // 同伴分离：避免僵尸互相重叠
    for (const o of zombies) {
      if (o === this || o.dead) continue
      const ddx = pos.x - o.group.position.x
      const ddz = pos.z - o.group.position.z
      const dd = Math.hypot(ddx, ddz)
      if (dd > 1e-3 && dd < 0.7) {
        pos.x += (ddx / dd) * dt * 0.6
        pos.z += (ddz / dd) * dt * 0.6
      }
    }

    this.clampToBounds(pos)
  }

  // ---------------- 私有 ----------------

  /** 技能前摇时长：对齐音效时长（声音结束即结算），下限 0.5s */
  private skillDur(name: SfxName, fallback: number) {
    return Math.max(getSfxDuration(name) ?? fallback, 0.5)
  }

  /** 开始技能前摇：播放对应音效并设定前摇时长 */
  private startSkill(kind: 'sweep' | 'lunge', now: number) {
    void now
    if (kind === 'sweep') {
      playSfx('sweep')
      this.strikeAt = this.skillDur('sweep', 1.2)
      this.state = 'sweep'
    } else {
      playSfx('lunge')
      this.strikeAt = this.skillDur('lunge', 0.6)
      this.state = 'lungeWind'
    }
    this.windT = 0
  }

  /** 消耗体力，耗尽则进入眩晕（掷定易伤倍率），返回是否已眩晕 */
  private spendStamina(n: number, now: number): boolean {
    this.stamina = Math.max(0, this.stamina - n)
    if (this.stamina <= 0) {
      this.state = 'stunned'
      this.stunnedAt = now
      // 易伤倍率：眩晕开始的一瞬间掷定，本次眩晕期间不变（+15%~85%）
      this.vulnMul = Math.round((1.15 + Math.random() * 0.7) * 100) / 100
      this.hooks.onStun(this)
      return true
    }
    return false
  }

  private hideRoarRing() {
    this.ring.visible = false
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0
    this.ring.scale.setScalar(0.35)
  }

  private moveToward(tx: number, tz: number, dt: number, speed: number) {
    const pos = this.group.position
    const dx = tx - pos.x
    const dz = tz - pos.z
    const d = Math.hypot(dx, dz)
    if (d < 0.05) return
    const step = Math.min(speed * dt, d)
    pos.x += (dx / d) * step
    pos.z += (dz / d) * step
    this.walkT += dt * speed
    this.faceTo(dx, dz, dt)
  }

  private faceTo(dx: number, dz: number, dt: number) {
    const target = Math.atan2(dx, dz)
    let diff = target - this.yaw
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    this.yaw += diff * Math.min(1, dt * 8)
    this.group.rotation.y = this.yaw
  }

  private clampToBounds(p: THREE.Vector3) {
    if (p.x < -3.5) {
      // 门廊内：z 锁门洞走廊
      p.z = THREE.MathUtils.clamp(p.z, 1.3, 2.5)
      p.x = Math.max(p.x, -5.45)
    } else {
      // 室内：房间范围（僵尸只会经门洞 z≈1.9 穿行）
      p.x = THREE.MathUtils.clamp(p.x, -3.4, 3.4)
      p.z = THREE.MathUtils.clamp(p.z, -2.6, 2.9)
    }
  }
}
