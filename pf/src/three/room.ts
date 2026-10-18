/**
 * 客厅静态场景：地板、三面墙（北墙带窗洞）、窗户与窗框、天花板、
 * 沙发 / 茶几等家具，以及环境光与窗外阳光。
 *
 * 坐标约定：地板中心为原点，宽 8m（x ∈ [-4, 4]）、深 6m（z ∈ [-3, 3]）、
 * 高 2.8m；北墙 z=-3（带窗）、西墙 x=-4、东墙 x=4，南面 z=+3 开放（便于观察）。
 */
import * as THREE from 'three'

/** 房间尺寸常量（设备模型挂点也会用到） */
export const ROOM = {
  W: 8,
  D: 6,
  H: 2.8,
  T: 0.12, // 墙厚
} as const

/** 北墙窗户位置常量（devices.ts 中窗帘 / 空调挂点对齐用） */
export const WINDOW = { cx: 0.8, halfW: 1.1, y0: 0.9, y1: 2.2 } as const

export interface RoomRig {
  group: THREE.Group
  /** 环境光（照度随主灯 / 紧急状态叠加调整） */
  ambient: THREE.AmbientLight
  /** 茶几玻璃杯中的水体（「喝水」交互：缩放 y 即水位变化，见 SceneManager） */
  water: THREE.Mesh
  dispose(): void
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export function buildRoom(scene: THREE.Scene): RoomRig {
  const group = new THREE.Group()
  const { W, D, H, T } = ROOM
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = []
  const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    disposables.push(x)
    return x
  }

