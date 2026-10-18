"""SCB → PB 的 aiohttp WebSocket 客户端：

- 连接 pb_url（默认 ws://localhost:3000/ws/scb，可配置），断线指数退避重连
- 连接内 seq 自增；hello(role=scb) → welcome(全量快照)
- 每 5s heartbeat（acq_connected 按采集模式上报）
- 连接后发送 decode_status；解码确认后封装 device_command 上报
- 下行处理：welcome / command_ack / device_state_update / state_snapshot /
  config_update（更新本地解码参数）/ error
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional

import aiohttp

from scb.config import SCBConfig
from scb.protocol import (
    CommandAckMsg,
    CommandAckPayload,
    CommandParams,
    ConfigUpdateMsg,
    ConfigUpdatePayload,
    DecodeStatusMsg,
    DecodeStatusPayload,
    DeviceCommandMsg,
    DeviceCommandPayload,
    DeviceId,
    DeviceStateUpdateMsg,
    ErrorMsg,
    Evidence,
    HelloMsg,
    HelloPayload,
    HeartbeatMsg,
    HeartbeatPayload,
    SCBInbound,
    StateSnapshotMsg,
    WelcomeMsg,
    Action,
    CommandId,
    TypeAdapter,
)

logger = logging.getLogger("scb.client")


def now_ms() -> int:
    """UTC epoch 毫秒"""
    return time.time_ns() // 1_000_000


class SCBClient:
    """PB WebSocket 客户端（收发 + 心跳 + 重连 + 参数下发回调）"""

    def __init__(self, cfg: SCBConfig,
                 status_provider: Optional[Callable[[], DecodeStatusPayload]] = None,
                 on_config_update: Optional[
                     Callable[[ConfigUpdatePayload], Awaitable[None]]] = None,
                 max_connect_attempts: Optional[int] = None):
        self.cfg = cfg
        self._status_provider = status_provider
        self._on_config_update = on_config_update
        self._max_attempts = max_connect_attempts

        self._seq = 0                       # 连接内单调递增序号
        self._send_queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._stop_event = asyncio.Event()
        self._inbound_adapter = TypeAdapter(SCBInbound)

        # 运行状态 / 统计（smoke 断言使用）
        self.client_id: Optional[str] = None
        self.snapshot = None                # StateSnapshotPayload
        self.welcome_event = asyncio.Event()
        self.command_sent_count = 0
        self.ack_results: list[CommandAckPayload] = []
        self.decode_rate_hz: Optional[float] = None  # 管线实测解码频率

    # ---------- 序号与信封 ----------

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    # ---------- 发送 ----------

    async def send(self, msg) -> int:
        """消息入队，由发送任务写出；返回其 seq"""
        await self._send_queue.put(msg)
        return msg.seq

    async def publish_command(self, cmd_id: CommandId, device_id: DeviceId,
                              action: Action, confidence: float,
                              evidence: Optional[Evidence] = None) -> Optional[int]:
        """封装并上报 device_command（解码确认后由管线调用）"""
        if self._ws is None:
            logger.warning("PB 未连接，丢弃指令 %s", cmd_id.value)
            return None
        payload = DeviceCommandPayload(
            cmd_id=cmd_id, device_id=device_id, action=action,
            params=CommandParams(), confidence=confidence, evidence=evidence,
        )
        msg = DeviceCommandMsg(type="device_command", seq=self._next_seq(),
                               ts=now_ms(), payload=payload)
        seq = await self.send(msg)
        self.command_sent_count += 1
        logger.info("↑ device_command %s → %s/%s conf=%.3f seq=%d",
                    cmd_id.value, device_id.value, action.value, confidence, seq)
        return seq

    async def _sender_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        while True:
            msg = await self._send_queue.get()
            await ws.send_str(msg.model_dump_json())

    async def _heartbeat_loop(self) -> None:
        """每 5s 心跳，兼报采集在线状态（按采集模式）"""
        try:
            while True:
                await asyncio.sleep(self.cfg.heartbeat_interval_s)
                if self._ws is None:
                    continue
                status = self._status_provider() if self._status_provider else None
                acq_connected = status.acq_connected if status else True
                msg = HeartbeatMsg(
                    type="heartbeat", seq=self._next_seq(), ts=now_ms(),
                    payload=HeartbeatPayload(acq_connected=acq_connected,
                                             decode_rate_hz=self.decode_rate_hz),
                )
                await self._ws.send_str(msg.model_dump_json())
                logger.debug("↑ heartbeat acq_connected=%s", acq_connected)
        except asyncio.CancelledError:
            pass

    async def _send_status(self) -> None:
        """发送 decode_status（连接后 / 参数变更时）"""
        if self._ws is None or self._status_provider is None:
            return
        msg = DecodeStatusMsg(type="decode_status", seq=self._next_seq(),
                              ts=now_ms(), payload=self._status_provider())
        await self._ws.send_str(msg.model_dump_json())
        logger.info("↑ decode_status threshold=%.2f window=%.1fs sr=%d ch=%d",
                    msg.payload.threshold, msg.payload.decode_window_s,
                    msg.payload.sample_rate, len(msg.payload.channels))

    # ---------- 连接生命周期 ----------

    async def run(self) -> None:
        """主循环：连接 → 握手 → 收发，断线指数退避重连"""
        backoff = 1.0
        attempts = 0
        while not self._stop_event.is_set():
            attempts += 1
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(self.cfg.pb_url) as ws:
                        self._ws = ws
                        self._seq = 0  # seq 为连接内序号，重连后重新自增
                        backoff = 1.0
                        sender = asyncio.create_task(self._sender_loop(ws))
                        heartbeat = asyncio.create_task(self._heartbeat_loop())
                        try:
                            await self._on_connected(ws)
                            async for raw in ws:
                                if raw.type == aiohttp.WSMsgType.TEXT:
                                    self._handle_inbound(raw.data)
                                elif raw.type in (aiohttp.WSMsgType.CLOSED,
                                                  aiohttp.WSMsgType.ERROR):
                                    break
                        finally:
                            heartbeat.cancel()
                            sender.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 连接失败 / 断线
                logger.warning("PB 连接异常：%s", exc)
            finally:
                self._ws = None
            if self._stop_event.is_set():
                break
            if self._max_attempts is not None and attempts >= self._max_attempts:
                logger.error("PB 连接尝试 %d 次失败，停止重连", attempts)
                break
            logger.info("%.1fs 后重连 PB（指数退避）...", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _on_connected(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        """握手：hello(role=scb, client_name, client_version) + decode_status"""
        hello = HelloMsg(
            type="hello", seq=self._next_seq(), ts=now_ms(),
            payload=HelloPayload(role="scb", client_name=self.cfg.client_name,
                                 client_version=self.cfg.client_version),
        )
        await ws.send_str(hello.model_dump_json())
        logger.info("↑ hello role=scb v=%s", self.cfg.client_version)
        await self._send_status()

    def stop(self) -> None:
        self._stop_event.set()

    # ---------- 下行处理 ----------

    def _handle_inbound(self, raw: str) -> None:
        try:
            event = self._inbound_adapter.validate_json(raw)
        except Exception as exc:
            logger.error("下行消息解析失败：%s | raw=%s", exc, raw[:200])
            return
        match event:
            case WelcomeMsg():
                self.client_id = event.payload.client_id
                self.snapshot = event.payload.snapshot
                logger.info("↓ welcome client_id=%s server_ts=%d 设备数=%d",
                            event.payload.client_id, event.payload.server_ts,
                            len(event.payload.snapshot.devices))
                self._print_snapshot(event.payload.snapshot)
                self.welcome_event.set()
            case CommandAckMsg():
                self.ack_results.append(event.payload)
                logger.info("↓ command_ack ack_seq=%d ok=%s code=%s message=%s",
                            event.payload.ack_seq, event.payload.ok,
                            event.payload.code.value, event.payload.message)
            case DeviceStateUpdateMsg():
                # 调试打印：PB 状态广播（SCB 复用显示）
                logger.info("↓ device_state_update %s → %s (update_id=%d)",
                            event.payload.device_id.value,
                            self._brief_state(event.payload.state),
                            event.payload.update_id)
            case StateSnapshotMsg():
                logger.info("↓ state_snapshot update_id=%d 设备数=%d",
                            event.payload.update_id, len(event.payload.devices))
            case ConfigUpdateMsg():
                logger.info("↓ config_update threshold=%s confirm_count=%s "
                            "cooldown_s=%s decode_window_s=%s",
                            event.payload.threshold, event.payload.confirm_count,
                            event.payload.cooldown_s, event.payload.decode_window_s)
                if self._on_config_update is not None:
                    asyncio.create_task(self._apply_config_update(event.payload))
            case ErrorMsg():
                logger.error("↓ error code=%s message=%s ref_seq=%s",
                             event.payload.code.value, event.payload.message,
                             event.payload.ref_seq)
            case _:
                logger.warning("↓ 未处理的消息类型：%s", type(event).__name__)

    async def _apply_config_update(self, payload: ConfigUpdatePayload) -> None:
        """应用参数回调 + 重新上报 decode_status（协议约定变更时发送）"""
        try:
            await self._on_config_update(payload)
        except Exception as exc:  # 回调异常不应中断收发循环
            logger.error("应用 config_update 失败：%s", exc)
            return
        try:
            await self._send_status()
        except Exception as exc:  # 连接可能已断开
            logger.debug("config_update 后重发 decode_status 失败：%s", exc)

    @staticmethod
    def _brief_state(state) -> str:
        return ", ".join(f"{k}={v}" for k, v in state.model_dump().items()
                         if k not in ("device_type", "device_id"))

    @staticmethod
    def _print_snapshot(snapshot) -> None:
        """打印 welcome 快照摘要（设备清单与关键状态）"""
        for dev in snapshot.devices:
            logger.info("  · %-20s [%s] %s", dev.device_id.value,
                        dev.device_type.value, SCBClient._brief_state(dev))

    # ---------- smoke 断言辅助 ----------

    @property
    def ack_ok_count(self) -> int:
        return sum(1 for ack in self.ack_results if ack.ok)

    async def wait_welcome(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self.welcome_event.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False
