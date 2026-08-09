import { describe, expect, test } from 'bun:test'
import {
  MAX_RAPID_REFILLS,
  RAPID_REFILL_TURNS,
  type AutoCompactTrackingState,
} from '../../../src/services/compact/autoCompact.js'

/**
 * 纯逻辑复刻 autoCompactIfNeeded 内 rapid 计数，避免 mock 整段 compact/LLM。
 * 与 autoCompact.ts 保持同步：改阈值时两处同测。
 */
function nextRapidRefillState(tracking: AutoCompactTrackingState | undefined): {
  trip: boolean
  nextRapidCount: number
} {
  if (tracking?.rapidRefillBreakerTripped) {
    return { trip: true, nextRapidCount: tracking.consecutiveRapidRefills ?? MAX_RAPID_REFILLS }
  }
  const isRapidRefill =
    tracking?.compacted === true &&
    (tracking.turnCounter ?? Number.POSITIVE_INFINITY) <= RAPID_REFILL_TURNS
  const nextRapidCount = isRapidRefill ? (tracking.consecutiveRapidRefills ?? 0) + 1 : 0
  return { trip: nextRapidCount >= MAX_RAPID_REFILLS, nextRapidCount }
}

describe('rapid refill breaker logic', () => {
  test('首次 compact 后短轮次触发计 1，未熔断', () => {
    const tracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: 't1',
      turnCounter: 1,
      consecutiveRapidRefills: 0,
    }
    const r = nextRapidRefillState(tracking)
    expect(r.trip).toBe(false)
    expect(r.nextRapidCount).toBe(1)
  })

  test(`连续 ${MAX_RAPID_REFILLS} 次 rapid 熔断`, () => {
    const tracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: 't3',
      turnCounter: RAPID_REFILL_TURNS,
      consecutiveRapidRefills: MAX_RAPID_REFILLS - 1,
    }
    const r = nextRapidRefillState(tracking)
    expect(r.trip).toBe(true)
    expect(r.nextRapidCount).toBe(MAX_RAPID_REFILLS)
  })

  test('turnCounter 超过 RAPID_REFILL_TURNS 不算 rapid，计数归零', () => {
    const tracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: 't9',
      turnCounter: RAPID_REFILL_TURNS + 1,
      consecutiveRapidRefills: 2,
    }
    const r = nextRapidRefillState(tracking)
    expect(r.trip).toBe(false)
    expect(r.nextRapidCount).toBe(0)
  })

  test('已熔断状态持续 trip', () => {
    const tracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: 'x',
      turnCounter: 0,
      rapidRefillBreakerTripped: true,
      consecutiveRapidRefills: MAX_RAPID_REFILLS,
    }
    expect(nextRapidRefillState(tracking).trip).toBe(true)
  })

  test('notified 标志不影响 trip，仅供 runCompaction 去重文案', () => {
    const tracking: AutoCompactTrackingState = {
      compacted: true,
      turnId: 'x',
      turnCounter: 0,
      rapidRefillBreakerTripped: true,
      rapidRefillBreakerNotified: true,
      consecutiveRapidRefills: MAX_RAPID_REFILLS,
    }
    expect(nextRapidRefillState(tracking).trip).toBe(true)
  })
})
