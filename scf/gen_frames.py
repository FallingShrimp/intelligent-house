"""
SCF SSVEP 预渲染帧图生成器（PIL 实现，借鉴 NDDrone-SDK 预渲染帧方案）。

运行步骤：
  1) 确认 scf/config.json 中的 refresh_rate / window_size / frames_per_cycle
     与目标显示器一致（建议显示器刷新率 ≥ 120 Hz，最低 60 Hz）
  2) python scf/gen_frames.py              # 按配置的 frames_per_cycle 生成
     python scf/gen_frames.py --count 60   # 或用 --count 覆盖周期帧数
  3) 生成后运行 python scf/preview.py 核对布局，或直接 python scf/stimulus.py

参数说明（命令行）：
  --config   配置文件路径，默认 scf/config.json
  --count    覆盖一个刺激周期的帧数（frames_per_cycle），
             需满足 f × count / refresh_rate 为整数（否则打印警告）
  --outdir   帧图输出目录，默认 scf/frames

输出结构：
  scf/frames/{cmd_index:02d}/{frame_no}.png   各指令块的逐帧图（frame_no: 0..count-1，
                                              cmd_index: 1..8，对应 CMD_01..CMD_08）
  scf/frames/prompt.png                       整屏提示帧（开始前的操作说明画面）

帧序列设计：每个刺激块按其 freq_hz 与 refresh_rate 计算正弦亮度包络
（亮度在 30%～100% 灰度间变化），块背景色（色相）区分指令，
底部绘制中文指令文字标签（无中文字体时退化英文）。
"""
from __future__ import annotations

import argparse
import os
import sys

try:
    from .common import (
        BASE_DIR,
        DEFAULT_CONFIG_PATH,
        FRAMES_DIR,
        compute_layout,
        cycle_is_consistent,
        brightness_env,
        draw_block_image,
        draw_center_text,
        load_config,
        load_font,
        modulate,
    )
except ImportError:  # 兼容 `python scf/gen_frames.py` 直接运行
    from common import (
        BASE_DIR,
        DEFAULT_CONFIG_PATH,
        FRAMES_DIR,
        compute_layout,
        cycle_is_consistent,
        brightness_env,
        draw_block_image,
        draw_center_text,
        load_config,
        load_font,
        modulate,
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="SCF SSVEP 预渲染帧图生成器")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--count", type=int, default=None,
                        help="覆盖一个刺激周期的帧数（frames_per_cycle）")
    parser.add_argument("--outdir", default=FRAMES_DIR, help="帧图输出目录")
    return parser.parse_args(argv)


