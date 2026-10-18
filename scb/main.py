"""SCB 异步入口：mock 模式循环运行解码管线（set_target 轮换 → 合成 epoch →
FBCCA → 决策 → 上报 PB）；--smoke 仅发出 3 条确认指令后退出（联调用）。

启动方式（在 scb 目录下）：python -m scb.main [--smoke]
也兼容直接运行：python scb/main.py [--smoke]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

# 允许在 scb 目录下直接 python main.py 运行（此时把项目根加入 sys.path）
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scb.acquisition import build_acquisition
from scb.client import SCBClient
from scb.config import SCBConfig, load_config, load_scf_sync
from scb.decision import CMD_ACTIONS, DecisionEngine, cmd_id_of, freq_of
from scb.decoder import SSVEPDecoder
from scb.protocol import ConfigUpdatePayload, DecodeStatusPayload, Evidence

# Windows 控制台统一 UTF-8，避免中文日志乱码
for _stream in (sys.stdout, sys.stderr):
    if _stream.encoding and _stream.encoding.lower() not in ("utf-8", "utf8"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

logger = logging.getLogger("scb.main")

# 管线常量
STEP_S = 0.25            # 滑动窗口步长
TARGET_HOLD_S = 5.0      # mock 模式每个目标频率保持时长（3s 窗 + 3 窗确认 + 余量）
SMOKE_COMMANDS = 3       # --smoke 需发出的确认指令数
SMOKE_TOTAL_TIMEOUT = 90  # smoke 总超时（秒）
PIPELINE_LOG_EVERY = 4   # 每 N 个窗口打印一次解码摘要


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s.%(msecs)03d %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


def log_scf_sync() -> None:
    """SCF 刺激同步（仅日志与离线分析标记，不影响主流程）"""
    sync = load_scf_sync()
    if sync is None:
        logger.info("SCF 同步文件不存在（../scf/stimulus_sync.json），跳过")
        return
    logger.info("SCF 刺激同步：freqs=%s start=%s end=%s",
                sync.get("frequencies"), sync.get("stimulus_start_ms"),
                sync.get("stimulus_end_ms"))


def make_status_provider(cfg: SCBConfig, acq):
    """decode_status / heartbeat 的采集状态来源"""
    def provider() -> DecodeStatusPayload:
        return DecodeStatusPayload(
            acq_connected=acq.connected,
            sample_rate=cfg.srate,
            channels=cfg.channels,
            decode_window_s=cfg.decode_window_s,
            threshold=cfg.threshold,
        )
    return provider


async def run_pipeline(cfg: SCBConfig, smoke: bool) -> int:
    """解码管线主循环；返回 smoke 退出码（非 smoke 恒 0，Ctrl+C 结束）"""
    acq = build_acquisition(cfg)
    decoder = SSVEPDecoder(cfg.frequencies, srate=cfg.srate,
                           window_s=cfg.decode_window_s)
    decision = DecisionEngine(threshold=cfg.threshold,
                              confirm_count=cfg.confirm_count,
                              cooldown_s=cfg.cooldown_s)

    async def on_config_update(payload: ConfigUpdatePayload) -> None:
        # PB 下发解码参数：更新本地 threshold / confirm_count / cooldown_s / decode_window_s
        cfg.apply_update(payload.threshold, payload.confirm_count,
                         payload.cooldown_s, payload.decode_window_s)
        decision.apply_update(payload.threshold, payload.confirm_count,
                              payload.cooldown_s)
        if payload.decode_window_s is not None:
            decoder.set_window_s(cfg.decode_window_s)  # 重建 FBCCA 参考信号
        logger.info("已应用 PB 下发参数：threshold=%.2f confirm=%d cooldown=%.1fs "
                    "window=%.1fs", cfg.threshold, cfg.confirm_count,
                    cfg.cooldown_s, cfg.decode_window_s)

    # smoke 模式：最多尝试 2 次连接（无 PB 时快速进入离线自检）
    client = SCBClient(cfg,
                       status_provider=make_status_provider(cfg, acq),
                       on_config_update=on_config_update,
                       max_connect_attempts=2 if smoke else None)
    client_task = asyncio.create_task(client.run())

    try:
        got_welcome = await client.wait_welcome(timeout=10.0)
        if not got_welcome:
            if smoke:
                logger.warning("未收到 PB welcome，进入离线管线自检（不发送指令）")
                return await _offline_check(cfg, acq, decoder, decision, client)
            logger.error("等待 PB welcome 超时，退出")
            return 1

        log_scf_sync()
        logger.info("解码参数：mode=%s freqs=%s threshold=%.2f confirm=%d "
                    "cooldown=%.1fs window=%.1fs",
                    cfg.mode, cfg.frequencies, cfg.threshold, cfg.confirm_count,
                    cfg.cooldown_s, cfg.decode_window_s)

        # mock 模式：注入初始目标频率并轮换
        if cfg.mode == "mock":
            acq.set_target(cfg.frequencies[0])
        target_idx = 0
        last_switch = time.monotonic()

        # 窗口起始时间戳（ms）：首窗覆盖「过去 epoch 长度」的数据，之后按步长前移
        start_ms = time.time_ns() // 1_000_000 - int(decoder.epoch_length_s * 1000)
        sent_via_pb = 0
        offline_confirms = 0
        window_count = 0
        decode_times: list[float] = []
        deadline = time.monotonic() + SMOKE_TOTAL_TIMEOUT
        next_beat = time.monotonic()

        while True:
            # mock 目标频率轮换
            if cfg.mode == "mock" and time.monotonic() - last_switch >= TARGET_HOLD_S:
                target_idx = (target_idx + 1) % len(cfg.frequencies)
                acq.set_target(cfg.frequencies[target_idx])
                last_switch = time.monotonic()
                logger.info("── 轮换目标频率 → %.1fHz（%s）",
                            cfg.frequencies[target_idx],
                            cmd_id_of(target_idx).value)

            # 采集（SDK 同步接口放线程池，避免阻塞事件循环）
            epoch = await asyncio.to_thread(acq.read_epoch, start_ms,
                                            decoder.epoch_length_s)
            start_ms += int(STEP_S * 1000)

            # FBCCA 解码 → 决策
            t0 = time.perf_counter()
            class_idx, rho = decoder.predict(epoch)
            decode_times.append(time.perf_counter() - t0)
            window_count += 1
            confirmed = decision.update(class_idx, rho)

            if window_count % PIPELINE_LOG_EVERY == 0:
                rate = 1.0 / (sum(decode_times[-20:]) / len(decode_times[-20:]))
                client.decode_rate_hz = round(rate, 2)
                logger.info("win#%d 识别 %.1fHz (%s) ρ=%.3f 阈值=%.2f 解码速率≈%.1fHz",
                            window_count, freq_of(class_idx, cfg.frequencies),
                            cmd_id_of(class_idx).value, rho, cfg.threshold, rate)

            if confirmed is not None:
                device_id, action = CMD_ACTIONS[cmd_id_of(confirmed).value]
                evidence = Evidence(freq_hz=freq_of(confirmed, cfg.frequencies),
                                    window_ms=int(decoder.window_s * 1000),
                                    confirm_count=decision.confirm_count)
                seq = await client.publish_command(
                    cmd_id_of(confirmed), device_id, action, confidence=rho,
                    evidence=evidence)
                if seq is not None:
                    sent_via_pb += 1
                else:
                    offline_confirms += 1

            if smoke and (sent_via_pb >= SMOKE_COMMANDS):
                break
            if smoke and time.monotonic() > deadline:
                logger.error("smoke 总超时（%ds），已发 %d 条", SMOKE_TOTAL_TIMEOUT,
                             sent_via_pb)
                break

            # 固定节拍（0.25s 步长）
            next_beat += STEP_S
            await asyncio.sleep(max(0.0, next_beat - time.monotonic()))

        if not smoke:
            return 0

        # ---- smoke 收尾：等待最后一条指令的 ack ----
        await asyncio.sleep(2.0)
        device_count = len(client.snapshot.devices) if client.snapshot else -1
        ok = (got_welcome and device_count == 7
              and client.command_sent_count >= 1 and client.ack_ok_count >= 1)
        logger.info("======== SMOKE %s ========", "PASS" if ok else "FAIL")
        logger.info("welcome=%s 设备数=%d device_command=%d ack_ok=%d/%d",
                    got_welcome, device_count, client.command_sent_count,
                    client.ack_ok_count, len(client.ack_results))
        return 0 if ok else 1
    finally:
        client.stop()
        client_task.cancel()
        acq.close()


async def _offline_check(cfg: SCBConfig, acq, decoder, decision, client) -> int:
    """无 PB 时的离线管线自检：验证 mock 采集 → FBCCA → 决策闭环（仅日志）"""
    log_scf_sync()
    acq.set_target(cfg.frequencies[0])
    target_idx = 0
    last_switch = time.monotonic()
    start_ms = time.time_ns() // 1_000_000 - int(decoder.epoch_length_s * 1000)
    confirms = 0
    deadline = time.monotonic() + 20.0
    next_beat = time.monotonic()
    while time.monotonic() < deadline and confirms < 3:
        if time.monotonic() - last_switch >= TARGET_HOLD_S:
            target_idx = (target_idx + 1) % len(cfg.frequencies)
            acq.set_target(cfg.frequencies[target_idx])
            last_switch = time.monotonic()
            logger.info("── 轮换目标频率 → %.1fHz", cfg.frequencies[target_idx])
        epoch = await asyncio.to_thread(acq.read_epoch, start_ms,
                                        decoder.epoch_length_s)
        start_ms += int(STEP_S * 1000)
        class_idx, rho = decoder.predict(epoch)
        confirmed = decision.update(class_idx, rho)
        logger.info("win 识别 %.1fHz ρ=%.3f 阈值=%.2f → %s",
                    freq_of(class_idx, cfg.frequencies), rho, cfg.threshold,
                    f"确认 {cmd_id_of(confirmed).value}" if confirmed is not None
                    else "未确认")
        if confirmed is not None:
            confirms += 1
        next_beat += STEP_S
        await asyncio.sleep(max(0.0, next_beat - time.monotonic()))
    ok = confirms >= 1
    logger.info("======== 离线自检 %s（确认 %d 条指令，PB 未连接不发送）========",
                "PASS" if ok else "FAIL", confirms)
    return 0 if ok else 1


async def _amain(smoke: bool) -> int:
    cfg = load_config()
    logger.info("SCB 启动：mode=%s pb_url=%s", cfg.mode, cfg.pb_url)
    return await run_pipeline(cfg, smoke)


def main() -> None:
    setup_logging()
    parser = argparse.ArgumentParser(description="SSVEP SCB（意图抽象层）")
    parser.add_argument("--smoke", action="store_true",
                        help="联调模式：仅发出 3 条确认指令后退出")
    args = parser.parse_args()
    try:
        code = asyncio.run(_amain(args.smoke))
    except KeyboardInterrupt:
        logger.info("收到 Ctrl+C，退出")
        code = 0
    sys.exit(code)


if __name__ == "__main__":
    main()
