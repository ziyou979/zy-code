/**
 * wirePollingPolicy 特性测试。
 *
 * 纯退避策略函数。
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BACKOFF,
  pollSleepDetectionThresholdMs,
  SPAWN_SESSIONS_DEFAULT,
  STATUS_UPDATE_INTERVAL_MS,
} from '../../../src/bridge/bridge-main/wirePollingPolicy.js'

describe('常量和默认值', () => {
  test('STATUS_UPDATE_INTERVAL_MS 为 1000', () => {
    expect(STATUS_UPDATE_INTERVAL_MS).toBe(1000)
  })

  test('SPAWN_SESSIONS_DEFAULT 为 32', () => {
    expect(SPAWN_SESSIONS_DEFAULT).toBe(32)
  })

  test('DEFAULT_BACKOFF 包含预期的连接参数', () => {
    expect(DEFAULT_BACKOFF.connInitialMs).toBeGreaterThan(0)
    expect(DEFAULT_BACKOFF.connCapMs).toBeGreaterThan(DEFAULT_BACKOFF.connInitialMs)
    expect(DEFAULT_BACKOFF.connGiveUpMs).toBeGreaterThan(DEFAULT_BACKOFF.connCapMs)
  })

  test('DEFAULT_BACKOFF 包含预期的通用参数', () => {
    expect(DEFAULT_BACKOFF.generalInitialMs).toBeGreaterThan(0)
    expect(DEFAULT_BACKOFF.generalCapMs).toBeGreaterThan(DEFAULT_BACKOFF.generalInitialMs)
    expect(DEFAULT_BACKOFF.generalGiveUpMs).toBeGreaterThan(DEFAULT_BACKOFF.generalCapMs)
  })
})

describe('pollSleepDetectionThresholdMs', () => {
  test('阈值 = connCapMs × 2', () => {
    const backoff = { connCapMs: 120_000 } as typeof DEFAULT_BACKOFF
    expect(pollSleepDetectionThresholdMs(backoff)).toBe(240_000)
  })

  test('不同 connCapMs 产生不同阈值', () => {
    const backoff = { connCapMs: 60_000 } as typeof DEFAULT_BACKOFF
    expect(pollSleepDetectionThresholdMs(backoff)).toBe(120_000)
  })

  test('使用 DEFAULT_BACKOFF 时阈值合理', () => {
    const threshold = pollSleepDetectionThresholdMs(DEFAULT_BACKOFF)
    expect(threshold).toBe(DEFAULT_BACKOFF.connCapMs * 2)
    expect(threshold).toBeGreaterThan(DEFAULT_BACKOFF.connCapMs)
  })
})
