/**
 * 僵尸网络渲染器（PB 权威世界模拟的 PF 表现层）
 *
 * AI 状态机已移至 PB（world.ts）：PF 只接收 10Hz 世界快照，
 * 在这里完成 插值移动 / 状态动画 / 受击闪红 / 出生钻出 / 死亡倒地淡出。
 * 动画节奏由 PB 下发的 state（状态名）+ st_t（已持续秒数）+ windup_dur（前摇总长）驱动。
 *
 * 模型与动画完全沿用单机版 Minecraft 方块僵尸；技能预警语言：
 * 金=可格挡普攻 / 白=不可格挡横扫 / 紫=位移突进 / 红圈=范围嘶吼。
 */
import * as THREE from 'three'

import type { NetZombieState, ZNetState } from '../protocol/messages'

export type { ZNetState }

/** 状态切换回调（SceneManager 据此播放 flashAlert / sweep / lunge / roar 音效） */
export type NetZombieStateChange = (from: ZNetState, to: ZNetState) => void

const ROAR_RADIUS = 3.0 // 与 PB world.ts 嘶吼半径一致（预警圈绘制用）

export class NetZombie {
  readonly group = new THREE.Group()
  readonly id: number
  state: ZNetState = 'enter'
  hp = 500
  /** 血量上限：随快照 max_hp 同步（补员僵尸世代递增），HUD 血条比例分母 */
  maxHp = 500
  stamina = 100
  readonly maxStamina = 100
  vulnMul = 0
  hasTarget = false
  removeMe = false
  get dead(): boolean {
    return this.state === 'dead'
  }

  /** 网络目标（10Hz 快照落点，逐帧插值逼近） */
  private netX = 0
  private netZ = 0
  private netYaw = Math.PI / 2
  private stT = 0            // 当前状态已持续秒（快照校准 + 帧间推进）
  private windupDur = 1.0
  private deathT = 0
  private spawnT = 0
  private flashT = 0
  private walkT = 0
  private lastPos = new THREE.Vector3()
  private mats: THREE.MeshStandardMaterial[] = []
  private armL!: THREE.Group
  private armR!: THREE.Group
  private legL!: THREE.Group
  private legR!: THREE.Group
  private body!: THREE.Mesh
  private ring!: THREE.Mesh
  private onStateChange?: NetZombieStateChange

  constructor(id: number, s: NetZombieState, onStateChange?: NetZombieStateChange) {
    this.id = id
    this.onStateChange = onStateChange
    this.build()
    this.group.scale.y = 0
    this.applyState(s, true)
  }

  // ---------------- 模型（与单机版一致） ----------------

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
    this.body = box(0.5, 0.72, 0.26, shirt)
    this.body.position.y = 1.08
    this.group.add(this.body)
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

  // ---------------- 状态应用 ----------------

  applyState(s: NetZombieState, first = false) {
    const prev = this.state
    this.hp = s.hp
    this.maxHp = s.max_hp || 500
    this.stamina = s.st
    this.vulnMul = s.vuln
    this.hasTarget = s.target
    this.netX = s.p[0]
    this.netZ = s.p[2]
    this.netYaw = s.yaw
    if (first) {
      this.state = s.state
      this.stT = s.st_t
      this.windupDur = s.windup_dur
      this.group.position.set(s.p[0], 0, s.p[2])
      this.group.rotation.y = s.yaw
      this.lastPos.copy(this.group.position)
      return
    }
    if (s.state !== prev) {
      this.onStateChange?.(prev, s.state)
      if (s.state === 'dead') this.deathT = 0
      if (prev === 'dead' && s.state !== 'dead') this.deathT = 0
    }
    this.state = s.state
    this.stT = s.st_t
    this.windupDur = s.windup_dur
  }

  /** 受击闪红（dmg_z 事件触发） */
  flash() {
    this.flashT = 0.12
  }

  // ---------------- 位置查询 ----------------

  get headPos(): THREE.Vector3 {
    return new THREE.Vector3(this.group.position.x, this.group.position.y + 1.63, this.group.position.z)
  }

  get centerPos(): THREE.Vector3 {
    return new THREE.Vector3(this.group.position.x, this.group.position.y + 1.05, this.group.position.z)
  }

  // ---------------- 帧更新 ----------------

