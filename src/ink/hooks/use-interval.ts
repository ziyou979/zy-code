import { useContext, useEffect, useRef, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'

/**
 * 返回时钟时间，以给定间隔更新。
 * 订阅为非 keepAlive 模式——不会单独保持时钟活跃，
 * 但当有 keepAlive 订阅者（如 spinner）驱动时钟时会更新。
 *
 * 用于从共享时钟驱动纯时间相关的计算（闪烁位置、帧索引）。
 */
export function useAnimationTimer(intervalMs: number): number {
  const clock = useContext(ClockContext)
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  useEffect(() => {
    if (!clock) {
      return
    }

    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now
        setTime(now)
      }
    }

    return clock.subscribe(onChange, false)
  }, [clock, intervalMs])

  return time
}

/**
 * 基于共享 Clock 的 interval hook。
 *
 * 与 `usehooks-ts` 的 `useInterval`（创建自己的 setInterval）不同，
 * 这个 hook 依赖单个共享时钟，所有定时器合并为一次唤醒。
 * 传入 `null` 作为 intervalMs 可暂停。
 */
export function useInterval(callback: () => void, intervalMs: number | null): void {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  const clock = useContext(ClockContext)

  useEffect(() => {
    if (!clock || intervalMs === null) {
      return
    }

    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now
        callbackRef.current()
      }
    }

    return clock.subscribe(onChange, false)
  }, [clock, intervalMs])
}
