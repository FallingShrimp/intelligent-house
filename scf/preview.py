"""
SCF 静态布局预览（无需 PsychoPy，纯 PIL 降级方案）。

用途：在未安装 PsychoPy 的环境中核对刺激面板布局——8 块 2×4 网格、
块位置坐标、各块频率与指令文字是否正确、有无遮挡重叠。

运行步骤：
  python scf/preview.py            # 读取 scf/config.json
  python scf/preview.py --config 自定义路径.json

输出：scf/preview.png（整屏单帧静态布局图，可直接用图片查看器打开）

说明：预览中各块以固定中等亮度（env=0.65，正弦相位 0 的均值）呈现；
实际刺激运行时各块按 freq_hz / refresh_rate 逐帧正弦调制（30%～100%）。
"""
from __future__ import annotations

import argparse
import os
import sys

try:
    from .common import (
        BASE_DIR,
        DEFAULT_CONFIG_PATH,
        compute_layout,
        draw_block_image,
        draw_center_text,
        load_config,
        load_font,
    )
except ImportError:  # 兼容 `python scf/preview.py` 直接运行
    from common import (
        BASE_DIR,
        DEFAULT_CONFIG_PATH,
        compute_layout,
        draw_block_image,
        draw_center_text,
        load_config,
        load_font,
    )

# 预览时使用的静态亮度系数（正弦包络均值 0.65）
PREVIEW_ENV = 0.65


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="SCF 静态布局预览（无 PsychoPy）")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--out", default=os.path.join(BASE_DIR, "preview.png"),
                        help="预览图输出路径，默认 scf/preview.png")
    return parser.parse_args(argv)


def render_preview(config: dict):
    """拼接整屏静态布局图：黑底 + 8 块静态帧 + 位置/频率/指令标注。"""
    from PIL import Image, ImageDraw

    layout = compute_layout(config)
    win_w, win_h = layout["window_size"]
    img = Image.new("RGB", (win_w, win_h), (10, 10, 10))
    draw = ImageDraw.Draw(img)
    pos_font = load_font(max(14, int(win_h * 0.022)))
    foot_font = load_font(max(14, int(win_h * 0.028)))

    rr = float(config["refresh_rate"])
    fpc = int(config["frames_per_cycle"])

    for i, cmd in enumerate(config["commands"]):
        x, y = layout["positions"][i]
        block = draw_block_image(cmd, config, frame_no=0,
                                 block_w=layout["block_w"],
                                 block_h=layout["block_h"],
                                 label_h=layout["label_h"],
                                 env=PREVIEW_ENV)
        img.paste(block, (x, y))
        # 块左上角外沿标注块位置（像素坐标）与网格序号
        draw.text((x + 6, y + 6), f"#{i + 1} pos=({x},{y})",
                  font=pos_font, fill=(255, 230, 80))

    # 底部整屏参数说明
    note = (f"静态预览（env={PREVIEW_ENV}）："
            f"{config['layout']['rows']}x{config['layout']['cols']} 网格 · 刷新率 {rr:.0f} Hz · "
            f"周期 {fpc} 帧 · 亮度 30%–100% 正弦调制 · 实际运行 stimulus.py")
    draw_center_text(draw, win_w / 2, win_h - win_h * 0.022, note, foot_font, (140, 140, 140))
    return img


def main(argv=None) -> int:
    args = parse_args(argv)
    config = load_config(args.config)
    img = render_preview(config)
    img.save(args.out)
    print(f"[SCF] 布局预览已生成 -> {args.out}（尺寸 {img.width}x{img.height}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
