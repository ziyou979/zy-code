import { useEffect, useRef, useState } from 'react'
import { getLastInteractionTime } from 'src/bootstrap/runtime/runtimeContext.js'
import { fetchPrStatus, type PrReviewState } from '../services/github/ghPrStatus.js'

const POLL_INTERVAL_MS = 60_000
const SLOW_GH_THRESHOLD_MS = 4_000
const IDLE_STOP_MS = 60 * 60_000 // 空闲 60 分钟后停止轮询

export type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  lastUpdated: number
}

const INITIAL_STATE: PrStatusState = {
  number: null,
  url: null,
  reviewState: null,
  lastUpdated: 0,
}

/**
 * 会话活跃期间每 60 秒轮询一次 PR 审查状态。
 * 连续 60 分钟没有交互时停止循环，不留下定时器。isLoading 在轮次开始或结束时
 * 发生变化，React 会重新运行 effect 并恢复循环。effect 以最近一次获取时间为基准
 * 安排下次轮询，避免轮次边界在同一间隔内多次启动 `gh`。单次获取超过 4 秒后永久停用。
 *
 * 传入 `enabled: false` 可完全跳过轮询，但仍须无条件调用此 hook，以遵守 hooks 规则。
 */
export function usePrStatus(isLoading: boolean, enabled = true): PrStatusState {
  const [prStatus, setPrStatus] = useState<PrStatusState>(INITIAL_STATE)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disabledRef = useRef(false)
  const lastFetchRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (disabledRef.current) {
      return
    }

    let cancelled = false
    let lastSeenInteractionTime = -1
    let lastActivityTimestamp = Date.now()

    async function poll() {
      if (cancelled) {
        return
      }

      const currentInteractionTime = getLastInteractionTime()
      if (lastSeenInteractionTime !== currentInteractionTime) {
        lastSeenInteractionTime = currentInteractionTime
        lastActivityTimestamp = Date.now()
      } else if (Date.now() - lastActivityTimestamp >= IDLE_STOP_MS) {
        return
      }

      const start = Date.now()
      const result = await fetchPrStatus()
      if (cancelled) {
        return
      }
      lastFetchRef.current = start

      setPrStatus((prev) => {
        const newNumber = result?.number ?? null
        const newReviewState = result?.reviewState ?? null
        if (prev.number === newNumber && prev.reviewState === newReviewState) {
          return prev
        }
        return {
          number: newNumber,
          url: result?.url ?? null,
          reviewState: newReviewState,
          lastUpdated: Date.now(),
        }
      })

      if (Date.now() - start > SLOW_GH_THRESHOLD_MS) {
        disabledRef.current = true
        return
      }

      if (!cancelled) {
        timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    const elapsed = Date.now() - lastFetchRef.current
    if (elapsed >= POLL_INTERVAL_MS) {
      void poll()
    } else {
      timeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS - elapsed)
    }

    return () => {
      cancelled = true
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [enabled, isLoading])

  return prStatus
}
