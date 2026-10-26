<script setup lang="ts">
/**
 * 应用根组件：全屏 3D 画布 + 2D 状态面板（左）+ 连接状态（右下）+ 紧急横幅。
 * Pinia 设备状态 → 3D 场景通过 watch 桥接（单一数据流，见 onMounted）。
 * 格斗 HUD（血条/体力/僵尸目标/飘字/格挡指示/眩晕）由 SceneManager 回调驱动。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BuffPickModal from './components/BuffPickModal.vue'
import DevicePanel from './components/DevicePanel.vue'
import DeathOverlay from './components/DeathOverlay.vue'
import DisplayNameModal from './components/DisplayNameModal.vue'
import EmergencyBanner from './components/EmergencyBanner.vue'
import Leaderboard from './components/Leaderboard.vue'
import MockCommandPanel from './components/MockCommandPanel.vue'
import StatusBar from './components/StatusBar.vue'
import { useDevicesStore, DEVICE_ORDER } from './stores/devices'
import { SceneManager, type PickState, type ViewMode } from './three/SceneManager'
import type { CombatHud } from './three/combat'
import type { DeviceId, DeviceState, NetPlayerState } from './protocol/messages'

import { pbClient } from './ws/client'

const host = ref<HTMLDivElement | null>(null)
const viewMode = ref<ViewMode>('fixed')
const flying = ref(false)
const locked = ref(false)
const toast = ref('')
// 死亡覆盖层状态（SceneManager 经 PB 快照推导；复活请求最终由 PB 校验）
const dead = ref(false)
const canRespawn = ref(false)
// 玩家列表 / 杀敌榜（10Hz world 快照驱动）
const roster = ref<NetPlayerState[]>([])
// 击杀三选一增益（PB pick_phase / 我的选择变化时由 SceneManager 推送）
const pick = ref<PickState>({ active: false, options: null, done: false })
// 联机对战：首次连接（localStorage 无 DisplayName）时弹出名字输入框
const needName = ref(!localStorage.getItem('DisplayName'))
function confirmName(name: string) {
  localStorage.setItem('DisplayName', name)
  pbClient.setDisplayName(name)
  pbClient.connect()
  needName.value = false
}
// 三选一：上报所选项（idx 为 PB 抽中的增益索引）
function choosePick(idx: number) {
  pbClient.sendMpAction({ kind: 'pick', idx })
}
let toastTimer = 0
function showToast(msg: string) {
  toast.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2200)
}
let scene: SceneManager | null = null

// ---------------- 格斗 HUD ----------------
const hud = ref<CombatHud | null>(null)
const hurtFlash = ref(false)
const parryFlash = ref(false)
let hurtTimer = 0
let parryTimer = 0
function flash(r: typeof hurtFlash, t: number) {
  r.value = true
  window.clearTimeout(t)
  return window.setTimeout(() => (r.value = false), 240)
}
interface FloatText {
  id: number
  text: string
  sx: number
  sy: number
  kind: 'normal' | 'crit' | 'heal' | 'blocked'
}
const floats = ref<FloatText[]>([])
let floatId = 0

onMounted(() => {
  if (!host.value) return
  scene = new SceneManager(
    host.value,
    (m) => (viewMode.value = m),
    (f) => (flying.value = f),
    (id, action) => pbClient.sendUiCommand(id, action),
    showToast,
    (l) => (locked.value = l),
    {
      onHud: (h) => (hud.value = h),
      onFloat: (text, sx, sy, kind) => {
        const id = ++floatId
        floats.value.push({ id, text, sx, sy, kind })
        window.setTimeout(() => {
          floats.value = floats.value.filter((f) => f.id !== id)
        }, 900)
      },
      onFlash: (kind) => {
        if (kind === 'hurt') hurtTimer = flash(hurtFlash, hurtTimer)
        else parryTimer = flash(parryFlash, parryTimer)
      },
    },
    (d, can) => {
      dead.value = d
      canRespawn.value = can
    },
    (players) => (roster.value = players),
    (st) => (pick.value = st),
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
})
</script>

<template>
  <div class="app-root">
    <div ref="host" class="canvas-host"></div>
    <!-- 第一人称准星：指针锁定时显示于屏幕中心（射线拾取即以该点为准） -->
    <div v-if="locked" class="crosshair">
      <span class="dot"></span>
      <span class="tick t"></span>
      <span class="tick b"></span>
      <span class="tick l"></span>
      <span class="tick r"></span>
      <!-- 重击蓄力扇环：圆心角 0~360° 表示进度 0~1，蓄满变金色 -->
      <svg v-if="hud && hud.charge != null" class="charge-ring" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="22" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="5" />
        <circle
          cx="32" cy="32" r="22" fill="none"
          :stroke="hud.charge >= 1 ? '#ffc93c' : '#3fd8d0'"
          stroke-width="5" stroke-linecap="round"
          :stroke-dasharray="`${hud.charge * 2 * Math.PI * 22} ${2 * Math.PI * 22}`"
          transform="rotate(-90 32 32)"
        />
      </svg>
    </div>
    <!-- 僵尸技能预警四角星（准星上方：点放大→成型→继续放大渐隐循环）
         金=可格挡普攻 / 白=不可格挡横扫（必须闪避）/ 紫=突进位移 -->
    <svg
      v-if="locked && hud && hud.incomingSkill"
      class="attack-alert"
      :class="hud.incomingSkill"
      viewBox="0 0 24 24" width="46" height="46"
    >
      <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" stroke-width="0.6" />
    </svg>
    <!-- 格挡进度 / 冷却（准星下方） -->
    <div v-if="locked && hud" class="block-meter">
      <div v-if="hud.blocking" class="block-fill" :class="{ gold: hud.blockPerfect, plain: !hud.blockPerfect }" :style="{ width: hud.blockAge01 * 100 + '%' }"></div>
      <div v-else-if="hud.blockCd01 < 1" class="block-fill gray" :style="{ width: hud.blockCd01 * 100 + '%' }"></div>
    </div>
    <div v-if="locked && hud && hud.chaseLeft > 0" class="chase-tag">追击 ×{{ hud.chaseLeft }}</div>
    <!-- 僵尸目标条 -->
    <div v-if="locked && hud && hud.target" class="zombie-bar">
      <div class="zb-name">僵尸</div>
      <div class="zb-track hp"><div class="zb-fill hp" :style="{ width: (hud.target.hp / hud.target.maxHp) * 100 + '%' }"></div></div>
      <div class="zb-track st"><div class="zb-fill st" :style="{ width: hud.target.stamina + '%' }"></div></div>
      <div v-if="hud.target.vulnMul" class="zb-vuln">易伤 ×{{ hud.target.vulnMul.toFixed(2) }}</div>
    </div>
    <!-- 玩家血条 / 体力条 -->
    <div v-if="locked && hud" class="self-bars">
      <div class="sb-row">
        <span class="sb-label">HP</span>
        <div class="sb-track hp"><div class="sb-fill hp" :style="{ width: (hud.hp / hud.maxHp) * 100 + '%' }"></div></div>
        <span class="sb-num">{{ hud.hp }}</span>
      </div>
      <div class="sb-row">
        <span class="sb-label">体力</span>
        <div class="sb-track st"><div class="sb-fill st" :style="{ width: (hud.stamina / hud.maxStamina) * 100 + '%' }"></div></div>
        <span class="sb-num">{{ hud.stamina }}</span>
      </div>
    </div>
    <!-- 伤害 / 飘字 -->
    <div class="floats">
      <div v-for="f in floats" :key="f.id" class="float" :class="f.kind" :style="{ left: f.sx + '%', top: f.sy + '%' }">{{ f.text }}</div>
    </div>
    <!-- 全屏闪光：受击红 / 完美格挡金 -->
    <div class="flash hurt" :class="{ on: hurtFlash }"></div>
    <div class="flash parry" :class="{ on: parryFlash }"></div>
    <!-- 眩晕遮罩 -->
    <div v-if="locked && hud && hud.stunnedFor > 0" class="stun-overlay">
      <div class="stun-text">眩晕 {{ hud.stunnedFor.toFixed(1) }}s</div>
    </div>
    <EmergencyBanner />
    <Leaderboard :players="roster" />
    <DisplayNameModal v-if="needName" @confirm="confirmName" />
    <DeathOverlay
      v-if="dead"
      :can-respawn="canRespawn"
      @respawn="pbClient.sendMpAction({ kind: 'respawn' })"
    />
    <BuffPickModal
      v-if="pick.active"
      :options="pick.options"
      :done="pick.done"
      @choose="choosePick"
    />
    <MockCommandPanel />
    <DevicePanel />
    <StatusBar />
    <div v-if="viewMode === 'fixed'" class="hint">拖拽旋转视角 · <b>左键点击</b>门 / 电视 / 空调 / 水杯交互 · 按 <b>V</b> 进入第一人称漫游</div>
    <div v-else-if="!flying" class="hint">点击画面锁定鼠标 · <b>WASD</b> 移动 · <b>双击 W</b> 疾跑 · <b>Shift</b> 闪避 · <b>空格</b>跳 · <b>双击空格</b>起飞 · <b>左键</b>挥剑攻击 / 交互 · <b>按住右键</b>格挡 · 开门有惊喜 · <b>ESC</b> 释放鼠标 · 按 <b>V</b> 返回固定视角</div>
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
.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.crosshair .dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.8);
  transform: translate(-50%, -50%);
}
.crosshair .tick {
  position: absolute;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
}
.crosshair .tick.t { width: 1.5px; height: 6px; transform: translate(-50%, -13px); }
.crosshair .tick.b { width: 1.5px; height: 6px; transform: translate(-50%, 7px); }
.crosshair .tick.l { width: 6px; height: 1.5px; transform: translate(-13px, -50%); }
.crosshair .tick.r { width: 6px; height: 1.5px; transform: translate(7px, -50%); }
.charge-ring {
  position: absolute;
  left: 50%; top: 50%;
  width: 64px; height: 64px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  filter: drop-shadow(0 0 4px rgba(63, 216, 208, 0.7));
}

/* ---------------- 僵尸攻击预警星 ---------------- */
.attack-alert {
  position: absolute;
  top: calc(50% - 66px);
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  filter: drop-shadow(0 0 6px rgba(255, 200, 80, 0.9));
  animation: alertStar 1.1s cubic-bezier(0.2, 0.9, 0.3, 1) infinite;
}
/* 从一个点放大成四角星 → 继续放大并渐隐 → 循环 */
@keyframes alertStar {
  0% { opacity: 0; transform: translateX(-50%) scale(0.06); }
  38% { opacity: 1; transform: translateX(-50%) scale(1); }
  75% { opacity: 1; transform: translateX(-50%) scale(1.7); }
  100% { opacity: 0; transform: translateX(-50%) scale(2.3); }
}
/* 预警配色：金=普攻 / 白=横扫（不可格挡）/ 紫=突进 */
.attack-alert path {
  fill: #ffd76a;
  stroke: #b8791a;
}
.attack-alert.sweep path {
  fill: #ffffff;
  stroke: #9a9a9a;
  filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.8));
}
.attack-alert.lunge path {
  fill: #c084fc;
  stroke: #6b21a8;
}

