/**
 * 远程玩家渲染：每个联机对等体渲染为一个彩色圆柱体 + 头顶名牌 + 手持钻石剑
 *
 * - 颜色由 PB 在连接时随机分配（welcome.you / world.players.color）
 * - 位置 / 朝向按 10Hz 快照插值；仅渲染 fp（第一人称）状态的玩家
 * - 动作标签（anim：swing0/1/2、counter、chase、block、stab|<pitch>）驱动剑的挥砍动画与
 *   身体倾斜脉冲；空中戳刺（stab）整体圆柱向目标俯仰方向倾斜；格挡中脚下显示护盾环
 * - 头顶血条（hp 来自 PB 权威快照）；命中溅血粒子（bleed）
 * - 死亡（hp=0）渲染为倒地尸体：横躺变暗 + 名牌 ☠ 标记，仍可被队友点击复活
 */
import * as THREE from 'three'
import type { NetPlayerState } from '../protocol/messages'

const CYL_R = 0.32
const CYL_H = 1.7
const ANIM_DUR = 0.3 // 挥砍动画时长 s（与倾斜脉冲同步）
const BAR_W = 0.66   // 血条宽
const BAR_H = 0.075
const BAR_Y = 1.98   // 血条高度（名牌下方）

const UP = new THREE.Vector3(0, 1, 0)
const TILT_RESET = new THREE.Quaternion() // 直立姿态（恒等四元数）

interface RemoteEntry {
	uuid: string
	name: string
	group: THREE.Group
	cyl: THREE.Mesh
	label: THREE.Sprite
	shield: THREE.Mesh
	mat: THREE.MeshStandardMaterial
	baseColor: THREE.Color
	arm: THREE.Group // 手腕枢轴（剑挂在上面，动画驱动其旋转）
	tilt: THREE.Group // 身体倾斜枢轴（空中戳刺 stab|pitch 驱动，外层 yaw 之内）
	hp: number
	maxHp: number
	dead: boolean
	labelCanvas: HTMLCanvasElement
	labelTex: THREE.CanvasTexture
	bar: THREE.Group      // 血条根（挂 world 层，不随玩家 yaw 旋转）
	barFill: THREE.Sprite // 血条前景
	// 插值目标
	tX: number
	tZ: number
	tYaw: number
	// 动作脉冲
	animTag: string | null
	animT: number
}

export class RemotePlayers {
	readonly group = new THREE.Group()
	private map = new Map<string, RemoteEntry>()
	/** 溅血粒子（burst 生命周期内逐帧更新） */
	private bursts: { pts: THREE.Points; mat: THREE.PointsMaterial; vel: Float32Array; t: number }[] = []

	/** world 快照应用：增删 / 更新目标（仅 fp 玩家可见；selfUuid 为本客户端自己，不渲染避免遮挡第一人称视角） */
	applySnapshot(players: NetPlayerState[], selfUuid?: string | null) {
		const seen = new Set<string>()
		for (const p of players) {
			if (!p.fp || p.uuid === selfUuid) continue
			seen.add(p.uuid)
			let e = this.map.get(p.uuid)
			if (!e) {
				e = this.create(p)
				this.map.set(p.uuid, e)
				this.group.add(e.group)
				this.group.add(e.bar)
			}
			e.tX = p.p[0]
			e.tZ = p.p[2]
			e.tYaw = p.yaw
			e.hp = p.hp
			e.maxHp = p.max_hp || 100
			// 死亡 ⇄ 复活切换：尸体变暗倒地 / 恢复站立与名牌
			const dead = p.hp <= 0
			if (dead !== e.dead) {
				e.dead = dead
				this.applyDeadLook(e)
			}
			// 新动作标签 → 触发挥砍 / 倾斜脉冲（block 标签持续期间姿态由 update 保持）
			if (p.anim && p.anim !== e.animTag) e.animT = ANIM_DUR
			e.animTag = p.anim
			e.shield.visible = p.blocking && !dead
		}
		// 移除消失 / 退出第一人称的玩家
		for (const [uuid, e] of [...this.map]) {
			if (!seen.has(uuid)) {
				e.group.removeFromParent()
				disposeGroup(e.group)
				e.bar.removeFromParent()
				disposeGroup(e.bar)
				this.map.delete(uuid)
			}
		}
	}

