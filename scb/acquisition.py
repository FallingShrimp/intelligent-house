"""SCB 采集层：复用 NDDrone-SDK 的 NDThread（ND8 TCP 采集）+ 共平均参考（CAR），
并提供无硬件联调用的 MockAcquisition（按目标刺激频率合成 SSVEP 信号）。"""
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


class MockAcquisition(BaseAcquisition):
    """模拟采集：按目标刺激频率合成 8 通道 SSVEP EEG，供无硬件联调。

    信号模型：amp·sin(2πft) + amp/2·sin(4πft) + 高斯噪声 σ=5μV，采样率 250Hz；
    幅度取 SSVEP 典型诱发幅值（μV 量级）。各通道施加随机幅度增益与微小相位差，
    使共平均参考（CAR）后 SSVEP 成分仍保留。set_target(freq_hz) 由外部注入目标。
    """

    def __init__(self, srate: int = 250, n_channels: int = 8,
                 noise_uv: float = 5.0, signal_amp_uv: float = 10.0,
                 channels: list[str] | None = None, seed: int = 42):
        self.srate = srate
        self.channels = channels or []
        self._n = n_channels
        self._noise = noise_uv
        self._amp = signal_amp_uv
        self._target_hz = 10.0
        self._rng = np.random.default_rng(seed)
        # 通道间差异：增益 0.7~1.3、相位 ±0.3 rad（保证 CAR 不完全抵消信号）
        self._gain = self._rng.uniform(0.7, 1.3, n_channels)
        self._phase = self._rng.uniform(-0.3, 0.3, n_channels)
        self._t0_s = time.time()  # 相位基准：以启动时刻为 0，避免绝对大数精度损失

    def set_target(self, freq_hz: float) -> None:
        """外部注入当前目标刺激频率（main 管线轮换调用）"""
        self._target_hz = float(freq_hz)

    def read_epoch(self, start_ms: int, length_s: float) -> np.ndarray:
        n = int(self.srate * length_s)
        # 相对时间（秒），保证相位连续
        t = start_ms / 1000.0 - self._t0_s + np.arange(n) / self.srate
        f = self._target_hz
        # 基频 + 1/2 二次谐波；通道间增益/相位差异
        x = (self._gain[:, None] * np.sin(2 * np.pi * f * t + self._phase[:, None])
             + 0.5 * self._gain[:, None] * np.sin(4 * np.pi * f * t + 2 * self._phase[:, None]))
        x = self._amp * x + self._rng.normal(0.0, self._noise, x.shape)
        # 与 Nd8Acquisition 一致，输出前做 CAR
        return x - x.mean(axis=0, keepdims=True)


def build_acquisition(cfg) -> BaseAcquisition:
    """按配置构建采集实例（mode: mock | nd8）"""
    if cfg.mode == "nd8":
        return Nd8Acquisition(device_address=(cfg.nd8_host, cfg.nd8_port),
                              srate=cfg.srate, record_srate=cfg.record_srate,
                              channels=cfg.channels)
    if cfg.mode == "mock":
        return MockAcquisition(srate=cfg.srate, n_channels=len(cfg.channels),
                               channels=cfg.channels)
    raise ValueError(f"未知采集模式：{cfg.mode}（应为 mock | nd8）")
