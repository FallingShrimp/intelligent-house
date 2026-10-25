/**
 * PB WebSocket 客户端（PF 侧）
 *
 * - 连接 ws://<PB>/ws/pf，地址可用 VITE_PB_URL 环境变量覆盖
 * - 连接成功后发送 hello(role=pf)，PB 回 welcome（含全量快照）
 * - 断线自动重连（指数退避，上限 5s）；重连成功后追加 state_request 拉取全量快照
 * - 收到消息按 type 分发给 Pinia store（设备状态 / 连接状态）
 */
import {
  PROTOCOL_VERSION,
  isType,
  type Action,
  type CommandParams,
  type DeviceId,
  type MpActionPayload,
  type MpEventPayload,
  type MpInputPayload,
  type PlayerYou,
  type StateRequestPayload,
  type ToPf,
  type UiCommandPayload,
  type WorldPayload,
} from '../protocol/messages'
import { useConnectionStore } from '../stores/connection'
import { useDevicesStore } from '../stores/devices'

export const CLIENT_NAME = 'pf'
export const CLIENT_VERSION = '0.1.0'

/** 默认 PB 地址（ElysiaJS 约定端点 /ws/pf） */
export const DEFAULT_PB_URL = 'ws://localhost:3000/ws/pf'

/** 读取环境变量覆盖的 PB 地址 */
export function resolvePbUrl(): string {
  const envUrl = import.meta.env.VITE_PB_URL
  return typeof envUrl === 'string' && envUrl.length > 0 ? envUrl : DEFAULT_PB_URL
}

/** 重连退避：base * 2^n，上限 5s，附加少量随机抖动避免惊群 */
function backoffDelay(attempt: number): number {
  return Math.min(5000, 400 * 2 ** attempt) + Math.random() * 200
}

export class PbClient {
  readonly url: string
  private ws: WebSocket | null = null
  /** 发送端连接内单调递增序号 */
  private seqCounter = 0
  /** 重连尝试计数（用于退避计算） */
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** 是否发生过断线（用于判断重连后是否补发 state_request） */
  private hasDisconnected = false

  /** 联机对战：本客户端玩家名（hello 必带；连接前由 setDisplayName 写入） */
  private displayName = ''
  /** 联机对战：PB 分配的本玩家身份（welcome 后可读） */
  you: PlayerYou | null = null
  /** 联机对战：世界快照 / 战斗事件回调（SceneManager 注册） */
  onWorld?: (payload: WorldPayload) => void
  onMpEvent?: (payload: MpEventPayload) => void

  constructor(url: string = resolvePbUrl()) {
    this.url = url
  }

  setDisplayName(name: string) {
    this.displayName = name
  }

  get hasIdentity(): boolean {
    return this.displayName.length > 0
  }

