"""
SCB ↔ PB WebSocket 协议 Schema（SCB 侧，Pydantic v2，Python >= 3.10）

- SCBOutbound：SCB → PB 上行消息集合
- SCBInbound ：PB → SCB 下行消息集合
序列化：msg.model_dump_json()
解析：TypeAdapter(SCBInbound).validate_json(raw)（按 type 自动分发到具体模型）
与 PB/PF 侧的 TypeScript 定义（见 7.7）字段一一对应，修改需双端同步。

来源：docs.md 7.6「SCB ↔ PB：Pydantic Schema」完整复制，不得改动字段。
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

PROTOCOL_VERSION = 1


class StrictModel(BaseModel):
    """所有模型禁止未知字段，尽早暴露双端协议不一致"""
    model_config = ConfigDict(extra="forbid")


# ---------------- 1. 枚举 ----------------

class Role(str, Enum):
    SCB = "scb"
    PF = "pf"


class DeviceType(str, Enum):
    LIGHT = "light"
    CURTAIN = "curtain"
    AC = "ac"
    TV = "tv"
    DOOR_LOCK = "door_lock"
    EMERGENCY = "emergency"


class DeviceId(str, Enum):
    LIVING_ROOM_LIGHT = "living_room_light"      # 客厅主灯
    BEDROOM_LIGHT = "bedroom_light"              # 卧室灯
    LIVING_ROOM_CURTAIN = "living_room_curtain"  # 客厅窗帘
    AIR_CONDITIONER = "air_conditioner"          # 空调
    TV = "tv"                                    # 电视
    DOOR_LOCK = "door_lock"                      # 门锁
    EMERGENCY = "emergency"                      # 全屋紧急呼叫


class CommandId(str, Enum):
    """SSVEP 解码输出的 8 个固定指令（对应 7.2 指令集）"""
    CMD_01 = "CMD_01"
    CMD_02 = "CMD_02"
    CMD_03 = "CMD_03"
    CMD_04 = "CMD_04"
    CMD_05 = "CMD_05"
    CMD_06 = "CMD_06"
    CMD_07 = "CMD_07"
    CMD_08 = "CMD_08"


class Action(str, Enum):
    TOGGLE = "toggle"                      # 开关 / 开合 / 锁舌切换
    TEMP_UP = "temp_up"                    # 空调温度 +step ℃
    TEMP_DOWN = "temp_down"                # 空调温度 -step ℃
    BRIGHTNESS_CYCLE = "brightness_cycle"  # 灯光亮度档位循环
    EMERGENCY = "emergency"                # 触发紧急呼叫
    EMERGENCY_RESET = "emergency_reset"    # 解除紧急呼叫（仅手动 / 调试）


class ErrorCode(str, Enum):
    OK = "OK"
    INVALID_FORMAT = "INVALID_FORMAT"          # JSON 非法 / 字段校验失败
    UNKNOWN_TYPE = "UNKNOWN_TYPE"              # 未知的 type
    UNKNOWN_DEVICE = "UNKNOWN_DEVICE"          # device_id 不在注册表
    OUT_OF_RANGE = "OUT_OF_RANGE"              # 参数越界（如温度超 16–30）
    INVALID_TRANSITION = "INVALID_TRANSITION"  # 非法状态迁移
    COOLDOWN = "COOLDOWN"                      # 指令冷却中被拒绝
    INTERNAL = "INTERNAL"                      # 服务端内部错误


# ---------------- 2. 设备状态（PB 为唯一事实源） ----------------

class LightState(StrictModel):
    device_type: Literal[DeviceType.LIGHT]
    device_id: DeviceId
    on: bool
    brightness: int = Field(ge=0, le=100)      # %
    color_temp: int = Field(ge=2700, le=6500)  # K


class CurtainState(StrictModel):
    device_type: Literal[DeviceType.CURTAIN]
    device_id: DeviceId
    position: int = Field(ge=0, le=100)  # % 0=全合 100=全开


class AcState(StrictModel):
    device_type: Literal[DeviceType.AC]
    device_id: DeviceId
    on: bool
    target_temp: int = Field(ge=16, le=30)  # ℃
    fan_swing: bool = False                 # 风口摆动


class TvState(StrictModel):
    device_type: Literal[DeviceType.TV]
    device_id: DeviceId
    on: bool
    volume: int = Field(ge=0, le=100)


class DoorLockState(StrictModel):
    device_type: Literal[DeviceType.DOOR_LOCK]
    device_id: DeviceId
    locked: bool


class EmergencyState(StrictModel):
    device_type: Literal[DeviceType.EMERGENCY]
    device_id: DeviceId
    active: bool
    triggered_at: Optional[int] = None  # 触发时刻 epoch ms


DeviceState = Annotated[
    Union[LightState, CurtainState, AcState, TvState, DoorLockState, EmergencyState],
    Field(discriminator="device_type"),
]


# ---------------- 3. Payload ----------------

class HelloPayload(StrictModel):
    role: Role
    client_name: str     # 如 "scb"
    client_version: str  # 如 "0.1.0"


class HeartbeatPayload(StrictModel):
    """SCB 周期心跳（建议 5s），兼报采集在线状态"""
    acq_connected: bool                     # ND8 TCP 是否在线
    decode_rate_hz: Optional[float] = None  # 实际解码频率


class DecodeStatusPayload(StrictModel):
    """解码运行参数上报（连接后及参数变更时发送）"""
    acq_connected: bool
    sample_rate: int = Field(ge=100)  # Hz
    channels: list[str]               # ["Oz", "O1", "O2", "POz"]
    decode_window_s: float = Field(gt=0)
    threshold: float = Field(ge=0, le=1)


class CommandParams(StrictModel):
    step: int = Field(default=1, ge=1, le=5)  # 空调温度步长 ℃


class Evidence(StrictModel):
    """解码证据（PB 仅记录日志，不参与路由）"""
    freq_hz: float      # FBCCA 识别出的刺激频率
    window_ms: int
    confirm_count: int  # 连续一致窗口数


class DeviceCommandPayload(StrictModel):
    """SSVEP 解码指令（SCB 核心上行消息）"""
    cmd_id: CommandId
    device_id: DeviceId
    action: Action
    params: CommandParams = Field(default_factory=CommandParams)
    confidence: float = Field(ge=0, le=1)  # 相关系数 ρ
    evidence: Optional[Evidence] = None


class StateRequestPayload(StrictModel):
    """请求全量快照（重连 / 手动刷新），payload 为空对象"""
    pass


class UiCommandPayload(StrictModel):
    """PF 手动控制（调试 / 无 BCI 演示降级），语义与 device_command 一致"""
    device_id: DeviceId
    action: Action
    params: CommandParams = Field(default_factory=CommandParams)


class TriggerInfo(StrictModel):
    cmd_id: CommandId  # 触发本次变更的指令
    cmd_seq: int       # 该指令在发送端连接内的 seq


class CommandAckPayload(StrictModel):
    """指令受理结果（仅回给指令发送方）"""
    ack_seq: int                         # 被确认消息的 seq
    ok: bool
    code: ErrorCode = ErrorCode.OK
    message: str = ""
    state: Optional[DeviceState] = None  # 受理成功时返回新状态


class DeviceStateUpdatePayload(StrictModel):
    """设备状态变更广播（PB → 全部 PF 与 SCB）"""
    update_id: int      # PB 全局单调递增，接收方用于乱序 / 丢包检测
    device_id: DeviceId
    state: DeviceState  # 变更后的完整状态
    source: Literal["scb", "manual"]
    trigger: Optional[TriggerInfo] = None


class StateSnapshotPayload(StrictModel):
    """全量状态快照（welcome 携带 / state_request 应答）"""
    update_id: int
    server_ts: int
    devices: list[DeviceState]


class ConfigUpdatePayload(StrictModel):
    """PB → SCB 下发解码参数（仅携带需修改的字段）"""
    threshold: Optional[float] = Field(default=None, ge=0, le=1)
    confirm_count: Optional[int] = Field(default=None, ge=1, le=10)
    cooldown_s: Optional[float] = Field(default=None, ge=0, le=30)
    decode_window_s: Optional[float] = Field(default=None, gt=0, le=8)


class WelcomePayload(StrictModel):
    """hello 应答，携带分配的 client_id 与全量快照"""
    client_id: str
    server_ts: int
    snapshot: StateSnapshotPayload


class ErrorPayload(StrictModel):
    """协议级错误（校验失败 / 无法路由时回给发送方）"""
    code: ErrorCode
    message: str
    ref_seq: Optional[int] = None  # 关联的出错消息 seq


# ---------------- 4. 消息信封 ----------------

class MessageBase(StrictModel):
    v: Literal[PROTOCOL_VERSION] = PROTOCOL_VERSION
    seq: int = Field(ge=0, description="发送端连接内单调递增")
    ts: int = Field(ge=0, description="发送时刻 epoch 毫秒")


# ---- SCB → PB ----

class HelloMsg(MessageBase):
    type: Literal["hello"]
    payload: HelloPayload


class HeartbeatMsg(MessageBase):
    type: Literal["heartbeat"]
    payload: HeartbeatPayload


class DeviceCommandMsg(MessageBase):
    type: Literal["device_command"]
    payload: DeviceCommandPayload


class DecodeStatusMsg(MessageBase):
    type: Literal["decode_status"]
    payload: DecodeStatusPayload


# ---- PB → SCB（welcome / state_update / snapshot / ack / error 与 PF 通道复用）----

class WelcomeMsg(MessageBase):
    type: Literal["welcome"]
    payload: WelcomePayload


class CommandAckMsg(MessageBase):
    type: Literal["command_ack"]
    payload: CommandAckPayload


class DeviceStateUpdateMsg(MessageBase):
    type: Literal["device_state_update"]
    payload: DeviceStateUpdatePayload


class StateSnapshotMsg(MessageBase):
    type: Literal["state_snapshot"]
    payload: StateSnapshotPayload


class ConfigUpdateMsg(MessageBase):
    type: Literal["config_update"]
    payload: ConfigUpdatePayload


class ErrorMsg(MessageBase):
    type: Literal["error"]
    payload: ErrorPayload


# ---------------- 5. 通道消息集合（判别联合） ----------------

SCBOutbound = Annotated[  # SCB → PB
    Union[HelloMsg, HeartbeatMsg, DeviceCommandMsg, DecodeStatusMsg],
    Field(discriminator="type"),
]

SCBInbound = Annotated[  # PB → SCB
    Union[WelcomeMsg, CommandAckMsg, DeviceStateUpdateMsg,
          StateSnapshotMsg, ConfigUpdateMsg, ErrorMsg],
    Field(discriminator="type"),
]
