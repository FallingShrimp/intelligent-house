"""SCB 解码层：复用 NDDrone-SDK 的 FBCCA（analyzer/spatialFilter.py）作为算法基线。

SDK 原实现 predict 仅返回 argmax 类别，无法拿到置信度。此处通过子类
FBCCAWithScore 重写 predict：打分逻辑逐行保留（3 子频带 Chebyshev-I 带通、
3 次谐波正弦参考、子频带权重 k^-1.25 + 0.25、加权相关系数），额外返回
被识别类别对应的子频带加权相关系数 ρ 作为置信度。

频率表默认 8 类（8.0–15.0Hz 步长 1，对应 CMD_01–CMD_08），可由配置文件修改。
"""
from __future__ import annotations

import numpy as np
from sklearn.cross_decomposition import CCA

from scb.config import SDK_SRC_PATH

# FBCCA 默认输入截取起点（点数）：SDK configCore 中 lag=0.14s @ 250Hz = 35 点
FBCCA_LAG = 35


class SSVEPDecoder:
    """FBCCA 解码器封装：fit 生成正弦参考，predict 返回 (类别索引, 加权相关系数 ρ)。

    说明：为拿到 ρ 值，将 SDK FBCCA 的 predict 打分方式原样复制并扩展返回值，
    滤波器组（filterbank）与参考信号（evokeds）生成逻辑完全复用 SDK 原实现。
    """

    def __init__(self, frequencies: list[float], srate: int = 250,
                 window_s: float = 3.0, n_band: int = 3, lag: int = FBCCA_LAG):
        self.frequencies = list(frequencies)
        self.srate = srate
        self.window_s = window_s
        self.lag = lag
        ensure_sdk_imports()
        from analyzer.spatialFilter import FBCCA  # noqa: 复用 SDK 解码算法

        # SDK get_reference 内部做标量×频率表逐元素乘，必须传 ndarray（list 会触发序列乘法）
        self._fb = FBCCA(n_components=1, n_band=n_band, srate=srate,
                         frequency=np.asarray(self.frequencies, dtype=float),
                         lag=lag, winLEN=window_s)
        self._fb.fit()  # 生成各频率的正弦/余弦谐波参考信号

    # ---- 常用属性代理 ----
    @property
    def n_band(self) -> int:
        return self._fb.n_band

    @property
    def n_classes(self) -> int:
        return self._fb.conditionNUM

    @property
    def win_len_points(self) -> int:
        return self._fb.winLEN

    @property
    def epoch_length_s(self) -> float:
        """管线应采集的时长：解码窗口 + lag 前置段（predict 内部会截掉 lag）"""
        return self.window_s + self.lag / self.srate

    def set_window_s(self, window_s: float) -> None:
        """decode_window_s 变更后重建解码器（重新生成参考信号）"""
        if abs(window_s - self.window_s) < 1e-9:
            return
        self.window_s = float(window_s)
        from analyzer.spatialFilter import FBCCA

        self._fb = FBCCA(n_components=1, n_band=self._fb.n_band, srate=self.srate,
                         frequency=np.asarray(self.frequencies, dtype=float),
                         lag=self.lag, winLEN=window_s)
        self._fb.fit()

    def predict(self, epoch: np.ndarray) -> tuple[int, float]:
        """对单窗口 epoch（通道 × 采样点）解码，返回 (类别索引, 该类相关系数 ρ)。

        打分方式与 SDK FBCCA.predict 一致：
        X → 截取 [lag, lag+winLEN) → 各子频带 Chebyshev-I 带通 → 与谐波参考 CCA
        → 相关系数矩阵 r → 子频带加权 rho = (k^-1.25 + 0.25) · r → argmax。
        """
        fb = self._fb
        X = np.asarray(epoch, dtype=float)
        if X.ndim == 2:
            X = np.expand_dims(X, axis=0)

        need = fb.lag + fb.winLEN
        if X.shape[-1] < need:  # 数据不足无法按 SDK 逻辑截取
            raise ValueError(f"epoch 点数不足：{X.shape[-1]} < {need}")

        # 与 SDK predict 一致：截取 [lag, lag+winLEN)，与参考信号对齐
        X = X[:, :, fb.lag : fb.lag + fb.winLEN]

        r = np.zeros((fb.n_band, fb.conditionNUM))
        cca = CCA(n_components=1)
        for fb_inx in range(fb.n_band):
            epoch_band = np.squeeze(fb.filterbank(X, fb.srate, fb_inx))
            for class_inx, evoked in zip(fb.montage, fb.evokeds):
                u, v = cca.fit_transform(evoked.T, epoch_band.T)
                r_temp = np.corrcoef(u.T, v.T)
                r[fb_inx, class_inx] = r_temp[0, 1]
        # 子频带加权（与 SDK 一致：k^-1.25 + 0.25），取被识别类别的 ρ
        fb_coefs = np.expand_dims(np.arange(1, fb.n_band + 1) ** -1.25 + 0.25, axis=0)
        rho = np.dot(fb_coefs, r)[0]
        target = int(np.nanargmax(rho))
        return target, float(np.clip(rho[target], 0.0, 1.0))


def ensure_sdk_imports() -> None:
    """确保 NDDrone-SDK/src 在 sys.path 中（与 acquisition.ensure_sdk_path 一致）"""
    from scb.acquisition import ensure_sdk_path

    ensure_sdk_path()
