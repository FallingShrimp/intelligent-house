<script setup lang="ts">
/**
 * 玩家列表 + 杀敌数排行榜（PB 10Hz world 快照驱动）：
 * 按击杀僵尸数降序排列，显示玩家颜色 / 名字 / 存活状态 / 击杀数，自己一行高亮。
 */
import { computed } from 'vue'
import type { NetPlayerState } from '../protocol/messages'
import { pbClient } from '../ws/client'

const props = defineProps<{ players: NetPlayerState[] }>()

const ranked = computed(() =>
  [...props.players].sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name)),
)
</script>

<template>
  <div class="board">
    <div class="board-title">玩家 · 击杀榜</div>
    <div v-if="!ranked.length" class="board-empty">暂无玩家</div>
    <div
      v-for="(p, i) in ranked"
      :key="p.uuid"
      class="row"
      :class="{ me: p.uuid === pbClient.you?.uuid, off: !p.fp }"
    >
      <span class="rank">{{ i + 1 }}</span>
      <span class="dot" :style="{ background: p.color }" />
      <span class="name" :class="{ dead: p.hp <= 0 }">
        {{ p.name }}<span v-if="p.hp <= 0" class="dead-tag">☠</span>
      </span>
      <span class="kills">{{ p.kills }}</span>
    </div>
  </div>
</template>

<style scoped>
.board {
  position: fixed;
  top: 64px;
  left: 16px;
  z-index: 20;
  min-width: 172px;
  padding: 10px 12px 8px;
  border-radius: 10px;
  background: rgba(8, 14, 24, 0.66);
  border: 1px solid rgba(120, 180, 255, 0.18);
  backdrop-filter: blur(4px);
  pointer-events: none;
}
.board-title {
  margin-bottom: 6px;
  color: rgba(200, 225, 250, 0.75);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
}
.board-empty {
  color: rgba(180, 205, 230, 0.45);
  font-size: 12px;
  padding: 2px 0 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2.5px 4px;
  border-radius: 5px;
  font-size: 12.5px;
}
.row.me {
  background: rgba(111, 195, 255, 0.14);
}
.row.off {
  opacity: 0.45;
}
.rank {
  width: 12px;
  color: rgba(200, 225, 250, 0.5);
  font-size: 11px;
  text-align: right;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  box-shadow: 0 0 5px rgba(0, 0, 0, 0.4);
}
.name {
  flex: 1;
  color: #e8f2fc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name.dead {
  color: rgba(255, 150, 140, 0.75);
  text-decoration: line-through;
}
.dead-tag {
  margin-left: 4px;
  font-size: 11px;
}
.kills {
  min-width: 22px;
  text-align: right;
  color: #ffd98a;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
</style>
