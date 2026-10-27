<script setup lang="ts">
/**
 * 击杀三选一增益弹窗：僵尸被击败后房间内所有玩家三选一，
 * 全员选完前 PB 冻结世界（pick_phase）。已选 / 无选项时显示等待横幅。
 * options 为 PB 抽中的增益索引（0–15，文案与 PB world.ts PICK_OPTIONS 对齐）。
 */
defineProps<{ options: number[] | null; done: boolean }>()
const emit = defineEmits<{ choose: [idx: number] }>()

const LABELS = [
	'攻击力 +5',
	'血量上限 +20',
	'完美格挡窗口 +2%',
	'体力上限 +10',
	'格挡最大持续 +0.25s',
	'所有伤害 +10%',
	'重击蓄力速度 +15%',
	'荆棘 +15%',
	'吸血 +2',
	'连续剑气 +1',
	'蓄力上限 +0.25s',
	'冲击力 +15%',
	'稳定性 +15%',
	'暴击率 +5%',
	'暴击伤害 +25%',
	'化气 +10%',
]
</script>

<template>
	<div class="pick-mask">
		<div v-if="options && !done" class="pick-panel">
			<div class="pick-title">僵尸被击倒！</div>
			<div class="pick-sub">三选一增益 · 所有玩家选择完毕后战斗继续</div>
			<button
				v-for="(opt, i) in options"
				:key="opt"
				class="pick-btn"
				@click="emit('choose', opt)"
			>
				<span class="pick-no">{{ i + 1 }}</span>
				<span class="pick-label">{{ LABELS[opt] ?? `增益 ${opt}` }}</span>
			</button>
		</div>
		<div v-else class="pick-waiting">
			<span class="spin"></span>等待其他玩家选择增益…
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
	min-width: 320px;
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

.pick-btn {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 18px;
	border: 1px solid rgba(120, 180, 255, 0.25);
	border-radius: 10px;
	background: rgba(30, 42, 60, 0.85);
	color: #cfe6ff;
	font-size: 15px;
	font-weight: 600;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s, transform 0.1s;
}

.pick-btn:hover {
	background: rgba(48, 68, 96, 0.95);
	border-color: rgba(140, 210, 255, 0.6);
	transform: translateY(-1px);
}

.pick-btn:active {
	transform: translateY(0);
}

.pick-no {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	border-radius: 6px;
	background: rgba(95, 247, 224, 0.15);
	color: #5ff7e0;
	font-size: 13px;
	font-weight: 700;
	flex: none;
}

.pick-waiting {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 22px;
	border-radius: 999px;
	background: rgba(13, 20, 30, 0.85);
	border: 1px solid rgba(120, 180, 255, 0.3);
	color: rgba(219, 231, 244, 0.85);
	font-size: 14px;
}

.spin {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	border: 2px solid rgba(120, 180, 255, 0.25);
	border-top-color: #5ff7e0;
	animation: pickSpin 0.9s linear infinite;
}

@keyframes pickSpin {
	to { transform: rotate(360deg); }
}
</style>
