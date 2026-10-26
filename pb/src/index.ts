/**
 * 仿真状态层（PB）服务入口 —— ElysiaJS + Bun
 *
 * 职责（docs.md 第四章）：
 * - WebSocket 服务端：/ws/scb（意图抽象层）与 /ws/pf（仿真渲染层）双端点角色隔离，
 *   hello.role 二次校验，不匹配回 error 并断开
 * - 消息路由：SCB 上行 hello/heartbeat/device_command/decode_status；
 *   PF 上行 hello/state_request/ui_command
 * - 设备状态机：7 台设备、8 条 SSVEP 指令（CMD_01–CMD_08），PB 为状态唯一事实源
 * - 下行：welcome（client_id + 全量快照）、command_ack（仅指令发送方）、
 *   device_state_update（广播给所有 PF 与 SCB）、state_snapshot、error（7.9 错误码表）
 * - 指令冷却：同一 device_id + cmd_id 3 秒，命中回 COOLDOWN；
 *   ui_command（手动控制 source=manual）不受冷却约束
 * - 附加：HTTP GET /api/state 返回当前快照（调试用）；SIGINT/SIGTERM 优雅关闭
 */
import { Elysia } from 'elysia'
import pino from 'pino'
import {
	COMMAND_MAP,
	DecodeStatusPayloadSchema,
	DeviceCommandPayloadSchema,
	EnvelopeSchema,
	HeartbeatPayloadSchema,
	HelloPayloadSchema,
	MpActionPayloadSchema,
	MpInputPayloadSchema,
	PF_PAYLOAD_SCHEMAS,
	PROTOCOL_VERSION,
	SCB_PAYLOAD_SCHEMAS,
	StateRequestPayloadSchema,
	UiCommandPayloadSchema,
	isAction,
	zodSummary,
} from './protocol'
import type {
	CommandAckPayload,
	CommandId,
	DeviceCommandPayload,
	DeviceId,
	DeviceState,
	DeviceStateUpdatePayload,
	AdminRestartingPayload,
	ErrorCode,
	ErrorPayload,
	HelloPayload,
	MpActionPayload,
	MpInputPayload,
	Role,
	StateSnapshotPayload,
	TriggerInfo,
	UiCommandPayload,
} from './protocol'
import { AdminRestartPayloadSchema } from './protocol'
import { COOLDOWN_MS, applyAction, createInitialDevices } from './devices'
import { World } from './world'

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const PORT = Number(process.env.PORT ?? 3000)

// ---------- 全局状态（内存，PB 为 SSOT） ----------

const devices = new Map<string, DeviceState>(
	createInitialDevices().map((d) => [d.device_id, d]),
)
/** 联机对战权威世界（玩家注册 / 僵尸 AI / 伤害裁决的唯一事实源；导出供冒烟测试同进程直读） */
export const world = new World()
/** 设备状态广播 update_id：PB 全局单调递增 */
let updateId = 0
/** client_id 分配计数器 */
let clientCounter = 0
/** 指令冷却表：key = `${device_id}|${cmd_id}` → 上次受理时刻（epoch ms） */
const cooldowns = new Map<string, number>()

// ---------- 连接管理 ----------

/** PB 侧用到的 WebSocket 最小接口（与 ElysiaWS 结构兼容） */
interface WSLike {
	id: string
	send(data: string): unknown
	close(): unknown
}

interface Conn {
	ws: WSLike
	role: Role
	clientId: string | null // hello 通过后分配
	helloed: boolean
	outSeq: number // PB → 本连接的下行 seq，连接内单调递增
	acqConnected: boolean | null // SCB 心跳上报的 ND8 采集在线状态
	mpUuid: string | null // 联机对战玩家 uuid（PF hello 后分配）
}

const conns = new Map<string, Conn>() // key = ws.id

// ---------- 下行发送 ----------

function sendMessage(conn: Conn, type: string, payload: unknown): void {
	const msg = { v: PROTOCOL_VERSION, type, seq: ++conn.outSeq, ts: Date.now(), payload }
	try {
		conn.ws.send(JSON.stringify(msg))
	} catch (err) {
		logger.warn({ client_id: conn.clientId, type, err: String(err) }, '下行消息发送失败')
	}
}

/** 协议级错误（7.9 错误码表），ref_seq 关联出错消息的 seq */
function sendError(conn: Conn, code: ErrorCode, message: string, refSeq?: number): void {
	const payload: ErrorPayload = { code, message }
	if (refSeq !== undefined) payload.ref_seq = refSeq
	sendMessage(conn, 'error', payload)
}

