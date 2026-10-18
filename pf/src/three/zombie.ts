/**
 * Minecraft 风格僵尸（方块人模型）+ 简易 AI 状态机
 *
 * enter（从门廊穿过门洞）→ chase（追击玩家）→ windup（1s 抬手前摇）
 * → 攻击（10 伤害，耗自身 10 体力）→ recover → 循环
 * 体力耗尽 → stunned 5s（前 1s 为玩家反击窗口）→ 体力回满继续
 * HP 归零 → dead（倒地淡出）
 *
 * 边界与 SceneManager 门洞/门廊数值对齐（z 1.45–2.35 门洞，x<-3.5 为门廊）。
 */
import * as THREE from 'three'
import { getSfxDuration, playSfx } from './audio'

export type ZombieState = 'enter' | 'chase' | 'windup' | 'recover' | 'stunned' | 'dead'

export interface ZombieHooks {
  onStrike(z: Zombie): void
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

export class Zombie {
  readonly group = new THREE.Group()
  hp = 500
  readonly maxHp = 500
  stamina = 100
  readonly maxStamina = 100
  state: ZombieState = 'enter'
  stunnedAt = 0
  vulnMul = 0               // 眩晕易伤倍率（1.15~1.85，眩晕开始瞬间掷定，非眩晕时为 0）
  removeMe = false
  get dead(): boolean {
    return this.state === 'dead'
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

    switch (this.state) {
      case 'enter': {
        // 穿过门洞进入室内
        this.moveToward(-2.6, 1.9, dt, 1.0)
        if (pos.x >= -3.05) this.state = 'chase'
        break
      }
      case 'chase': {
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
          this.stamina -= ATTACK_COST
          if (this.stamina <= 0) {
            this.state = 'stunned'
            this.stunnedAt = now
            // 易伤倍率：眩晕开始的一瞬间掷定，本次眩晕期间不变（+15%~85%）
            this.vulnMul = Math.round((1.15 + Math.random() * 0.7) * 100) / 100
            this.hooks.onStun(this)
            return
          }
          this.state = 'recover'
          this.recT = 0
        }
        break
      }
      case 'recover': {
        this.recT += dt
        if (this.recT >= RECOVER_S) this.state = 'chase'
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
