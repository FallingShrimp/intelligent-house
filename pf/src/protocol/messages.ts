/**
 * WebSocket 通信协议类型定义（PB 仿真状态层 / PF 仿真渲染层共用）
 *
 * 说明：TS 接口为编译期约束；PB 收到 SCB/PF 消息时建议用 zod 等
 * 做一次运行时校验（可选），以对齐 Pydantic 的 extra=forbid 行为。
 *
 * 来源：docs.md 7.7「PB ↔ PF：TypeScript 接口」，字段保持 snake_case，
 * 修改需与 PB（7.6 Pydantic Schema）双端同步。
 */

// ---------- 1. 枚举与常量 ----------

export const PROTOCOL_VERSION = 1;

export type Role = 'scb' | 'pf';

export type DeviceType =
  | 'light' | 'curtain' | 'ac' | 'tv' | 'door_lock' | 'emergency';

export type DeviceId =
  | 'living_room_light'
  | 'bedroom_light'
  | 'living_room_curtain'
  | 'air_conditioner'
  | 'tv'
  | 'door_lock'
  | 'emergency';

export type CommandId =
  | 'CMD_01' | 'CMD_02' | 'CMD_03' | 'CMD_04'
  | 'CMD_05' | 'CMD_06' | 'CMD_07' | 'CMD_08';

export type Action =
  | 'toggle'
  | 'temp_up'
  | 'temp_down'
  | 'brightness_cycle'
  | 'emergency'
  | 'emergency_reset';

export type ErrorCode =
  | 'OK'
  | 'INVALID_FORMAT'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_DEVICE'
  | 'OUT_OF_RANGE'
  | 'INVALID_TRANSITION'
  | 'COOLDOWN'
  | 'INTERNAL';

/** CMD_xx → (device_id, action) 映射，PB 状态机据此路由（对应 7.4 迁移表） */
export const COMMAND_MAP: Record<CommandId, { device_id: DeviceId; action: Action }> = {
  CMD_01: { device_id: 'living_room_light', action: 'toggle' },
  CMD_02: { device_id: 'living_room_curtain', action: 'toggle' },
  CMD_03: { device_id: 'air_conditioner', action: 'temp_up' },
  CMD_04: { device_id: 'air_conditioner', action: 'temp_down' },
  CMD_05: { device_id: 'tv', action: 'toggle' },
  CMD_06: { device_id: 'emergency', action: 'emergency' },
  CMD_07: { device_id: 'bedroom_light', action: 'brightness_cycle' },
  CMD_08: { device_id: 'door_lock', action: 'toggle' },
};

// ---------- 2. 设备状态 ----------

export interface LightState {
  device_type: 'light';
  device_id: DeviceId;
  on: boolean;
  brightness: number;   // 0–100
  color_temp: number;   // 2700–6500 K
}

export interface CurtainState {
  device_type: 'curtain';
  device_id: DeviceId;
  position: number;     // 0–100，0=全合 100=全开
}

export interface AcState {
  device_type: 'ac';
  device_id: DeviceId;
  on: boolean;
  target_temp: number;  // 16–30 ℃
  fan_swing: boolean;
}

export interface TvState {
  device_type: 'tv';
  device_id: DeviceId;
  on: boolean;
  volume: number;       // 0–100
}

export interface DoorLockState {
  device_type: 'door_lock';
  device_id: DeviceId;
  locked: boolean;
}

export interface EmergencyState {
  device_type: 'emergency';
  device_id: DeviceId;
  active: boolean;
  triggered_at: number | null;  // epoch ms
}

export type DeviceState =
  | LightState
  | CurtainState
  | AcState
  | TvState
  | DoorLockState
  | EmergencyState;

// ---------- 3. Payload ----------

export interface HelloPayload {
  role: Role;
  client_name: string;
  client_version: string;
}

export interface WelcomePayload {
  client_id: string;
  server_ts: number;
  snapshot: StateSnapshotPayload;
}

export interface HeartbeatPayload {
  acq_connected: boolean;
  decode_rate_hz?: number;
}

export interface DecodeStatusPayload {
  acq_connected: boolean;
  sample_rate: number;    // Hz
  channels: string[];     // ["Oz", "O1", "O2", "POz"]
  decode_window_s: number;
  threshold: number;      // 0–1
}

