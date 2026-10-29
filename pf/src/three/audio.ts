/**
 * 简易战斗音效：静态导入音频资源（Vite 打包），每次播放新建 Audio 实例，
 * 允许快速连击时重叠播放。资源位于 src/assets/audio/。
 */
import swingUrl from '../assets/audio/swing.mp3'
import perfectParryUrl from '../assets/audio/perfect-parry.wav'
import unexactParryUrl from '../assets/audio/unexact-parry.wav'
import swordParryUrl from '../assets/audio/sword-parry.ogg'
import counterUrl from '../assets/audio/counter-attack.wav'
import counter2Url from '../assets/audio/counter-attack-2.wav'
import dashUrl from '../assets/audio/dash.wav'
import flashAlertUrl from '../assets/audio/flash-alert.wav'
import kickUrl from '../assets/audio/kick.wav'
import sweepUrl from '../assets/audio/sweep.wav'
import lungeUrl from '../assets/audio/lunge.wav'
import roarUrl from '../assets/audio/roar.mp3'

export type SfxName =
  | 'swing'          // 三段普通攻击挥砍
  | 'perfectParry'   // 完美格挡
  | 'unexactParry'   // 不完美格挡
  | 'swordParry'     // 格挡令僵尸体力耗尽
  | 'counter'        // 反击戳刺
  | 'counter2'       // 追击
  | 'dash'           // 闪避
  | 'flashAlert'     // 僵尸攻击前摇预警（时长即前摇时长）
  | 'kick'           // 玩家受伤
  | 'sweep'          // 僵尸横扫（时长即前摇时长）
  | 'lunge'          // 僵尸突进蓄力（时长即前摇时长）
  | 'roar'           // 僵尸嘶吼（时长即前摇时长）
  | 'orbShot'        // 苍弓射球状闪电（WebAudio 合成）
  | 'beamBurst'      // 苍弓蓄满爆发（WebAudio 合成）

const URLS: Partial<Record<SfxName, string>> = {
  swing: swingUrl,
  perfectParry: perfectParryUrl,
  unexactParry: unexactParryUrl,
  swordParry: swordParryUrl,
  counter: counterUrl,
  counter2: counter2Url,
  dash: dashUrl,
  flashAlert: flashAlertUrl,
  kick: kickUrl,
  sweep: sweepUrl,
  lunge: lungeUrl,
  roar: roarUrl,
}

// ---------------- 时长预量取（用于前摇与音效对齐） ----------------

const durations = new Map<SfxName, number>()

// 探测需要与攻击前摇对齐的音效时长：loadedmetadata 后缓存，
// 前摇按该时长判定，保证「声音结束 → 伤害结算」精确同步。
// 元数据未就绪时回退调用方默认值。
for (const [name, url] of [
  ['flashAlert', flashAlertUrl],
  ['sweep', sweepUrl],
  ['lunge', lungeUrl],
  ['roar', roarUrl],
] as const) {
  const probe = new Audio(url)
  probe.addEventListener('loadedmetadata', () => durations.set(name, probe.duration), { once: true })
  probe.load()
}

export function getSfxDuration(name: SfxName): number | undefined {
  return durations.get(name)
}

export function playSfx(name: SfxName, volume = 0.6) {
  if (name === 'orbShot') return synthOrbShot(volume)
  if (name === 'beamBurst') return synthBeamBurst(volume)
  const url = URLS[name]
  if (!url) return
  const audio = new Audio(url)
  audio.volume = volume
  void audio.play().catch(() => {
    // 自动播放策略拦截时静默忽略（用户已有点击手势，正常不会发生）
  })
}

// ---------------- WebAudio 合成音效（苍弓电系，无静态资源依赖） ----------------

let ac: AudioContext | null = null

function audioCtx(): AudioContext | null {
  try {
    if (!ac) ac = new AudioContext()
    if (ac.state === 'suspended') void ac.resume()
    return ac
  } catch {
    return null // 无 AudioContext 环境（极端沙箱）静默降级
  }
}

/** 射球：方波 920→180 Hz 下扫（电弧「咻」）+ 短促 gain 包络 */
function synthOrbShot(volume: number) {
  const c = audioCtx()
  if (!c) return
  const t = c.currentTime
  const o = c.createOscillator()
  o.type = 'square'
  o.frequency.setValueAtTime(920, t)
  o.frequency.exponentialRampToValueAtTime(180, t + 0.16)
  const g = c.createGain()
  g.gain.setValueAtTime(Math.max(0.001, volume * 0.35), t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  o.connect(g).connect(c.destination)
  o.start(t)
  o.stop(t + 0.2)
}

/** 蓄满爆发：锯齿低频轰 130→40 Hz + 高频嘶声衰减（能量释放感） */
function synthBeamBurst(volume: number) {
  const c = audioCtx()
  if (!c) return
  const t = c.currentTime
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(130, t)
  o.frequency.exponentialRampToValueAtTime(40, t + 0.32)
  const g = c.createGain()
  g.gain.setValueAtTime(Math.max(0.001, volume * 0.5), t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.36)
  o.connect(g).connect(c.destination)
  o.start(t)
  o.stop(t + 0.38)
  // 高频嘶声层（爆发亮部）
  const h = c.createOscillator()
  h.type = 'sawtooth'
  h.frequency.setValueAtTime(1400, t)
  h.frequency.exponentialRampToValueAtTime(240, t + 0.22)
  const hg = c.createGain()
  hg.gain.setValueAtTime(Math.max(0.001, volume * 0.16), t)
  hg.gain.exponentialRampToValueAtTime(0.001, t + 0.24)
  h.connect(hg).connect(c.destination)
  h.start(t)
  h.stop(t + 0.26)
}

/** 持续激光循环音（蓄力期间开启 / 停止）：锯齿 72Hz + LFO 颤振 */
let beamLoop: { osc: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode; gain: GainNode } | null = null

export function setBeamLoop(on: boolean, volume = 0.22) {
  const c = audioCtx()
  if (!c) return
  if (on && !beamLoop) {
    const t = c.currentTime
    const osc = c.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 72
    const lfo = c.createOscillator()
    lfo.frequency.value = 11
    const lfoGain = c.createGain()
    lfoGain.gain.value = 14 // 频率颤振深度 Hz
    lfo.connect(lfoGain).connect(osc.frequency)
    const gain = c.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume * 0.4), t + 0.08)
    osc.connect(gain).connect(c.destination)
    osc.start(t)
    lfo.start(t)
    beamLoop = { osc, lfo, lfoGain, gain }
  } else if (!on && beamLoop) {
    const { osc, lfo, gain } = beamLoop
    beamLoop = null
    const t = c.currentTime
    gain.gain.cancelScheduledValues(t)
    gain.gain.setValueAtTime(Math.max(0.001, gain.gain.value), t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
    osc.stop(t + 0.12)
    lfo.stop(t + 0.12)
  }
}
