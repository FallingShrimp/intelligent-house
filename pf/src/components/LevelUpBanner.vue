<script setup lang="ts">
/**
 * 场景升级横幅（全员橙色 LEVEL UP）：
 * 3s 动画 —— 0.5s 缓出 2x→1x 渐显 → 停留 2s → 0.5s 缓入 1x→0 渐隐。
 * 提示期（3s）玩家可继续攻击，结束后进入升级三选一（BuffPickModal）。
 */
defineProps<{ level: number }>()
</script>

<template>
	<div class="levelup">
		<div class="lu-main">LEVEL UP</div>
		<div class="lu-sub">场景等级 {{ level }}</div>
	</div>
</template>

<style scoped>
.levelup {
	position: fixed;
	top: 22vh;
	left: 50%;
	transform: translateX(-50%);
	z-index: 55;
	text-align: center;
	pointer-events: none;
	/* 3s 总时长：0.5s 缓出进场（2x→1x 渐显）/ 停留 2s / 0.5s 缓入离场（1x→0 渐隐） */
	animation: levelUp 3s both;
}
.lu-main {
	color: #ff9a3c;
	font-size: 58px;
	font-weight: 900;
	letter-spacing: 10px;
	text-shadow:
		0 0 18px rgba(255, 140, 40, 0.85),
		0 2px 6px rgba(0, 0, 0, 0.85),
		0 0 2px #ffd7a0;
}
.lu-sub {
	margin-top: 4px;
	color: rgba(255, 205, 150, 0.9);
	font-size: 15px;
	font-weight: 700;
	letter-spacing: 4px;
	text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
}
/* 段 1 缓出（0→16.7%），段 2 线性停留，段 3 缓入（83.3%→100%） */
@keyframes levelUp {
	0% {
		opacity: 0;
		transform: translateX(-50%) scale(2);
		animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); /* 缓出 */
	}
	16.7% {
		opacity: 1;
		transform: translateX(-50%) scale(1);
	}
	83.3% {
		opacity: 1;
		transform: translateX(-50%) scale(1);
		animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); /* 缓入 */
	}
	100% {
		opacity: 0;
		transform: translateX(-50%) scale(0);
	}
}
</style>