/* ---------------- 格挡指示 ---------------- */
.block-meter {
  position: absolute;
  top: calc(50% + 16px);
  left: 50%;
  transform: translateX(-50%);
  width: 46px;
  height: 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.55);
  overflow: hidden;
  pointer-events: none;
}
.block-fill {
  height: 100%;
  border-radius: 2px;
}
.block-fill.gold { background: linear-gradient(90deg, #ffd76a, #ffb02e); box-shadow: 0 0 6px rgba(255, 200, 80, 0.8); }
.block-fill.plain { background: rgba(255, 255, 255, 0.85); }
.block-fill.gray { background: rgba(150, 160, 175, 0.6); }
.chase-tag {
  position: absolute;
  top: calc(50% + 26px);
  left: 50%;
  transform: translateX(-50%);
  color: #ffd76a;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}

/* ---------------- 僵尸目标条 ---------------- */
.zb-vuln {
  margin-top: 3px;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #ffd76a;
  text-shadow: 0 0 6px rgba(255, 180, 60, 0.8), 0 1px 2px rgba(0, 0, 0, 0.8);
  animation: vulnPulse 0.8s ease-in-out infinite alternate;
}
@keyframes vulnPulse {
  from { opacity: 0.75; }
  to { opacity: 1; }
}

.zombie-bar {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  width: 240px;
  pointer-events: none;
}
.zb-name {
  text-align: center;
  color: #a8e6a0;
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  margin-bottom: 3px;
}
.zb-track {
  height: 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.25);
  overflow: hidden;
  margin-bottom: 3px;
}
.zb-fill {
  height: 100%;
  transition: width 0.15s;
}
.zb-fill.hp { background: linear-gradient(90deg, #7ec850, #4f8f3f); }
.zb-fill.st { height: 5px; background: linear-gradient(90deg, #63c7e8, #3a8fb5); }
.zb-track.st { height: 5px; }

/* ---------------- 玩家血条 / 体力条 ---------------- */
.self-bars {
  position: absolute;
  bottom: 52px;
  left: 50%;
  transform: translateX(-50%);
  width: 260px;
  pointer-events: none;
}
.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.sb-label {
  width: 30px;
  text-align: right;
  color: rgba(219, 231, 244, 0.85);
  font-size: 11px;
  font-weight: 600;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}
.sb-track {
  flex: 1;
  height: 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.25);
  overflow: hidden;
}
.sb-fill {
  height: 100%;
  transition: width 0.15s;
}
.sb-fill.hp { background: linear-gradient(90deg, #ff6a5e, #d43a2e); }
.sb-fill.st { background: linear-gradient(90deg, #ffe082, #ffb02e); }
.sb-num {
  width: 32px;
  color: rgba(219, 231, 244, 0.9);
  font-size: 11px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}

/* ---------------- 飘字 ---------------- */
.floats {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.float {
  position: absolute;
  transform: translate(-50%, -50%);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
  animation: floatUp 0.9s ease-out forwards;
}
.float.crit {
  color: #ffd76a;
  font-size: 20px;
}
.float.heal {
  color: #52e07c;
}
.float.blocked {
  color: #9aa7b5;
  font-size: 13px;
}
@keyframes floatUp {
  0% { opacity: 0; margin-top: 0; }
  15% { opacity: 1; }
  100% { opacity: 0; margin-top: -46px; }
}

/* ---------------- 全屏闪光 ---------------- */
.flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.flash.hurt {
  background: radial-gradient(ellipse at center, transparent 45%, rgba(200, 20, 10, 0.45) 100%);
}
.flash.parry {
  background: radial-gradient(ellipse at center, rgba(255, 220, 130, 0.25) 0%, transparent 60%);
}
.flash.on { opacity: 1; }

/* ---------------- 眩晕遮罩 ---------------- */
.stun-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(30, 10, 10, 0.25) 0%, rgba(60, 5, 5, 0.55) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.stun-text {
  color: #ff9a8a;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 6px;
  text-shadow: 0 0 12px rgba(0, 0, 0, 0.9);
  animation: stunPulse 0.9s ease-in-out infinite;
}
@keyframes stunPulse {
  0%, 100% { opacity: 0.75; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
</style>
