/**
 * modelCost 测试：费用计算函数。
 *
 * calculateCostFromTokens 是纯计算函数（内部拼 Usage 对象后委托 calculateCost）。
 * calculateCost 验证缓存 token 从顶层字段正确读取并参与计费。
 * getCurrencySymbol 根据当前主模型的货币单位返回符号。
 * getModelCurrency 返回模型的货币单位。
 * getCurrencySymbolFor 根据货币类型返回符号。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

describe('modelCost', () => {
  beforeEach(() => {
    mock.module('../../src/services/model/modelCapabilities.js', () => ({
      getStaticPricingForModel: () => ({
        cost_input: 30,
        cost_output: 60,
        cost_cache_write: 37.5,
        cost_cache_read: 1.5,
        cost_web_search: 10,
        currency: 'CNY',
      }),
      getModelCapability: () => undefined,
    }))
  })

  afterEach(() => {
    mock.restore()
  })

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

  describe('calculateCost — TokenUsage 顶层缓存字段', () => {
    test('顶层 cacheReadInputTokens 被正确扣除和计费', () => {
      const { calculateCost } = require('../../src/utils/modelCost.js')
      // 模拟 NonNullableUsage 风格的传入（缓存字段在顶层）
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 800_000,
        cacheCreationInputTokens: 0,
      }
      const cost = calculateCost('gpt-4', usage)
      // 费用应该 > 0（确认不再返回 0）
      expect(cost).toBeGreaterThan(0)

      // 对比全部按普通输入计费的情况
      const costAllPlainInput = calculateCost('gpt-4', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })
      // 缓存命中让费用显著降低
      expect(cost).toBeLessThan(costAllPlainInput)
    })

    test('顶层 cacheCreationInputTokens 被正确扣除和计费', () => {
      const { calculateCost } = require('../../src/utils/modelCost.js')
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 500_000,
      }
      const cost = calculateCost('gpt-4', usage)
      expect(cost).toBeGreaterThan(0)
    })

    test('缓存字段缺失时不报错，视为 0', () => {
      const { calculateCost } = require('../../src/utils/modelCost.js')
      // 不传缓存字段 — 不应 crash
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
      }
      const cost = calculateCost('gpt-4', usage)
      expect(typeof cost).toBe('number')
      expect(cost).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getModelCurrency', () => {
    test('配置 currency: CNY 时返回 CNY', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => ({
          cost_input: 1,
          cost_output: 2,
          cost_cache_write: 0,
          cost_cache_read: 0,
          cost_web_search: 0,
          currency: 'CNY',
        }),
      }))
      const { getModelCurrency } = await import('../../src/utils/modelCost.js')
      expect(getModelCurrency('test-model')).toBe('CNY')
    })

    test('配置 currency: USD 时返回 USD', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => ({
          cost_input: 1,
          cost_output: 2,
          cost_cache_write: 0,
          cost_cache_read: 0,
          cost_web_search: 0,
          currency: 'USD',
        }),
      }))
      const { getModelCurrency } = await import('../../src/utils/modelCost.js')
      expect(getModelCurrency('test-model')).toBe('USD')
    })

    test('无定价配置时默认 CNY', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => null,
      }))
      mock.module('../../src/services/model/model.js', () => ({
        getDefaultMainLoopModelSetting: () => null,
      }))
      const { getModelCurrency } = await import('../../src/utils/modelCost.js')
      expect(getModelCurrency('unknown-model')).toBe('CNY')
    })
  })

  describe('getCurrencySymbolFor', () => {
    test('CNY → ¥', async () => {
      const { getCurrencySymbolFor } = await import('../../src/utils/modelCost.js')
      expect(getCurrencySymbolFor('CNY')).toBe('¥')
    })

    test('USD → $', async () => {
      const { getCurrencySymbolFor } = await import('../../src/utils/modelCost.js')
      expect(getCurrencySymbolFor('USD')).toBe('$')
    })
  })

  describe('getCurrencySymbol — 根据模型货币', () => {
    test('当前模型 currency 为 USD 时返回 $', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => ({
          cost_input: 1,
          cost_output: 2,
          cost_cache_write: 0,
          cost_cache_read: 0,
          cost_web_search: 0,
          currency: 'USD',
        }),
      }))
      mock.module('../../src/services/model/model.js', () => ({
        getDefaultMainLoopModelSetting: () => 'gpt-4o',
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('$')
    })

    test('当前模型 currency 为 CNY 时返回 ¥', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => ({
          cost_input: 1,
          cost_output: 2,
          cost_cache_write: 0,
          cost_cache_read: 0,
          cost_web_search: 0,
          currency: 'CNY',
        }),
      }))
      mock.module('../../src/services/model/model.js', () => ({
        getDefaultMainLoopModelSetting: () => 'qwen3.6-max',
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('¥')
    })

    test('无模型配置时默认返回 ¥', async () => {
      mock.module('../../src/services/model/modelCapabilities.js', () => ({
        getStaticPricingForModel: () => null,
      }))
      mock.module('../../src/services/model/model.js', () => ({
        getDefaultMainLoopModelSetting: () => null,
      }))
      const { getCurrencySymbol: fn } = await import('../../src/utils/modelCost.js')
      expect(fn()).toBe('¥')
    })
  })
})
