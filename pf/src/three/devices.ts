/**
 * 设备模型与状态动画：吸顶灯 / 窗帘 / 空调 / 电视 / 门锁 / 紧急呼叫。
 *
 * 设计：buildDevices() 返回 DeviceRigs；PF 收到 device_state_update 后
 * 由 SceneManager.applyDeviceState() 调 apply(state, animate)，
 * 内部用 TweenSystem 启动过渡补间，动画由统一渲染循环驱动（update）。
 * 全部几何体为程序化生成，不加载外部模型文件。
 */
import * as THREE from 'three'
import type { DeviceState, LightState } from '../protocol/messages'
import { ROOM, WINDOW, type RoomRig } from './room'
import { TweenSystem } from './tween'

/** 主灯最大强度（candela；three r155+ 为物理光照单位） */
const MAX_LIGHT_INTENSITY = 90

/** 色温两端颜色：2700K 暖黄 ↔ 6500K 冷白（docs 3.2：Color.lerpColors 插值） */
const KELVIN_WARM = new THREE.Color(0xffb46b)
const KELVIN_COOL = new THREE.Color(0xeaf2ff)

/** 紧急闪烁红色 */
const EMERGENCY_RED = new THREE.Color(0xff2020)
const WHITE = new THREE.Color(0xffffff)

/** 2700–6500K 线性插值到颜色 */
function kelvinToColor(kelvin: number, out: THREE.Color): THREE.Color {
  const t = (kelvin - 2700) / (6500 - 2700)
  return out.lerpColors(KELVIN_WARM, KELVIN_COOL, Math.min(1, Math.max(0, t)))
}

export interface DeviceRigs {
  /** 应用设备状态（animate=false 时瞬时落位，用于全量快照首次同步） */
  apply(state: DeviceState, animate: boolean): void
  /** 每帧驱动：补间推进、风口摆动、紧急红闪等 */
  update(dt: number, time: number): void
  /** 可交互对象（userData.interact 标签：door / tv / ac），供射线拾取 */
  interactables: THREE.Object3D[]
  /** 开/关门门板摆动（本地视觉动画；是否允许开门由后端同步的 locked 状态校验） */
  setDoorOpen(open: boolean, animate?: boolean): void
  dispose(): void
}

