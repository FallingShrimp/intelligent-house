/**
 * Minecraft 风格苍弓（第一人称视模型 + 远端玩家简模）
 *
 * 弓面竖直、弦沿 +Y，弓臂弧顶朝 -Z（建模后由挂载方旋转对准持弓方向）。
 * 电系配色（青蓝能量）：弓臂青绿微光、握把深木、弦亮白；搭弦能量球由
 * combat.ts 在蓄力时显示并随蓄力进度增大（ORB 能量主题与球状闪电一致）。
 */
import * as THREE from 'three'

/** 第一人称视模型：精细版（同 buildSword 风格） */
export function buildBow(): THREE.Group {
  const g = new THREE.Group()

  const mat = (color: string, emissive = 0) =>
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: emissive,
      roughness: 0.35,
      metalness: 0.15,
    })
  const limbM = mat('#1f8f81', 0.22)   // 弓臂（青绿微光）
  const tipM = mat('#7df9ff', 0.5)     // 弓梢（电蓝）
  const gripM = mat('#4a2c14')         // 握把（深木）
  const stringM = mat('#cfe8ef', 0.1)  // 弦（亮白）

  const R = 0.3
  // 弓臂：半圆弧（XY 平面，arc 从 +X 经 +Y 到 -X）→ 整组旋转后弧顶朝前
  const limb = new THREE.Mesh(new THREE.TorusGeometry(R, 0.018, 8, 32, Math.PI), limbM)
  limb.rotation.z = -Math.PI / 2 // 弧顶 +X、两端 ±Y 竖直（弦在 x=0 连接两端）
  g.add(limb)

  // 弓臂内衬第二层弧（叠出发光层次，居中于弧顶）
  const inner = new THREE.Mesh(new THREE.TorusGeometry(R - 0.035, 0.008, 6, 24, Math.PI * 0.86), tipM)
  inner.rotation.z = Math.PI / 2 - (Math.PI * 0.86) / 2
  g.add(inner)

  // 弓梢（两端小方块，位于弧开口侧竖直两端）
  for (const y of [-R, R]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.045), tipM)
    tip.position.set(0, y, 0)
    g.add(tip)
  }

  // 握把（弧顶中部）
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.05), gripM)
  grip.position.set(R - 0.015, 0, 0)
  g.add(grip)

  // 弦（连接两端的竖直线段）
  const str = new THREE.Mesh(new THREE.BoxGeometry(0.008, R * 2 - 0.03, 0.008), stringM)
  str.position.set(0, 0, 0)
  g.add(str)

  return g
}

/** 搭弦能量球（蓄力时显示，随蓄力进度增大增亮；返回 mesh 便于 combat 驱动） */
export function buildBowOrb(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0x7df9ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  )
  m.visible = false
  return m
}

/** 远端玩家简模弓（挂在手腕枢轴上，建模方向同剑：弦沿 +Y） */
export function buildRemoteBow(): THREE.Group {
  const g = new THREE.Group()

  const R = 0.22
  const limb = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.014, 6, 24, Math.PI),
    new THREE.MeshStandardMaterial({
      color: 0x1f8f81, emissive: 0x1f8f81, emissiveIntensity: 0.25, roughness: 0.35,
    }),
  )
  limb.rotation.z = -Math.PI / 2
  g.add(limb)

  const str = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, R * 2 - 0.03, 0.006),
    new THREE.MeshStandardMaterial({ color: 0xcfe8ef, emissive: 0xcfe8ef, emissiveIntensity: 0.1 }),
  )
  str.position.set(0, 0, 0)
  g.add(str)

  const grip = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.12, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x4a2c14, roughness: 0.7 }),
  )
  grip.position.set(R - 0.015, 0, 0)
  g.add(grip)

  return g
}
