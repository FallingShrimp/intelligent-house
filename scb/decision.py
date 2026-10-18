"""SCB 决策与防误触引擎（docs 6.2）：

- 置信度阈值：ρ ≥ 0.45（可调）
- 连续确认：连续 N（默认 3）个窗口识别结果一致
- 时间约束：N 次确认须在 5 秒内完成，超时重置
- 指令冷却：同一指令触发后 3 秒内不再重复触发
输出确认的类别索引（由上层映射为 cmd_id）。
"""
from __future__ import annotations

import time
from typing import Optional

from scb.protocol import Action, CommandId, DeviceId

# 指令 → 设备/动作映射（docs 7.2 / 7.4，PB 状态机执行对应迁移）
CMD_ACTIONS: dict[str, tuple[DeviceId, Action]] = {
    "CMD_01": (DeviceId.LIVING_ROOM_LIGHT, Action.TOGGLE),
    "CMD_02": (DeviceId.LIVING_ROOM_CURTAIN, Action.TOGGLE),
    "CMD_03": (DeviceId.AIR_CONDITIONER, Action.TEMP_UP),
    "CMD_04": (DeviceId.AIR_CONDITIONER, Action.TEMP_DOWN),
    "CMD_05": (DeviceId.TV, Action.TOGGLE),
    "CMD_06": (DeviceId.EMERGENCY, Action.EMERGENCY),
    "CMD_07": (DeviceId.BEDROOM_LIGHT, Action.BRIGHTNESS_CYCLE),
    "CMD_08": (DeviceId.DOOR_LOCK, Action.TOGGLE),
}


def cmd_id_of(class_idx: int) -> CommandId:
    """FBCCA 类别索引 → 指令编码（0 → CMD_01 … 7 → CMD_08）"""
    return CommandId[f"CMD_{class_idx + 1:02d}"]


def freq_of(class_idx: int, frequencies: list[float]) -> float:
    """类别索引 → 刺激频率（Hz）"""
    return float(frequencies[class_idx])


class DecisionEngine:
    """滑动窗口连续解码决策：一致窗口计数 + 时间约束 + 冷却"""

    def __init__(self, threshold: float = 0.45, confirm_count: int = 3,
                 cooldown_s: float = 3.0, window_time_limit_s: float = 5.0):
        self.threshold = threshold
        self.confirm_count = confirm_count
        self.cooldown_s = cooldown_s
        self.window_time_limit_s = window_time_limit_s
        self._streak_class: Optional[int] = None   # 当前连续一致的类别
        self._streak_count = 0                      # 已连续一致的窗口数
        self._streak_start = 0.0                    # 本次连续序列起点（monotonic）
        self._last_fired: dict[int, float] = {}     # 类别 → 上次触发时刻（monotonic）

    def update(self, class_idx: int, rho: float) -> Optional[int]:
        """输入单个窗口的解码结果；若形成一次有效确认则返回类别索引，否则 None"""
        now = time.monotonic()
        # 1) 置信度不足 → 重置连续确认
        if rho < self.threshold:
            self._reset()
            return None
        # 2) 与当前连续序列不一致 → 重新计数
        if class_idx != self._streak_class:
            self._streak_class = class_idx
            self._streak_count = 1
            self._streak_start = now
            return None
        self._streak_count += 1
        # 3) 时间约束：confirm_count 次确认须在 window_time_limit_s 内完成
        if now - self._streak_start > self.window_time_limit_s:
            self._streak_class = class_idx
            self._streak_count = 1
            self._streak_start = now
            return None
        # 4) 达到连续确认次数
        if self._streak_count >= self.confirm_count:
            last = self._last_fired.get(class_idx)
            self._reset()
            if last is not None and now - last < self.cooldown_s:
                return None  # 命中冷却：丢弃本次确认
            self._last_fired[class_idx] = now
            return class_idx
        return None

    def apply_update(self, threshold=None, confirm_count=None,
                     cooldown_s=None, decode_window_s=None) -> None:
        """应用 PB config_update 下发参数（decode_window_s 由解码器处理，此处仅存储）"""
        if threshold is not None:
            self.threshold = float(threshold)
        if confirm_count is not None:
            self.confirm_count = int(confirm_count)
        if cooldown_s is not None:
            self.cooldown_s = float(cooldown_s)

    def _reset(self) -> None:
        self._streak_class = None
        self._streak_count = 0