function snapshotPayload(): StateSnapshotPayload {
	return { update_id: updateId, server_ts: Date.now(), devices: [...devices.values()] }
}

/**
 * 状态变更广播：update_id 全局递增，发给所有已完成握手的 PF 与 SCB 连接
 * （SCB 调试显示复用同一广播，docs.md 7.9 时序）。
 * trigger 仅在 SCB 指令触发时携带 { cmd_id, cmd_seq }。
 */
function broadcastDeviceStateUpdate(
	deviceId: DeviceId,
	state: DeviceState,
	source: 'scb' | 'manual',
	trigger?: TriggerInfo,
): void {
	updateId += 1
	const payload: DeviceStateUpdatePayload = {
		update_id: updateId,
		device_id: deviceId,
		state,
		source,
		trigger,
	}
	for (const conn of conns.values()) {
		if (conn.helloed) sendMessage(conn, 'device_state_update', payload)
	}
	logger.info(
		{ update_id: updateId, device_id: deviceId, source, trigger: trigger ?? null },
		'设备状态变更广播',
	)
}

// ---------- 消息处理器 ----------

/** hello 接入注册：role 二次校验（不匹配回 error 并断开）→ 分配 client_id → welcome（含全量快照） */
function handleHello(conn: Conn, data: HelloPayload): void {
	if (data.role !== conn.role) {
		logger.warn(
			{ endpoint: `/ws/${conn.role}`, hello_role: data.role },
			'hello.role 与端点不匹配，回 error 并断开',
		)
		sendError(conn, 'INVALID_FORMAT', `hello.role=${data.role} 与端点 /ws/${conn.role} 不匹配`)
		conn.ws.close()
		return
	}
	if (conn.helloed) {
		sendError(conn, 'INVALID_FORMAT', '重复发送 hello，连接已完成注册')
		return
	}
	conn.helloed = true
	conn.clientId = `${conn.role}-${++clientCounter}`

	// 联机对战：PF 必须给出 display_name 才算注册成功（分配 uuid + 随机颜色）
	let you: { uuid: string; name: string; color: string } | undefined
	if (conn.role === 'pf') {
		if (!data.display_name) {
			conn.helloed = false
			sendError(conn, 'INVALID_FORMAT', 'PF 连接必须携带 display_name（玩家名）')
			conn.ws.close()
			return
		}
		const joined = world.join(conn.ws.id, data.display_name)
		conn.mpUuid = joined.uuid
		you = { uuid: joined.uuid, name: data.display_name, color: joined.color }
	}

	sendMessage(conn, 'welcome', {
		client_id: conn.clientId,
		server_ts: Date.now(),
		snapshot: snapshotPayload(),
		...(you ? { you } : {}),
	})
	logger.info(
		{
			client_id: conn.clientId,
			client_name: data.client_name,
			client_version: data.client_version,
			display_name: data.display_name ?? null,
			mp_uuid: conn.mpUuid,
		},
		'客户端注册完成',
	)
}

/**
 * SCB 核心上行：SSVEP 解码指令。
 * 流程：schema 校验 → 设备存在性（UNKNOWN_DEVICE）→ COMMAND_MAP 路由与一致性
 * → 冷却检查（同一 device_id+cmd_id 3s，命中回 COOLDOWN）→ 状态机迁移 → 广播 → command_ack
 */
