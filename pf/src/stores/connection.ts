/**
 * 连接状态 store（右下角状态栏数据源）
 */
import { defineStore } from 'pinia'
import type { ErrorCode } from '../protocol/messages'

export type ConnectionStatus =
  | 'connecting'     // 首次连接中
  | 'connected'      // 已连接
  | 'reconnecting'   // 断线重连中
  | 'closed'         // 已关闭（dispose 后）

export interface LastAck {
  ok: boolean
  code: ErrorCode
  message: string
  at: number
}

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    status: 'connecting' as ConnectionStatus,
    /** PB 分配的 client_id（welcome 下发） */
    clientId: '',
    /** 重连尝试次数（连接成功后清零） */
    reconnectAttempt: 0,
    /** 最近一条 ui_command 回执 */
    lastAck: null as LastAck | null,
    /** 最近一条协议错误（type=error） */
    lastError: '',
  }),

  getters: {
    /** 状态栏展示文本 */
    statusText(state): string {
      switch (state.status) {
        case 'connected':
          return '已连接'
        case 'connecting':
          return '连接中…'
        case 'reconnecting':
          return `重连中（第 ${state.reconnectAttempt} 次）`
        case 'closed':
          return '已断开'
      }
    },
  },

  actions: {
    setStatus(status: ConnectionStatus) {
      if (status === 'connected') this.reconnectAttempt = 0
      this.status = status
    },
    setWelcome(clientId: string) {
      this.clientId = clientId
      this.lastError = ''
    },
    pushAck(ok: boolean, code: ErrorCode, message: string) {
      this.lastAck = { ok, code, message, at: Date.now() }
    },
    pushError(message: string) {
      this.lastError = message
      console.error('[connection] 协议错误:', message)
    },
  },
})
