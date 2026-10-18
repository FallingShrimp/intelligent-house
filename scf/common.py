"""
SCF 公共工具模块：配置加载、2×4 网格布局计算、正弦亮度包络与中文字体加载。

被 gen_frames.py / stimulus.py / preview.py 三个入口共用。
路径约定：所有默认路径均以 scf/ 包目录为基准解析（不依赖当前工作目录），
因此 `python scf/xxx.py` 与 `python -m scf.xxx` 两种运行方式行为一致。

亮度包络设计（借鉴 NDDrone-SDK 预渲染帧思想）：
  每个刺激块按其 freq_hz 与 refresh_rate 逐帧计算正弦亮度系数
      env(n) = 0.65 + 0.35 * sin(2π · f · n / refresh_rate)
  即亮度在 30%～100% 之间正弦调制；块基色与 env 相乘得到当帧像素色，
  大面积亮度闪烁即为 SSVEP 刺激源，块底色（色相）用于视觉区分指令。
"""
from __future__ import annotations

import json
import math
import os

# 亮度包络上下限（相对满量程灰度的比例）
ENV_MIN = 0.30
ENV_MAX = 1.00

# scf 包所在目录（所有相对路径的基准）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
FRAMES_DIR = os.path.join(BASE_DIR, "frames")
SYNC_PATH = os.path.join(BASE_DIR, "stimulus_sync.json")

# 中文字体候选（按优先级）：黑体 → 微软雅黑 → 等线；全部缺失时退化为英文 label
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\Deng.ttf",
]

_font_cache: dict = {}


def load_config(path: str | None = None) -> dict:
    """加载刺激配置 JSON；path 为空时读取 scf/config.json。"""
    with open(path or DEFAULT_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def compute_layout(config: dict, window_size: tuple[int, int] | None = None) -> dict:
    """
    按 2×4 网格计算 8 个刺激块在整屏中的像素布局（块尺寸自适应窗口）。

    返回 dict：
      block_w / block_h : 单个块图像像素尺寸（含底部标签带）
      label_h           : 底部标签带高度（label_ratio × block_h）
      positions         : 8 个块的左上角像素坐标 [(x, y), ...]，行优先，
                          顺序与 config["commands"] 一一对应
    """
    win_w, win_h = window_size or tuple(config["window_size"])
    lay = config["layout"]
    rows, cols = int(lay["rows"]), int(lay["cols"])
    margin, gap = float(lay["margin_ratio"]), float(lay["gap_ratio"])

    mx, my = win_w * margin, win_h * margin          # 整屏四周留白
    gx, gy = win_w * gap, win_h * gap                # 块间距
    block_w = int((win_w - 2 * mx - (cols - 1) * gx) / cols)
    block_h = int((win_h - 2 * my - (rows - 1) * gy) / rows)
    label_h = int(block_h * float(lay["label_ratio"]))

    positions = []
    for row in range(rows):
        for col in range(cols):
            x = int(mx + col * (block_w + gx))
            y = int(my + row * (block_h + gy))
            positions.append((x, y))
    return {
        "block_w": block_w,
        "block_h": block_h,
        "label_h": label_h,
        "positions": positions,
        "window_size": (win_w, win_h),
    }


def brightness_env(frame_no: int, freq_hz: float, refresh_rate: float) -> float:
    """
    计算第 frame_no 帧（帧计数从 0 起）的亮度系数，范围 [ENV_MIN, ENV_MAX]。

    帧计数驱动相位：t = frame_no / refresh_rate，依赖 waitBlanking 垂直同步
    将实际刷新率锁定在 refresh_rate，从而保证刺激频率准确。
    """
    phase = 2.0 * math.pi * freq_hz * frame_no / float(refresh_rate)
    mid = (ENV_MIN + ENV_MAX) / 2.0
    amp = (ENV_MAX - ENV_MIN) / 2.0
    return mid + amp * math.sin(phase)


def cycle_is_consistent(config: dict, frames_per_cycle: int) -> bool:
    """
    校验周期帧数是否能让每个刺激频率恰好完成整数个闪烁周期
    （f · frames_per_cycle / refresh_rate ∈ ℤ），保证帧序循环无相位跳变。
    """
    rr = float(config["refresh_rate"])
    for cmd in config["commands"]:
        cycles = float(cmd["freq_hz"]) * frames_per_cycle / rr
        if abs(cycles - round(cycles)) > 1e-6:
            return False
    return True


def has_cjk_font() -> bool:
    """检测系统中是否存在可用的中文字体文件（否则绘制时退化英文 label）。"""
    return any(os.path.exists(p) for p in FONT_CANDIDATES)


def load_font(size: int):
    """
    加载指定像素大小的中文字体（simhei → msyh → Deng）。
    全部缺失时返回 None，调用方应以默认位图字体退化绘制英文。
    """
    from PIL import ImageFont

    size = max(1, int(size))
    if size in _font_cache:
        return _font_cache[size]
    font = None
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size)
                break
            except OSError:
                continue
    if font is None:
        try:
            font = ImageFont.load_default()
        except Exception:
            font = None
    _font_cache[size] = font
    return font


