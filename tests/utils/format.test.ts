/**
 * format 测试：纯展示格式化函数。
 *
 * 重点关注：
 * - formatDuration / formatDurationZh 各时间单位的边界值
 * - formatFileSize 各单位的转换与舍入
 * - formatSecondsShort 子秒精度（始终保留 1 位小数）
 * - formatNumber / formatTokens 紧凑格式
 * - formatRelativeTime 正/负差值
 */
import { describe, expect, test } from 'bun:test'
import {
  formatDuration,
  formatDurationZh,
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  formatRelativeTimeAgo,
  formatSecondsShort,
  formatTokens,
} from '../../src/utils/format.js'

describe('format', () => {
  describe('formatDuration（英文）', () => {
    test('0ms → "0s"', () => {
      expect(formatDuration(0)).toBe('0s')
    })

    test('小于 1ms 才显示小数', () => {
      // 0.5ms: 代码中 ms < 1 分支 (ms / 1000).toFixed(1) = "0.0s"
      expect(formatDuration(0.5)).toBe('0.0s')
    })

    test('1ms → "0s"（Math.floor 截断）', () => {
      expect(formatDuration(1)).toBe('0s')
    })

    test('999ms → "0s"（Math.floor 截断）', () => {
      expect(formatDuration(999)).toBe('0s')
    })

    test('1000ms → "1s"', () => {
      expect(formatDuration(1000)).toBe('1s')
    })

    test('30s → "30s"', () => {
      expect(formatDuration(30000)).toBe('30s')
    })

    test('59s → "59s"', () => {
      expect(formatDuration(59000)).toBe('59s')
    })

    test('59500ms (59.5s) → "59s"', () => {
      // 59.5s 因 Math.floor 截断为 59s
      expect(formatDuration(59500)).toBe('59s')
    })

    test('60s → "1m 0s"', () => {
      expect(formatDuration(60000)).toBe('1m 0s')
    })

    test('90s → "1m 30s"', () => {
      expect(formatDuration(90000)).toBe('1m 30s')
    })

    test('1h 0m 0s → "1h 0m 0s"', () => {
      expect(formatDuration(3600000)).toBe('1h 0m 0s')
    })

    test('1h 30m 0s → "1h 30m 0s"', () => {
      expect(formatDuration(5400000)).toBe('1h 30m 0s')
    })

    test('1d 0h 0m → "1d 0h 0m"', () => {
      expect(formatDuration(86400000)).toBe('1d 0h 0m')
    })

    test('hideTrailingZeros：1h → "1h"', () => {
      expect(formatDuration(3600000, { hideTrailingZeros: true })).toBe('1h')
    })

    test('hideTrailingZeros：90m → "1h 30m"（秒被隐藏）', () => {
      expect(formatDuration(5400000, { hideTrailingZeros: true })).toBe('1h 30m')
    })

    test('mostSignificantOnly：2d 3h → "2d"', () => {
      expect(formatDuration(183600000, { mostSignificantOnly: true })).toBe('2d')
    })

    test('mostSignificantOnly：30m → "30m"', () => {
      expect(formatDuration(1800000, { mostSignificantOnly: true })).toBe('30m')
    })
  })

  describe('formatDurationZh（中文）', () => {
    test('0ms → "0 秒"', () => {
      expect(formatDurationZh(0)).toBe('0 秒')
    })

    test('小于 1ms 才显示小数', () => {
      expect(formatDurationZh(0.5)).toBe('0.0 秒')
    })

    test('1ms → "0 秒"', () => {
      expect(formatDurationZh(1)).toBe('0 秒')
    })

    test('30s → "30 秒"', () => {
      expect(formatDurationZh(30000)).toBe('30 秒')
    })

    test('90s → "1 分 30 秒"', () => {
      expect(formatDurationZh(90000)).toBe('1 分 30 秒')
    })

    test('1h → "1 小时 0 分 0 秒"', () => {
      expect(formatDurationZh(3600000)).toBe('1 小时 0 分 0 秒')
    })

    test('hideTrailingZeros：1h → "1 小时"', () => {
      expect(formatDurationZh(3600000, { hideTrailingZeros: true })).toBe('1 小时')
    })

    test('mostSignificantOnly：2d 3h → "2 天"', () => {
      expect(formatDurationZh(183600000, { mostSignificantOnly: true })).toBe('2 天')
    })
  })

  describe('formatSecondsShort', () => {
    test('1234ms → "1.2s"', () => {
      expect(formatSecondsShort(1234)).toBe('1.2s')
    })

    test('500ms → "0.5s"', () => {
      expect(formatSecondsShort(500)).toBe('0.5s')
    })

    test('0ms → "0.0s"', () => {
      expect(formatSecondsShort(0)).toBe('0.0s')
    })
  })

  describe('formatFileSize', () => {
    test('0 bytes → "0 bytes"', () => {
      expect(formatFileSize(0)).toBe('0 bytes')
    })

    test('500 bytes → "500 bytes"', () => {
      expect(formatFileSize(500)).toBe('500 bytes')
    })

    test('1024 bytes → "1KB"', () => {
      expect(formatFileSize(1024)).toBe('1KB')
    })

    test('1536 bytes → "1.5KB"', () => {
      expect(formatFileSize(1536)).toBe('1.5KB')
    })

    test('1MB → "1MB"', () => {
      expect(formatFileSize(1048576)).toBe('1MB')
    })

    test('1.5MB → "1.5MB"', () => {
      expect(formatFileSize(1572864)).toBe('1.5MB')
    })

    test('1GB → "1GB"', () => {
      expect(formatFileSize(1073741824)).toBe('1GB')
    })

    test('2.5GB → "2.5GB"', () => {
      expect(formatFileSize(2684354560)).toBe('2.5GB')
    })
  })

  describe('formatNumber', () => {
    test('0 → "0"', () => {
      expect(formatNumber(0)).toBe('0')
    })

    test('999 → "999"', () => {
      expect(formatNumber(999)).toBe('999')
    })

    test('1000 → "1.0k"', () => {
      expect(formatNumber(1000)).toBe('1.0k')
    })

    test('1500 → "1.5k"', () => {
      expect(formatNumber(1500)).toBe('1.5k')
    })

    test('1_000_000 → "1.0m"', () => {
      expect(formatNumber(1000000)).toBe('1.0m')
    })
  })

  describe('formatTokens', () => {
    test('0 → "0"', () => {
      expect(formatTokens(0)).toBe('0')
    })

    test('1000 → "1k"（移除 .0）', () => {
      expect(formatTokens(1000)).toBe('1k')
    })

    test('1500 → "1.5k"', () => {
      expect(formatTokens(1500)).toBe('1.5k')
    })
  })

  describe('formatRelativeTime', () => {
    const now = new Date('2025-01-15T12:00:00Z')

    test('30 秒前 → "30s ago"', () => {
      const d = new Date(now.getTime() - 30000)
      expect(formatRelativeTime(d, { now })).toBe('30s ago')
    })

    test('5 分钟前 → "5m ago"', () => {
      const d = new Date(now.getTime() - 300000)
      expect(formatRelativeTime(d, { now })).toBe('5m ago')
    })

    test('2 小时后 → "in 2h"', () => {
      const d = new Date(now.getTime() + 7200000)
      expect(formatRelativeTime(d, { now })).toBe('in 2h')
    })

    test('刚好现在 → "0s ago"', () => {
      expect(formatRelativeTime(now, { now })).toBe('0s ago')
    })
  })

  describe('formatRelativeTimeAgo', () => {
    const now = new Date('2025-01-15T12:00:00Z')

    test('过去时间 → "X units ago"', () => {
      const d = new Date(now.getTime() - 60000)
      expect(formatRelativeTimeAgo(d, { now })).toBe('1m ago')
    })

    test('未来时间 → 不带 ago', () => {
      const d = new Date(now.getTime() + 60000)
      expect(formatRelativeTimeAgo(d, { now })).toBe('in 1m')
    })
  })

  describe('formatRelativeTime（长样式）', () => {
    const now = new Date('2025-01-15T12:00:00Z')

    test('long style：30 秒前 → "30 seconds ago"', () => {
      const d = new Date(now.getTime() - 30000)
      const result = formatRelativeTime(d, { now, style: 'long' })
      expect(result).toMatch(/30 seconds? ago/)
    })

    test('小于 1s 且 style 非 narrow → format(0, second)', () => {
      const d = now // exactly now
      const result = formatRelativeTime(d, { now, style: 'long' })
      expect(typeof result).toBe('string')
    })
  })

  describe('formatDuration 进位', () => {
    test('119999ms (59.999s → 进位 → 2m 0s)', () => {
      expect(formatDuration(119999)).toBe('2m 0s')
    })

    test('3599999ms (59m 59.999s → 二级进位 → 1h 0m 0s)', () => {
      expect(formatDuration(3599999)).toBe('1h 0m 0s')
    })

    test('86399999ms (23h 59m 59.999s → 三级进位 → 1d 0h 0m)', () => {
      expect(formatDuration(86399999)).toBe('1d 0h 0m')
    })
  })

  describe('formatDuration mostSignificantOnly', () => {
    test('59s → "59s"', () => {
      expect(formatDuration(59000, { mostSignificantOnly: true })).toBe('59s')
    })

    test('60s → "1m"', () => {
      expect(formatDuration(60000, { mostSignificantOnly: true })).toBe('1m')
    })

    test('1h 1m → "1h"', () => {
      expect(formatDuration(3660000, { mostSignificantOnly: true })).toBe('1h')
    })

    test('1d 2h → "1d"', () => {
      expect(formatDuration(93600000, { mostSignificantOnly: true })).toBe('1d')
    })
  })

  describe('formatDuration hideTrailingZeros', () => {
    test('1h 0m 0s → "1h"', () => {
      expect(formatDuration(3600000, { hideTrailingZeros: true })).toBe('1h')
    })

    test('1h 30m 0s → "1h 30m"', () => {
      expect(formatDuration(5400000, { hideTrailingZeros: true })).toBe('1h 30m')
    })

    test('30m 0s → "30m"', () => {
      expect(formatDuration(1800000, { hideTrailingZeros: true })).toBe('30m')
    })
  })

  describe('formatDurationZh 进位', () => {
    test('119999ms → "2 分 0 秒"', () => {
      expect(formatDurationZh(119999)).toBe('2 分 0 秒')
    })

    test('3599999ms → "1 小时 0 分 0 秒"', () => {
      expect(formatDurationZh(3599999)).toBe('1 小时 0 分 0 秒')
    })

    test('86399999ms → "1 天 0 小时 0 分"', () => {
      expect(formatDurationZh(86399999)).toBe('1 天 0 小时 0 分')
    })
  })

  describe('formatDurationZh mostSignificantOnly', () => {
    test('30m → "30 分"', () => {
      expect(formatDurationZh(1800000, { mostSignificantOnly: true })).toBe('30 分')
    })

    test('1h → "1 小时"', () => {
      expect(formatDurationZh(3600000, { mostSignificantOnly: true })).toBe('1 小时')
    })

    test('1d → "1 天"', () => {
      expect(formatDurationZh(86400000, { mostSignificantOnly: true })).toBe('1 天')
    })
  })

  describe('formatDurationZh hideTrailingZeros', () => {
    test('1 天 0 小时 0 分 → "1 天"', () => {
      expect(formatDurationZh(86400000, { hideTrailingZeros: true })).toBe('1 天')
    })

    test('1 天 2 小时 0 分 → "1 天 2 小时"', () => {
      expect(formatDurationZh(93600000, { hideTrailingZeros: true })).toBe('1 天 2 小时')
    })
  })
})