export function buildDevices(
  scene: THREE.Scene,
  room: RoomRig,
  tweens: TweenSystem,
): DeviceRigs {
  const disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = []
  const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => {
    disposables.push(x)
    return x
  }
  const mat = (params: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(params))
  const box = (w: number, h: number, d: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  // ============================================================
  // living_room_light：吸顶灯（灯座 + 半球灯罩 + PointLight）
  // ============================================================
  const { W, D, H } = ROOM
  const lampGroup = new THREE.Group()
  lampGroup.position.set(0, H, 0)
  const baseMat = mat({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.3 })
  const lampBase = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.36, 0.05, 32)), baseMat)
  lampBase.position.y = -0.025
  const shadeMat = mat({
    color: 0xfdfdf6,
    roughness: 0.6,
    emissive: 0xffffff,
    emissiveIntensity: 0.03,
  })
  // 下半球灯罩（θ 从 π/2 到 π）
  const shade = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.28, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)),
    shadeMat,
  )
  shade.position.y = -0.05
  lampGroup.add(lampBase, shade)
  scene.add(lampGroup)

  const point = new THREE.PointLight(0xffffff, 0, 14, 2)
  point.position.set(0, H - 0.55, 0)
  point.castShadow = true
  point.shadow.mapSize.set(1024, 1024)
  point.shadow.bias = -0.004
  scene.add(point)

  /** 环境光增量（0–0.35），随主灯亮度变化，update 中与基础值合成 */
  let ambientBoost = 0
  /** 紧急模式下用于恢复主灯的目标状态 */
  let lastLightState: LightState | null = null

  function targetIntensity(s: LightState): number {
    return s.on ? MAX_LIGHT_INTENSITY * (s.brightness / 100) ** 0.8 : 0
  }

  function applyLight(s: LightState, animate: boolean) {
    lastLightState = s
    const fromColor = point.color.clone()
    const toColor = kelvinToColor(s.color_temp, new THREE.Color())
    // 亮度渐变（0.5s，docs 3.2）
    tweens.start('light.intensity', point.intensity, targetIntensity(s), animate ? 0.5 : 0, (v) => {
      point.intensity = v
      const ratio = v / MAX_LIGHT_INTENSITY
      shadeMat.emissiveIntensity = 0.03 + 1.5 * ratio
      ambientBoost = 0.35 * ratio // 照度随主灯状态叠加
    })
    // 色温插值（0.5s）
    tweens.start('light.color', 0, 1, animate ? 0.5 : 0, (k) => {
      point.color.lerpColors(fromColor, toColor, k)
      shadeMat.emissive.copy(point.color)
    }, (t) => t) // 线性即可
  }

  // ============================================================
  // living_room_curtain：轨道 + 两片褶皱帘（2.5s 缓动开合）
  // ============================================================
  const railY = WINDOW.y1 + 0.12
  const railZ = -D / 2 + 0.18 // 窗内侧
  const railHalf = 1.9        // 轨道半长
  const curtainW = 1.2        // 单片帘宽
  const closedOff = 0.62      // 全合（position=0）时片中心偏移
  const openOff = 1.3         // 全开（position=100）时片中心偏移

  const curtainGroup = new THREE.Group()
  const railMat = mat({ color: 0x9a9a9a, roughness: 0.35, metalness: 0.7 })
  const rail = new THREE.Mesh(track(new THREE.CylinderGeometry(0.02, 0.02, railHalf * 2, 12)), railMat)
  rail.rotation.z = Math.PI / 2
  rail.position.set(WINDOW.cx, railY, railZ)
  curtainGroup.add(rail)

  const curtainMat = mat({ color: 0xd9cfbc, roughness: 1, side: THREE.DoubleSide })
  const curtainGeo = track(new THREE.PlaneGeometry(curtainW, 1.52, 28, 1))
  // 顶点做正弦褶皱
  const posAttr = curtainGeo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i)
    posAttr.setZ(i, Math.sin(x * Math.PI * 9) * 0.035)
  }
  posAttr.needsUpdate = true
  curtainGeo.computeVertexNormals()

  const curtainL = new THREE.Mesh(curtainGeo, curtainMat)
  const curtainR = new THREE.Mesh(curtainGeo, curtainMat)
  for (const c of [curtainL, curtainR]) {
    c.castShadow = true
    c.receiveShadow = true
    c.position.set(WINDOW.cx, railY - 0.76, railZ)
    curtainGroup.add(c)
  }
  scene.add(curtainGroup)

  let displayedPos = 0 // 当前显示的 position（0–100）
  function placeCurtain(p: number) {
    const off = closedOff + (openOff - closedOff) * (p / 100)
    curtainL.position.x = WINDOW.cx - off
    curtainR.position.x = WINDOW.cx + off
  }
  placeCurtain(0)

  // ============================================================
  // air_conditioner：壁挂机（机体 + CanvasTexture 温度显示 + 出风叶片）
  // ============================================================
  const acGroup = new THREE.Group()
  acGroup.position.set(-1.9, 2.15, -D / 2 + 0.15)
  const acBodyMat = mat({ color: 0xf5f5f2, roughness: 0.35, metalness: 0.1 })
  const acBody = box(1.0, 0.32, 0.26, acBodyMat)
  const acLip = box(1.0, 0.03, 0.28, mat({ color: 0xdcdcd8, roughness: 0.5 }))
  acLip.position.y = 0.145
  acGroup.add(acBody, acLip)

  // 温度显示窗（CanvasTexture，target_temp 变化时重绘）
  const acCanvas = document.createElement('canvas')
  acCanvas.width = 256
  acCanvas.height = 96
  const acCtx = acCanvas.getContext('2d')!
  const acTex = track(new THREE.CanvasTexture(acCanvas))
  acTex.colorSpace = THREE.SRGBColorSpace
  const acDisplayMat = mat({ map: acTex, emissive: 0xffffff, emissiveMap: acTex, emissiveIntensity: 0.9, roughness: 0.3 })
  const acDisplay = new THREE.Mesh(track(new THREE.PlaneGeometry(0.32, 0.12)), acDisplayMat)
  acDisplay.position.set(0.3, -0.05, 0.131)
  acGroup.add(acDisplay)

  let acOn = false
  let acTemp = 26
  let acSwing = false
  function drawAcDisplay() {
    const c = acCtx
    c.fillStyle = '#04101c'
    c.fillRect(0, 0, 256, 96)
    if (acOn) {
      c.fillStyle = '#7fe8ff'
      c.font = 'bold 52px Consolas, monospace'
      c.textBaseline = 'middle'
      c.fillText(String(acTemp), 18, 46)
      c.font = '24px Consolas, monospace'
      c.fillText('℃', 24 + String(acTemp).length * 30, 66)
      c.fillStyle = acSwing ? '#ffd97f' : '#3d5566'
      c.font = 'bold 20px sans-serif'
      c.fillText(acSwing ? 'SWING' : 'FIXED', 158, 48)
    } else {
      c.fillStyle = '#33434f'
      c.font = 'bold 44px Consolas, monospace'
      c.textBaseline = 'middle'
      c.fillText('--', 24, 48)
    }
    acTex.needsUpdate = true
  }
  drawAcDisplay()

  // 出风口叶片（pivot 在后沿，fan_swing 时摆动）
  const louverPivot = new THREE.Group()
  louverPivot.position.set(0, -0.13, 0.07)
  const louver = box(0.92, 0.015, 0.1, mat({ color: 0xe8e8e4, roughness: 0.5 }))
  louver.position.z = 0.045
  louverPivot.add(louver)
  acGroup.add(louverPivot)
  scene.add(acGroup)

  // ============================================================
  // tv：电视柜 + 挂墙电视（CanvasTexture 彩色测试图样）
  // ============================================================
  const tvGroup = new THREE.Group()
  const standMat = mat({ color: 0x4a4038, roughness: 0.6 })
  const stand = box(0.42, 0.42, 1.7, standMat)
  stand.position.set(W - 0.28, 0.21, 0)
  const standTop = box(0.46, 0.03, 1.76, mat({ color: 0x2f2a24, roughness: 0.4 }))
  standTop.position.set(W - 0.28, 0.435, 0)
  tvGroup.add(stand, standTop)

  const bezelMat = mat({ color: 0x14161a, roughness: 0.3, metalness: 0.4 })
  const bezel = box(0.05, 0.92, 1.62, bezelMat)
  bezel.position.set(W - 0.09, 1.35, 0)
  tvGroup.add(bezel)

  const tvCanvas = document.createElement('canvas')
  tvCanvas.width = 512
  tvCanvas.height = 288
  const tvCtx = tvCanvas.getContext('2d')!
  const tvTex = track(new THREE.CanvasTexture(tvCanvas))
  tvTex.colorSpace = THREE.SRGBColorSpace
  const tvScreenMat = mat({
    color: 0x000000,        // 关机时靠材质颜色吸收光线 → 黑屏
    roughness: 0.2,
    emissive: 0xffffff,
    emissiveMap: tvTex,
    map: tvTex,
    emissiveIntensity: 0,
  })
  // 屏幕法线朝 -x（面向沙发）
  const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(1.5, 0.84)), tvScreenMat)
  screen.rotation.y = -Math.PI / 2
  screen.position.set(W - 0.062, 1.35, 0)
  tvGroup.add(screen)
  scene.add(tvGroup)

  let tvOn = false
  let tvVolume = 30
  function drawTvScreen() {
    const c = tvCtx
    c.fillStyle = '#000'
    c.fillRect(0, 0, 512, 288)
    if (tvOn) {
      // 上 65%：SMPTE 风格彩条
      const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']
      const bw = 512 / bars.length
      bars.forEach((col, i) => {
        c.fillStyle = col
        c.fillRect(i * bw, 0, bw + 1, 187)
      })
      // 中 12%：反相彩条
      bars.forEach((col, i) => {
        c.fillStyle = `#${(0xffffff - parseInt(col.slice(1), 16)).toString(16).padStart(6, '0')}`
        c.fillRect(i * bw, 187, bw + 1, 35)
      })
      // 中央圆靶
      c.strokeStyle = 'rgba(255,255,255,0.85)'
      c.lineWidth = 3
      c.beginPath()
      c.arc(256, 100, 46, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.arc(256, 100, 22, 0, Math.PI * 2)
      c.stroke()
      // 底部信息区：标题 + 音量条
      c.fillStyle = '#101418'
      c.fillRect(0, 222, 512, 66)
      c.fillStyle = '#e8f4ff'
      c.font = 'bold 22px sans-serif'
      c.fillText('SSVEP · SMART HOME TV DEMO', 20, 248)
      c.fillStyle = '#5a6a7a'
      c.font = '16px monospace'
      c.fillText(`VOL ${tvVolume}`, 420, 248)
      c.fillStyle = '#233240'
      c.fillRect(20, 262, 472, 12)
      c.fillStyle = '#39c5ff'
      c.fillRect(20, 262, 472 * (tvVolume / 100), 12)
    }
    tvTex.needsUpdate = true
  }
  drawTvScreen()

  // ============================================================
  // door_lock：门体（铰链枢组，可摆动开合）+ 锁舌位移 + 红/绿指示灯
  // ============================================================
  const doorGroup = new THREE.Group()
  doorGroup.userData.interact = 'door'
  // 门轴枢组：铰链在门板南缘（z=1.45），绕 y 轴旋转实现开合（向屋内 +x 摆动）
  const doorPivot = new THREE.Group()
  doorPivot.position.set(-W / 2 + 0.04, 1.01, 1.45)
  const doorMat = mat({ color: 0x8a5a33, roughness: 0.55 })
  const door = box(0.05, 2.02, 0.9, doorMat)
  door.position.set(0, 0, 0.45)
  const handle = new THREE.Mesh(
    track(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 12)),
    mat({ color: 0xc8b070, roughness: 0.3, metalness: 0.8 }),
  )
  handle.rotation.x = Math.PI / 2
  handle.position.set(0.045, 0.04, 0.71)
  doorPivot.add(door, handle)

  // 锁舌：locked 时向门框方向（-z）伸出
  const bolt = box(0.04, 0.05, 0.12, mat({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.7 }))
  const boltZLocked = -0.04
  const boltZUnlocked = 0.02
  bolt.position.set(0.005, 0.04, boltZUnlocked)
  doorPivot.add(bolt)

  // 锁状态指示灯（法线 +x 的小圆片）
  const ledMat = mat({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 1.6 })
  const led = new THREE.Mesh(track(new THREE.CircleGeometry(0.03, 16)), ledMat)
  led.rotation.y = Math.PI / 2
  led.position.set(0.032, 0.49, 0.45)
  doorPivot.add(led)
  doorGroup.add(doorPivot)
  scene.add(doorGroup)

  function setDoorOpen(open: boolean, animate = true) {
    // 门板向屋内摆动 109°（1.9 rad）
    tweens.start('door.swing', doorPivot.rotation.y, open ? 1.9 : 0, animate ? 1.2 : 0, (v) => {
      doorPivot.rotation.y = v
    })
  }

  const LED_RED = new THREE.Color(0xff2020)
  const LED_GREEN = new THREE.Color(0x30ff70)

  // ============================================================
  // emergency：红色警示信标（全屋灯光红闪在 update 中合成）
  // ============================================================
  const beaconGroup = new THREE.Group()
  beaconGroup.position.set(-W / 2 + 0.5, H - 0.06, 1.9)
  const beaconBase = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.11, 0.04, 16)), mat({ color: 0x333, roughness: 0.5 }))
  beaconBase.position.y = -0.02
  const beaconMat = mat({ color: 0x550000, emissive: 0xff2020, emissiveIntensity: 0.15 })
  const beacon = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 16, 12)), beaconMat)
  beaconGroup.add(beaconBase, beacon)
  scene.add(beaconGroup)

  let emergencyActive = false
  let emergencyWasActive = false
  /** 紧急脉动系数（update 中计算，0–1） */
  let emergencyPulse = 0

  // ============================================================
  // 状态应用入口
  // ============================================================
  function apply(state: DeviceState, animate: boolean) {
    switch (state.device_type) {
      case 'light': {
        if (state.device_id === 'living_room_light') applyLight(state, animate)
        // bedroom_light 不在客厅场景内建模（面板展示）
        break
      }
      case 'curtain': {
        // 开合滑动 2.5s 缓动（docs 3.2）
        tweens.start(
          'curtain.position',
          displayedPos,
          state.position,
          animate ? 2.5 : 0,
          (v) => {
            displayedPos = v
            placeCurtain(v)
          },
        )
        break
      }
      case 'ac': {
        const tempChanged = state.target_temp !== acTemp
        acOn = state.on
        acTemp = state.target_temp
        acSwing = state.fan_swing
        drawAcDisplay()
        if (tempChanged && animate) {
          // 温度数字「跳动」：显示窗短暂放大回弹
          tweens.start('ac.pop', 0, 1, 0.28, (k) => {
            const s = 1 + 0.3 * Math.sin(k * Math.PI)
            acDisplay.scale.set(s, s, 1)
          })
        }
        break
      }
      case 'tv': {
        tvOn = state.on
        tvVolume = state.volume
        drawTvScreen()
        // 屏幕点亮 / 熄灭 0.5s 渐变
        tweens.start('tv.screen', tvScreenMat.emissiveIntensity, tvOn ? 1.15 : 0, animate ? 0.5 : 0, (v) => {
          tvScreenMat.emissiveIntensity = v
        })
        break
      }
      case 'door_lock': {
        tweens.start(
          'door.bolt',
          bolt.position.z,
          state.locked ? boltZLocked : boltZUnlocked,
          animate ? 0.4 : 0,
          (v) => {
            bolt.position.z = v
          },
        )
        // 指示灯红（锁定）/ 绿（解锁）渐变
        const fromC = ledMat.emissive.clone()
        const toC = state.locked ? LED_RED : LED_GREEN
        tweens.start('door.led', 0, 1, animate ? 0.3 : 0, (k) => {
          ledMat.emissive.lerpColors(fromC, toC, k)
        }, (t) => t)
        break
      }
      case 'emergency': {
        emergencyActive = state.active
        break
      }
    }
  }

  // ============================================================
  // 每帧驱动
  // ============================================================
  function update(dt: number, time: number) {
    tweens.update(dt)

    // 空调出风叶片：fan_swing 时正弦摆动，关闭时缓慢复位
    const louverTarget = acSwing ? 0.34 + Math.sin(time * 2.6) * 0.28 : 0.02
    louverPivot.rotation.x += (louverTarget - louverPivot.rotation.x) * Math.min(1, dt * 8)

    // 紧急呼叫：全屋灯光红色循环闪烁
    if (emergencyActive) {
      emergencyWasActive = true
      emergencyPulse = (Math.sin(time * 6) + 1) / 2
      // 主灯强度脉动 + 染红（覆盖普通补间输出，解除时恢复）
      point.intensity = Math.max(point.intensity, 6) * (0.45 + 0.55 * emergencyPulse)
      point.color.lerpColors(WHITE, EMERGENCY_RED, 0.7 * emergencyPulse)
      // 警示信标
      beaconMat.emissiveIntensity = 0.15 + emergencyPulse * 3.4
    } else {
      emergencyPulse = 0
      if (emergencyWasActive) {
        emergencyWasActive = false
        beaconMat.emissiveIntensity = 0.15
        if (lastLightState) applyLight(lastLightState, false) // 恢复主灯目标状态
      }
    }

    // 环境光 = 基础 0.35 + 主灯亮度增量 + 紧急红色脉冲
    room.ambient.intensity = 0.35 + ambientBoost + (emergencyActive ? 0.25 * emergencyPulse : 0)
    if (emergencyActive) {
      room.ambient.color.lerpColors(WHITE, EMERGENCY_RED, 0.55 * emergencyPulse)
    } else {
      room.ambient.color.copy(WHITE)
    }
  }

  function dispose() {
    scene.remove(lampGroup, curtainGroup, acGroup, tvGroup, doorGroup, beaconGroup, point)
    for (const d of disposables) d.dispose()
  }

  // 交互标签：整组可点击（door 已在 doorGroup 上标注）
  tvGroup.userData.interact = 'tv'
  acGroup.userData.interact = 'ac'

  const interactables: THREE.Object3D[] = [doorGroup, tvGroup, acGroup]
  return { apply, update, dispose, interactables, setDoorOpen }
}
