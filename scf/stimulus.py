"""
SCF SSVEP 刺激呈现主程序（PsychoPy 全屏，借鉴 NDDrone-SDK SimulationWindow）。

运行步骤：
  1) pip install -r scf/requirements.txt（psychopy / pillow / numpy）
  2) python scf/gen_frames.py --count 60        # 先生成预渲染帧图
  3) python scf/stimulus.py                     # 运行刺激呈现
     （亦可 `python -m scf.stimulus`；`--config` 可指定配置文件）

呈现方式：
  · 全屏黑底 Window：waitBlanking=True 垂直同步锁定刷新率、units='pix'
  · 加载 scf/frames 下全部预渲染帧为 ImageStim，按 2×4 网格排布
    （块尺寸与位置按实际窗口分辨率自适应缩放）
  · 先显示提示帧 prompt.png，按 空格 开始刺激；运行中按 ESC 退出
  · 逐帧播放：每帧 draw 全部 8 个块对应帧图 + flip；播满一个周期
    （frames_per_cycle 帧）后循环；帧计时由帧计数驱动，依赖垂直同步
    保证刺激频率准确

与 SCB 同步：
  按 空格 开始时记录毫秒时间戳写入 scf/stimulus_sync.json：
      {"started_at_ms": ..., "refresh_rate": ..., "frequencies": [...],
       "frame_count": ..., ...}
  按 ESC 退出后追加 "ended_at_ms"，供 SCB 采集/解码做同步标记与离线分析。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

try:
    from .common import (
        DEFAULT_CONFIG_PATH,
        FRAMES_DIR,
        SYNC_PATH,
        compute_layout,
        load_config,
    )
except ImportError:  # 兼容 `python scf/stimulus.py` 直接运行
    from common import (
        DEFAULT_CONFIG_PATH,
        FRAMES_DIR,
        SYNC_PATH,
        compute_layout,
        load_config,
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="SCF SSVEP 刺激呈现（PsychoPy）")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="配置文件路径")
    parser.add_argument("--frames-dir", default=FRAMES_DIR,
                        help="预渲染帧目录，默认 scf/frames")
    return parser.parse_args(argv)


def write_sync(path: str, config: dict, started_at_ms: int | None,
               actual_fps: float | None, window_size, ended_at_ms: int | None = None) -> None:
    """写入 / 更新刺激同步文件 stimulus_sync.json（SCB 读取）。"""
    data = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            data = {}
    if started_at_ms is not None:
        data.update({
            "started_at_ms": started_at_ms,                       # 刺激开始时刻（UTC epoch ms）
            "refresh_rate": float(config["refresh_rate"]),        # 标称刷新率
            "frequencies": [float(c["freq_hz"]) for c in config["commands"]],
            "frame_count": int(config["frames_per_cycle"]),       # 一个周期的帧数
            "window_size": list(window_size),
            "actual_frame_rate": round(actual_fps, 4) if actual_fps else None,
        })
    if ended_at_ms is not None:
        data["ended_at_ms"] = ended_at_ms                         # 刺激结束时刻（UTC epoch ms）
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[SCF] 同步文件已更新 -> {path}")


def load_block_stims(win, config: dict, layout: dict, frames_dir: str):
    """
    加载全部预渲染帧为 ImageStim。

    返回 frame_stims：frame_stims[n] 为第 n 帧的 8 个块 ImageStim 列表
    （顺序与 config["commands"] 一致），运行时逐帧 draw 全部块后 flip。
    """
    from psychopy import visual

    frame_count = int(config["frames_per_cycle"])
    block_w, block_h = layout["block_w"], layout["block_h"]
    win_w, win_h = layout["window_size"]

    frame_stims = []
    for n in range(frame_count):
        row = []
        for i, _cmd in enumerate(config["commands"], start=1):
            path = os.path.join(frames_dir, f"{i:02d}", f"{n}.png")
            if not os.path.exists(path):
                raise FileNotFoundError(
                    f"缺少帧图 {path}，请先运行 python scf/gen_frames.py --count {frame_count}")
            # PsychoPy 中心坐标系：x 向右、y 向上、原点在屏幕中心
            x0, y0 = layout["positions"][i - 1]
            pos = (x0 + block_w / 2 - win_w / 2, win_h / 2 - (y0 + block_h / 2))
            stim = visual.ImageStim(win, image=path, pos=pos,
                                    size=(block_w, block_h), units="pix",
                                    flipVert=False)
            row.append(stim)
        frame_stims.append(row)
    return frame_stims


def run(config: dict, frames_dir: str) -> None:
    # psychopy 延迟导入：未安装时仅影响本函数，preview/gen_frames 不受影响
    from psychopy import event, visual

    # 全屏黑底窗口，waitBlanking 垂直同步锁定刷新率（与 NDDrone-SDK 一致）
    win = visual.Window(
        size=tuple(config["window_size"]),
        fullscr=True,
        monitor="testMonitor",
        units="pix",
        color=(0, 0, 0),
        colorSpace="rgb255",
        waitBlanking=True,
        screen=0,
        allowGUI=False,
        useFBO=False,
    )
    try:
        actual_fps = win.getActualFrameRate() or 0.0
        print(f"[SCF] 实际刷新率 getActualFrameRate = {actual_fps:.3f} Hz"
              f"（标称 {float(config['refresh_rate']):.0f} Hz）")

        # 布局按实际窗口分辨率自适应（全屏可能返回不同于配置的分辨率）
        layout = compute_layout(config, win.size)
        print(f"[SCF] 布局：{config['layout']['rows']}x{config['layout']['cols']} 网格，"
              f"块尺寸 {layout['block_w']}x{layout['block_h']}，窗口 {layout['window_size']}")

        frame_stims = load_block_stims(win, config, layout, frames_dir)

        # 提示帧：等待空格开始（ESC 直接退出）
        prompt_path = os.path.join(frames_dir, "prompt.png")
        if not os.path.exists(prompt_path):
            raise FileNotFoundError(
                f"缺少提示帧 {prompt_path}，请先运行 python scf/gen_frames.py")
        prompt_stim = visual.ImageStim(win, image=prompt_path, pos=(0, 0),
                                       size=layout["window_size"], units="pix",
                                       flipVert=False)
        prompt_stim.draw()
        win.flip()
        keys = event.waitKeys(keyList=["space", "escape"])
        if "escape" in keys:
            print("[SCF] 在提示帧阶段退出")
            return

        # 记录刺激开始时间戳（毫秒），写入同步文件供 SCB 读取
        started_at_ms = int(time.time() * 1000)
        write_sync(SYNC_PATH, config, started_at_ms, actual_fps, layout["window_size"])
        print("[SCF] 刺激开始（空格已按下），按 ESC 退出")

        # 主循环：帧计数驱动逐帧播放，一个周期 frames_per_cycle 帧后循环
        frame_count = int(config["frames_per_cycle"])
        running = True
        n_frames_played = 0
        while running:
            for n in range(frame_count):
                for key in event.getKeys(keyList=["escape"]):
                    running = False
                    break
                if not running:
                    break
                for stim in frame_stims[n]:
                    stim.draw()
                win.flip()  # waitBlanking 在此阻塞至垂直消隐，锁定刷新率
                n_frames_played += 1
        print(f"[SCF] 刺激结束，共播放 {n_frames_played} 帧")
    finally:
        # 更新同步文件：追加结束时间戳
        ended_at_ms = int(time.time() * 1000)
        write_sync(SYNC_PATH, config, None, None, None, ended_at_ms=ended_at_ms)
        win.close()


def main(argv=None) -> int:
    args = parse_args(argv)
    config = load_config(args.config)
    try:
        run(config, args.frames_dir)
    except ImportError:
        print("[错误] 未安装 psychopy，无法运行刺激呈现。请先："
              "pip install -r scf/requirements.txt"
              "（无 PsychoPy 时可用 python scf/preview.py 核对布局）")
        return 1
    except FileNotFoundError as exc:
        print(f"[错误] {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
