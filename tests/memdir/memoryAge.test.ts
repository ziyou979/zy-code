import { afterEach, describe, expect, test } from 'bun:test'
import { memoryAge, memoryAgeDays } from '../../src/memdir/memoryAge.js'

const originalDateNow = Date.now

afterEach(() => {
  Date.now = originalDateNow
})

describe('memoryAge', () => {
  test('跨过本地午夜后立即视为昨天', () => {
    const now = new Date(2026, 7, 12, 0, 5)
    const mtime = new Date(2026, 7, 11, 23, 55)
    Date.now = () => now.getTime()

    expect(memoryAgeDays(mtime.getTime())).toBe(1)
    expect(memoryAge(mtime.getTime())).toBe('yesterday')
  })

  test('同一日内即使接近二十四小时仍视为今天', () => {
    const now = new Date(2026, 7, 12, 23, 55)
    const mtime = new Date(2026, 7, 12, 0, 5)
    Date.now = () => now.getTime()

    expect(memoryAgeDays(mtime.getTime())).toBe(0)
    expect(memoryAge(mtime.getTime())).toBe('today')
  })
})
