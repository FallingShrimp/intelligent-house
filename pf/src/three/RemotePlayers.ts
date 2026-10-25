/**
 * 远程玩家渲染：每个联机对等体渲染为一个彩色圆柱体 + 头顶名牌
 *
 * - 颜色由 PB 在连接时随机分配（welcome.you / world.players.color）
 * - 位置 / 朝向按 10Hz 快照插值；仅渲染 fp（第一人称）状态的玩家
 * - 动作标签（挥剑 / 格挡）驱动简单的倾斜脉冲；格挡中脚下显示护盾环
 */
import * as THREE from 'three'
import type { NetPlayerState } from '../protocol/messages'

const CYL_R = 0.32
const CYL_H = 1.7

interface RemoteEntry {
	uuid: string
	group: THREE.Group
	cyl: THREE.Mesh
	label: THREE.Sprite
	shield: THREE.Mesh
	mat: THREE.MeshStandardMaterial
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
			}
			e.tX = p.p[0]
			e.tZ = p.p[2]
			e.tYaw = p.yaw
			// 新动作标签 → 触发倾斜脉冲
			if (p.anim && p.anim !== e.animTag) e.animT = 0.3
			e.animTag = p.anim
			e.shield.visible = p.blocking
		}
		// 移除消失 / 退出第一人称的玩家
		for (const [uuid, e] of [...this.map]) {
			if (!seen.has(uuid)) {
				e.group.removeFromParent()
				disposeGroup(e.group)
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
			// 动作倾斜脉冲（衰减）
			if (e.animT > 0) {
				e.animT = Math.max(0, e.animT - dt)
				g.rotation.z = Math.sin((0.3 - e.animT) * 20) * 0.12 * (e.animT / 0.3)
			} else {
				g.rotation.z = 0
			}
			// 名牌始终面向相机（Sprite 自带）
		}
	}

	dispose() {
		for (const e of this.map.values()) {
			e.group.removeFromParent()
			disposeGroup(e.group)
		}
		this.map.clear()
	}

	// ---------------- 私有 ----------------

	private create(p: NetPlayerState): RemoteEntry {
		const group = new THREE.Group()
		const color = new THREE.Color(p.color)

		const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
		const cyl = new THREE.Mesh(new THREE.CylinderGeometry(CYL_R, CYL_R, CYL_H, 20), mat)
		cyl.position.y = CYL_H / 2
		cyl.castShadow = true
		group.add(cyl)

		// 头顶半球（区分朝向）
		const head = new THREE.Mesh(
			new THREE.SphereGeometry(CYL_R, 16, 12),
			new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
		)
		head.position.y = CYL_H
		group.add(head)

		// 朝向指示（面前小方块）
		const nose = new THREE.Mesh(
			new THREE.BoxGeometry(0.1, 0.1, 0.18),
			new THREE.MeshStandardMaterial({ color: 0x222831 }),
		)
		nose.position.set(0, CYL_H - 0.15, CYL_R + 0.06)
		group.add(nose)

		// 格挡护盾环（脚下）
		const shield = new THREE.Mesh(
			new THREE.RingGeometry(CYL_R + 0.1, CYL_R + 0.22, 32),
			new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
		)
		shield.rotation.x = -Math.PI / 2
		shield.position.y = 0.04
		shield.visible = false
		group.add(shield)

		// 名牌
		const label = makeLabel(p.name, `#${color.getHexString()}`)
		label.position.y = CYL_H + 0.45
		group.add(label)

		group.position.set(p.p[0], 0, p.p[2])
		group.rotation.y = p.yaw

		return {
			uuid: p.uuid, group, cyl, label, shield, mat,
			tX: p.p[0], tZ: p.p[2], tYaw: p.yaw,
			animTag: p.anim, animT: 0,
		}
	}
}

// ---------------- 工具 ----------------

function makeLabel(name: string, sub: string): THREE.Sprite {
	const canvas = document.createElement('canvas')
	canvas.width = 256
	canvas.height = 64
	const ctx = canvas.getContext('2d')!
	ctx.font = 'bold 30px system-ui, sans-serif'
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillStyle = 'rgba(10, 14, 20, 0.65)'
	const w = Math.min(250, ctx.measureText(name).width + 36)
	roundRect(ctx, 128 - w / 2, 6, w, 52, 12)
	ctx.fill()
	ctx.fillStyle = '#ffffff'
	ctx.fillText(name, 128, 34, w - 20)
	void sub
	const tex = new THREE.CanvasTexture(canvas)
	tex.colorSpace = THREE.SRGBColorSpace
	const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }))
	sprite.scale.set(1.6, 0.4, 1)
	return sprite
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
