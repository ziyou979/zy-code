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

  test('serverToolUse 为零', () => {
    expect(EMPTY_USAGE.serverToolUse.webSearchRequests).toBe(0)
    expect(EMPTY_USAGE.serverToolUse.webFetchRequests).toBe(0)
  })

  test('cacheCreation 为零', () => {
    expect(EMPTY_USAGE.cacheCreation.ephemeral1hInputTokens).toBe(0)
    expect(EMPTY_USAGE.cacheCreation.ephemeral5mInputTokens).toBe(0)
  })

  test('serviceTier 为 standard', () => {
    expect(EMPTY_USAGE.serviceTier).toBe('standard')
  })

  test('speed 为 standard', () => {
    expect(EMPTY_USAGE.speed).toBe('standard')
  })

  test('inferenceGeo 为空字符串', () => {
    expect(EMPTY_USAGE.inferenceGeo).toBe('')
  })

  test('cacheDeletedInputTokens 为零', () => {
    expect(EMPTY_USAGE.cacheDeletedInputTokens).toBe(0)
  })

  test('iterations 为空数组', () => {
    expect(EMPTY_USAGE.iterations).toEqual([])
  })
})
