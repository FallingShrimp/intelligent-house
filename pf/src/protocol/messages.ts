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
  /** 联机对战：PF 必须携带玩家名（localStorage DisplayName） */
  display_name?: string;
}

export interface PlayerYou {
  uuid: string;
  name: string;
  color: string;
}

export interface WelcomePayload {
  client_id: string;
  server_ts: number;
  snapshot: StateSnapshotPayload;
  /** 联机对战：本客户端的玩家身份 */
  you?: PlayerYou;
}

// ---------- 联机对战（PB 权威世界模拟） ----------

/** PF → PB 输入状态（10Hz） */
export interface MpInputPayload {
  p: [number, number, number];
  yaw: number;
  dir: [number, number];
  /** 相机 3D 前向（准星方向，剑气飞行方向用） */
  dir3: [number, number, number];
  mode: 'fp' | 'free';
  anim?: string | null;
}

/** PF → PB 动作意图 */
export interface MpActionPayload {
  kind: 'attack' | 'parry_start' | 'parry_stop' | 'respawn' | 'wave' | 'pick' | 'revive' | 'lamp'
  segment?: number
  /** wave 专用：蓄力时长 s（PB 按每秒 10 体力结算消耗） */
  hold?: number
  /** pick 专用：所选增益索引（0–15，必须是 PB 分到自己抽中的 3 项之一） */
  idx?: number
  /** revive 专用：要复活的队友（尸体）uuid */
  target?: string
}

export type ZNetState =
  | 'enter' | 'chase' | 'windup' | 'recover' | 'stunned' | 'dead'
  | 'sweep' | 'lungeWind' | 'lungeDash' | 'roar';

export interface NetPlayerState {
  uuid: string; name: string; color: string;
  p: [number, number, number]; yaw: number;
  fp: boolean;
  hp: number; st: number;
  /** 击杀三选一累积增益（血条比例 / 伤害数字等展示用） */
  max_hp: number; max_st: number; atk: number; dmg_mul: number;
  stun_for: number;
  blocking: boolean;
  anim: string | null;
  kills: number;
  /** 格挡最大持续 s / 完美格挡窗口比例（窗口 = max_block × parry_pct）/ 重击蓄力时长 s */
  max_block: number; parry_pct: number; charge_dur: number;
  /** 荆棘（受击反伤比例）/ 吸血（造成伤害回复固定值）/ 连续剑气（蓄力后追加发数） */
  thorn_pct: number; lifesteal: number; multi_wave: number;
  /** 冲击力（攻击扣对方体力的倍率）/ 稳定性（受击扣自身体力的抗性） */
  impact: number; stability: number;
  /** 暴击率（0~1）/ 暴击伤害加成（暴击伤害 = 基础 × (1 + crit_dmg)） */
  crit_rate: number; crit_dmg: number;
  /** 化气（完美格挡回复比例：回复血量 = 格挡伤害 × huaqi） */
  huaqi: number;
  /** 三选一状态（进行中非空）：抽到的 3 个增益索引 + 是否已选 */
  pick: { options: number[]; done: boolean } | null;
}

export interface NetZombieState {
  id: number;
  p: [number, number, number]; yaw: number;
  hp: number; st: number;
  state: ZNetState; st_t: number; windup_dur: number;
  vuln: number;
  target: boolean;
}

/** PB → PF 世界快照（10Hz） */
export interface WorldPayload {
  t: number;
  chase_left: number;
  /** 击杀三选一进行中（全员选完前 PB 冻结 tick） */
  pick_phase: boolean;
  players: NetPlayerState[];
  zombies: NetZombieState[];
}

/** 伤害符号（与 PB DamageSign 枚举同构）：治疗 / 被闪避·格挡 / 正常 / 暴击 */
export type DamageSign = -1 | 0 | 1 | 2;

/** PB → PF 战斗事件（伤害 / 格挡 / 眩晕 / 击退等，瞬时效果触发） */
export type MpEventPayload =
  | { kind: 'join'; uuid: string; name: string; color: string }
  | { kind: 'leave'; uuid: string; name: string }
  | { kind: 'dmg_z'; id: number; amount: number; sign: DamageSign; by: string }
  | { kind: 'dmg_p'; uuid: string; amount: number; sign: DamageSign; by: string; interrupt: boolean }
  | { kind: 'parry'; uuid: string; perfect: boolean; fail: boolean; drain: number; byZombie: boolean }
  | { kind: 'zstun'; id: number; mul: number }
  | { kind: 'zdie'; id: number }
  | { kind: 'knockback'; uuid: string; dx: number; dz: number; speed: number }
  | { kind: 'slow'; uuid: string; dur: number }
  | { kind: 'guardbreak'; uuid: string; dur: number }
  /** 复活：pos 为复活落点（手动 = 出生点 / 队友复活 = 原地），PF 相机复位用 */
  | { kind: 'respawn'; uuid: string; pos: [number, number, number] }
  | { kind: 'counter_open' }
  | { kind: 'roar_interrupt'; id: number }
  /** 重击剑气：by 玩家从 (x,y,z) 沿 3D (dx,dy,dz) 发射，绕飞行轴随机 roll 旋转（各 PF 本地渲染飞行视觉 + 与 PB 同公式定向，伤害由 PB 弹道裁决） */
  | { kind: 'wave'; by: string; x: number; y: number; z: number; dx: number; dy: number; dz: number; roll: number };

export interface HeartbeatPayload {
  acq_connected: boolean;
  decode_rate_hz?: number;
}

/** 运维：PB 即将重启（自接管），客户端提示并等待重连 */
export interface AdminRestartingPayload {
  delay_ms: number;
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
export interface MpInputMsg extends BaseMessage { type: 'mp_input'; payload: MpInputPayload; }
export interface MpActionMsg extends BaseMessage { type: 'mp_action'; payload: MpActionPayload; }
export interface AdminRestartMsg extends BaseMessage { type: 'admin_restart'; payload: Record<string, never>; }

// ---- PB → SCB ----

export interface ConfigUpdateMsg extends BaseMessage { type: 'config_update'; payload: ConfigUpdatePayload; }

// ---- PB → PF（联机对战） ----

export interface WorldMsg extends BaseMessage { type: 'world'; payload: WorldPayload; }
export interface EventMsg extends BaseMessage { type: 'event'; payload: MpEventPayload; }
export interface AdminRestartingMsg extends BaseMessage { type: 'admin_restarting'; payload: AdminRestartingPayload; }

// ---------- 5. 通道消息集合 ----------

/** PB 视角：从 SCB 接收 */
export type FromScb = HelloMsg | HeartbeatMsg | DeviceCommandMsg | DecodeStatusMsg;
/** PB 视角：发送给 SCB */
export type ToScb = WelcomeMsg | CommandAckMsg | DeviceStateUpdateMsg | StateSnapshotMsg | ConfigUpdateMsg | ErrorMsg;
/** PB 视角：从 PF 接收 */
export type FromPf = HelloMsg | StateRequestMsg | UiCommandMsg | MpInputMsg | MpActionMsg | AdminRestartMsg;
/** PB 视角：发送给 PF */
export type ToPf = WelcomeMsg | StateSnapshotMsg | DeviceStateUpdateMsg | CommandAckMsg | ErrorMsg | WorldMsg | EventMsg | AdminRestartingMsg;

/** 按类型收窄消息（PF 侧常用） */
export function isType<T extends ToPf['type']>(msg: ToPf, type: T): msg is Extract<ToPf, { type: T }> {
  return msg.type === type;
}
