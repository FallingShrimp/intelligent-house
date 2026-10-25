"""SCB 采集层：复用 NDDrone-SDK 的 NDThread（ND8 TCP 采集）+ 共平均参考（CAR）。"""
from __future__ import annotations

import sys
import time

import numpy as np

from scb.config import SDK_SRC_PATH


def ensure_sdk_path() -> None:
    """将 ../NDDrone-SDK/src 插入 sys.path，以复用 engine.thread / analyzer 模块（不修改 SDK）"""
    sdk_src = str(SDK_SRC_PATH)
    if sdk_src not in sys.path:
        sys.path.insert(0, sdk_src)


class BaseAcquisition:
    """采集层统一接口：read_epoch(start_ms, length_s) → np.ndarray（通道 × 采样点）"""

    channels: list[str] = []
    srate: int = 250

    def read_epoch(self, start_ms: int, length_s: float) -> np.ndarray:
        raise NotImplementedError

    @property
    def connected(self) -> bool:
        return True

    def close(self) -> None:  # pragma: no cover - 接口默认空实现
        pass


class Nd8Acquisition(BaseAcquisition):
    """ND8 真实采集：复用 NDDrone-SDK 的 NDThread（TCP 取数 + 50Hz 陷波 + 重采样）。

    - device_address 默认 ("127.0.0.1", 8899)，srate=250，record_srate=1000
    - read_epoch 额外实现共平均参考 CAR（各通道减去全部通道的瞬时均值）
    """

    def __init__(self, device_address: tuple[str, int] = ("127.0.0.1", 8899),
                 srate: int = 250, record_srate: int = 1000,
                 channels: list[str] | None = None):
        ensure_sdk_path()
        from engine.thread.NDThread import NDThread  # noqa: 复用 SDK 采集，延迟导入

        self.channels = channels or []
        self.srate = srate
        self._nd = NDThread(deviceAddress=device_address, srate=srate,
                            record_srate=record_srate)
        self._nd.connect()   # 建立 TCP（失败时 SDK 返回空 socket，run 循环内自旋）
        self._nd.start()     # 后台线程轮询取数，维护滑动缓存

    def read_epoch(self, start_ms: int, length_s: float) -> np.ndarray:
        """按窗口起始时间戳（ms）读取 length_s 秒数据，返回 CAR 后的 (通道 × 采样点)。

        与 NDThread.readFixedData 等价，但在数据未就绪时 sleep 重试（避免 SDK 内
        while 死循环烧满 CPU）；preprocess 含 1000Hz→250Hz 重采样与 50Hz 陷波。
        """
        nd = self._nd
        # 与 readFixedData 一致：downRatio = 重采样后的目标点数
        nd.downRatio = int(nd.srate * length_s)
        need_ms = int(length_s * 1000)
        while True:
            data = nd.readEEGData(start_ms, need_ms)
            if data is not None:
                break
            time.sleep(0.05)  # 缓存不足，等待采集线程入库
        data = nd.preprocess(data)
        # 共平均参考 CAR：各通道减去所有通道的瞬时均值
        return data - data.mean(axis=0, keepdims=True)

    @property
    def connected(self) -> bool:
        """ND8 TCP 是否在线：采集线程存活且 socket 可 getpeername"""
        sock = getattr(self._nd, "sock", None)
        if sock is None or not self._nd.is_alive():
            return False
        try:
            sock.getpeername()
            return True
        except OSError:
            return False

    def close(self) -> None:
        self._nd.disconnect()


def build_acquisition(cfg) -> BaseAcquisition:
    """按配置构建采集实例（mode: nd8）"""
    if cfg.mode == "nd8":
        return Nd8Acquisition(device_address=(cfg.nd8_host, cfg.nd8_port),
                              srate=cfg.srate, record_srate=cfg.record_srate,
                              channels=cfg.channels)
    raise ValueError(f"未知采集模式：{cfg.mode}（应为 nd8）")