  /** 建立连接（可在 pinia 安装后调用） */
  connect() {
    if (this.disposed) return
    const conn = useConnectionStore()
    conn.setStatus(this.hasDisconnected ? 'reconnecting' : 'connecting')
    try {
      this.ws = new WebSocket(this.url)
    } catch (err) {
      console.error('[ws] 创建连接失败:', err)
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = this.onOpen
    this.ws.onmessage = this.onMessage
    this.ws.onclose = this.onClose
    this.ws.onerror = () => console.warn('[ws] 连接异常:', this.url)
  }

  /** 发送 ui_command（手动控制 / 演示降级，docs 7.5） */
  sendUiCommand(deviceId: DeviceId, action: Action, params?: CommandParams) {
    const payload: UiCommandPayload = { device_id: deviceId, action }
    if (params) payload.params = params
    this.send('ui_command', payload)
  }

  /** 联机对战：上报输入状态（10Hz，SceneManager 调用） */
  sendMpInput(payload: MpInputPayload) {
    this.send('mp_input', payload)
  }

  /** 联机对战：上报动作意图（攻击 / 格挡开始 / 结束） */
  sendMpAction(payload: MpActionPayload) {
    this.send('mp_action', payload)
  }

  /** 请求全量快照（重连后 / 手动刷新） */
  requestState() {
    const payload: StateRequestPayload = {}
    this.send('state_request', payload)
  }

  /** 主动关闭并停止重连（组件卸载时调用） */
  dispose() {
    this.disposed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    useConnectionStore().setStatus('closed')
  }

  // ---------------- 内部实现 ----------------

  private get nextSeq(): number {
    return this.seqCounter++
  }

  /** PF → PB 可发送的消息类型（docs 7.5 + 联机对战 mp_input/mp_action） */
  private send(
    type: 'hello' | 'state_request' | 'ui_command' | 'mp_input' | 'mp_action',
    payload: unknown,
  ) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[ws] 未连接，丢弃消息:', type)
      return
    }
    const msg = { v: PROTOCOL_VERSION, type, seq: this.nextSeq, ts: Date.now(), payload }
    ws.send(JSON.stringify(msg))
  }

  private onOpen = () => {
    const conn = useConnectionStore()
    const isReconnect = this.hasDisconnected
    this.attempt = 0
    conn.setStatus('connected')

    // 接入注册（docs 7.5：PF → hello，role=pf 二次校验；联机对战必带玩家名）
    this.send('hello', {
      role: 'pf',
      client_name: CLIENT_NAME,
      client_version: CLIENT_VERSION,
      display_name: this.displayName || undefined,
    })

    // welcome 已携带全量快照；断线期间可能错过状态广播，重连成功后主动拉取一次
    if (isReconnect) this.requestState()
  }

  private onMessage = (ev: MessageEvent) => {
    let msg: ToPf
    try {
      msg = JSON.parse(String(ev.data)) as ToPf
    } catch {
      console.warn('[ws] 非法 JSON 帧，忽略')
      return
    }
    if (typeof msg?.type !== 'string') {
      console.warn('[ws] 缺少 type 字段，忽略')
      return
    }
    this.dispatch(msg)
  }

  /** 按 type 分发到 Pinia store（与 docs 7.7 PF 侧示例一致） */
  private dispatch(msg: ToPf) {
    const devices = useDevicesStore()
    const conn = useConnectionStore()

    if (isType(msg, 'welcome')) {
      conn.setWelcome(msg.payload.client_id)
      this.you = msg.payload.you ?? null
      devices.replaceAll(
        msg.payload.snapshot.devices,
        msg.payload.snapshot.update_id,
        msg.payload.snapshot.server_ts,
      )
      return
    }
    if (isType(msg, 'state_snapshot')) {
      devices.replaceAll(
        msg.payload.devices,
        msg.payload.update_id,
        msg.payload.server_ts,
      )
      return
    }
    if (isType(msg, 'device_state_update')) {
      devices.apply(msg.payload.state, msg.payload.update_id, msg.payload.source)
      return
    }
    if (isType(msg, 'command_ack')) {
      conn.pushAck(msg.payload.ok, msg.payload.code, msg.payload.message)
      if (!msg.payload.ok) console.warn('[ws] 指令被拒绝:', msg.payload.code, msg.payload.message)
      return
    }
    if (isType(msg, 'error')) {
      conn.pushError(`${msg.payload.code}: ${msg.payload.message}`)
      return
    }
    if (isType(msg, 'world')) {
      this.onWorld?.(msg.payload)
      return
    }
    if (isType(msg, 'event')) {
      this.onMpEvent?.(msg.payload)
      return
    }
    // 其余类型（config_update 等）不属 PF 通道，忽略
  }

  private onClose = () => {
    if (this.disposed) return
    this.hasDisconnected = true
    this.ws = null
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    const conn = useConnectionStore()
    conn.reconnectAttempt = this.attempt + 1
    conn.setStatus('reconnecting')
    const delay = backoffDelay(this.attempt)
    this.attempt++
    console.warn(`[ws] 连接断开，${Math.round(delay)}ms 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

/** 全局单例（main.ts connect，面板组件直接调用 sendUiCommand） */
export const pbClient = new PbClient()