  // ---------------- 材质 ----------------
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x9a7355, roughness: 0.75, metalness: 0.05 }))
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.95 }))
  const ceilMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 1 }))
  const skirtMat = track(new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.9 }))
  const frameMat = track(new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: 0.4, metalness: 0.5 }))
  const glassMat = track(new THREE.MeshStandardMaterial({
    color: 0xaaccdd, roughness: 0.05, metalness: 0.1,
    transparent: true, opacity: 0.18, side: THREE.DoubleSide,
  }))
  const sofaMat = track(new THREE.MeshStandardMaterial({ color: 0x5b7c99, roughness: 1 }))
  const sofaCushionMat = track(new THREE.MeshStandardMaterial({ color: 0x7b9ab5, roughness: 1 }))
  const woodMat = track(new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.6 }))
  const rugMat = track(new THREE.MeshStandardMaterial({ color: 0x46586b, roughness: 1 }))
  const potMat = track(new THREE.MeshStandardMaterial({ color: 0xb0653a, roughness: 0.9 }))
  const leafMat = track(new THREE.MeshStandardMaterial({ color: 0x3f7a44, roughness: 0.9 }))
  const artMat = track(new THREE.MeshStandardMaterial({ color: 0x35506b, roughness: 0.8 }))
  const artFrameMat = track(new THREE.MeshStandardMaterial({ color: 0x503c28, roughness: 0.7 }))

  // ---------------- 地板 / 天花板 ----------------
  const floor = box(W + 0.6, 0.1, D + 0.6, floorMat)
  floor.position.y = -0.05
  group.add(floor)

  const ceiling = new THREE.Mesh(track(new THREE.PlaneGeometry(W, D)), ceilMat)
  ceiling.rotation.x = Math.PI / 2 // 法线朝下
  ceiling.position.y = H
  ceiling.receiveShadow = true
  group.add(ceiling)

  // ---------------- 北墙（z=-3，带窗洞） ----------------
  const { cx: winCx, halfW: winHalfW, y0: winY0, y1: winY1 } = WINDOW
  const wallZ = -D / 2 - T / 2

  const northSegs: Array<[number, number, number, number]> = [
    // [中心x, 中心y, 宽, 高]
    [0, winY0 / 2, W, winY0],                      // 窗下
    [0, (winY1 + H) / 2, W, H - winY1],            // 窗上
    [(-W / 2 + (winCx - winHalfW)) / 2, (winY0 + winY1) / 2, winCx - winHalfW + W / 2, winY1 - winY0], // 窗左
    [((winCx + winHalfW) + W / 2) / 2, (winY0 + winY1) / 2, W / 2 - (winCx + winHalfW), winY1 - winY0], // 窗右
  ]
  for (const [cx, cy, w, h] of northSegs) {
    const seg = box(w, h, T, wallMat)
    seg.position.set(cx, cy, wallZ)
    group.add(seg)
  }

  // 西墙（带门洞：z 1.45–2.35，洞高 2.1，与门体对齐） / 东墙
  const westSegs: Array<[number, number, number, number]> = [
    // [中心z, 中心y, 深(z向), 高]
    [-0.775, H / 2, 4.45, H],           // 门洞南侧（z -3 → 1.45）
    [2.675, H / 2, 0.65, H],            // 门洞北侧（z 2.35 → 3）
    [1.9, (2.1 + H) / 2, 0.9, H - 2.1], // 门楣（门洞上方）
  ]
  for (const [cz, cy, d, h] of westSegs) {
    const seg = box(T, h, d, wallMat)
    seg.position.set(-W / 2 - T / 2, cy, cz)
    group.add(seg)
  }
  const eastWall = box(T, H, D, wallMat)
  eastWall.position.set(W / 2 + T / 2, H / 2, 0)
  group.add(eastWall)

  // 踢脚线（北 / 西 / 东；西墙避开门口）
  const skirtH = 0.1
  const skirtN = box(W, skirtH, 0.02, skirtMat)
  skirtN.position.set(0, skirtH / 2, -D / 2 + 0.011)
  group.add(skirtN)
  const skirtW1 = box(0.02, skirtH, 4.45, skirtMat)
  skirtW1.position.set(-W / 2 + 0.011, skirtH / 2, -0.775)
  const skirtW2 = box(0.02, skirtH, 0.65, skirtMat)
  skirtW2.position.set(-W / 2 + 0.011, skirtH / 2, 2.675)
  const skirtE = box(0.02, skirtH, D, skirtMat)
  skirtE.position.set(W / 2 - 0.011, skirtH / 2, 0)
  group.add(skirtW1, skirtW2, skirtE)

  // ---------------- 门外门廊（开门可走入的小玄关） ----------------
  const porchFloor = box(1.8, 0.1, 1.5, floorMat)
  porchFloor.position.set(-4.9, -0.05, 1.9)
  const porchBack = box(0.12, 2.4, 1.5, wallMat)
  porchBack.position.set(-5.74, 1.2, 1.9)
  const porchSideN = box(1.8, 2.4, 0.12, wallMat)
  porchSideN.position.set(-4.9, 1.2, 1.15)
  const porchSideS = box(1.8, 2.4, 0.12, wallMat)
  porchSideS.position.set(-4.9, 1.2, 2.65)
  const porchRoof = box(2.0, 0.1, 1.7, ceilMat)
  porchRoof.position.set(-4.9, 2.45, 1.9)
  const doormat = box(0.6, 0.02, 0.9, rugMat)
  doormat.position.set(-4.3, 0.012, 1.9)
  doormat.receiveShadow = true
  group.add(porchFloor, porchBack, porchSideN, porchSideS, porchRoof, doormat)

  // ---------------- 窗户：窗框 + 中梃 + 玻璃 ----------------
  const frameT = 0.07
  const frameD = 0.1
  const frameZ = -D / 2 + 0.02
  const winW = winHalfW * 2
  const winH = winY1 - winY0
  const winCy = (winY0 + winY1) / 2

  const framePieces: Array<[number, number, number, number, boolean]> = [
    // [中心x, 中心y, 尺寸1, 尺寸2, 是否竖条]
    [winCx, winY0 + frameT / 2, winW, frameT, false],              // 下框
    [winCx, winY1 - frameT / 2, winW, frameT, false],              // 上框
    [winCx - winHalfW + frameT / 2, winCy, frameT, winH, true],    // 左框
    [winCx + winHalfW - frameT / 2, winCy, frameT, winH, true],    // 右框
    [winCx, winCy, 0.05, winH, true],                              // 竖中梃
    [winCx, winCy, winW, 0.05, false],                             // 横中梃
  ]
  for (const [cx, cy, s1, s2, vertical] of framePieces) {
    const piece = vertical ? box(s1, s2, frameD, frameMat) : box(s1, s2, frameD, frameMat)
    piece.position.set(cx, cy, frameZ)
    group.add(piece)
  }
  // 窗台板
  const sill = box(winW + 0.16, 0.04, 0.16, frameMat)
  sill.position.set(winCx, winY0 - 0.02, -D / 2 + 0.06)
  group.add(sill)

  const glass = new THREE.Mesh(track(new THREE.PlaneGeometry(winW, winH)), glassMat)
  glass.position.set(winCx, winCy, -D / 2 + 0.04)
  group.add(glass)

  // ---------------- 窗外景与阳光 ----------------
  const outdoorMat = track(new THREE.MeshBasicMaterial({ color: 0xcfe3ef }))
  const outdoor = new THREE.Mesh(track(new THREE.PlaneGeometry(16, 9)), outdoorMat)
  outdoor.position.set(0, 3, -D / 2 - 3)
  group.add(outdoor)

  const ambient = new THREE.AmbientLight(0xffffff, 0.35)
  group.add(ambient)
  const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x8d7a63, 0.3)
  group.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff1d8, 2.4)
  sun.position.set(2.5, 6, -9)
  sun.target.position.set(0.5, 0, 0)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -7
  sun.shadow.camera.right = 7
  sun.shadow.camera.top = 7
  sun.shadow.camera.bottom = -7
  sun.shadow.camera.near = 0.5
  sun.shadow.camera.far = 25
  sun.shadow.bias = -0.0005
  group.add(sun, sun.target)

  // ---------------- 家具：沙发（靠西墙，朝东） ----------------
  const sofa = new THREE.Group()
  const seat = box(0.85, 0.4, 2.0, sofaMat)
  seat.position.set(0, 0.28, 0)
  const backrest = box(0.24, 0.72, 2.0, sofaMat)
  backrest.position.set(-0.32, 0.62, 0)
  const armL = box(0.85, 0.58, 0.24, sofaMat)
  armL.position.set(0, 0.37, -1.12)
  const armR = box(0.85, 0.58, 0.24, sofaMat)
  armR.position.set(0, 0.37, 1.12)
  const cushionL = box(0.68, 0.13, 0.86, sofaCushionMat)
  cushionL.position.set(0.05, 0.545, -0.48)
  const cushionR = box(0.68, 0.13, 0.86, sofaCushionMat)
  cushionR.position.set(0.05, 0.545, 0.48)
  sofa.add(seat, backrest, armL, armR, cushionL, cushionR)
  sofa.position.set(-3.35, 0, 0)
  group.add(sofa)

  // ---------------- 茶几 + 茶杯 ----------------
  const table = new THREE.Group()
  const top = box(0.65, 0.05, 1.1, woodMat)
  top.position.y = 0.42
  table.add(top)
  for (const [lx, lz] of [[-0.26, -0.48], [-0.26, 0.48], [0.26, -0.48], [0.26, 0.48]]) {
    const leg = box(0.05, 0.42, 0.05, woodMat)
    leg.position.set(lx, 0.21, lz)
    table.add(leg)
  }
  // 玻璃杯 + 杯中的水（左键点击喝水，水位由 SceneManager 驱动，30s 自动续满）
  const waterGlassMat = track(
    new THREE.MeshPhysicalMaterial({ color: 0xdff2fb, roughness: 0.08, transparent: true, opacity: 0.35 }),
  )
  const waterGlass = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.038, 0.09, 16)), waterGlassMat)
  waterGlass.position.set(0.05, 0.49, 0.15)
  waterGlass.castShadow = true
  waterGlass.userData.interact = 'water'
  table.add(waterGlass)
  // 水体：几何原点移到底部，缩放 y 即从杯底下降
  const waterGeo = track(new THREE.CylinderGeometry(0.04, 0.033, 0.055, 16))
  waterGeo.translate(0, 0.0275, 0)
  const waterMat = track(
    new THREE.MeshStandardMaterial({ color: 0x62b8e8, transparent: true, opacity: 0.78, roughness: 0.15 }),
  )
  const water = new THREE.Mesh(waterGeo, waterMat)
  water.position.set(0.05, 0.4475, 0.15)
  water.userData.interact = 'water'
  table.add(water)
  table.position.set(-1.65, 0, 0)
  group.add(table)

  // ---------------- 地毯 ----------------
  const rug = new THREE.Mesh(track(new THREE.PlaneGeometry(2.4, 3.2)), rugMat)
  rug.rotation.x = -Math.PI / 2
  rug.position.set(-1.5, 0.006, 0)
  rug.receiveShadow = true
  group.add(rug)

  // ---------------- 门（西墙南段，门体与锁舌动画见 devices.ts） ----------------
  // 门框
  const doorFrameMat = track(new THREE.MeshStandardMaterial({ color: 0x6d4a2b, roughness: 0.7 }))
  const frameL = box(0.08, 2.1, 0.06, doorFrameMat)
  frameL.position.set(-W / 2 + 0.03, 1.05, 1.38)
  const frameR = box(0.08, 2.1, 0.06, doorFrameMat)
  frameR.position.set(-W / 2 + 0.03, 1.05, 2.42)
  const frameT2 = box(0.08, 0.06, 1.1, doorFrameMat)
  frameT2.position.set(-W / 2 + 0.03, 2.12, 1.9)
  group.add(frameL, frameR, frameT2)

  // ---------------- 装饰：西墙挂画 + 绿植 ----------------
  const art = box(0.04, 0.7, 1.0, artMat)
  art.position.set(-W / 2 + 0.04, 1.65, -1.2)
  const artFrame = box(0.03, 0.78, 1.08, artFrameMat)
  artFrame.position.set(-W / 2 + 0.025, 1.65, -1.2)
  group.add(artFrame, art)

  const pot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 16)), potMat)
  pot.position.set(-3.5, 0.15, -2.45)
  pot.castShadow = true
  const leaves = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.34, 1)), leafMat)
  leaves.position.set(-3.5, 0.62, -2.45)
  leaves.castShadow = true
  group.add(pot, leaves)

  scene.add(group)

  return {
    group,
    ambient,
    water,
    dispose() {
      scene.remove(group)
      for (const d of disposables) d.dispose()
      // 遍历释放几何体（box() 每次新建）
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose()
      })
    },
  }
}