function handleDeviceCommand(conn: Conn, seq: number, data: DeviceCommandPayload): void {
	logger.info(
		{
			client_id: conn.clientId,
			cmd_id: data.cmd_id,
			device_id: data.device_id,
			action: data.action,
			confidence: data.confidence,
			evidence: data.evidence ?? null,
		},
		'收到 device_command',
	)

	// 1) 设备存在性 → UNKNOWN_DEVICE（7.9 错误码表）
	if (!devices.has(data.device_id)) {
		logger.warn({ client_id: conn.clientId, device_id: data.device_id }, '指令目标设备不在注册表')
		sendError(conn, 'UNKNOWN_DEVICE', `device_id 不在注册表: ${data.device_id}`, seq)
		return
	}
	// 2) cmd_id → COMMAND_MAP 路由（docs.md 7.7）
	const mapped = COMMAND_MAP[data.cmd_id as CommandId]
	if (!mapped) {
		sendError(conn, 'INVALID_FORMAT', `未知 cmd_id: ${data.cmd_id}`, seq)
		return
	}
	// 3) cmd_id 与 payload 中 device_id/action 的一致性
	if (mapped.device_id !== data.device_id || mapped.action !== data.action) {
		sendError(
			conn,
			'INVALID_FORMAT',
			`cmd_id=${data.cmd_id} 应作用于 ${mapped.device_id}/${mapped.action}，与 payload 不一致`,
			seq,
		)
		return
	}
	// 4) 冷却检查（docs.md 7.9：同一指令触发后 3 秒内不再重复触发）
	const key = `${data.device_id}|${data.cmd_id}`
	const last = cooldowns.get(key)
	const now = Date.now()
	if (last !== undefined && now - last < COOLDOWN_MS) {
		const remainS = ((COOLDOWN_MS - (now - last)) / 1000).toFixed(1)
		sendMessage(conn, 'command_ack', {
			ack_seq: seq,
			ok: false,
			code: 'COOLDOWN',
			message: `指令冷却中（${remainS}s 后可重试）`,
		} satisfies CommandAckPayload)
		logger.info({ client_id: conn.clientId, key }, '指令命中冷却窗口，拒绝')
		return
	}
	// 5) 状态机迁移（docs.md 7.4 指令 → 状态迁移映射）
	const result = applyAction(devices.get(data.device_id)!, mapped.action, data.params?.step ?? 1)
	if (!result.ok) {
		sendMessage(conn, 'command_ack', {
			ack_seq: seq,
			ok: false,
			code: result.code,
			message: result.message,
		} satisfies CommandAckPayload)
		logger.warn({ client_id: conn.clientId, code: result.code, message: result.message }, '指令状态迁移被拒绝')
		return
	}
	// 6) 提交状态 → 全局广播（携带 trigger）→ 点对点 ack（回显 ack_seq + 新状态）
	devices.set(data.device_id, result.state)
	cooldowns.set(key, now)
	broadcastDeviceStateUpdate(data.device_id as DeviceId, result.state, 'scb', {
		cmd_id: data.cmd_id as CommandId,
		cmd_seq: seq,
	})
	sendMessage(conn, 'command_ack', {
		ack_seq: seq,
		ok: true,
		code: 'OK',
		message: '',
		state: result.state,
	} satisfies CommandAckPayload)
}

/**
 * PF 手动控制：语义与 device_command 一致，但不受冷却约束（docs.md 7.9 约定 4），
 * source='manual'，广播不携带 trigger（无 cmd_id）。
 */
function handleUiCommand(conn: Conn, seq: number, data: UiCommandPayload): void {
	logger.info(
		{ client_id: conn.clientId, device_id: data.device_id, action: data.action },
		'收到 ui_command（手动控制，不走冷却）',
	)
	if (!devices.has(data.device_id)) {
		sendError(conn, 'UNKNOWN_DEVICE', `device_id 不在注册表: ${data.device_id}`, seq)
		return
	}
	if (!isAction(data.action)) {
		sendError(conn, 'INVALID_FORMAT', `未知 action: ${data.action}`, seq)
		return
	}
	const result = applyAction(devices.get(data.device_id)!, data.action, data.params?.step ?? 1)
	if (!result.ok) {
		sendMessage(conn, 'command_ack', {
			ack_seq: seq,
			ok: false,
			code: result.code,
			message: result.message,
		} satisfies CommandAckPayload)
		logger.warn({ client_id: conn.clientId, code: result.code, message: result.message }, '手动指令状态迁移被拒绝')
		return
	}
	devices.set(data.device_id, result.state)
	broadcastDeviceStateUpdate(data.device_id as DeviceId, result.state, 'manual')
	sendMessage(conn, 'command_ack', {
		ack_seq: seq,
		ok: true,
		code: 'OK',
		message: '',
		state: result.state,
	} satisfies CommandAckPayload)
}

// ---------- 上行消息路由 ----------