	/** 全部远程玩家中心点（战斗本地预判用） */
	centers(): { uuid: string; x: number; y: number; z: number }[] {
		return [...this.map.values()].map((e) => ({
			uuid: e.uuid,
			x: e.group.position.x,
			y: 1.0,
			z: e.group.position.z,
		}))
	}

	/** 死亡玩家（尸体）列表：供存活队友准星指向后发起 revive 复活 */
	corpses(): { uuid: string; name: string; x: number; y: number; z: number }[] {
		return [...this.map.values()]
			.filter((e) => e.hp <= 0)
			.map((e) => ({
				uuid: e.uuid,
				name: e.name,
				x: e.group.position.x,
				y: 0.6,
				z: e.group.position.z,
			}))
	}

	/** 死亡 ⇄ 复活外观切换：尸体变暗 + 名牌 ☠；复活恢复原色与名牌 */
	private applyDeadLook(e: RemoteEntry) {
		if (e.dead) {
			e.mat.color.copy(e.baseColor).multiplyScalar(0.4)
		} else {
			e.mat.color.copy(e.baseColor)
		}
		drawLabel(e.labelCanvas, e.labelTex, e.name, e.dead)
	}

	/** 远程玩家受击闪白（dmg_p 事件） */
	flash(uuid: string) {
		const e = this.map.get(uuid)
		if (!e) return
		e.mat.emissive.setHex(0xffffff)
		e.mat.emissiveIntensity = 0.8
		setTimeout(() => {
			e.mat.emissive.setHex(0x000000)
			e.mat.emissiveIntensity = 0
		}, 120)
	}

	/** 命中溅血：红色粒子从玩家胸口向外抛洒（dmg_p 事件） */
	bleed(uuid: string) {
		const e = this.map.get(uuid)
		if (!e) return
		const N = 16
		const pos = new Float32Array(N * 3)
		const vel = new Float32Array(N * 3)
		for (let i = 0; i < N; i++) {
			pos[i * 3] = e.group.position.x + (Math.random() - 0.5) * 0.25
			pos[i * 3 + 1] = 1.15 + (Math.random() - 0.5) * 0.5
			pos[i * 3 + 2] = e.group.position.z + (Math.random() - 0.5) * 0.25
			const a = Math.random() * Math.PI * 2
			const sp = 0.8 + Math.random() * 1.7
			vel[i * 3] = Math.cos(a) * sp
			vel[i * 3 + 1] = 1 + Math.random() * 2.2
			vel[i * 3 + 2] = Math.sin(a) * sp
		}
		const geo = new THREE.BufferGeometry()
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
		const mat = new THREE.PointsMaterial({
			color: 0xc81e1e, size: 0.09, transparent: true,
			opacity: 1, depthWrite: false,
		})
		const pts = new THREE.Points(geo, mat)
		this.group.add(pts)
		this.bursts.push({ pts, mat, vel, t: 0 })
	}

