<script setup lang="ts">
/**
 * 左侧设备面板：设备列表（名称 / 关键状态字段 / 来源图标）
 * + 底部手动控制按钮组（发 ui_command，调试 / 无 BCI 演示降级）
 */
import { computed } from 'vue'
import type { Action, DeviceId, DeviceState } from '../protocol/messages'
import { DEVICE_ICONS, DEVICE_LABELS, DEVICE_ORDER, useDevicesStore } from '../stores/devices'
import { pbClient } from '../ws/client'

const store = useDevicesStore()

/** 来源标记 → 图标（🧠 = SCB 脑控指令，✋ = PF 手动控制） */
const SOURCE_ICONS = { scb: '🧠', manual: '✋' } as const

interface Chip {
  label: string
  value: string
}

interface Row {
  id: DeviceId
  icon: string
  label: string
  present: boolean
  chips: Chip[]
  source: keyof typeof SOURCE_ICONS | null
  alert: boolean
}

/** 按设备类型抽取关键状态字段 */
function describe(state: DeviceState): Chip[] {
  switch (state.device_type) {
    case 'light':
      return [
        { label: '电源', value: state.on ? '开' : '关' },
        { label: '亮度', value: `${state.brightness}%` },
        { label: '色温', value: `${state.color_temp}K` },
      ]
    case 'curtain':
      return [
        { label: '开度', value: `${state.position}%` },
        { label: '状态', value: state.position >= 100 ? '全开' : state.position <= 0 ? '全合' : '开合中' },
      ]
    case 'ac':
      return [
        { label: '电源', value: state.on ? '开' : '关' },
        { label: '设定', value: `${state.target_temp}℃` },
        { label: '扫风', value: state.fan_swing ? '开' : '关' },
      ]
    case 'tv':
      return [
        { label: '电源', value: state.on ? '开' : '关' },
        { label: '音量', value: `${state.volume}` },
      ]
    case 'door_lock':
      return [{ label: '锁态', value: state.locked ? '已上锁' : '已解锁' }]
    case 'emergency':
      return [
        { label: '状态', value: state.active ? '⚠ 已触发' : '正常' },
        ...(state.triggered_at
          ? [{ label: '时刻', value: new Date(state.triggered_at).toLocaleTimeString() }]
          : []),
      ]
  }
}

/** 每设备的手动控制动作（语义与 device_command 一致，docs 7.5） */
const CONTROL_ACTIONS: Record<DeviceId, Array<{ action: Action; label: string }>> = {
  living_room_light: [
    { action: 'toggle', label: '开/关' },
    { action: 'brightness_cycle', label: '亮度循环' },
  ],
  bedroom_light: [
    { action: 'toggle', label: '开/关' },
    { action: 'brightness_cycle', label: '亮度循环' },
  ],
  living_room_curtain: [{ action: 'toggle', label: '开/合' }],
  air_conditioner: [
    { action: 'toggle', label: '开/关' },
    { action: 'temp_up', label: '温度+' },
    { action: 'temp_down', label: '温度−' },
  ],
  tv: [{ action: 'toggle', label: '开/关' }],
  door_lock: [{ action: 'toggle', label: '上锁/解锁' }],
  emergency: [
    { action: 'emergency', label: '触发' },
    { action: 'emergency_reset', label: '解除' },
  ],
}

const rows = computed<Row[]>(() =>
  DEVICE_ORDER.map((id) => {
    const entry = store.devices.get(id)
    const state = entry?.state
    return {
      id,
      icon: DEVICE_ICONS[id],
      label: DEVICE_LABELS[id],
      present: state !== undefined,
      chips: state ? describe(state) : [],
      source: entry?.source ?? null,
      alert: id === 'emergency' && store.emergencyActive,
    }
  }),
)

function send(id: DeviceId, action: Action) {
  pbClient.sendUiCommand(id, action)
}
</script>

<template>
  <aside class="device-panel">
    <h2>🏠 设备状态</h2>
    <div v-for="row in rows" :key="row.id" class="device" :class="{ alert: row.alert }">
      <div class="head">
        <span class="icon">{{ row.icon }}</span>
        <span class="name">{{ row.label }}</span>
        <span
          class="source"
          :title="row.source ? `来源：${row.source === 'scb' ? 'SCB 脑控指令' : 'PF 手动控制'}` : '尚未收到更新'"
        >{{ row.source ? SOURCE_ICONS[row.source] : '·' }}</span>
      </div>
      <div v-if="row.present" class="chips">
        <span v-for="chip in row.chips" :key="chip.label" class="chip">
          {{ chip.label }} <b>{{ chip.value }}</b>
        </span>
      </div>
      <div v-else class="chips muted">等待 PB 快照…</div>
      <div class="actions">
        <button
          v-for="btn in CONTROL_ACTIONS[row.id]"
          :key="btn.action"
          @click="send(row.id, btn.action)"
        >{{ btn.label }}</button>
      </div>
    </div>
    <p class="footnote">💡 按钮发送 ui_command（手动控制 / 演示降级）</p>
  </aside>
</template>

<style scoped>
.device-panel {
  position: absolute;
  top: 16px;
  left: 16px;
  bottom: 16px;
  width: 264px;
  overflow-y: auto;
  background: rgba(13, 20, 30, 0.82);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(120, 180, 255, 0.18);
  border-radius: 12px;
  padding: 14px 14px 8px;
  color: #dbe7f4;
  box-sizing: border-box;
}
h2 {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
}
.device {
  border: 1px solid rgba(120, 180, 255, 0.12);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.device.alert {
  border-color: rgba(255, 70, 70, 0.85);
  background: rgba(255, 40, 40, 0.16);
  animation: pulse 0.8s ease-in-out infinite;
}
@keyframes pulse {
  50% { box-shadow: 0 0 14px rgba(255, 50, 50, 0.55); }
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon { font-size: 15px; }
.name { flex: 1; font-size: 13px; font-weight: 600; }
.source { font-size: 13px; opacity: 0.9; }
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin: 6px 0;
  font-size: 11px;
}
.chip {
  background: rgba(120, 180, 255, 0.12);
  border-radius: 4px;
  padding: 2px 6px;
}
.chip b { color: #8fd4ff; }
.muted { opacity: 0.45; }
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.actions button {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 5px;
  border: 1px solid rgba(120, 180, 255, 0.35);
  background: rgba(50, 110, 180, 0.25);
  color: #dcecff;
  cursor: pointer;
  transition: background 0.15s;
}
.actions button:hover { background: rgba(80, 150, 230, 0.45); }
.actions button:active { transform: scale(0.96); }
.footnote {
  font-size: 10px;
  opacity: 0.4;
  margin: 4px 0 8px;
}
</style>