  update(dt: number, now: number) {
    const pos = this.group.position

    // 出生钻出：enter 状态前 0.45s 由地面升起；其余状态（刷新后快照直建的
    // 已在场僵尸等）一律恢复完整高度——构造器将 scale.y 置 0，必须在此复位
    if (this.state === 'enter' && this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.45)
      this.group.scale.y = 0.95 * this.spawnT
    } else if (this.group.scale.y !== 0.95) {
      this.group.scale.y = 0.95
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

    // 死亡：后仰倒地 → 淡出（deathT 本地推进，快照只保证状态翻转）
    if (this.state === 'dead') {
      this.hideRoarRing()
      this.deathT += dt
      const fall = Math.min(1, this.deathT / 0.5)
      this.group.rotation.x = -fall * 1.45
      pos.y = -fall * 0.06
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

    // 位置插值（10Hz 快照之间平滑；冲刺时收紧跟随）
    const k = Math.min(1, dt * (this.state === 'lungeDash' ? 16 : 10))
    pos.x += (this.netX - pos.x) * k
    pos.z += (this.netZ - pos.z) * k
    let yd = this.netYaw - this.group.rotation.y
    while (yd > Math.PI) yd -= Math.PI * 2
    while (yd < -Math.PI) yd += Math.PI * 2
    this.group.rotation.y += yd * Math.min(1, dt * 10)

    // 行走摆腿（位置在动才摆）
    const moved = pos.distanceTo(this.lastPos) > 0.001
    this.lastPos.copy(pos)
    const walking = moved && (this.state === 'chase' || this.state === 'enter')
    if (walking) this.walkT += dt * 7

    // 状态动画（stT 帧间推进，快照校准）
    this.stT += dt
    switch (this.state) {
      case 'stunned': {
        this.body.rotation.set(0.3, 0, Math.sin(now * 5) * 0.1)
        this.armL.rotation.x = -0.3
        this.armR.rotation.x = -0.3
        this.group.rotation.z = Math.sin(now * 6) * 0.05
        return
      }
      case 'windup': {
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        const raise = Math.min(1, this.stT / this.windupDur)
        const tremble = Math.sin(now * 30) * 0.03
        this.armL.rotation.x = -1.35 - raise * 1.1 + tremble
        this.armR.rotation.x = -1.35 - raise * 1.1 - tremble
        this.body.rotation.x = -raise * 0.15
        break
      }
      case 'sweep': {
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        const p = Math.min(1, this.stT / this.windupDur)
        this.armL.rotation.x = -1.35
        this.armR.rotation.x = -1.35
        this.armL.rotation.z = p * 1.25
        this.armR.rotation.z = -p * 1.25
        this.body.rotation.y = Math.sin(p * Math.PI) * 0.35
        if (this.stT >= this.windupDur) {
          this.armL.rotation.z = 0
          this.armR.rotation.z = 0
          this.body.rotation.y = 0
        }
        break
      }
      case 'lungeWind': {
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        const p = Math.min(1, this.stT / this.windupDur)
        this.body.rotation.x = 0.5 * p
        this.legL.rotation.x = 0.65 * p
        this.legR.rotation.x = 0.65 * p
        this.armL.rotation.x = -0.2 * p
        this.armR.rotation.x = -0.2 * p
        break
      }
      case 'lungeDash': {
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        this.armL.rotation.x = -1.6
        this.armR.rotation.x = -1.6
        this.body.rotation.x = 0.35
        break
      }
      case 'roar': {
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        const p = Math.min(1, this.stT / this.windupDur)
        this.body.rotation.x = -0.45 * p
        this.armL.rotation.x = 0.45 * p
        this.armR.rotation.x = 0.45 * p
        this.ring.visible = true
        const rm = this.ring.material as THREE.MeshBasicMaterial
        rm.opacity = 0.25 + 0.5 * p
        this.ring.scale.setScalar(0.35 + 0.65 * p)
        break
      }
      default: {
        // chase / enter / recover：复位姿态 + 行走摆动
        this.body.rotation.set(0, 0, 0)
        this.group.rotation.z = 0
        this.hideRoarRing()
        if (walking) {
          this.legL.rotation.x = Math.sin(this.walkT) * 0.55
          this.legR.rotation.x = -Math.sin(this.walkT) * 0.55
          this.armL.rotation.x = -1.35 + Math.sin(this.walkT) * 0.1
          this.armR.rotation.x = -1.35 - Math.sin(this.walkT) * 0.1
        } else {
          this.legL.rotation.x *= 1 - Math.min(1, dt * 10)
          this.legR.rotation.x *= 1 - Math.min(1, dt * 10)
          this.armL.rotation.x += (-1.35 - this.armL.rotation.x) * Math.min(1, dt * 8)
          this.armR.rotation.x += (-1.35 - this.armR.rotation.x) * Math.min(1, dt * 8)
        }
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    this.group.removeFromParent()
  }

  private hideRoarRing() {
    this.ring.visible = false
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0
    this.ring.scale.setScalar(0.35)
  }
}