def draw_prompt_image(config: dict, layout: dict):
    """
    绘制整屏提示帧 prompt.png：黑底 + 标题 + 操作说明 + 8 块静态预览 + 参数提示。
    刺激尚未开始，各块以固定中等亮度（env=0.65）呈现，不闪烁。
    8 块先按真实布局合成整屏小图，再整体等比缩放放入标题与底部说明之间，
    避免遮挡与溢出。
    """
    from PIL import Image, ImageDraw

    win_w, win_h = layout["window_size"]
    img = Image.new("RGB", (win_w, win_h), (8, 8, 8))
    draw = ImageDraw.Draw(img)

    title_font = load_font(int(win_h * 0.075))
    tip_font = load_font(int(win_h * 0.038))
    foot_font = load_font(int(win_h * 0.030))

    # 顶部标题与操作说明
    draw_center_text(draw, win_w / 2, win_h * 0.075, "SSVEP 智能家居刺激面板",
                     title_font, (240, 240, 240))
    draw_center_text(draw, win_w / 2, win_h * 0.155,
                     "注视目标闪烁块以发出指令 · 按 空格 开始 · 按 ESC 退出",
                     tip_font, (170, 170, 170))

    # 中部：按真实布局合成 8 块静态帧（env=0.65 中等亮度），整体等比缩放后居中
    mini = Image.new("RGB", (win_w, win_h), (8, 8, 8))
    for i, cmd in enumerate(config["commands"]):
        x, y = layout["positions"][i]
        block = draw_block_image(cmd, config, frame_no=0,
                                 block_w=layout["block_w"],
                                 block_h=layout["block_h"],
                                 label_h=layout["label_h"],
                                 env=0.65)  # 静态中等亮度
        mini.paste(block, (x, y))
    avail_h = int(win_h * 0.68)   # 标题区与底部说明之间的高度
    avail_w = int(win_w * 0.92)
    scale = min(avail_h / win_h, avail_w / win_w)
    mini = mini.resize((int(win_w * scale), int(win_h * scale)), Image.LANCZOS)
    img.paste(mini, ((win_w - mini.width) // 2,
                     int(win_h * 0.21) + (avail_h - mini.height) // 2))

    # 底部参数提示
    rr = config["refresh_rate"]
    fpc = config["frames_per_cycle"]
    freqs = "/".join(f"{float(c['freq_hz']):.0f}" for c in config["commands"])
    draw_center_text(draw, win_w / 2, win_h - win_h * 0.035,
                     f"刷新率 {rr} Hz · 周期 {fpc} 帧 · 频率表 {freqs} Hz · "
                     f"亮度 30%–100% 正弦调制",
                     foot_font, (120, 120, 120))
    return img


def generate(config: dict, frames_per_cycle: int, outdir: str) -> None:
    """按配置逐块逐帧渲染 PNG 并输出 prompt.png。"""
    os.makedirs(outdir, exist_ok=True)

    # 周期一致性校验：不满足时仅警告（帧序循环会出现相位跳变）
    if not cycle_is_consistent(config, frames_per_cycle):
        rr = float(config["refresh_rate"])
        bad = [c["id"] for c in config["commands"]
               if abs(float(c["freq_hz"]) * frames_per_cycle / rr
                      - round(float(c["freq_hz"]) * frames_per_cycle / rr)) > 1e-6]
        print(f"[警告] frames_per_cycle={frames_per_cycle} 下以下频率无法整周期循环，"
              f"帧序回绕时会出现相位跳变：{', '.join(bad)}")

    layout = compute_layout(config)
    block_w, block_h, label_h = layout["block_w"], layout["block_h"], layout["label_h"]
    rr = float(config["refresh_rate"])
    total = len(config["commands"]) * frames_per_cycle
    done = 0

    for i, cmd in enumerate(config["commands"], start=1):
        cmd_dir = os.path.join(outdir, f"{i:02d}")
        os.makedirs(cmd_dir, exist_ok=True)
        freq = float(cmd["freq_hz"])
        for frame_no in range(frames_per_cycle):
            env = brightness_env(frame_no, freq, rr)
            img = draw_block_image(cmd, config, frame_no,
                                   block_w, block_h, label_h, env=env)
            img.save(os.path.join(cmd_dir, f"{frame_no}.png"))
            done += 1
        print(f"[SCF] {cmd['id']}（{cmd['label']}，{freq:.1f} Hz）"
              f"已生成 {frames_per_cycle} 帧 -> {cmd_dir}")

    prompt_path = os.path.join(outdir, "prompt.png")
    draw_prompt_image(config, layout).save(prompt_path)
    print(f"[SCF] 提示帧已生成 -> {prompt_path}")
    print(f"[SCF] 完成：{done} 帧块图 + 1 张提示帧（块尺寸 {block_w}x{block_h}，"
          f"标签带 {label_h}px）")


def main(argv=None) -> int:
    args = parse_args(argv)
    config = load_config(args.config)
    frames_per_cycle = args.count or int(config["frames_per_cycle"])
    if frames_per_cycle <= 0:
        print("[错误] --count / frames_per_cycle 必须为正整数")
        return 1
    generate(config, frames_per_cycle, args.outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
