/**
 * 设备状态机（docs.md 7.4 设备注册表 + 指令 → 状态迁移映射）
 *
 * PB 是设备状态的唯一事实源（SSOT）：本模块负责
 * 1. 按设备注册表初始化 7 台设备；
 * 2. 按迁移映射执行 action，做字段约束校验（越界 → OUT_OF_RANGE，
 *    设备不支持该操作 → INVALID_TRANSITION）。
 * 状态更新采用不可变复制，避免广播对象与内部状态共享引用。
 */
import type { Action, DeviceId, DeviceState, ErrorCode } from './protocol'

/** 指令冷却窗口（docs.md 7.9：同一 device_id + cmd_id 3 秒内不再重复触发） */
export const COOLDOWN_MS = 3000

/** 灯光亮度档位（CMD_07 brightness_cycle 在这些档位间循环） */
export const BRIGHTNESS_LEVELS = [0, 40, 70, 100]

/** 空调温度约束 */
export const AC_TEMP_MIN = 16
export const AC_TEMP_MAX = 30

/**
 * 设备注册表初始状态（docs.md 7.4）
 */
export function createInitialDevices(): DeviceState[] {
  return [
    {
      device_type: 'light',
      device_id: 'living_room_light',
      on: false,
      brightness: 80,
      color_temp: 4000,
    },
    {
      device_type: 'light',
      device_id: 'bedroom_light',
      on: false,
      brightness: 80,
      color_temp: 4000,
    },
    { device_type: 'curtain', device_id: 'living_room_curtain', position: 0 },
    {
      device_type: 'ac',
      device_id: 'air_conditioner',
      on: false,
      target_temp: 26,
      fan_swing: false,
    },
    { device_type: 'tv', device_id: 'tv', on: false, volume: 30 },
    { device_type: 'door_lock', device_id: 'door_lock', locked: true },
    {
      device_type: 'emergency',
      device_id: 'emergency',
      active: false,
      triggered_at: null,
    },
  ]
}

export type ApplyResult =
  | { ok: true; state: DeviceState }
  | { ok: false; code: Exclude<ErrorCode, 'OK'>; message: string }

function ok(state: DeviceState): ApplyResult {
  return { ok: true, state }
}

function invalidTransition(action: Action, deviceType: DeviceState['device_type']): ApplyResult {
  return {
    ok: false,
    code: 'INVALID_TRANSITION',
    message: `设备类型 ${deviceType} 不支持动作 ${action}`,
  }
}

/**
 * 执行状态迁移。
 * @param state 当前设备状态
 * @param action 已验证合法的 Action
 * @param step 空调温度步长（temp_up / temp_down 用），默认 1
 */
export function applyAction(state: DeviceState, action: Action, step: number): ApplyResult {
  switch (state.device_type) {
    case 'light': {
      if (action === 'toggle') {
        // CMD_01 / CMD_05 语义：on 取反
        return ok({ ...state, on: !state.on })
      }
      if (action === 'brightness_cycle') {
        // CMD_07 语义：brightness 在 0/40/70/100 档位间循环；
        // 当前值不在档位（如初始 80）时取第一个更大的档位
        const next = BRIGHTNESS_LEVELS.find((lv) => lv > state.brightness) ?? 0
        return ok({ ...state, brightness: next })
      }
      return invalidTransition(action, 'light')
    }
    case 'curtain': {
      if (action === 'toggle') {
        // CMD_02 语义：position 在 0 ↔ 100 间切换（PF 负责动画插值）
        return ok({ ...state, position: state.position > 0 ? 0 : 100 })
      }
      return invalidTransition(action, 'curtain')
    }
    case 'ac': {
      if (action === 'toggle') {
        return ok({ ...state, on: !state.on })
      }
      if (action === 'temp_up' || action === 'temp_down') {
        // CMD_03 / CMD_04 语义：target_temp ±step，步长 1（16–30 ℃，步长 1）
        const target = state.target_temp + (action === 'temp_up' ? step : -step)
        if (target < AC_TEMP_MIN || target > AC_TEMP_MAX) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            message: `target_temp ${target} 超出 ${AC_TEMP_MIN}–${AC_TEMP_MAX} ℃ 范围`,
          }
        }
        return ok({ ...state, target_temp: target })
      }
      return invalidTransition(action, 'ac')
    }
    case 'tv': {
      if (action === 'toggle') {
        return ok({ ...state, on: !state.on })
      }
      return invalidTransition(action, 'tv')
    }
    case 'door_lock': {
      if (action === 'toggle') {
        // CMD_08 语义：locked 取反
        return ok({ ...state, locked: !state.locked })
      }
      return invalidTransition(action, 'door_lock')
    }
    case 'emergency': {
      if (action === 'emergency') {
        // CMD_06 语义：active=true，记录触发时刻
        return ok({ ...state, active: true, triggered_at: Date.now() })
      }
      if (action === 'emergency_reset') {
        // 解除紧急呼叫（仅 ui_command 手动 / 调试，docs.md 7.9 约定 5）
        return ok({ ...state, active: false, triggered_at: null })
      }
      return invalidTransition(action, 'emergency')
    }
  }
}

/** 类型守卫：device_id 是否属于注册表 7 台设备 */
export function isDeviceId(x: string): x is DeviceId {
  return createInitialDevices().some((d) => d.device_id === x)
}

/** 便于日志 / 调试展示的设备名映射 */
export const DEVICE_LABELS: Record<DeviceId, string> = {
  living_room_light: '客厅主灯',
  bedroom_light: '卧室灯',
  living_room_curtain: '客厅窗帘',
  air_conditioner: '空调',
  tv: '电视',
  door_lock: '门锁',
  emergency: '全屋紧急呼叫',
}

export type { DeviceId, DeviceState }
