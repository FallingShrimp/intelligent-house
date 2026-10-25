<script setup lang="ts">
/**
 * 死亡覆盖层：半透明红色全屏 + 「复活」按钮。
 * canRespawn=false 时按钮禁用并提示复活条件（是否可复活最终由 PB 校验）。
 */
defineProps<{ canRespawn: boolean }>()
const emit = defineEmits<{ respawn: [] }>()
</script>

<template>
	<div class="death-mask">
		<div class="death-inner">
			<div class="death-title">你妈死了</div>
			<button class="respawn-btn" :disabled="!canRespawn" @click="emit('respawn')">复活</button>
			<div v-if="!canRespawn" class="death-hint">
				队友尚存且僵尸仍在房间内——等待队友走近点击你的尸体复活（所有玩家阵亡或僵尸被清空后可自行复活）
			</div>
		</div>
	</div>
</template>

<style scoped>
.death-mask {
	position: fixed;
	inset: 0;
	z-index: 55;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(110, 0, 0, 0.45);
	backdrop-filter: blur(2px);
	pointer-events: all;
}

.death-inner {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 18px;
}

.death-title {
	color: #ffdede;
	font-size: 56px;
	font-weight: 800;
	letter-spacing: 12px;
	text-shadow: 0 2px 24px rgba(0, 0, 0, 0.6);
}

.respawn-btn {
	min-width: 160px;
	padding: 12px 32px;
	border: none;
	border-radius: 10px;
	background: linear-gradient(180deg, #ff5f52, #d3382c);
	color: #fff;
	font-size: 18px;
	font-weight: 700;
	letter-spacing: 6px;
	cursor: pointer;
	box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}

.respawn-btn:not(:disabled):hover {
	filter: brightness(1.12);
}

.respawn-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.death-hint {
	max-width: 420px;
	color: rgba(255, 220, 220, 0.85);
	font-size: 13px;
	text-align: center;
	line-height: 1.6;
	text-shadow: 0 1px 8px rgba(0, 0, 0, 0.6);
}
</style>
