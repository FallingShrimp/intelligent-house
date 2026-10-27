/**
 * PB ↔ SCB/PF 通信协议定义（严格对齐 docs.md 7.3–7.9）
 *
 * - 消息信封：{ v: 1, type, seq, ts, payload }，ts 为 UTC epoch 毫秒
 * - zod schema 对齐 7.6 的 Pydantic 定义，extra=forbid → .strict()
 * - device_id / cmd_id / action 在 schema 层放宽为 string：
 *   语义校验（设备存在性 → UNKNOWN_DEVICE、指令映射一致性）由业务层完成，
 *   这样才能按 7.9 错误码表产生 UNKNOWN_DEVICE / OUT_OF_RANGE 等错误。
 */
import { z } from 'zod'

// ---------- 1. 枚举与常量 ----------

export const PROTOCOL_VERSION = 1

export type Role = 'scb' | 'pf'

export type DeviceType =
	| 'light'
	| 'curtain'
	| 'ac'
	| 'tv'
	| 'door_lock'
	| 'emergency'

export type DeviceId =
	| 'living_room_light'
	| 'bedroom_light'
	| 'living_room_curtain'
	| 'air_conditioner'
	| 'tv'
	| 'door_lock'
	| 'emergency'

export type CommandId =
	| 'CMD_01'
	| 'CMD_02'
	| 'CMD_03'
	| 'CMD_04'
	| 'CMD_05'
	| 'CMD_06'
	| 'CMD_07'
	| 'CMD_08'

export type Action =
	| 'toggle'
	| 'temp_up'
	| 'temp_down'
	| 'brightness_cycle'
	| 'emergency'
	| 'emergency_reset'

export type ErrorCode =
	| 'OK'
	| 'INVALID_FORMAT'
	| 'UNKNOWN_TYPE'
	| 'UNKNOWN_DEVICE'
	| 'OUT_OF_RANGE'
	| 'INVALID_TRANSITION'
	| 'COOLDOWN'
	| 'INTERNAL'

/** 全部合法 Action（用于 ui_command 的 action 值校验） */
export const ACTIONS = [
	'toggle',
	'temp_up',
	'temp_down',
	'brightness_cycle',
	'emergency',
	'emergency_reset',
] as const

export function isAction(x: string): x is Action {
	return (ACTIONS as readonly string[]).includes(x)
}

/** CMD_xx → (device_id, action) 映射，PB 状态机据此路由（对应 docs.md 7.4 迁移表 / 7.7 COMMAND_MAP） */
export const COMMAND_MAP: Record<CommandId, { device_id: DeviceId; action: Action }> = {
	CMD_01: { device_id: 'living_room_light', action: 'toggle' },
	CMD_02: { device_id: 'living_room_curtain', action: 'toggle' },
	CMD_03: { device_id: 'air_conditioner', action: 'temp_up' },
	CMD_04: { device_id: 'air_conditioner', action: 'temp_down' },
	CMD_05: { device_id: 'tv', action: 'toggle' },
	CMD_06: { device_id: 'emergency', action: 'emergency' },
	CMD_07: { device_id: 'bedroom_light', action: 'brightness_cycle' },
	CMD_08: { device_id: 'door_lock', action: 'toggle' },
}

// ---------- 2. 设备状态（PB 为唯一事实源） ----------

export interface LightState {
	device_type: 'light'
	device_id: DeviceId
	on: boolean
	brightness: number // 0–100 %
	color_temp: number // 2700–6500 K
}

export interface CurtainState {
	device_type: 'curtain'
	device_id: DeviceId
	position: number // 0–100，0=全合 100=全开
}

export interface AcState {
	device_type: 'ac'
	device_id: DeviceId
	on: boolean
	target_temp: number // 16–30 ℃
	fan_swing: boolean
}

export interface TvState {
	device_type: 'tv'
	device_id: DeviceId
	on: boolean
	volume: number // 0–100
}

export interface DoorLockState {
	device_type: 'door_lock'
	device_id: DeviceId
	locked: boolean
}

export interface EmergencyState {
	device_type: 'emergency'
	device_id: DeviceId
	active: boolean
	triggered_at: number | null // epoch ms
}

export type DeviceState =
	| LightState
	| CurtainState
	| AcState
	| TvState
	| DoorLockState
	| EmergencyState

// ---------- 3. Payload zod schema（对齐 7.6 Pydantic 模型） ----------

/** 空调温度步长，默认 1 ℃ */
export const CommandParamsSchema = z
	.object({
		step: z.number().int().min(1).max(5),
	})
	.strict()
export type CommandParams = z.infer<typeof CommandParamsSchema>

/** 解码证据（PB 仅记录日志，不参与路由） */
export const EvidenceSchema = z
	.object({
		freq_hz: z.number(),
		window_ms: z.number().int(),
		confirm_count: z.number().int(),
	})
	.strict()

export const HelloPayloadSchema = z
	.object({
		role: z.enum(['scb', 'pf']),
		client_name: z.string(),
		client_version: z.string(),
		// 联机对战：PF 必须提供玩家名（PB 据此注册玩家并分配 uuid/颜色）
		display_name: z.string().min(1).max(24).optional(),
	})
	.strict()
export type HelloPayload = z.infer<typeof HelloPayloadSchema>

/** SCB 周期心跳（建议 5s），兼报采集在线状态 */
export const HeartbeatPayloadSchema = z
	.object({
		acq_connected: z.boolean(),
		decode_rate_hz: z.number().nullish(),
	})
	.strict()
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>

