import React, { createContext, useEffect, useState } from 'react'
import { FRAME_INTERVAL_MS } from '../constants.js'
import { useTerminalFocus } from '../hooks/useTerminalFocus.js'
export type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  /** 返回当前绝对 Unix 时间戳（ms），与 tick 同步。用于需要同步时间读取的场景（如 useElapsedTime）。 */
  absoluteNow: () => number
  setTickInterval: (ms: number) => void
}
export function createClock(tickIntervalMs: number): Clock {
  const subscribers = new Map<() => void, boolean>()
  let interval: ReturnType<typeof setInterval> | null = null
  let currentTickIntervalMs = tickIntervalMs
  let startTime = 0
  // 当前 tick 时间的快照，确保同一 tick 中的所有订阅者看到相同的值（保持动画同步）
  let tickTime = 0
  // 当前 tick 对应的绝对 Unix 时间戳快照
  let absoluteTickTime = 0
  function tick(): void {
    const now = Date.now()
    tickTime = now - startTime
    absoluteTickTime = now
    for (const onChange of subscribers.keys()) {
      onChange()
    }
  }
  function updateInterval(): void {
    const anyKeepAlive = [...subscribers.values()].some(Boolean)
    if (anyKeepAlive) {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
      if (startTime === 0) {
        startTime = Date.now()
      }
      interval = setInterval(tick, currentTickIntervalMs)
    } else if (interval) {
      clearInterval(interval)
      interval = null
    }
  }
  return {
    subscribe(onChange, keepAlive) {
      subscribers.set(onChange, keepAlive)
      updateInterval()
      return () => {
        subscribers.delete(onChange)
        updateInterval()
      }
    },
    now() {
      if (startTime === 0) {
        startTime = Date.now()
      }
      // 当时钟间隔运行时，返回同步的 tickTime，以便同一 tick 中的所有订阅者看到相同的值。
      // 暂停时（无 keepAlive 订阅者），返回实时值以避免返回暂停前的陈旧 tickTime。
      if (interval && tickTime) {
        return tickTime
      }
      return Date.now() - startTime
    },
    absoluteNow() {
      // 当时钟运行时，返回与 tick 同步的绝对时间戳；否则实时读取。
      if (interval && absoluteTickTime) {
        return absoluteTickTime
      }
      return Date.now()
    },
    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) {
        return
      }
      currentTickIntervalMs = ms
      updateInterval()
    },
  }
}
export const ClockContext = createContext<Clock | null>(null)
const BLURRED_TICK_INTERVAL_MS = FRAME_INTERVAL_MS * 2

// 独立组件，避免 App.tsx 在创建时钟时重新渲染。
// 时钟值是稳定的（通过 useState 只创建一次），因此 provider
// 本身不会导致消费者重新渲染。
export function ClockProvider({ children }: { children: React.ReactNode }) {
  const [clock] = useState(() => createClock(FRAME_INTERVAL_MS))
  const focused = useTerminalFocus()
  useEffect(() => {
    clock.setTickInterval(focused ? FRAME_INTERVAL_MS : BLURRED_TICK_INTERVAL_MS)
  }, [clock, focused])
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}
