/**
 * 压缩真实阶段进度
 */
import { describe, expect, test } from 'bun:test'
import {
  advanceStagePercent,
  buildCompactProgressMessage,
  COMPACT_STAGE_PCT,
  compactApiStreamPercent,
  formatCompactPercentHint,
} from '../../../src/services/compact/compactProgress.js'

describe('COMPACT_STAGE_PCT', () => {
  test('阶段锚点单调递增', () => {
    const order = [
      COMPACT_STAGE_PCT.pre_hooks,
      COMPACT_STAGE_PCT.start,
      COMPACT_STAGE_PCT.api_start,
      COMPACT_STAGE_PCT.api_soft_cap,
      COMPACT_STAGE_PCT.attachments,
      COMPACT_STAGE_PCT.session_start,
      COMPACT_STAGE_PCT.post_hooks,
      COMPACT_STAGE_PCT.done,
    ]
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!).toBeGreaterThan(order[i - 1]!)
    }
    expect(COMPACT_STAGE_PCT.done).toBe(100)
  })
})

describe('compactApiStreamPercent', () => {
  test('0 字符 = api_start', () => {
    expect(compactApiStreamPercent(0)).toBe(COMPACT_STAGE_PCT.api_start)
  })

  test('随字符数在 api_start…api_soft_cap 内推进', () => {
    const mid = compactApiStreamPercent(1000)
    const high = compactApiStreamPercent(4000)
    expect(mid).toBeGreaterThan(COMPACT_STAGE_PCT.api_start)
    expect(mid).toBeLessThan(high)
    expect(high).toBe(COMPACT_STAGE_PCT.api_soft_cap)
  })

  test('超量输出不突破 soft_cap', () => {
    expect(compactApiStreamPercent(100_000)).toBe(COMPACT_STAGE_PCT.api_soft_cap)
  })
})

describe('advanceStagePercent', () => {
  test('只增不减', () => {
    expect(advanceStagePercent(50, 40)).toBe(50)
    expect(advanceStagePercent(50, 70)).toBe(70)
  })

  test('钳制 0–100', () => {
    expect(advanceStagePercent(0, 150)).toBe(100)
    expect(advanceStagePercent(0, -5)).toBe(0)
  })
})

describe('formatCompactPercentHint', () => {
  test('渲染 ▰▱ 进度条 + 整数百分比', () => {
    const hint = formatCompactPercentHint(28)
    expect(hint).toContain('28%')
    expect(hint).toContain('▰')
    expect(hint).toContain('▱')
    expect(hint.startsWith('▰'.repeat(6) + '▱'.repeat(14))).toBe(true)
  })

  test('0% 全空、100% 全满', () => {
    expect(formatCompactPercentHint(0)).toBe(`${'▱'.repeat(20)} 0%`)
    expect(formatCompactPercentHint(100)).toBe(`${'▰'.repeat(20)} 100%`)
  })
})

describe('buildCompactProgressMessage', () => {
  test('优先使用 hintText', () => {
    const msg = buildCompactProgressMessage({ hintText: 'custom-hint', pct: 10 })
    expect(msg).toContain('custom-hint')
    expect(msg).not.toContain('10%')
  })

  test('带 stage 时含进度条、百分比与阶段标签', () => {
    const msg = buildCompactProgressMessage({ pct: 42, stage: 'api' })
    expect(msg).toContain('42%')
    expect(msg).toContain('▰')
    expect(msg.includes('\n')).toBe(false)
    // 阶段标签（中/英任一种 i18n）
    expect(msg.length).toBeGreaterThan('Compacting'.length)
  })

  test('post_hooks 阶段已超过 90%，compact_end 可直接卸条', () => {
    expect(COMPACT_STAGE_PCT.post_hooks).toBeGreaterThanOrEqual(90)
  })
})
