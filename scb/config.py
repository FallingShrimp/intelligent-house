"""SCB 配置加载与 SCF 刺激同步文件读取（刺激同步仅用于日志与离线分析标记）。"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

# 包目录 / 项目根目录（config.json 与 SCF 同步文件均按此定位，与启动时 cwd 无关）
PKG_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PKG_DIR.parent
DEFAULT_CONFIG_PATH = PKG_DIR / "config.json"
SCF_SYNC_PATH = PROJECT_ROOT / "scf" / "stimulus_sync.json"

# NDDrone-SDK 源码目录（采集与解码复用）
SDK_SRC_PATH = PROJECT_ROOT / "NDDrone-SDK" / "src"


@dataclass
class SCBConfig:
    """SCB 运行配置（config.json 可覆盖默认值）"""
    pb_url: str = "ws://localhost:3000/ws/scb"  # PB WebSocket 端点（可配置）
    mode: str = "nd8"                           # 采集模式：nd8
    frequencies: list[float] = field(
        default_factory=lambda: [8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
    )                                           # 8 类刺激频率，对应 CMD_01–CMD_08
    threshold: float = 0.45                     # 置信度阈值 ρ
    confirm_count: int = 3                      # 连续确认窗口数
    cooldown_s: float = 3.0                     # 同一指令冷却时间
    decode_window_s: float = 3.0                # 解码窗口长度
    nd8_host: str = "127.0.0.1"                 # ND8 设备地址
    nd8_port: int = 8899
    srate: int = 250                            # 输出采样率（重采样后）
    record_srate: int = 1000                    # ND8 内部记录率
    heartbeat_interval_s: float = 5.0           # 心跳周期
    channels: list[str] = field(
        default_factory=lambda: ["Oz", "O1", "O2", "POz", "PO3", "PO4", "M1", "M2"]
    )                                           # 通道映射（6–8 通道，docs 6.1）
    client_name: str = "scb"
    client_version: str = "0.1.0"

    def apply_update(self, threshold=None, confirm_count=None,
                     cooldown_s=None, decode_window_s=None) -> None:
        """应用 PB config_update 下发的解码参数（仅携带需修改的字段）"""
        if threshold is not None:
            self.threshold = float(threshold)
        if confirm_count is not None:
            self.confirm_count = int(confirm_count)
        if cooldown_s is not None:
            self.cooldown_s = float(cooldown_s)
        if decode_window_s is not None:
            self.decode_window_s = float(decode_window_s)


def load_config(path: str | Path | None = None) -> SCBConfig:
    """加载配置：默认读 scb/config.json，可用环境变量 SCB_CONFIG 覆盖路径"""
    cfg_path = Path(path or os.environ.get("SCB_CONFIG", DEFAULT_CONFIG_PATH))
    cfg = SCBConfig()
    if cfg_path.is_file():
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        for key, value in data.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)
    return cfg


def load_scf_sync() -> dict | None:
    """读取 ../scf/stimulus_sync.json（若存在，SCF 写入刺激起止时间戳与频率表）。

    仅用于日志与离线分析标记，不影响主流程。
    """
    if not SCF_SYNC_PATH.is_file():
        return None
    try:
        return json.loads(SCF_SYNC_PATH.read_text(encoding="utf-8"))
    except Exception:  # 文件损坏时忽略，不影响主流程
        return None
