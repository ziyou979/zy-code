import { describe, expect, it, vi } from 'bun:test'
import { retryWithBackoffLoop } from '../../src/services/http/retryLoop.js'
import {
  formatTimestamp,
  formatLocalISODate,
  formatFileTimestamp,
  formatTimestamp12h,
} from '../../src/utils/formatTimestamp.js'
import { padVisual, truncateToWidth } from '../../src/utils/truncate.js'

describe('retryWithBackoffLoop - 重试骨架', () => {
  it('首次成功立即返回，不重试', async () => {
    const fetchOnce = vi.fn().mockResolvedValue({ success: true })
    const onRetry = vi.fn()
    const result = await retryWithBackoffLoop({ maxRetries: 3, fetchOnce, onRetry })
    expect(result).toEqual({ success: true })
    expect(fetchOnce).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('skipRetry 立即返回，不重试', async () => {
    const fetchOnce = vi.fn().mockResolvedValue({ success: false, skipRetry: true })
    const result = await retryWithBackoffLoop({ maxRetries: 3, fetchOnce })
    expect(result).toEqual({ success: false, skipRetry: true })
    expect(fetchOnce).toHaveBeenCalledTimes(1)
  })

  it('耗尽重试次数后返回最后一个结果（fail-open）', async () => {
    const fetchOnce = vi.fn().mockResolvedValue({ success: false })
    const result = await retryWithBackoffLoop({ maxRetries: 2, fetchOnce })
    expect(result).toEqual({ success: false })
    // 总尝试 = maxRetries + 1
    expect(fetchOnce).toHaveBeenCalledTimes(3)
  })

  it('每次重试前调用 onRetry', async () => {
    const fetchOnce = vi
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true })
    const onRetry = vi.fn()
    const result = await retryWithBackoffLoop({ maxRetries: 3, fetchOnce, onRetry })
    expect(result).toEqual({ success: true })
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number))
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Number))
  })
})

describe('formatTimestamp - 时间戳格式化', () => {
  // 固定本地时间：2026-09-01 14:05:09（用本地 Date 构造保证时区无关）
  const date = new Date(2026, 8, 1, 14, 5, 9)

  it('formatTimestamp 输出 HH:mm:ss', () => {
    expect(formatTimestamp(date)).toBe('14:05:09')
  })

  it('formatLocalISODate 输出 YYYY-MM-DD', () => {
    expect(formatLocalISODate(date)).toBe('2026-09-01')
  })

  it('formatFileTimestamp 输出文件名安全的 YYYY-MM-DD-HHmmss', () => {
    expect(formatFileTimestamp(date)).toBe('2026-09-01-140509')
  })

  it('formatTimestamp12h 输出 h:mm:ssam/pm', () => {
    expect(formatTimestamp12h(date)).toBe('2:05:09pm')
    expect(formatTimestamp12h(new Date(2026, 8, 1, 0, 30, 0))).toBe('12:30:00am')
    expect(formatTimestamp12h(new Date(2026, 8, 1, 12, 0, 0))).toBe('12:00:00pm')
  })
})

describe('padVisual - 宽度填充', () => {
  it('左对齐（默认）：右侧补空格', () => {
    expect(padVisual('ab', 2, 5)).toBe('ab   ')
  })

  it('右对齐：左侧补空格', () => {
    expect(padVisual('ab', 2, 5, 'right')).toBe('   ab')
  })

  it('居中：左右分配（奇数余数归右）', () => {
    expect(padVisual('ab', 2, 5, 'center')).toBe(' ab  ')
  })

  it('超宽时不填充（不产生负宽空格）', () => {
    expect(padVisual('abcdef', 6, 3)).toBe('abcdef')
  })

  it('truncateToWidth 按 grapheme 迭代（ZWJ emoji 不拆断）', () => {
    // 👨‍👩‍👧 是多 codepoint 组成的单一 grapheme
    const emoji = '👨‍👩‍👧'
    const result = truncateToWidth(`hi ${emoji}`, 4)
    expect(result.endsWith('…')).toBe(true)
    // 结果中 emoji 要么完整保留，要么完全不出现
    expect(result.includes(emoji) || !result.slice(0, -1).includes(emoji.slice(0, 2))).toBe(true)
  })
})
