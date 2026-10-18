/**
 * 极简补间（tween）系统
 *
 * 设备状态过渡动画统一由 requestAnimationFrame 循环驱动：
 * 记录起始值 / 目标值 / 耗时，按缓动函数插值；同一 key 的新补间直接覆盖旧的。
 */
export type EaseFn = (t: number) => number

/** 缓入缓出（三次曲线） */
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

/** 线性 */
export const linear = (t: number): number => t

export interface Tween {
  from: number
  to: number
  /** 时长（秒），<=0 时直接落到目标值 */
  duration: number
  elapsed: number
  ease: EaseFn
  onUpdate: (value: number) => void
}

export class TweenSystem {
  private map = new Map<string, Tween>()

  /**
   * 启动一个补间；若同 key 存在进行中的补间，其 onUpdate 不再被调用（被覆盖）。
   * @param key    通道标识，如 'light.intensity'、'curtain.position'
   * @param from   起始值（一般取当前显示值，避免跳变）
   * @param to     目标值
   * @param duration 时长（秒）
   */
  start(
    key: string,
    from: number,
    to: number,
    duration: number,
    onUpdate: (value: number) => void,
    ease: EaseFn = easeInOut,
  ): void {
    if (duration <= 0) {
      this.map.delete(key)
      onUpdate(to)
      return
    }
    this.map.set(key, { from, to, duration, elapsed: 0, ease, onUpdate })
  }

  /** 每帧推进，dt 为秒 */
  update(dt: number): void {
    for (const [key, tween] of this.map) {
      tween.elapsed += dt
      const k = Math.min(1, tween.elapsed / tween.duration)
      tween.onUpdate(tween.from + (tween.to - tween.from) * tween.ease(k))
      if (k >= 1) this.map.delete(key)
    }
  }

  dispose(): void {
    this.map.clear()
  }
}
