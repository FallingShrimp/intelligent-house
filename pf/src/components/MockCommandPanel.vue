<script setup lang="ts">
/**
 * 模拟指令面板（右上角）：单选 CMD_01~CMD_08 + 发送按钮，
 * 用于无 ND8 硬件时手动模拟 SCB 解码输出（替代已删除的 mock 采集轮换）。
 * 发送走 ui_command 通道，PB 状态机按相同迁移表处理，与真实指令效果一致。
 */
import { ref } from 'vue'
import { COMMAND_MAP, type CommandId } from '../protocol/messages'
import { pbClient } from '../ws/client'

const LABELS: Record<CommandId, string> = {
  CMD_01: '主灯开关',
  CMD_02: '窗帘开合',
  CMD_03: '空调升温',
  CMD_04: '空调降温',
  CMD_05: '电视开关',
  CMD_06: '紧急呼叫',
  CMD_07: '卧室灯亮度',
  CMD_08: '门锁开关',
}
const IDS = Object.keys(LABELS) as CommandId[]

const selected = ref<CommandId>('CMD_01')

function send() {
  const { device_id, action } = COMMAND_MAP[selected.value]
  pbClient.sendUiCommand(device_id, action)
}
</script>

<template>
  <div class="mock-panel">
    <div class="mp-title">模拟指令（SSVEP 替身）</div>
    <label v-for="id in IDS" :key="id" class="mp-row">
      <input v-model="selected" type="radio" :value="id" name="mock-cmd" />
      <span class="mp-id">{{ id }}</span>
      <span class="mp-label">{{ LABELS[id] }}</span>
    </label>
    <button class="mp-send" @click="send">发送模拟指令</button>
  </div>
</template>

<style scoped>
.mock-panel {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: rgba(16, 20, 28, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  backdrop-filter: blur(6px);
  color: #e8ecf4;
  font-size: 12px;
  user-select: none;
}
.mp-title {
  font-weight: 600;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
  color: #9fd0ff;
}
.mp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 1px 2px;
  border-radius: 4px;
}
.mp-row:hover { background: rgba(255, 255, 255, 0.06); }
.mp-row input { accent-color: #4a9eff; cursor: pointer; }
.mp-id { font-family: monospace; color: #b8c4d8; width: 52px; }
.mp-label { color: #e8ecf4; }
.mp-send {
  margin-top: 6px;
  padding: 6px 0;
  border: none;
  border-radius: 6px;
  background: #2f6fed;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.mp-send:hover { background: #3d7cff; }
.mp-send:active { transform: translateY(1px); }
</style>