	update(dt: number) {
		for (const e of this.map.values()) {
			const g = e.group
			const k = Math.min(1, dt * 10)
			g.position.x += (e.tX - g.position.x) * k
			g.position.z += (e.tZ - g.position.z) * k
			let yd = e.tYaw - g.rotation.y
			while (yd > Math.PI) yd -= Math.PI * 2
			while (yd < -Math.PI) yd += Math.PI * 2
			g.rotation.y += yd * k
			// 尸体：倒地姿态（绕 Z 转成横躺并微抬避免半嵌地面），隐藏血条、跳过动作动画
			if (e.dead) {
				const kd = Math.min(1, dt * 5)
				g.rotation.z += (Math.PI / 2 - g.rotation.z) * kd
				g.position.y += (0.3 - g.position.y) * kd
				e.bar.visible = false
				continue
			}
			g.position.y += (0 - g.position.y) * k
			// 动作倾斜脉冲（衰减）
			if (e.animT > 0) {
				e.animT = Math.max(0, e.animT - dt)
				g.rotation.z = Math.sin((ANIM_DUR - e.animT) * 20) * 0.12 * (e.animT / ANIM_DUR)
			} else {
				g.rotation.z += (0 - g.rotation.z) * k // 复活后从倒地姿态平滑起身
			}
			// 空中戳刺：身体向目标俯仰方向倾斜（顶面法向量 → 目标方向），结束 slerp 回直立
			const stab = e.animTag?.startsWith('stab|') ?? false
			if (stab && e.animT > 0) {
				const pitch = parseFloat(e.animTag!.slice(5))
				const dir = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch))
				e.tilt.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(UP, dir), k)
			} else {
				e.tilt.quaternion.slerp(TILT_RESET, k)
			}
			// 剑动画：按动作标签驱动手腕枢轴旋转（p = 0→1 动画进度）
			const arm = e.arm
			if (e.animT > 0 && e.animTag) {
				const p = 1 - e.animT / ANIM_DUR
				const s = p * p * (3 - 2 * p) // smoothstep 缓动
				const pose = stab ? 'counter' : e.animTag // 戳刺复用反击手臂姿态
				switch (pose) {
					case 'swing0': // 左挥：绕 Y 从右往左扫
						arm.rotation.set(Math.PI / 2 - 0.25, THREE.MathUtils.lerp(1.25, -1.05, s), 0)
						break
					case 'swing1': // 右挥：反向
						arm.rotation.set(Math.PI / 2 - 0.25, THREE.MathUtils.lerp(-1.05, 1.25, s), 0)
						break
					case 'swing2': // 上劈：从举过头劈到前下
					case 'chase':
						arm.rotation.set(THREE.MathUtils.lerp(Math.PI / 2 - 2.1, Math.PI / 2 + 0.45, s), 0, 0)
						break
					case 'counter': // 戳刺：指前 + 前伸脉冲
						arm.rotation.set(Math.PI / 2, 0, 0)
						arm.position.z = 0.05 + Math.sin(p * Math.PI) * 0.4
						break
					case 'block': // 格挡：剑横举胸前（保持姿态到标签结束）
						arm.rotation.set(Math.PI / 2 * 0.85, 0, 1.0)
						break
					default:
						arm.rotation.set(0.5, 0, 0)
				}
			} else if (e.animTag === 'block') {
					arm.rotation.set(Math.PI / 2 * 0.85, 0, 1.0) // 格挡姿态持续保持
					arm.position.z = 0.05
				} else if (e.animTag === 'charge') {
					arm.rotation.set(-0.9, 0, 0.3) // 蓄力：剑举过头顶
					arm.position.z = 0.05
				} else {
					arm.rotation.set(0.5, 0, 0) // idle 姿态
					arm.position.z = 0.05
				}
				// 头顶血条（世界层，不随 yaw 旋转；死亡隐藏）
				e.bar.position.set(g.position.x, BAR_Y, g.position.z)
				const ratio = Math.max(0, Math.min(1, e.hp / (e.maxHp || 100)))
				e.barFill.scale.x = Math.max(BAR_W * ratio, 0.001)
				e.barFill.position.x = -BAR_W / 2 // 左对齐：向右缩短
				e.bar.visible = e.hp > 0
				// 名牌始终面向相机（Sprite 自带）
		}
		// 溅血粒子更新（抛洒 + 重力 + 地面反弹 + 淡出）
		for (let i = this.bursts.length - 1; i >= 0; i--) {
			const b = this.bursts[i]
			b.t += dt
			if (b.t >= 0.55) {
				b.pts.removeFromParent()
				b.pts.geometry.dispose()
				b.mat.dispose()
				this.bursts.splice(i, 1)
				continue
			}
			const attr = b.pts.geometry.getAttribute('position') as THREE.BufferAttribute
			const arr = attr.array as Float32Array
			for (let j = 0; j < b.vel.length; j += 3) {
				b.vel[j + 1] -= 9.8 * dt
				arr[j] += b.vel[j] * dt
				arr[j + 1] += b.vel[j + 1] * dt
				arr[j + 2] += b.vel[j + 2] * dt
				if (arr[j + 1] < 0.03) { arr[j + 1] = 0.03; b.vel[j + 1] *= -0.3 }
			}
			attr.needsUpdate = true
			b.mat.opacity = 1 - b.t / 0.55
		}
	}

	dispose() {
		for (const e of this.map.values()) {
			e.group.removeFromParent()
			disposeGroup(e.group)
			e.bar.removeFromParent()
			disposeGroup(e.bar)
		}
		this.map.clear()
		for (const b of this.bursts) {
			b.pts.removeFromParent()
			b.pts.geometry.dispose()
			b.mat.dispose()
		}
		this.bursts.length = 0
	}

	// ---------------- 私有 ----------------

	private create(p: NetPlayerState): RemoteEntry {
		const group = new THREE.Group()
		const color = new THREE.Color(p.color)

		const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
		const cyl = new THREE.Mesh(new THREE.CylinderGeometry(CYL_R, CYL_R, CYL_H, 20), mat)
		cyl.position.y = CYL_H / 2
		cyl.castShadow = true
		// 身体倾斜枢轴：空中戳刺时整体倾斜（外层 yaw 之内，脚下护盾环不跟随）
		const tilt = new THREE.Group()
		group.add(tilt)
		tilt.add(cyl)

		// 头顶半球（区分朝向）
		const head = new THREE.Mesh(
			new THREE.SphereGeometry(CYL_R, 16, 12),
			new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
		)
		head.position.y = CYL_H
		tilt.add(head)

		// 朝向指示（面前小方块）
		const nose = new THREE.Mesh(
			new THREE.BoxGeometry(0.1, 0.1, 0.18),
			new THREE.MeshStandardMaterial({ color: 0x222831 }),
		)
		nose.position.set(0, CYL_H - 0.15, CYL_R + 0.06)
		tilt.add(nose)

		// 格挡护盾环（脚下）
		const shield = new THREE.Mesh(
			new THREE.RingGeometry(CYL_R + 0.1, CYL_R + 0.22, 32),
			new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
		)
		shield.rotation.x = -Math.PI / 2
		shield.position.y = 0.04
		shield.visible = false
		group.add(shield)

		// 手持钻石剑（右手侧，手腕枢轴驱动挥砍动画）
		const arm = new THREE.Group()
		arm.position.set(CYL_R + 0.04, 1.15, 0.05)
		arm.rotation.set(0.5, 0, 0) // idle：剑尖斜向前上
		arm.add(buildRemoteSword())
		tilt.add(arm)

		// 名牌（canvas + 纹理存入 entry：死亡 ☠ 标记需原位重绘）
		const labelCanvas = document.createElement('canvas')
		labelCanvas.width = 256
		labelCanvas.height = 64
		const labelTex = new THREE.CanvasTexture(labelCanvas)
		labelTex.colorSpace = THREE.SRGBColorSpace
		drawLabel(labelCanvas, labelTex, p.name, p.hp <= 0)
		const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, depthTest: false }))
		label.scale.set(1.6, 0.4, 1)
		label.position.y = CYL_H + 0.45
		group.add(label)

		// 头顶血条（背景 + 前景左对齐；挂 world 层不随 yaw 旋转）
		const bar = new THREE.Group()
		const barBg = new THREE.Sprite(new THREE.SpriteMaterial({
			color: 0x0d131c, opacity: 0.78, transparent: true, depthWrite: false,
		}))
		barBg.scale.set(BAR_W + 0.03, BAR_H + 0.03, 1)
		barBg.renderOrder = 9
		bar.add(barBg)
		const barFill = new THREE.Sprite(new THREE.SpriteMaterial({
			color: 0xe63946, opacity: 0.95, transparent: true, depthWrite: false,
		}))
		barFill.center.set(0, 0.5) // 左对齐
		barFill.scale.set(BAR_W, BAR_H, 1)
		barFill.position.x = -BAR_W / 2
		barFill.renderOrder = 10
		bar.add(barFill)
		bar.position.set(p.p[0], BAR_Y, p.p[2])

		group.position.set(p.p[0], 0, p.p[2])
		group.rotation.y = p.yaw

		return {
			uuid: p.uuid, name: p.name, group, cyl, label, shield, mat,
			baseColor: color.clone(), arm, tilt, hp: p.hp, maxHp: p.max_hp || 100,
			dead: p.hp <= 0, labelCanvas, labelTex, bar, barFill,
			tX: p.p[0], tZ: p.p[2], tYaw: p.yaw,
			animTag: p.anim, animT: 0,
		}
	}
}

