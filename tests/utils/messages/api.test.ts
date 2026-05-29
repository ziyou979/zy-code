/**
 * normalizeMessagesForAPI 行为测试 — 核心行为验证。
 *
 * api.ts 有 2661 行和极重的依赖链，本测试仅 mock 最小必要模块，
 * 聚焦于类型系统重构会影响的核心行为。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---- 最小 Mock：仅阻断 analytics 副作用 ----
function setupMocks() {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (key: string) => `[i18n:${key}]`,
    t: (key: string) => `[i18n:${key}]`,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
  mock.module('../../../src/services/analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: (_k: string, def: unknown) => def,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
    checkGate_CACHED_OR_BLOCKING: async () => false,
    checkSecurityRestrictionGate: async () => false,
    hasGrowthBookEnvOverride: () => false,
    getAllGrowthBookFeatures: () => ({}),
    getGrowthBookConfigOverrides: () => ({}),
    setGrowthBookConfigOverride: () => {},
    clearGrowthBookConfigOverrides: () => {},
    getApiBaseUrlHost: () => undefined,
    initializeGrowthBook: async () => null,
    getFeatureValue_DEPRECATED: async (_f: string, def: unknown) => def,
    refreshGrowthBookAfterAuthChange: () => {},
    resetGrowthBook: () => {},
    refreshGrowthBookFeatures: async () => {},
    setupPeriodicGrowthBookRefresh: () => {},
    stopPeriodicGrowthBookRefresh: () => {},
    getDynamicConfig_BLOCKS_ON_INIT: async () => null,
    getDynamicConfig_CACHED_MAY_BE_STALE: () => null,
    onGrowthBookRefresh: () => () => {},
  }))
  mock.module('../../../src/services/analytics/index.js', () => ({
    logEvent: () => {},
  }))
  mock.module('../../../src/services/analytics/metadata.js', () => ({
    sanitizeToolNameForAnalytics: (s: string) => s,
  }))
}

// ---- 辅助构造函数 ----

let counter = 0
function makeUserMsg(content: string | unknown[], opts: Record<string, unknown> = {}) {
  counter++
  return {
    type: 'user' as const,
    uuid: opts.uuid || `user-uuid-${String(counter).padStart(4, '0')}`,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user' as const, content },
    ...opts,
  }
}

function makeAssistantMsg(content: unknown[], opts: Record<string, unknown> = {}) {
  counter++
  return {
    type: 'assistant' as const,
    uuid: opts.uuid || `asst-uuid-${String(counter).padStart(4, '0')}`,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant' as const,
      content,
      id: opts.messageId || `msg-${String(counter).padStart(3, '0')}`,
      model: opts.model || 'test-model',
      stopReason: 'end_turn',
      context_management: null,
    },
    requestId: undefined,
    isApiErrorMessage: opts.isApiErrorMessage || false,
    ...opts,
  }
}

function makeProgressMsg() {
  return {
    type: 'progress' as const,
    uuid: 'prog-001',
    timestamp: '2024-01-01T00:00:00.000Z',
    data: { type: 'status' },
    toolUseID: 'tu-1',
    parentToolUseID: '',
  }
}

describe('normalizeMessagesForAPI — 核心行为', () => {
  beforeEach(() => {
    counter = 0
    setupMocks()
  })
  afterEach(() => mock.restore())

  test('过滤 progress 消息', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('hello'),
      makeProgressMsg(),
      makeAssistantMsg([{ type: 'text', text: 'reply' }]),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    expect(result.find((m: any) => m.type === 'progress')).toBeUndefined()
  })

  test('过滤 virtual 消息', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('real'),
      makeUserMsg('virtual', { isVirtual: true }),
      makeAssistantMsg([{ type: 'text', text: 'reply' }]),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    const userMsgs = result.filter((m: any) => m.type === 'user')
    const hasVirtual = userMsgs.some((m: any) => {
      const content = m.message.content
      if (typeof content === 'string') return content.includes('virtual')
      return Array.isArray(content) && content.some((b: any) => b.text?.includes('virtual'))
    })
    expect(hasVirtual).toBe(false)
  })

  test('合并连续 user 消息', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('first'),
      makeUserMsg('second'),
      makeAssistantMsg([{ type: 'text', text: 'reply' }]),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    const userMsgs = result.filter((m: any) => m.type === 'user')
    expect(userMsgs).toHaveLength(1)
  })

  test('过滤非 local_command 的 system 消息', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('prompt'),
      {
        type: 'system' as const,
        subtype: 'informational' as const,
        content: 'info msg',
        level: 'info',
        uuid: 'sys-001',
        timestamp: '2024-01-01T00:00:00.000Z',
        isMeta: false,
      },
      makeAssistantMsg([{ type: 'text', text: 'reply' }]),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    expect(result.find((m: any) => m.type === 'system')).toBeUndefined()
  })

  test('同 message.id 的 assistant 消息合并', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('prompt'),
      makeAssistantMsg([{ type: 'text', text: 'part 1' }], { messageId: 'same-id' }),
      makeUserMsg([{ type: 'tool_result', toolCallId: 'tc-1', content: 'result' }]),
      makeAssistantMsg([{ type: 'text', text: 'part 2' }], { messageId: 'same-id' }),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    const asstMsgs = result.filter((m: any) => m.type === 'assistant')
    expect(asstMsgs).toHaveLength(1)
    expect(asstMsgs[0].message.content).toHaveLength(2)
  })

  test('输入空数组 → 输出空数组', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const result = normalizeMessagesForAPI([])
    expect(result).toEqual([])
  })

  test('结果中 user 和 assistant 交替', async () => {
    const { normalizeMessagesForAPI } = await import('../../../src/utils/messages/api.js')
    const messages = [
      makeUserMsg('a'),
      makeUserMsg('b'),
      makeAssistantMsg([{ type: 'text', text: 'r1' }]),
      makeUserMsg('c'),
    ]
    const result = normalizeMessagesForAPI(messages as any)

    // 连续 user 合并后，应该只有 user, assistant, user 交替
    const types = result.map((m: any) => m.type)
    for (let i = 1; i < types.length; i++) {
      expect(types[i]).not.toBe(types[i - 1])
    }
  })
})
