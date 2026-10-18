<script setup lang="ts">
/**
 * 紧急呼叫醒目提示条：emergency.active 时全屏顶部红色横幅，
 * 提供 emergency_reset 复位按钮（docs 7.9 约定 5）。
 */
import { computed } from 'vue'
import { useDevicesStore } from '../stores/devices'
import { pbClient } from '../ws/client'

const store = useDevicesStore()

const triggeredAtText = computed(() => {
  const entry = store.devices.get('emergency')
  const state = entry?.state
  if (!state || state.device_type !== 'emergency' || state.triggered_at === null) return ''
  return new Date(state.triggered_at).toLocaleTimeString()
})
</script>

<template>
  <div v-if="store.emergencyActive" class="banner" role="alert">
    <span class="blink">🚨</span>
    <b>紧急呼叫已触发</b>
    <span v-if="triggeredAtText" class="time">{{ triggeredAtText }}</span>
    <span class="flex-fill"></span>
    <button @click="pbClient.sendUiCommand('emergency', 'emergency_reset')">解除紧急呼叫</button>
  </div>
</template>

<style scoped>
.banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  background: linear-gradient(90deg, rgba(180, 10, 10, 0.92), rgba(120, 0, 0, 0.88));
  color: #fff;
  font-size: 15px;
  border-bottom: 2px solid #ff5b5b;
  z-index: 30;
}
.blink { animation: blink 0.7s infinite; font-size: 20px; }
@keyframes blink { 50% { opacity: 0.2; } }
.time { opacity: 0.85; font-size: 13px; }
.flex-fill { flex: 1; }
button {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
button:hover { background: rgba(255, 255, 255, 0.28); }
</style>