// ---------------- 简化钻石剑（远程玩家手持） ----------------

/** 剑刃沿 +Y 建模，由手腕枢轴（arm）的旋转控制指向 */
function buildRemoteSword(): THREE.Group {
	const g = new THREE.Group()

	// 剑刃（钻石青，带一点自发光）
	const blade = new THREE.Mesh(
		new THREE.BoxGeometry(0.055, 0.58, 0.15),
		new THREE.MeshStandardMaterial({
			color: 0x4aedd9, roughness: 0.25, metalness: 0.35,
			emissive: 0x0a4a42, emissiveIntensity: 0.4,
		}),
	)
	blade.position.y = 0.44
	blade.castShadow = true
	g.add(blade)

	// 剑尖（楔形）
	const tip = new THREE.Mesh(
		new THREE.ConeGeometry(0.075, 0.14, 4),
		new THREE.MeshStandardMaterial({ color: 0x4aedd9, roughness: 0.25, metalness: 0.35 }),
	)
	tip.position.y = 0.8
	tip.rotation.y = Math.PI / 4
	g.add(tip)

	// 护手（横条）
	const guard = new THREE.Mesh(
		new THREE.BoxGeometry(0.22, 0.045, 0.07),
		new THREE.MeshStandardMaterial({ color: 0x2a5a8c, roughness: 0.4 }),
	)
	guard.position.y = 0.13
	g.add(guard)

	// 剑柄
	const hilt = new THREE.Mesh(
		new THREE.BoxGeometry(0.05, 0.16, 0.05),
		new THREE.MeshStandardMaterial({ color: 0x1a2b4a, roughness: 0.7 }),
	)
	hilt.position.y = 0.03
	g.add(hilt)

	return g
}