function routeMessage(conn: Conn, raw: unknown): void {
	// 1) JSON 解析（单帧单消息）。
	//    Elysia 1.4 的 ws 会将 JSON 文本帧自动解析为对象传入，此处兼容 object / string 两种形态
	let parsed: unknown
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw)
		} catch {
			sendError(conn, 'INVALID_FORMAT', 'JSON 解析失败（单帧须为单条 JSON 消息）')
			return
		}
	} else if (raw !== null && typeof raw === 'object') {
		parsed = raw
	} else {
		sendError(conn, 'INVALID_FORMAT', `不支持的帧格式: ${typeof raw}`)
		return
	}
	// 2) 统一信封校验（v/seq/ts 结构）
	const env = EnvelopeSchema.safeParse(parsed)
	if (!env.success) {
		const maybeSeq = (parsed as { seq?: unknown } | null)?.seq
		const refSeq = typeof maybeSeq === 'number' ? maybeSeq : undefined
		sendError(conn, 'INVALID_FORMAT', `消息信封校验失败: ${zodSummary(env.error)}`, refSeq)
		return
	}
	const { type, seq, payload } = env.data

	// 3) 通道归属：type 必须属于当前端点允许的上行集合
	const allowed = conn.role === 'scb' ? SCB_PAYLOAD_SCHEMAS : PF_PAYLOAD_SCHEMAS
	if (!(type in allowed)) {
		sendError(conn, 'UNKNOWN_TYPE', `未知或本通道不支持的消息 type: ${type}`, seq)
		return
	}
	// 4) 握手前置：未注册前仅接受 hello
	if (!conn.helloed && type !== 'hello') {
		sendError(conn, 'INVALID_FORMAT', '须先发送 hello 完成注册', seq)
		return
	}

	// 5) 按 type 分发（payload 逐类型 zod 校验，strict 对齐 Pydantic extra=forbid）
	switch (type) {
		case 'hello': {
			const p = HelloPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `hello payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			handleHello(conn, p.data)
			return
		}
		case 'heartbeat': {
			// 心跳：记录采集在线状态与解码频率（建议 5s 周期）
			const p = HeartbeatPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `heartbeat payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			conn.acqConnected = p.data.acq_connected
			logger.info(
				{ client_id: conn.clientId, acq_connected: p.data.acq_connected, decode_rate_hz: p.data.decode_rate_hz ?? null },
				'SCB 心跳',
			)
			return
		}
		case 'decode_status': {
			// 解码参数上报：仅记录日志（协议约定 PB 不参与解码参数路由）
			const p = DecodeStatusPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `decode_status payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			logger.info({ client_id: conn.clientId, ...p.data }, 'SCB 解码参数上报')
			return
		}
		case 'device_command': {
			const p = DeviceCommandPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `device_command payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			handleDeviceCommand(conn, seq, p.data)
			return
		}
		case 'state_request': {
			// 请求全量快照（payload 为空对象）
			const p = StateRequestPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `state_request payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			sendMessage(conn, 'state_snapshot', snapshotPayload())
			return
		}
		case 'ui_command': {
			const p = UiCommandPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `ui_command payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			handleUiCommand(conn, seq, p.data)
			return
		}
		case 'mp_input': {
			const p = MpInputPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `mp_input payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			if (conn.mpUuid) world.setInput(conn.mpUuid, p.data)
			return
		}
		case 'mp_action': {
			const p = MpActionPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `mp_action payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			if (!conn.mpUuid) return
			const d = p.data
			if (d.kind === 'pick') {
				if (typeof d.idx === 'number') world.pickChoose(conn.mpUuid, d.idx)
				return
			}
			if (d.kind === 'revive') {
				if (d.target) world.reviveBy(conn.mpUuid, d.target)
				return
			}
			world.action(conn.mpUuid, d)
			return
		}
		case 'admin_restart': {
			const p = AdminRestartPayloadSchema.safeParse(payload)
			if (!p.success) {
				sendError(conn, 'INVALID_FORMAT', `admin_restart payload 校验失败: ${zodSummary(p.error)}`, seq)
				return
			}
			handleAdminRestart(conn)
			return
		}
		default:
			sendError(conn, 'UNKNOWN_TYPE', `未知消息 type: ${type}`, seq)
	}
}

/**
 * 重启 PB（自接管）：广播 admin_restarting → 300ms 后 spawn 新 PB 进程
 * （携带 PB_TAKEOVER_PORT，新实例 listen 失败自动重试）→ 本进程退出。
 * 已知影响：设备状态机随进程重置回初始快照，SCB 重连后按其实际状态重新同步。
 */
let restarting = false
function handleAdminRestart(conn: Conn): void {
	if (restarting) return // 幂等：重启流程进行中忽略重复请求
	restarting = true
	logger.warn({ client_id: conn.clientId }, '收到 admin_restart：PB 自接管重启')
	const payload: AdminRestartingPayload = { delay_ms: 300 }
	for (const c of conns.values()) {
		if (!c.helloed) continue
		sendMessage(c, 'admin_restarting', payload)
	}
	setTimeout(() => {
		try {
			const child = Bun.spawn([process.execPath, 'src/index.ts'], {
				env: { ...process.env, PB_TAKEOVER_PORT: String(PORT) },
				stdio: ['ignore', 'inherit', 'inherit'],
			})
			logger.warn({ child_pid: child.pid, port: PORT }, '新 PB 进程已拉起，本进程退出')
		} catch (err) {
			logger.error({ err: String(err) }, 'PB 自接管重启：spawn 失败')
		}
		process.exit(0)
	}, 300)
}

