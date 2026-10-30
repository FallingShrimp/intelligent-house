<script setup lang="ts">
/**
 * 经验进度条（屏幕最下方居中）：显示场景等级 / 当前经验 / 升级阈值。
 * 数据来自 PB 快照 scene（exp / level），阈值 = 100 + 等级 × 75（与 PB gainExp 一致）。
 */
import { computed } from 'vue'
import type { SceneState } from '../protocol/messages'

const props = defineProps<{ scene: SceneState | null }>()

const threshold = computed(() => 100 + (props.scene?.level ?? 0) * 75)
const pct = computed(() => {
  const exp = props.scene?.exp ?? 0
  return Math.max(0, Math.min(1, exp / threshold.value)) * 100
})
</script>

<template>
  <div class="expbar">
    <span class="lv">Lv.{{ scene?.level ?? 0 }}</span>
    <div class="track">
      <div class="fill" :style="{ width: `${pct}%` }" />
    </div>
    <span class="num">{{ Math.round(scene?.exp ?? 0) }} / {{ threshold }}</span>
  </div>
</template>

<style scoped>
.expbar {
  position: fixed;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-radius: 999px;
  background: rgba(8, 14, 24, 0.66);
  border: 1px solid rgba(120, 180, 255, 0.18);
  backdrop-filter: blur(4px);
  pointer-events: none;
}
.lv {
  color: #ffd98a;
  font-size: 12.5px;
  font-weight: 800;
  letter-spacing: 1px;
  flex: none;
}
.track {
  width: 220px;
  height: 8px;
  border-radius: 999px;
  background: rgba(120, 180, 255, 0.12);
  border: 1px solid rgba(120, 180, 255, 0.22);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #4aa3ff, #8fd4ff);
  box-shadow: 0 0 8px rgba(111, 195, 255, 0.55);
  transition: width 0.3s ease-out;
}
.num {
  color: rgba(200, 225, 250, 0.78);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  flex: none;
}
</style>
