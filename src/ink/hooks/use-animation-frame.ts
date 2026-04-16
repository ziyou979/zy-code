import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

/**
 * 用于同步动画的 Hook，离屏时暂停。
 *
 * 返回一个附加到动画元素的 ref 和当前动画时间。
 * 所有实例共享同一个时钟，因此动画保持同步。
 * 只有当至少有一个 keepAlive 订阅者时时钟才会运行。
 *
 * 传入 `null` 暂停——取消订阅时钟，不再触发滴答。
 * 时间冻结在最后的值，再次传入数字时从当前时钟时间恢复。
 *
 * @param intervalMs - 更新间隔，或 null 暂停
 * @returns [ref, time] - 附加到元素的 ref，经过的时间（ms）
 *
 * @example
 * function Spinner() {
 *   const [ref, time] = useAnimationFrame(120)
 *   const frame = Math.floor(time / 120) % FRAMES.length
 *   return <Box ref={ref}>{FRAMES[frame]}</Box>
 * }
 *
 * 终端失焦时时钟会自动减速，因此调用者无需处理焦点状态。
 */
export function useAnimationFrame(
  intervalMs: number | null = 16,
): [ref: (element: DOMElement | null) => void, time: number] {
  const clock = useContext(ClockContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  const active = isVisible && intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return

    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      if (now - lastUpdate >= intervalMs!) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive: true —— 可见的动画驱动时钟
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active])

  return [viewportRef, time]
}
