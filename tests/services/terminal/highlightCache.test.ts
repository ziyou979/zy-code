import { describe, expect, test } from 'bun:test'
import { cachedHighlight } from '../../../src/services/terminal/highlightCache.js'
import type { CliHighlight } from '../../../src/services/terminal/cliHighlight.js'

describe('cachedHighlight', () => {
  test('命中缓存避免重算，按输出体积淘汰且保留最近访问项', () => {
    let calls = 0
    const hl: CliHighlight = {
      supportsLanguage: () => true,
      highlight: (code) => {
        calls++
        return code + 'x'.repeat(100000)
      },
    }
    cachedHighlight(hl, 'budget-first', 'ts')
    cachedHighlight(hl, 'budget-first', 'ts')
    expect(calls).toBe(1)
    for (let i = 0; i < 60; i++) cachedHighlight(hl, `budget-${i}`, 'ts')
    const previous = calls
    cachedHighlight(hl, 'budget-59', 'ts')
    expect(calls).toBe(previous)
    cachedHighlight(hl, 'budget-first', 'ts')
    expect(calls).toBe(previous + 1)
  })
  test('超大高亮结果原样返回但不进入缓存', () => {
    let calls = 0
    const output = 'x'.repeat(300000)
    const hl: CliHighlight = {
      supportsLanguage: () => true,
      highlight: () => {
        calls++
        return output
      },
    }
    expect(cachedHighlight(hl, 'oversized-result', 'ts')).toBe(output)
    expect(cachedHighlight(hl, 'oversized-result', 'ts')).toBe(output)
    expect(calls).toBe(2)
  })
})