// ---------- Elysia 应用 ----------

export const app = new Elysia()
	// 调试接口：返回当前全量快照（与 StateSnapshotPayload 同构）
	.get('/api/state', () => snapshotPayload())
	.ws('/ws/scb', {
		open(ws) {
			onOpen(ws as unknown as WSLike, 'scb')
		},
		message(ws, message) {
			onMessage(ws as unknown as WSLike, message)
		},
		close(ws) {
			onClose(ws as unknown as WSLike)
		},
	})
	.ws('/ws/pf', {
		open(ws) {
			onOpen(ws as unknown as WSLike, 'pf')
		},
		message(ws, message) {
			onMessage(ws as unknown as WSLike, message)
		},
		close(ws) {
			onClose(ws as unknown as WSLike)
		},
	})

function onOpen(ws: WSLike, role: Role): void {
	conns.set(ws.id, {
		ws,
		role,
		clientId: null,
		helloed: false,
		outSeq: 0,
		acqConnected: null,
		mpUuid: null,
	})
	logger.info({ endpoint: `/ws/${role}`, ws_id: ws.id }, '连接建立，等待 hello')
}

function onMessage(ws: WSLike, message: unknown): void {
	const conn = conns.get(ws.id)
	if (!conn) return
	try {
		routeMessage(conn, message)
	} catch (err) {
		// 兜底：单条消息处理异常不拖垮连接，按 7.9 回 INTERNAL
		logger.error({ client_id: conn.clientId, err: String(err) }, '消息处理异常')
		sendError(conn, 'INTERNAL', '服务端内部错误')
	}
}

function onClose(ws: WSLike): void {
	const conn = conns.get(ws.id)
	conns.delete(ws.id)
	// 联机对战：断开即离开房间（世界内移除玩家）
	if (conn) world.leave(conn.ws.id)
	logger.info({ client_id: conn?.clientId ?? null, ws_id: ws.id }, '连接关闭')
}

// ---------- 启动与优雅关闭 ----------

/**
 * 联机对战主循环：10Hz tick + world 快照 / 事件广播（仅发给已注册 PF）。
 * 独立导出以便冒烟测试（scripts/multi_smoke.ts）在导入模式下启动。
 */
export function startWorldLoop(): () => void {
	let lastTick = Date.now()
	const MP_TICK_MS = 100
	const mpTimer = setInterval(() => {
		const now = Date.now()
		const dt = Math.min(0.25, (now - lastTick) / 1000)
		lastTick = now
		world.tick(dt)
		const snap = world.snapshot()
		const events = world.drainEvents()
		for (const conn of conns.values()) {
			if (!conn.helloed || conn.role !== 'pf') continue
			sendMessage(conn, 'world', snap)
			for (const ev of events) sendMessage(conn, 'event', ev)
		}
	}, MP_TICK_MS)
	return () => clearInterval(mpTimer)
}

if (import.meta.main) {
	// 显式绑定全网卡：局域网设备的 PF 客户端需要经内网 IP 访问 WS
	// 自接管重启（PB_TAKEOVER_PORT）：旧进程退出端口释放有延迟 → listen 失败重试（200ms × 60）
	const takeover = Boolean(process.env.PB_TAKEOVER_PORT)
	for (let attempt = 0; ; attempt++) {
		try {
			app.listen({ port: PORT, hostname: '0.0.0.0' })
			break
		} catch (err) {
			if (!takeover || attempt >= 60) throw err
			logger.warn({ port: PORT, attempt: attempt + 1, err: String(err) }, 'listen 失败（接管重启），200ms 后重试')
			await Bun.sleep(200)
		}
	}
	logger.info(
		{ port: app.server?.port, scb: `/ws/scb`, pf: `/ws/pf`, http: `/api/state` },
		'PB 仿真状态层已启动',
	)

	const stopWorldLoop = startWorldLoop()

	const shutdown = (signal: string) => {
		logger.info({ signal }, '收到退出信号，优雅关闭中')
		stopWorldLoop()
		for (const conn of conns.values()) {
			try {
				conn.ws.close()
			} catch {
				// 连接可能已关闭，忽略
			}
		}
		conns.clear()
		app.server?.stop(true)
		logger.info('PB 已停止')
		process.exit(0)
	}
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('SIGTERM', () => shutdown('SIGTERM'))
}
