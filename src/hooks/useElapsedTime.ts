import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../ink/components/ClockContext.js'
import { getLocalizedDurationFormatter } from '../utils/format.js'

/**
 * Hook that returns formatted elapsed time since startTime.
 * 使用共享的 ClockContext 驱动更新，避免每个调用者创建独立的 setInterval，
 * 从而防止 Ink 帧周期内多个零散 setState 导致的渲染重叠（帧覆盖）问题。
 *
 * 所有 useElapsedTime 实例在同一个 clock tick 中批量 setState，
 * Ink reconciler 只需一次渲染即可完成全部更新。
 *
 * @param startTime - Unix timestamp in ms
 * @param isRunning - Whether to actively update the timer
 * @param ms - 保留作为接口兼容（当前不使用，精度由 ClockContext 决定）
 * @param pausedMs - Total paused duration to subtract
 * @param endTime - If set, freezes the duration at this timestamp (for
 *   terminal tasks). Without this, viewing a 2-min task 30 min after
 *   completion would show "32m".
 * @returns Formatted duration string (e.g., "1m 23s")
 */
export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  _ms: number = 1000,
  pausedMs: number = 0,
  endTime?: number,
): string {
  const clock = useContext(ClockContext)
  const fmt = getLocalizedDurationFormatter()
  const [elapsed, setElapsed] = useState(() =>
    fmt(Math.max(0, (endTime ?? Date.now()) - startTime - pausedMs)),
  )

  useEffect(() => {
    if (!isRunning || !clock) {
      // 不运行时，直接计算一次静态值
      setElapsed(fmt(Math.max(0, (endTime ?? Date.now()) - startTime - pausedMs)))
      return
    }

    // 订阅共享时钟（keepAlive: true）——确保即使 spinner 动画暂停（如 reducedMotion
    // 或 leaderIsIdle），时钟仍继续滴答，elapsedTime 能正常更新。
    // 所有 useElapsedTime 实例在同一个 tick 中批量 setState，
    // 避免独立 setInterval 导致的 Ink 帧竞争和渲染重叠。
    const onChange = (): void => {
      const now = clock.absoluteNow()
      setElapsed(fmt(Math.max(0, (endTime ?? now) - startTime - pausedMs)))
    }

    return clock.subscribe(onChange, true)
  }, [isRunning, startTime, pausedMs, endTime, clock, fmt])

  return elapsed
}