export interface CommandParams {
  step?: number;          // 空调温度步长，默认 1
}

export interface Evidence {
  freq_hz: number;
  window_ms: number;
  confirm_count: number;
}

export interface DeviceCommandPayload {
  cmd_id: CommandId;
  device_id: DeviceId;
  action: Action;
  params?: CommandParams;
  confidence: number;     // 0–1
  evidence?: Evidence;
}

export interface StateRequestPayload {
  // 空对象
}

export interface UiCommandPayload {
  device_id: DeviceId;
  action: Action;
  params?: CommandParams;
}

export interface TriggerInfo {
  cmd_id: CommandId;
  cmd_seq: number;
}

export interface CommandAckPayload {
  ack_seq: number;
  ok: boolean;
  code: ErrorCode;
  message: string;
  state?: DeviceState;
}

export interface DeviceStateUpdatePayload {
  update_id: number;      // PB 全局单调递增
  device_id: DeviceId;
  state: DeviceState;
  source: 'scb' | 'manual';
  trigger?: TriggerInfo;
}

export interface StateSnapshotPayload {
  update_id: number;
  server_ts: number;
  devices: DeviceState[];
}

export interface ConfigUpdatePayload {
  threshold?: number;
  confirm_count?: number;
  cooldown_s?: number;
  decode_window_s?: number;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  ref_seq?: number;
}

// ---------- 4. 消息信封 ----------

export interface BaseMessage {
  v: typeof PROTOCOL_VERSION;
  /** 发送端连接内单调递增 */
  seq: number;
  /** 发送时刻 epoch 毫秒 */
  ts: number;
}

// ---- 通用（两通道复用） ----

export interface HelloMsg extends BaseMessage { type: 'hello'; payload: HelloPayload; }
export interface WelcomeMsg extends BaseMessage { type: 'welcome'; payload: WelcomePayload; }
export interface CommandAckMsg extends BaseMessage { type: 'command_ack'; payload: CommandAckPayload; }
export interface DeviceStateUpdateMsg extends BaseMessage { type: 'device_state_update'; payload: DeviceStateUpdatePayload; }
export interface StateSnapshotMsg extends BaseMessage { type: 'state_snapshot'; payload: StateSnapshotPayload; }
export interface ErrorMsg extends BaseMessage { type: 'error'; payload: ErrorPayload; }

// ---- SCB → PB ----

export interface HeartbeatMsg extends BaseMessage { type: 'heartbeat'; payload: HeartbeatPayload; }
export interface DeviceCommandMsg extends BaseMessage { type: 'device_command'; payload: DeviceCommandPayload; }
export interface DecodeStatusMsg extends BaseMessage { type: 'decode_status'; payload: DecodeStatusPayload; }

// ---- PF → PB ----

export interface StateRequestMsg extends BaseMessage { type: 'state_request'; payload: StateRequestPayload; }
export interface UiCommandMsg extends BaseMessage { type: 'ui_command'; payload: UiCommandPayload; }

// ---- PB → SCB ----

export interface ConfigUpdateMsg extends BaseMessage { type: 'config_update'; payload: ConfigUpdatePayload; }

// ---------- 5. 通道消息集合 ----------

/** PB 视角：从 SCB 接收 */
export type FromScb = HelloMsg | HeartbeatMsg | DeviceCommandMsg | DecodeStatusMsg;
/** PB 视角：发送给 SCB */
export type ToScb = WelcomeMsg | CommandAckMsg | DeviceStateUpdateMsg | StateSnapshotMsg | ConfigUpdateMsg | ErrorMsg;
/** PB 视角：从 PF 接收 */
export type FromPf = HelloMsg | StateRequestMsg | UiCommandMsg;
/** PB 视角：发送给 PF */
export type ToPf = WelcomeMsg | StateSnapshotMsg | DeviceStateUpdateMsg | CommandAckMsg | ErrorMsg;

/** 按类型收窄消息（PF 侧常用） */
export function isType<T extends ToPf['type']>(msg: ToPf, type: T): msg is Extract<ToPf, { type: T }> {
  return msg.type === type;
}
