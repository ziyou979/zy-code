import { describe, expect, it } from 'bun:test'
import { wrapWithOsc8Link, createHyperlink } from '../../src/utils/hyperlink.js'

describe('wrapWithOsc8Link - 纯序列构造（空参数 ;; 形式）', () => {
  it('包装文本为 OSC 8 超链接', () => {
    expect(wrapWithOsc8Link('click me', 'https://example.com')).toBe(
      '\x1b]8;;https://example.com\x07click me\x1b]8;;\x07',
    )
  })

  it('空 url 仍输出完整序列（不崩溃）', () => {
    expect(wrapWithOsc8Link('text', '')).toBe('\x1b]8;;\x07text\x1b]8;;\x07')
  })
})

describe('createHyperlink - 能力检测与回退', () => {
  it('支持时包装 content', () => {
    const result = createHyperlink('https://example.com', 'click me', {
      supportsHyperlinks: true,
    })
    expect(result).toBe('\x1b]8;;https://example.com\x07click me\x1b]8;;\x07')
  })

  it('不支持时回退为 content（不输出转义序列）', () => {
    const result = createHyperlink('https://example.com', 'click me', {
      supportsHyperlinks: false,
    })
    expect(result).toBe('click me')
  })

  it('content 缺省时显示 url', () => {
    const result = createHyperlink('https://example.com', undefined, {
      supportsHyperlinks: true,
    })
    expect(result).toBe('\x1b]8;;https://example.com\x07https://example.com\x1b]8;;\x07')
  })

  it('不支持且 content 缺省时回退为 url', () => {
    const result = createHyperlink('https://example.com', undefined, {
      supportsHyperlinks: false,
    })
    expect(result).toBe('https://example.com')
  })
})

describe('与 terminal-ui/hyperlink.ts 的差异', () => {
  it('本实现不应用颜色（区别于带 chalk.blue 的 UI 版）', () => {
    const result = createHyperlink('https://example.com', 'click me', {
      supportsHyperlinks: true,
    })
    expect(result).not.toContain('\x1b[') // 除 OSC 8 序列外无 ANSI 颜色码
  })
})