/** 解码运行参数上报（连接后及参数变更时发送），PB 仅记录日志 */
export const DecodeStatusPayloadSchema = z
	.object({
		acq_connected: z.boolean(),
		sample_rate: z.number().int().min(100),
		channels: z.array(z.string()),
		decode_window_s: z.number().gt(0),
		threshold: z.number().min(0).max(1),
	})
	.strict()
export type DecodeStatusPayload = z.infer<typeof DecodeStatusPayloadSchema>

/**
 * SSVEP 解码指令（SCB 核心上行）。
 * cmd_id / device_id / action 放宽为 string，语义校验在业务层（见文件头注释）。
 */
export const DeviceCommandPayloadSchema = z
	.object({
		cmd_id: z.string(),
		device_id: z.string(),
		action: z.string(),
		params: CommandParamsSchema.optional(),
		confidence: z.number().min(0).max(1),
		evidence: EvidenceSchema.nullish(),
	})
	.strict()
export type DeviceCommandPayload = z.infer<typeof DeviceCommandPayloadSchema>

/** 请求全量快照（重连 / 手动刷新），payload 为空对象 */
export const StateRequestPayloadSchema = z.object({}).strict()

/** PF 手动控制（调试 / 无 BCI 演示降级），语义与 device_command 一致 */
export const UiCommandPayloadSchema = z
	.object({
		device_id: z.string(),
		action: z.string(),
		params: CommandParamsSchema.optional(),
	})
	.strict()
export type UiCommandPayload = z.infer<typeof UiCommandPayloadSchema>

// ---------- 联机对战（PB 权威世界模拟，PF 只上报输入 / 动作意图） ----------

/** PF 输入状态（建议 10Hz）：位置 / 朝向 / 视线（3D，剑气方向用）/ 视角模式 / 当前动作标签 */
export const MpInputPayloadSchema = z
	.object({
		p: z.tuple([z.number(), z.number(), z.number()]),
		yaw: z.number(),
		dir: z.tuple([z.number(), z.number()]), // 相机水平前向单位向量
		dir3: z.tuple([z.number(), z.number(), z.number()]), // 相机 3D 前向（准星方向，剑气飞行用）
		mode: z.enum(['fp', 'free']),
		anim: z.string().nullish(),
	})
	.strict()
export type MpInputPayload = z.infer<typeof MpInputPayloadSchema>

/** PF 动作意图：攻击 / 格挡 / 请求复活 / 剑气 / 三选一 / 队友复活 / 台灯召唤 */
export const MpActionPayloadSchema = z
	.object({
		kind: z.enum(['attack', 'parry_start', 'parry_stop', 'respawn', 'wave', 'pick', 'revive', 'lamp']),
		segment: z.number().int().min(0).max(2).optional(),
		/** wave 专用：蓄力时长 s（PB 按每秒 10 体力结算消耗） */
		hold: z.number().min(0).max(10).optional(),
		/** pick 专用：选择的增益索引（0-15，必须是 PF 分到的 3 项之一） */
		idx: z.number().int().min(0).max(15).optional(),
		/** revive 专用：要复活的玩家 uuid */
		target: z.string().min(1).optional(),
	})
	.strict()
export type MpActionPayload = z.infer<typeof MpActionPayloadSchema>

/** PF 专属：重启 PB 服务（仅 PF 通道可发，SCB 天然隔离） */
export const AdminRestartPayloadSchema = z.object({}).strict()
export type AdminRestartPayload = z.infer<typeof AdminRestartPayloadSchema>

/** 下行广播：PB 即将重启（自接管），客户端应提示并等待重连 */
export interface AdminRestartingPayload {
	delay_ms: number
}

// ---------- 4. 消息信封 ----------

/** 统一信封校验：v 固定为 1，seq/ts 为非负整数，payload 再按 type 分发校验 */
export const EnvelopeSchema = z
	.object({
		v: z.literal(PROTOCOL_VERSION),
		type: z.string(),
		seq: z.number().int().min(0),
		ts: z.number().int().min(0),
		payload: z.unknown(),
	})
	.strict()

/** 各端点允许的上行 type → payload schema（同时用于通道归属判断） */
export const SCB_PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
	hello: HelloPayloadSchema,
	heartbeat: HeartbeatPayloadSchema,
	device_command: DeviceCommandPayloadSchema,
	decode_status: DecodeStatusPayloadSchema,
}

export const PF_PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
	hello: HelloPayloadSchema,
	state_request: StateRequestPayloadSchema,
	ui_command: UiCommandPayloadSchema,
	mp_input: MpInputPayloadSchema,
	mp_action: MpActionPayloadSchema,
	admin_restart: AdminRestartPayloadSchema,
}

// ---------- 5. 下行 payload 类型（PB 发送侧，对齐 7.7 接口） ----------

export interface TriggerInfo {
	cmd_id: CommandId
	cmd_seq: number
}

export interface CommandAckPayload {
	ack_seq: number
	ok: boolean
	code: ErrorCode
	message: string
	state?: DeviceState
}

export interface DeviceStateUpdatePayload {
	update_id: number // PB 全局单调递增
	device_id: DeviceId
	state: DeviceState
	source: 'scb' | 'manual'
	trigger?: TriggerInfo
}

export interface StateSnapshotPayload {
	update_id: number
	server_ts: number
	devices: DeviceState[]
}

export interface WelcomePayload {
	client_id: string
	server_ts: number
	snapshot: StateSnapshotPayload
}

export interface ErrorPayload {
	code: ErrorCode
	message: string
	ref_seq?: number
}

/** 提取 zod 校验失败摘要（记日志 / 回 error.message 用） */
export function zodSummary(err: z.ZodError): string {
	return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
}
