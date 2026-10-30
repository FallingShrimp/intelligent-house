<script setup lang="ts">
/**
 * 升级三选一（场景升级后全员进行，全员选完前 PB 冻结世界 pick_phase）。
 * options 为 PB 抽中的 3 张增益卡牌（id / label / 稀有度 / 标签），
 * 按稀有度着色（WASTE 灰 / NORMAL 白 / RARE 蓝 / EPIC 紫 / LEGENDARY 金 /
 * INFINITY 彩虹），labels 以 chips 展示。emit choose(0-2) 为卡牌位次索引。
 * 已选 / 无选项时显示等待横幅。
 */
import type { CardQuality, PickCardOption } from '../protocol/messages'

defineProps<{ options: PickCardOption[] | null; done: boolean }>()
const emit = defineEmits<{ choose: [idx: number] }>()

const QUALITY_NAME: Record<CardQuality, string> = {
	WASTE: '废品',
	NORMAL: '普通',
	RARE: '稀有',
	EPIC: '史诗',
	LEGENDARY: '传说',
	INFINITY: '无限',
}
</script>

<template>
	<div class="pick-mask">
		<div v-if="options && !done" class="pick-panel">
			<div class="pick-title">升级</div>
			<div class="pick-sub">三选一增益 · 所有玩家选择完毕后战斗继续</div>
			<button
				v-for="(card, i) in options"
				:key="card.id"
				class="card"
				:class="card.quality.toLowerCase()"
				@click="emit('choose', i)"
			>
				<span class="card-head">
					<span class="card-no">{{ i + 1 }}</span>
					<span class="card-quality" :class="card.quality.toLowerCase()">{{ QUALITY_NAME[card.quality] ?? card.quality }}</span>
				</span>
				<span class="card-label">{{ card.label }}</span>
				<span class="card-tags">
					<span v-for="tag in card.labels" :key="tag" class="chip">{{ tag }}</span>
				</span>
			</button>
		</div>
		<div v-else class="pick-waiting">
			<span class="spin"></span>等待其他玩家选择升级…
		</div>
	</div>
</template>

<style scoped>
.pick-mask {
	position: fixed;
	inset: 0;
	z-index: 60;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(8, 12, 20, 0.55);
	backdrop-filter: blur(2px);
	pointer-events: all;
}

.pick-panel {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 26px 30px;
	border-radius: 14px;
	background: rgba(13, 20, 30, 0.92);
	border: 1px solid rgba(120, 180, 255, 0.3);
	box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
	min-width: 360px;
}

.pick-title {
	color: #ffd76a;
	font-size: 22px;
	font-weight: 800;
	letter-spacing: 3px;
	text-align: center;
	text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
}

.pick-sub {
	color: rgba(219, 231, 244, 0.65);
	font-size: 12px;
	text-align: center;
	margin-bottom: 6px;
}

/* ---------------- 增益卡牌 ---------------- */

.card {
	display: flex;
	flex-direction: column;
	gap: 7px;
	padding: 12px 16px;
	border-radius: 10px;
	background: rgba(30, 42, 60, 0.85);
	border: 1.5px solid rgba(160, 170, 185, 0.45); /* NORMAL 白 */
	color: #cfe6ff;
	cursor: pointer;
	text-align: left;
	transition: background 0.15s, border-color 0.15s, transform 0.1s, box-shadow 0.15s;
}
.card:hover {
	background: rgba(48, 68, 96, 0.95);
	transform: translateY(-2px);
}

.card-head {
	display: flex;
	align-items: center;
	gap: 8px;
}
.card-no {
	width: 20px;
	height: 20px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 50%;
	background: rgba(120, 180, 255, 0.16);
	color: rgba(219, 231, 244, 0.85);
	font-size: 12px;
	font-weight: 700;
	flex: none;
}
.card-quality {
	font-size: 11px;
	font-weight: 800;
	letter-spacing: 2px;
}
.card-label {
	font-size: 15px;
	font-weight: 700;
	line-height: 1.35;
}
.card-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
}
.chip {
	padding: 1.5px 8px;
	border-radius: 999px;
	background: rgba(120, 180, 255, 0.12);
	border: 1px solid rgba(120, 180, 255, 0.28);
	color: rgba(190, 220, 250, 0.85);
	font-size: 11px;
}

/* 稀有度配色：WASTE 灰 / NORMAL 白 / RARE 蓝 / EPIC 紫 / LEGENDARY 金 / INFINITY 彩虹 */
.card.waste { border-color: rgba(150, 158, 170, 0.4); }
.card.waste .card-label { color: #9aa7b5; }
.card.waste .card-quality { color: #8d99a8; }

.card.normal { border-color: rgba(210, 226, 245, 0.5); }
.card.normal .card-label { color: #eef5fd; }
.card.normal .card-quality { color: #c6d6e8; }

.card.rare { border-color: rgba(74, 163, 255, 0.75); box-shadow: 0 0 12px rgba(74, 163, 255, 0.18); }
.card.rare .card-label { color: #7db8ff; }
.card.rare .card-quality { color: #5f9ff0; }

.card.epic { border-color: rgba(192, 132, 252, 0.8); box-shadow: 0 0 12px rgba(192, 132, 252, 0.22); }
.card.epic .card-label { color: #d3a8fd; }
.card.epic .card-quality { color: #b87ef7; }

.card.legendary { border-color: rgba(255, 203, 88, 0.85); box-shadow: 0 0 14px rgba(255, 190, 70, 0.3); }
.card.legendary .card-label { color: #ffd76a; }
.card.legendary .card-quality { color: #f5b83c; }

.card.infinity {
	border-color: transparent;
	background:
		linear-gradient(rgba(30, 42, 60, 0.92), rgba(30, 42, 60, 0.92)) padding-box,
		linear-gradient(90deg, #ff5f5f, #ffb44d, #ffe14d, #6ee787, #4dc9ff, #a78bfa, #ff5f9e) border-box;
	box-shadow: 0 0 16px rgba(255, 120, 200, 0.35);
	animation: rainbowHue 2.4s linear infinite;
}
.card.infinity .card-label {
	background: linear-gradient(90deg, #ff8f8f, #ffd66e, #8fffa9, #6fd3ff, #c9a4ff, #ff8fc7);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}
.card.infinity .card-quality { color: #ffb3e2; }
@keyframes rainbowHue {
	from { filter: hue-rotate(0deg); }
	to { filter: hue-rotate(360deg); }
}

.pick-waiting {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 20px;
	border-radius: 10px;
	background: rgba(13, 20, 30, 0.85);
	border: 1px solid rgba(120, 180, 255, 0.25);
	color: rgba(219, 231, 244, 0.85);
	font-size: 13px;
}
.spin {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	border: 2px solid rgba(120, 180, 255, 0.3);
	border-top-color: #8fd4ff;
	animation: spin 0.9s linear infinite;
}
@keyframes spin {
	to { transform: rotate(360deg); }
}
</style>
