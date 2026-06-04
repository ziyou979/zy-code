/**
 * emptyUsage 测试：零初始化使用量常量。
 *
 * 重点关注：
 * - EMPTY_USAGE 字段完整性
 * - 所有数值字段为 0
 * - 不可变（Readonly）
 */
import { describe, expect, test } from 'bun:test'
import { EMPTY_USAGE } from '../../../src/services/api/emptyUsage.js'

describe('EMPTY_USAGE', () => {
  test('所有数值字段为零', () => {
    expect(EMPTY_USAGE.inputTokens).toBe(0)
    expect(EMPTY_USAGE.outputTokens).toBe(0)
    expect(EMPTY_USAGE.cacheCreationInputTokens).toBe(0)
    expect(EMPTY_USAGE.cacheReadInputTokens).toBe(0)
  })

  test('server_tool_use 为零', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const usage = EMPTY_USAGE as any
    expect(usage.server_tool_use.web_search_requests).toBe(0)
    expect(usage.server_tool_use.web_fetch_requests).toBe(0)
  })

  test('cache_creation 为零', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const usage = EMPTY_USAGE as any
    expect(usage.cache_creation.ephemeral_1h_input_tokens).toBe(0)
    expect(usage.cache_creation.ephemeral_5m_input_tokens).toBe(0)
  })

  test('service_tier 为 standard', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((EMPTY_USAGE as any).service_tier).toBe('standard')
  })

  test('speed 为 standard', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((EMPTY_USAGE as any).speed).toBe('standard')
  })

  test('inference_geo 为空字符串', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((EMPTY_USAGE as any).inference_geo).toBe('')
  })

  test('iterations 为空数组', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((EMPTY_USAGE as any).iterations).toEqual([])
  })
})
