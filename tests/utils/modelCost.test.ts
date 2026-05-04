/**
 * modelCost 测试：费用计算函数。
 *
 * calculateCostFromTokens 是纯计算函数（内部拼 Usage 对象后委托 calculateUSDCost）。
 * getCurrencySymbol 依赖 i18n，用 mock 测试多语言分支。
 */
import { describe, test, expect } from 'bun:test'

describe('modelCost', () => {
  describe('calculateCostFromTokens', () => {
    test('零用量 → 0', () => {
      const { calculateCostFromTokens } = require('../../src/utils/modelCost.js')
      const result = calculateCostFromTokens('gpt-4', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })
      expect(result).toBe(0)
    })

    test('非零用量 → 返回数值', () => {
      const { calculateCostFromTokens } = require('../../src/utils/modelCost.js')
      const result = calculateCostFromTokens('gpt-4', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
      })
      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getCurrencySymbol', () => {
    test('zh-CN → ￥', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../src/i18n/index.js', () => ({
        getUiLanguage: () => 'zh-CN',
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('￥')
      mock.restore()
    })

    test('en → $', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../src/i18n/index.js', () => ({
        getUiLanguage: () => 'en',
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('$')
      mock.restore()
    })

    test('其他语言 → $', async () => {
      const { mock } = await import('bun:test')
      mock.module('../../src/i18n/index.js', () => ({
        getUiLanguage: () => 'ja',
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('$')
      mock.restore()
    })
  })
})
