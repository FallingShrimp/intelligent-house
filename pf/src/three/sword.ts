/**
 * Minecraft 风格钻石剑（第一人称视模型）
 *
 * 方块感分段盒体 + 像素配色（钻石青 → 冰蓝渐变刃尖，握把端在原点，刃朝 +Y）。
 * 残影「剑光」由 combat.ts 在挥砍时克隆本模型并替换为加色半透明材质实现。
 */
import * as THREE from 'three'

export function buildSword(): THREE.Group {
  const g = new THREE.Group()

  const mat = (color: string, emissive = 0) =>
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: emissive,
      roughness: 0.35,
      metalness: 0.15,
    })
  const pommelM = mat('#4a2c14')
  const handleM = mat('#7a4a21')
  const guardM = mat('#1f8f81')
  const bladeM = mat('#4aedd9', 0.28)
  const edgeM = mat('#9dfff2', 0.45)
  const tipM = mat('#d4fff8', 0.55)

  const box = (w: number, h: number, d: number, m: THREE.Material) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
  const add = (mesh: THREE.Mesh, y: number) => {
    mesh.position.y = y
    g.add(mesh)
    return mesh
  }

  add(box(0.06, 0.08, 0.06, pommelM), -0.1) // 剑首
  add(box(0.05, 0.24, 0.05, handleM), 0.04) // 握柄
  add(box(0.17, 0.05, 0.07, guardM), 0.17) // 护手
  add(box(0.08, 0.27, 0.034, bladeM), 0.33) // 刃根
  add(box(0.06, 0.26, 0.034, bladeM), 0.585) // 刃身
  add(box(0.042, 0.18, 0.034, edgeM), 0.8) // 刃尖
  add(box(0.024, 0.11, 0.026, tipM), 0.94) // 锋
  return g
}
