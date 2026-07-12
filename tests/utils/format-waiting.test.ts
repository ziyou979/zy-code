import { describe, expect, test } from 'bun:test'
import { formatWaitingDuration } from '../../src/utils/format.js'

describe('formatWaitingDuration', () => {
  const t0 = 1_000_000_000_000

  test('秒级', () => {
    expect(formatWaitingDuration(t0, t0 + 45_000)).toBe('waiting 45s')
  })

  test('分钟级（CC waiting 3m 风格）', () => {
    expect(formatWaitingDuration(t0, t0 + 3 * 60_000)).toBe('waiting 3m')
  })

  test('小时级', () => {
    expect(formatWaitingDuration(t0, t0 + 2 * 3600_000)).toBe('waiting 2h')
  })
})
