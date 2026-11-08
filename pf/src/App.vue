<script setup lang="ts">
/**
 * 应用根组件：全屏 3D 画布 + 2D 状态面板（左）+ 连接状态（右下）+ 紧急横幅。
 * Pinia 设备状态 → 3D 场景通过 watch 桥接（单一数据流，见 onMounted）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DevicePanel from './components/DevicePanel.vue'
import EmergencyBanner from './components/EmergencyBanner.vue'
import MockCommandPanel from './components/MockCommandPanel.vue'
import StatusBar from './components/StatusBar.vue'
import { useDevicesStore, DEVICE_ORDER } from './stores/devices'
import { SceneManager, type ViewMode } from './three/SceneManager'
import type { DeviceId, DeviceState } from './protocol/messages'
import { pbClient } from './ws/client'

const host = ref<HTMLDivElement | null>(null)
const viewMode = ref<ViewMode>('fixed')
const flying = ref(false)
const locked = ref(false)
const toast = ref('')
let toastTimer = 0
function showToast(msg: string) {
  toast.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2200)
}
let scene: SceneManager | null = null

onMounted(() => {
  if (!host.value) return
  scene = new SceneManager(
    host.value,
    (m) => (viewMode.value = m),
    (f) => (flying.value = f),
    (id, action) => pbClient.sendUiCommand(id, action),
    showToast,
    (l) => (locked.value = l),
  )

  // 设备状态 → 3D 场景：按 device_id 引用比较，仅对实际变化的设备调用 apply。
  // 首批（welcome/state_snapshot 全量快照）瞬时落位，其后的广播带过渡动画。
  const store = useDevicesStore()
  const lastApplied = new Map<DeviceId, DeviceState>()
  let hasAppliedAny = false
  watch(
    () => store.orderedStates,
    (list) => {
      const animate = hasAppliedAny
      for (const state of list) {
        if (lastApplied.get(state.device_id) === state) continue
        lastApplied.set(state.device_id, state)
        scene?.applyDeviceState(state, animate)
      }
      hasAppliedAny = true
    },
    { immediate: true },
  )
  // DEVICE_ORDER 仅用于保持 import 侧副作用一致（面板渲染顺序由 store getter 保证）
  void DEVICE_ORDER
})

onBeforeUnmount(() => {
  scene?.dispose()
  scene = null
  window.clearTimeout(toastTimer)
})
</script>

<template>
  <div class="app-root">
    <div ref="host" class="canvas-host"></div>
    <EmergencyBanner />
    <MockCommandPanel />
    <DevicePanel />
    <StatusBar />
    <div v-if="viewMode === 'fixed'" class="hint">拖拽旋转视角 · <b>左键点击</b>门 / 电视 / 空调 / 水杯交互 · 按 <b>V</b> 进入第一人称漫游</div>
    <div v-else-if="!flying" class="hint">点击画面锁定鼠标 · <b>WASD</b> 移动 · <b>双击 W</b> 疾跑 · <b>空格</b>跳 · <b>双击空格</b>起飞 · <b>左键</b>交互 · <b>ESC</b> 释放鼠标 · 按 <b>V</b> 返回固定视角</div>
    <div v-else class="hint">飞行模式 · <b>WASD</b> 移动 · <b>空格</b>上升 · <b>Ctrl</b> 下降 · <b>双击空格</b>降落 · 按 <b>V</b> 返回固定视角</div>
    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
.canvas-host {
  position: absolute;
  inset: 0;
}
.canvas-host :deep(canvas) {
  display: block;
}
.hint {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 8px;
  background: rgba(13, 20, 30, 0.7);
  border: 1px solid rgba(120, 180, 255, 0.15);
  color: rgba(219, 231, 244, 0.75);
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}
.hint b { color: #8fd4ff; }
.toast {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 18px;
  border-radius: 10px;
  background: rgba(13, 20, 30, 0.85);
  border: 1px solid rgba(120, 180, 255, 0.3);
  color: #cfe6ff;
  font-size: 13px;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}
</style>
