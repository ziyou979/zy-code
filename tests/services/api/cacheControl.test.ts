/**
 * getPromptCachingEnabled 测试：隐式缓存检查。
 *
 * 核心逻辑：当模型的 prompt_caching 模式为 "implicit" 时，
 * 不需要客户端发送 cache_control 标记，应返回 false。
 *
 * prompt_caching 模式优先级：
 * 1. DISABLE_PROMPT_CACHING 环境变量（最高优先级）→ false
 * 2. prompt_caching: "implicit" → false（无需客户端标记）
 * 3. prompt_caching: "explicit" / 未配置 → 默认行为（true）
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'

// 使用 beforeAll 预先导入真实模块，再设置 mock 覆盖个别导出。
// 避免 async factory 在 mock.module 内的无限递归问题。
let mockCachingMode: 'implicit' | 'explicit' | undefined = undefined

beforeAll(async () => {
  const real = await import('../../../src/utils/settings/localModelCapabilities.js')
  mock.module('../../../src/utils/settings/localModelCapabilities.js', () => ({
    ...real,
    getModelPromptCachingMode: () => mockCachingMode,
  }))
})

// 在 mock 注册后导入被测模块
import { getPromptCachingEnabled } from '../../../src/services/api/cacheControl.js'

describe('getPromptCachingEnabled', () => {
  test('prompt_caching 为 implicit 时返回 false', () => {
    mockCachingMode = 'implicit'
    expect(getPromptCachingEnabled('test-model')).toBe(false)
  })

  test('prompt_caching 为 explicit 时返回 true', () => {
    mockCachingMode = 'explicit'
    expect(getPromptCachingEnabled('test-model')).toBe(true)
  })

  test('无 prompt_caching 配置时返回 true', () => {
    mockCachingMode = undefined
    expect(getPromptCachingEnabled('test-model')).toBe(true)
  })

  test('DISABLE_PROMPT_CACHING 环境变量优先于所有模型配置', () => {
    process.env.DISABLE_PROMPT_CACHING = 'true'
    mockCachingMode = 'implicit'

    expect(getPromptCachingEnabled('test-model')).toBe(false)

    delete process.env.DISABLE_PROMPT_CACHING
  })
})
