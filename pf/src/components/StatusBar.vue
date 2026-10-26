<script setup lang="ts">
/**
 * 右下角连接状态栏：连接状态（已连接 / 重连中）、PB 地址、
 * update_id（乱序 / 丢包检测可见）、最近指令回执与 PB 重启按钮（二次确认）。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'
import { useDevicesStore } from '../stores/devices'
import { pbClient } from '../ws/client'

const conn = useConnectionStore()
const devices = useDevicesStore()

const dotClass = computed(() => {
  switch (conn.status) {
    case 'connected':
      return 'ok'
    case 'closed':
      return 'off'
    default:
      return 'warn'
  }
})

const updateIdText = computed(() => (devices.updateId >= 0 ? String(devices.updateId) : '—'))

// ---------------- PB 重启（运维，二次确认） ----------------

/** null = 未点击；true = 已点击等待确认（3s 未确认还原）；false = 已发出请求 */
const restartState = ref<'idle' | 'confirm' | 'sent'>('idle')
let confirmTimer = 0

function onRestartClick() {
  if (restartState.value === 'idle') {
    restartState.value = 'confirm'
    window.clearTimeout(confirmTimer)
    confirmTimer = window.setTimeout(() => (restartState.value = 'idle'), 3000)
    return
  }
  if (restartState.value === 'confirm') {
    window.clearTimeout(confirmTimer)
    restartState.value = 'sent'
    pbClient.sendAdminRestart()
  }
}

onBeforeUnmount(() => window.clearTimeout(confirmTimer))

// 任何窗口收到 PB 重启广播（含其他客户端发起）→ 全部进入「重启中」提示态
pbClient.onAdminRestarting = () => {
  restartState.value = 'sent'
}
</script>

<template>
  <div class="status-bar">
    <div class="row">
      <span class="dot" :class="dotClass"></span>
      <span>{{ conn.statusText }}</span>
      <!-- PB 自接管重启：首次点击进入确认态（3s 还原），再次点击才真正下发 -->
      <button
        class="restart-btn"
        :class="{ confirm: restartState === 'confirm', sent: restartState === 'sent' }"
        :disabled="restartState === 'sent'"
        @click="onRestartClick"
      >
        {{ restartState === 'idle' ? '重启 PB' : restartState === 'confirm' ? '确认重启？' : 'PB 重启中…' }}
      </button>
    </div>
    <div class="muted">{{ pbClient.url }}</div>
    <div v-if="conn.clientId" class="muted">client: {{ conn.clientId }}</div>
    <div class="row">
      <span class="muted">update_id</span>
      <b>{{ updateIdText }}</b>
      <span v-if="devices.outOfOrderDropped > 0" class="drop">
        乱序丢弃 {{ devices.outOfOrderDropped }}
      </span>
    </div>
    <div v-if="conn.lastAck" :class="conn.lastAck.ok ? 'ack-ok' : 'ack-fail'">
      {{ conn.lastAck.ok ? '✓ 回执 OK' : `✗ ${conn.lastAck.code}${conn.lastAck.message ? ' · ' + conn.lastAck.message : ''}` }}
    </div>
    <div v-if="conn.lastError" class="ack-fail">{{ conn.lastError }}</div>
  </div>
</template>

<style scoped>
.status-bar {
  position: absolute;
  right: 16px;
  bottom: 16px;
  min-width: 200px;
  background: rgba(13, 20, 30, 0.82);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(120, 180, 255, 0.18);
  border-radius: 10px;
  padding: 10px 12px;
  color: #dbe7f4;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
.dot.ok { background: #35d07f; box-shadow: 0 0 8px #35d07f; }
.dot.warn { background: #ffb340; box-shadow: 0 0 8px #ffb340; animation: blink 0.9s infinite; }
.dot.off { background: #6b7684; }
@keyframes blink { 50% { opacity: 0.25; } }
.muted { opacity: 0.55; font-size: 11px; }
b { color: #8fd4ff; }
.drop { color: #ffb340; font-size: 11px; }
.ack-ok { color: #35d07f; font-size: 11px; }
.ack-fail { color: #ff6a6a; font-size: 11px; word-break: break-all; }
.restart-btn {
  margin-left: auto;
  border: 1px solid rgba(255, 106, 106, 0.55);
  background: rgba(255, 106, 106, 0.12);
  color: #ff8a8a;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.restart-btn:hover { background: rgba(255, 106, 106, 0.25); }
.restart-btn.confirm {
  background: #e63946;
  border-color: #e63946;
  color: #fff;
  animation: blink 0.9s infinite;
}
.restart-btn.sent {
  cursor: default;
  opacity: 0.7;
  color: #ffb340;
  border-color: rgba(255, 179, 64, 0.55);
  background: rgba(255, 179, 64, 0.12);
}
</style>
