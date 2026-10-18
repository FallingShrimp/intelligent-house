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

const URLS: Record<SfxName, string> = {
  swing: swingUrl,
  perfectParry: perfectParryUrl,
  unexactParry: unexactParryUrl,
  swordParry: swordParryUrl,
  counter: counterUrl,
  counter2: counter2Url,
  dash: dashUrl,
  flashAlert: flashAlertUrl,
  kick: kickUrl,
}

// ---------------- 时长预量取（用于前摇与音效对齐） ----------------

const durations = new Map<SfxName, number>()

// 启动即探测 flash-alert 时长：loadedmetadata 后缓存，僵尸攻击前摇按该时长判定，
// 保证「声音结束 → 伤害结算」精确同步。元数据未就绪时回退调用方默认值。
const flashAlertProbe = new Audio(flashAlertUrl)
flashAlertProbe.addEventListener(
  'loadedmetadata',
  () => durations.set('flashAlert', flashAlertProbe.duration),
  { once: true },
)
flashAlertProbe.load()

export function getSfxDuration(name: SfxName): number | undefined {
  return durations.get(name)
}

export function playSfx(name: SfxName, volume = 0.6) {
  const audio = new Audio(URLS[name])
  audio.volume = volume
  void audio.play().catch(() => {
    // 自动播放策略拦截时静默忽略（用户已有点击手势，正常不会发生）
  })
}
