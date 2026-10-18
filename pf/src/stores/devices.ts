/**
 * 设备状态 store（PF 侧镜像）
 *
 * PB 是设备状态唯一事实源（SSOT，docs 7.9 约定 3），
 * 本 store 仅缓存最近一次收到的状态用于 UI 渲染与 3D 场景 watch，
 * 不做任何本地状态推导。
 */
import { defineStore } from 'pinia'
import type { DeviceId, DeviceState } from '../protocol/messages'

/** 面板展示顺序（与 docs 7.4 设备注册表一致） */
export const DEVICE_ORDER: DeviceId[] = [
  'living_room_light',
  'bedroom_light',
  'living_room_curtain',
  'air_conditioner',
  'tv',
  'door_lock',
  'emergency',
]

/** 设备中文名 */
export const DEVICE_LABELS: Record<DeviceId, string> = {
  living_room_light: '客厅主灯',
  bedroom_light: '卧室灯',
  living_room_curtain: '客厅窗帘',
  air_conditioner: '空调',
  tv: '电视',
  door_lock: '门锁',
  emergency: '紧急呼叫',
}

/** 设备图标（面板展示用） */
export const DEVICE_ICONS: Record<DeviceId, string> = {
  living_room_light: '💡',
  bedroom_light: '💡',
  living_room_curtain: '🪟',
  air_conditioner: '❄️',
  tv: '📺',
  door_lock: '🚪',
  emergency: '🚨',
}

/** 状态来源标记（对应 device_state_update.source） */
export type StateSource = 'scb' | 'manual'

export interface DeviceEntry {
  state: DeviceState
  /** 最近一次变更来源：🧠 脑控（scb）/ ✋ 手动（manual）；全量快照不带来源时为 null */
  source: StateSource | null
  /** 本地收到该状态的时刻（epoch ms） */
  receivedAt: number
}

export const useDevicesStore = defineStore('devices', {
  state: () => ({
    /** device_id → 最近状态（Map，保持注册表语义） */
    devices: new Map<DeviceId, DeviceEntry>(),
    /** PB 全局单调递增的 update_id，用于乱序 / 丢包检测 */
    updateId: -1,
    /** 最近一次快照的 server_ts */
    serverTs: 0,
    /** 因乱序被丢弃的 update 条数（调试可见） */
    outOfOrderDropped: 0,
  }),

  getters: {
    /** 按注册表顺序返回已知的设备状态（供 3D 场景 watch 与面板遍历） */
    orderedStates(state): DeviceState[] {
      const list: DeviceState[] = []
      for (const id of DEVICE_ORDER) {
        const entry = state.devices.get(id)
        if (entry) list.push(entry.state)
      }
      return list
    },
    /** 紧急呼叫是否处于触发状态 */
    emergencyActive(state): boolean {
      const entry = state.devices.get('emergency')
      return entry?.state.device_type === 'emergency' ? entry.state.active : false
    },
  },

  actions: {
    /**
     * 全量替换（welcome.snapshot / state_snapshot 应答）。
     * 快照不带单条来源标记，统一置 null。
     */
    replaceAll(devices: DeviceState[], updateId: number, serverTs: number) {
      this.devices.clear()
      for (const state of devices) {
        this.devices.set(state.device_id, { state, source: null, receivedAt: Date.now() })
      }
      // 快照代表全量事实，直接采用其 update_id（不做乱序比较）
      this.updateId = updateId
      this.serverTs = serverTs
    },

    /**
     * 应用单条状态更新（device_state_update 广播）。
     * 乱序检测：payload.update_id 小于本地值时忽略该条（docs 7.9 约定 2）。
     * @returns 是否被采纳
     */
    apply(state: DeviceState, updateId?: number, source?: StateSource): boolean {
      if (updateId !== undefined) {
        if (updateId < this.updateId) {
          this.outOfOrderDropped++
          console.warn(
            `[devices] 丢弃乱序更新: update_id=${updateId} < 本地 ${this.updateId} (${state.device_id})`,
          )
          return false
        }
        this.updateId = updateId
      }
      this.devices.set(state.device_id, {
        state,
        source: source ?? null,
        receivedAt: Date.now(),
      })
      return true
    },
  },
})
