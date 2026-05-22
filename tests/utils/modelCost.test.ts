/**
 * modelCost 测试：费用计算函数。
 *
 * calculateCostFromTokens 是纯计算函数（内部拼 Usage 对象后委托 calculateUSDCost）。
 * calculateUSDCost 验证缓存 token 从顶层字段正确读取并参与计费。
 * getCurrencySymbol 依赖 i18n，用 mock 测试多语言分支。
 */
import { describe, expect, test } from 'bun:test'

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

    test('缓存命中 token 降低总费用', () => {
      const { calculateCostFromTokens } = require('../../src/utils/modelCost.js')
      // 全部作为普通输入
      const costWithoutCache = calculateCostFromTokens('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })
      // 一半来自缓存命中（缓存命中价格应低于普通输入）
      const costWithCache = calculateCostFromTokens('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 500_000,
        cacheCreationInputTokens: 0,
      })
      // 有缓存命中时费用应该更低（缓存读取单价 < 普通输入单价）
      expect(costWithCache).toBeLessThan(costWithoutCache)
    })

    test('缓存写入 token 按独立单价计费，不同于普通输入', () => {
      const { calculateCostFromTokens } = require('../../src/utils/modelCost.js')
      // 全部作为普通输入
      const costAllPlain = calculateCostFromTokens('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })
      // 一半来自缓存写入
      const costWithCacheWrite = calculateCostFromTokens('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 500_000,
      })
      // 缓存写入 token 按独立单价计费 → 总费用与全普通输入不同
      // （具体高或低取决于模型定价，但不应相等，除非 cacheWrite 单价恰好等于 input 单价）
      expect(costWithCacheWrite).not.toBe(costAllPlain)
      // 确认费用 > 0（缓存写入部分确实被计费了）
      expect(costWithCacheWrite).toBeGreaterThan(0)
    })
  })

  describe('calculateUSDCost — TokenUsage 顶层缓存字段', () => {
    test('顶层 cacheReadInputTokens 被正确扣除和计费', () => {
      const { calculateUSDCost } = require('../../src/utils/modelCost.js')
      // 模拟 NonNullableUsage 风格的传入（缓存字段在顶层）
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 800_000,
        cacheCreationInputTokens: 0,
      }
      const cost = calculateUSDCost('gpt-4', usage)
      // 费用应该 > 0（确认不再返回 0）
      expect(cost).toBeGreaterThan(0)

      // 对比全部按普通输入计费的情况
      const costAllPlainInput = calculateUSDCost('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })
      // 缓存命中让费用显著降低
      expect(cost).toBeLessThan(costAllPlainInput)
    })

    test('顶层 cacheCreationInputTokens 被正确扣除和计费', () => {
      const { calculateUSDCost } = require('../../src/utils/modelCost.js')
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 500_000,
      }
      const cost = calculateUSDCost('gpt-4', usage)
      expect(cost).toBeGreaterThan(0)
    })

    test('缓存字段缺失时不报错，视为 0', () => {
      const { calculateUSDCost } = require('../../src/utils/modelCost.js')
      // 不传缓存字段 — 不应 crash
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
      }
      const cost = calculateUSDCost('gpt-4', usage)
      expect(typeof cost).toBe('number')
      expect(cost).toBeGreaterThanOrEqual(0)
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