// ---------------- 工具 ----------------

/** 名牌重绘（死亡时加 ☠ 前缀并变灰，复用同一 canvas / 纹理） */
function drawLabel(canvas: HTMLCanvasElement, tex: THREE.CanvasTexture, name: string, dead: boolean) {
	const ctx = canvas.getContext('2d')!
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	const text = dead ? `☠ ${name}` : name
	ctx.font = 'bold 30px system-ui, sans-serif'
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillStyle = 'rgba(10, 14, 20, 0.65)'
	const w = Math.min(250, ctx.measureText(text).width + 36)
	roundRect(ctx, 128 - w / 2, 6, w, 52, 12)
	ctx.fill()
	ctx.fillStyle = dead ? '#9fb4c8' : '#ffffff'
	ctx.fillText(text, 128, 34, w - 20)
	tex.needsUpdate = true
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath()
	ctx.moveTo(x + r, y)
	ctx.arcTo(x + w, y, x + w, y + h, r)
	ctx.arcTo(x + w, y + h, x, y + h, r)
	ctx.arcTo(x, y + h, x, y, r)
	ctx.arcTo(x, y, x + w, y, r)
	ctx.closePath()
}

function disposeGroup(group: THREE.Group) {
	group.traverse((o) => {
		const m = o as THREE.Mesh
		if (m.isMesh || (o as THREE.Sprite).isSprite) {
			const geo = (m as THREE.Mesh).geometry
			geo?.dispose()
			const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[]
			if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
			else mat?.dispose()
		}
	})
}
