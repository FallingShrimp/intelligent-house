<script setup lang="ts">
/**
 * 词条面板（排行榜下方，Tab 与排行榜同步展示 / 关闭）：
 * - 上半：场景属性 + 共享词条（经验 / 等级 / 幸运 / 经验倍率，全员一致）
 * - 下半：我的玩家词条（PB 快照写入，升级选卡累积）
 * 格式化按词条数据格式：INT 整数 / VALUE 原值 / PERCENT ×100%。
 * 注：当前生命值不是词条（走血条），不在此列。
 */
import { computed } from 'vue'
import type { NetPlayerState, SceneState } from '../protocol/messages'

const props = defineProps<{ me: NetPlayerState | null; scene: SceneState | null }>()

type Fmt = 'INT' | 'VALUE' | 'PERCENT'

function fmt(n: number | undefined, f: Fmt): string {
	if (n === undefined || Number.isNaN(n)) return '-'
	if (f === 'INT') return String(Math.round(n))
	if (f === 'PERCENT') return `${Math.round(n * 100)}%`
	return String(Math.round(n * 100) / 100)
}

/** 场景属性 + 共享词条（经验 / 等级为场景属性非词条，幸运 / 经验倍率为共享词条） */
const sceneRows = computed(() => {
	const s = props.scene
	return [
		{ name: '经验', value: fmt(s?.exp, 'VALUE') },
		{ name: '等级', value: fmt(s?.level, 'INT') },
		{ name: '幸运', value: fmt(s?.luck, 'VALUE') },
		{ name: '经验倍率', value: fmt(s?.exp_mul, 'PERCENT') },
	]
})

/** 我的玩家词条（snake_case 快照字段 → 展示名 + 格式） */
const statRows = computed(() => {
	const p = props.me
	if (!p) return []
	const rows: [string, number | undefined, Fmt][] = [
		['攻击力', p.atk, 'VALUE'],
		['生命上限', p.max_hp, 'VALUE'],
		['体力上限', p.max_st, 'VALUE'],
		['完美格挡窗口', p.parry_pct, 'PERCENT'],
		['格挡最大持续', p.max_block, 'VALUE'],
		['所有伤害', p.dmg_mul, 'PERCENT'],
		['蓄力时长', p.charge_dur, 'VALUE'],
		['荆棘', p.thorn_pct, 'PERCENT'],
		['吸血', p.lifesteal, 'VALUE'],
		['连续剑气', p.multi_wave, 'INT'],
		['冲击力', p.impact, 'PERCENT'],
		['稳定性', p.stability, 'PERCENT'],
		['暴击率', p.crit_rate, 'PERCENT'],
		['暴击伤害', p.crit_dmg, 'PERCENT'],
		['化气', p.huaqi, 'PERCENT'],
		['防御', p.def, 'VALUE'],
	]
	return rows.map(([name, v, f]) => ({ name, value: fmt(v, f) }))
})
</script>

<template>
	<div class="panel">
		<div class="panel-title">共享词条</div>
		<div class="grid scene">
			<div v-for="r in sceneRows" :key="r.name" class="cell">
				<span class="k">{{ r.name }}</span>
				<span class="v">{{ r.value }}</span>
			</div>
		</div>
		<div class="panel-title">我的词条</div>
		<div v-if="!statRows.length" class="empty">未加入房间</div>
		<div v-else class="grid stats">
			<div v-for="r in statRows" :key="r.name" class="cell">
				<span class="k">{{ r.name }}</span>
				<span class="v">{{ r.value }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.panel {
	min-width: 236px;
	max-width: 300px;
	padding: 10px 12px 8px;
	border-radius: 10px;
	background: rgba(8, 14, 24, 0.66);
	border: 1px solid rgba(120, 180, 255, 0.18);
	backdrop-filter: blur(4px);
	pointer-events: none;
}

.panel-title {
	margin-bottom: 5px;
	color: rgba(200, 225, 250, 0.75);
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 2px;
}

.panel-title+.panel-title,
.grid+.panel-title {
	margin-top: 8px;
}

.grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 2px 10px;
}

.grid.scene {
	grid-template-columns: 1fr 1fr;
}

.cell {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 6px;
	padding: 1.5px 4px;
	border-radius: 4px;
	font-size: 12px;
}

.cell:nth-child(odd) {
	background: rgba(120, 180, 255, 0.06);
}

.k {
	color: rgba(219, 231, 244, 0.72);
	white-space: nowrap;
}

.v {
	color: #ffd98a;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}

.empty {
	color: rgba(180, 205, 230, 0.45);
	font-size: 12px;
	padding: 2px 0 4px;
}
</style>