def modulate(color, env: float) -> tuple[int, int, int]:
    """按亮度系数 env 缩放基色，返回 RGB 元组（用于块背景 / 图标着色）。"""
    return tuple(max(0, min(255, int(round(c * env)))) for c in color)


def draw_center_text(draw, cx: float, cy: float, text: str, font, fill) -> None:
    """在 (cx, cy) 中心点绘制文本；兼容 FreeType 与默认位图字体（手动居中）。"""
    if font is None:
        from PIL import ImageFont

        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text, font=font, fill=fill)


def draw_block_image(cmd: dict, config: dict, frame_no: int,
                     block_w: int, block_h: int, label_h: int,
                     env: float | None = None):
    """
    绘制单个刺激块的第 frame_no 帧图像（PIL Image，RGB）。

    结构：
      · 上部闪烁区：块基色 × 亮度包络 env；中央绘制 icon 汉字
        （icon 颜色 = 基色 × env × 0.5，随背景同步调制、始终可辨）
      · 下部标签带：固定深灰底，两行文字——指令 label（中文优先，
        字体缺失时退化为 label_en）+ 「频率 · 指令编号」小字

    env 为 None 时按 frame_no / freq_hz / refresh_rate 实时计算；
    预览图可显式传入固定 env（如 0.65）绘制静态帧。
    """
    from PIL import Image, ImageDraw

    if env is None:
        env = brightness_env(frame_no, float(cmd["freq_hz"]),
                             float(config["refresh_rate"]))
    base = cmd["color"]
    flick_h = block_h - label_h

    img = Image.new("RGB", (block_w, block_h), (0, 0, 0))
    flick = Image.new("RGB", (block_w, flick_h), modulate(base, env))
    d = ImageDraw.Draw(flick)
    # 中央 icon 汉字（面积小，主要 SSVEP 能量来自整块背景亮度调制）
    icon_font = load_font(int(flick_h * 0.42))
    draw_center_text(d, block_w / 2, flick_h * 0.46, cmd["icon"], icon_font,
                     modulate(base, env * 0.5))
    img.paste(flick, (0, 0))

    # 底部标签带（不参与闪烁，保证文字全程可读）
    band = Image.new("RGB", (block_w, label_h), (18, 18, 18))
    bd = ImageDraw.Draw(band)
    # 中文优先，中文字体缺失时退化英文 label
    label_text = cmd["label"] if has_cjk_font() else cmd.get("label_en", cmd["id"])
    label_font = load_font(int(label_h * 0.40))
    draw_center_text(bd, block_w / 2, label_h * 0.38, label_text, label_font, (235, 235, 235))
    sub_font = load_font(int(label_h * 0.28))
    draw_center_text(bd, block_w / 2, label_h * 0.78,
                     f"{float(cmd['freq_hz']):.1f} Hz · {cmd['id']}", sub_font, (150, 150, 150))
    img.paste(band, (0, flick_h))
    return img
