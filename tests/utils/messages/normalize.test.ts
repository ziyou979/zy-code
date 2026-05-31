/**
 * normalizeMessages 行为测试 — 覆盖消息归一化、合并、过滤逻辑。
 *
 * 覆盖 src/utils/messages/normalize.ts 中的核心函数：
 * - normalizeMessages: string→block 转换、多 block 拆分、UUID 派生
 * - mergeUserMessages: 文本接缝处理
 * - mergeAssistantMessages: 内容块合并
 * - smooshIntoToolResult: 内容块折叠到 tool_result
 * - filter*: 空白/孤立 thinking/trailing thinking 过滤
 * - ensureNonEmptyAssistantContent: 空内容修复
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---- Mock 重依赖 ----
function setupMocks() {
  mock.module('../../../src/constants/messages.js', () => ({
    getNoContentMessage: () => '[no content]',
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
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (key: string) => `[i18n:${key}]`,
    t: (key: string) => `[i18n:${key}]`,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
}

// ---- 辅助构造函数 ----

function makeUserMsg(
  content: string | Array<Record<string, unknown>>,
  opts: Record<string, unknown> = {},
) {
  return {
    type: 'user' as const,
    uuid: opts.uuid || 'user-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user' as const, content },
    ...opts,
  }
}

function makeAssistantMsg(
  content: Array<Record<string, unknown>>,
  opts: Record<string, unknown> = {},
) {
  return {
    type: 'assistant' as const,
    uuid: opts.uuid || 'asst-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant' as const,
      content,
      id: opts.messageId || 'msg-001',
      model: 'test-model',
      stopReason: 'end_turn',
      context_management: null,
    },
    requestId: undefined,
    ...opts,
  }
}

describe('normalizeMessages', () => {
  beforeEach(setupMocks)
  afterEach(() => mock.restore())

  // ====================================================================
  // normalizeMessages 核心行为
  // ====================================================================
  describe('normalizeMessages — 用户消息', () => {
    test('string content → TextBlock 转换', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const msgs = [makeUserMsg('Hello world')]
      const result: any[] = normalizeMessages(msgs as any)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('user')
      const content = (result[0] as any).message.content
      expect(content).toEqual([{ type: 'text', text: 'Hello world' }])
    })

    test('单 block 用户消息 — 保持不拆分', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const blocks = [{ type: 'text', text: 'single block' }]
      const msgs = [makeUserMsg(blocks)]
      const result = normalizeMessages(msgs as any)

      expect(result).toHaveLength(1)
      expect((result[0] as any).message.content).toEqual(blocks)
      // UUID 不变（单 block 不触发 isNewChain）
      expect(result[0].uuid).toBe('user-uuid-0001')
    })

    test('多 block 用户消息 — 拆分为多条单 block 消息', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const blocks = [
        { type: 'text', text: 'block 1' },
        { type: 'text', text: 'block 2' },
        { type: 'text', text: 'block 3' },
      ]
      const msgs = [makeUserMsg(blocks)]
      const result = normalizeMessages(msgs as any)

      expect(result).toHaveLength(3)
      result.forEach((msg: any) => {
        expect(msg.type).toBe('user')
        expect(msg.message.content).toHaveLength(1)
      })
      expect((result[0] as any).message.content[0].text).toBe('block 1')
      expect((result[1] as any).message.content[0].text).toBe('block 2')
      expect((result[2] as any).message.content[0].text).toBe('block 3')
    })

    test('多 block 后所有后续消息 UUID 都派生', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const multiBlock = makeUserMsg([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ])
      const singleBlock = makeUserMsg([{ type: 'text', text: 'c' }], {
        uuid: 'user-uuid-0002',
      })
      const result = normalizeMessages([multiBlock, singleBlock] as any)

      expect(result).toHaveLength(3)
      // 第一条消息的两个 block 有不同 UUID
      expect(result[0].uuid).not.toBe(result[1].uuid)
      // isNewChain=true 后，后续单 block 消息也派生新 UUID
      expect(result[2].uuid).not.toBe('user-uuid-0002')
    })

    test('image block 的 imagePasteId 映射', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const blocks = [
        { type: 'image', mimeType: 'image/png', data: 'base64...' },
        { type: 'text', text: 'caption' },
      ]
      const msg = makeUserMsg(blocks, { imagePasteIds: [42] })
      const result = normalizeMessages([msg] as any)

      expect(result).toHaveLength(2)
      // image block 应该获得 imagePasteId
      expect((result[0] as any).imagePasteIds).toEqual([42])
      // text block 不应该有 imagePasteId
      expect((result[1] as any).imagePasteIds).toBeUndefined()
    })

    test('system/progress/attachment 消息透传', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const systemMsg = {
        type: 'system' as const,
        subtype: 'informational' as const,
        content: 'info',
        level: 'info' as const,
        uuid: 'sys-001',
        timestamp: '2024-01-01T00:00:00.000Z',
        isMeta: false,
      }
      const progressMsg = {
        type: 'progress' as const,
        uuid: 'prog-001',
        timestamp: '2024-01-01T00:00:00.000Z',
        data: { type: 'status' },
        toolUseID: 'tu-1',
        parentToolUseID: '',
      }
      const result: any[] = normalizeMessages([systemMsg, progressMsg] as any)

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('system')
      expect(result[1].type).toBe('progress')
    })
  })

  describe('normalizeMessages — 助手消息', () => {
    test('多 block 助手消息 — 拆分为多条单 block 消息', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const blocks = [
        { type: 'text', text: 'response' },
        { type: 'tool_call', id: 'tc-1', name: 'Bash', input: {} },
      ]
      const msgs = [makeAssistantMsg(blocks)]
      const result = normalizeMessages(msgs as any)

      expect(result).toHaveLength(2)
      expect((result[0] as any).message.content).toEqual([blocks[0]])
      expect((result[1] as any).message.content).toEqual([blocks[1]])
    })

    test('非数组 content → 空数组', async () => {
      const { normalizeMessages } = await import('../../../src/utils/messages/normalize.js')
      const msgs = [{ ...makeAssistantMsg([]), message: { role: 'assistant', content: 'string' } }]
      const result = normalizeMessages(msgs as any)

      expect(result).toHaveLength(0)
    })
  })

  // ====================================================================
  // mergeUserMessages
  // ====================================================================
  describe('mergeUserMessages', () => {
    test('两个 string 消息 — 接缝处加换行', async () => {
      const { mergeUserMessages } = await import('../../../src/utils/messages/normalize.js')
      const a = makeUserMsg('first') as any
      const b = makeUserMsg('second') as any
      const result = mergeUserMessages(a, b)

      const content = result.message.content as any[]
      expect(Array.isArray(content)).toBe(true)
      // 第一个文本块末尾应有 \n
      expect(content[0].text).toBe('first\n')
      expect(content[1].text).toBe('second')
    })

    test('保留非 meta 消息的 uuid', async () => {
      const { mergeUserMessages } = await import('../../../src/utils/messages/normalize.js')
      const a = makeUserMsg('a', { uuid: 'uuid-a' }) as any
      const b = makeUserMsg('b', { uuid: 'uuid-b' }) as any
      const result = mergeUserMessages(a, b)

      expect(result.uuid).toBe('uuid-a')
    })

    test('meta 消息使用后续 uuid', async () => {
      const { mergeUserMessages } = await import('../../../src/utils/messages/normalize.js')
      const a = makeUserMsg('a', { uuid: 'uuid-a', isMeta: true }) as any
      const b = makeUserMsg('b', { uuid: 'uuid-b' }) as any
      const result = mergeUserMessages(a, b)

      expect(result.uuid).toBe('uuid-b')
    })
  })

  // ====================================================================
  // mergeAssistantMessages
  // ====================================================================
  describe('mergeAssistantMessages', () => {
    test('合并两个助手消息的 content', async () => {
      const { mergeAssistantMessages } = await import('../../../src/utils/messages/normalize.js')
      const a = makeAssistantMsg([{ type: 'text', text: 'part 1' }]) as any
      const b = makeAssistantMsg([{ type: 'text', text: 'part 2' }]) as any
      const result = mergeAssistantMessages(a, b)

      expect(result.message.content).toHaveLength(2)
      expect((result.message.content[0] as any).text).toBe('part 1')
      expect((result.message.content[1] as any).text).toBe('part 2')
    })
  })

  // ====================================================================
  // isToolResultMessage
  // ====================================================================
  describe('isToolResultMessage', () => {
    test('包含 tool_result block 的 user 消息 → true', async () => {
      const { isToolResultMessage } = await import('../../../src/utils/messages/normalize.js')
      const msg = makeUserMsg([{ type: 'tool_result', toolCallId: 'tc-1', content: 'result' }])
      expect(isToolResultMessage(msg as any)).toBe(true)
    })

    test('string content → false', async () => {
      const { isToolResultMessage } = await import('../../../src/utils/messages/normalize.js')
      expect(isToolResultMessage(makeUserMsg('hello') as any)).toBe(false)
    })

    test('assistant 消息 → false', async () => {
      const { isToolResultMessage } = await import('../../../src/utils/messages/normalize.js')
      const msg = makeAssistantMsg([{ type: 'text', text: 'hi' }])
      expect(isToolResultMessage(msg as any)).toBe(false)
    })
  })

  // ====================================================================
  // smooshIntoToolResult
  // ====================================================================
  describe('smooshIntoToolResult', () => {
    test('空 blocks → 原样返回', async () => {
      const { smooshIntoToolResult } = await import('../../../src/utils/messages/normalize.js')
      const tr = { type: 'tool_result' as const, toolCallId: 'tc-1', content: 'existing' }
      const result = smooshIntoToolResult(tr, [])

      expect(result).toEqual(tr)
    })

    test('string content + 全 text blocks → 字符串拼接', async () => {
      const { smooshIntoToolResult } = await import('../../../src/utils/messages/normalize.js')
      const tr = { type: 'tool_result' as const, toolCallId: 'tc-1', content: 'existing' }
      const blocks = [{ type: 'text' as const, text: 'added' }]
      const result = smooshIntoToolResult(tr, blocks)

      expect(result!.content).toBe('existing\n\nadded')
    })

    test('isError tool_result 过滤非 text blocks', async () => {
      const { smooshIntoToolResult } = await import('../../../src/utils/messages/normalize.js')
      const tr = {
        type: 'tool_result' as const,
        toolCallId: 'tc-1',
        content: 'error',
        isError: true,
      }
      const blocks = [
        { type: 'text' as const, text: 'keep this' },
        { type: 'image' as const, mimeType: 'image/png', data: 'skip this' },
      ]
      const result = smooshIntoToolResult(tr, blocks)

      expect(result!.content).toBe('error\n\nkeep this')
    })
  })

  // ====================================================================
  // filterTrailingThinkingFromLastAssistant
  // ====================================================================
  describe('filterTrailingThinkingFromLastAssistant', () => {
    test('最后一条 assistant 以 thinking 结尾 → 移除尾部 thinking', async () => {
      const { filterTrailingThinkingFromLastAssistant } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [
        makeAssistantMsg([
          { type: 'text', text: 'content' },
          { type: 'thinking', thinking: 'should be removed' },
        ]),
      ]
      const result = filterTrailingThinkingFromLastAssistant(msgs as any)

      expect(result).toHaveLength(1)
      const content = (result[0] as any).message.content
      expect(content).toHaveLength(1)
      expect(content[0].type).toBe('text')
    })

    test('最后一条不是 assistant → 不变', async () => {
      const { filterTrailingThinkingFromLastAssistant } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [makeUserMsg('hello')]
      const result = filterTrailingThinkingFromLastAssistant(msgs as any)

      expect(result).toEqual(msgs as any)
    })
  })

  // ====================================================================
  // filterWhitespaceOnlyAssistantMessages
  // ====================================================================
  describe('filterWhitespaceOnlyAssistantMessages', () => {
    test('仅含空白 text 的 assistant → 过滤', async () => {
      const { filterWhitespaceOnlyAssistantMessages } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [makeAssistantMsg([{ type: 'text', text: '   \n\n  ' }]), makeUserMsg('next')]
      const result = filterWhitespaceOnlyAssistantMessages(msgs as any)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('user')
    })

    test('含非空白内容的 assistant → 保留', async () => {
      const { filterWhitespaceOnlyAssistantMessages } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [makeAssistantMsg([{ type: 'text', text: 'real content' }])]
      const result = filterWhitespaceOnlyAssistantMessages(msgs as any)

      expect(result).toHaveLength(1)
    })
  })

  // ====================================================================
  // ensureNonEmptyAssistantContent
  // ====================================================================
  describe('ensureNonEmptyAssistantContent', () => {
    test('非最后一条的空 content assistant → 填充 NO_CONTENT_MESSAGE', async () => {
      const { ensureNonEmptyAssistantContent } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [makeAssistantMsg([]), makeUserMsg('next')]
      const result = ensureNonEmptyAssistantContent(msgs as any)

      expect(result).toHaveLength(2)
      const content = (result[0] as any).message.content
      expect(content).toHaveLength(1)
      expect(content[0].text).toBe('[no content]')
    })

    test('最后一条的空 content assistant → 不修改', async () => {
      const { ensureNonEmptyAssistantContent } = await import(
        '../../../src/utils/messages/normalize.js'
      )
      const msgs = [makeUserMsg('prev'), makeAssistantMsg([])]
      const result = ensureNonEmptyAssistantContent(msgs as any)

      // 最后一条 assistant 允许空 content
      expect(result).toHaveLength(2)
      expect((result[1] as any).message.content).toEqual([])
    })
  })

  // ====================================================================
  // mergeAdjacentUserMessages
  // ====================================================================
  describe('mergeAdjacentUserMessages', () => {
    test('连续 user 消息合并为一条', async () => {
      const { mergeAdjacentUserMessages } = await import('../../../src/utils/messages/normalize.js')
      const msgs = [
        makeUserMsg('first'),
        makeUserMsg('second'),
        makeAssistantMsg([{ type: 'text', text: 'reply' }]),
      ]
      const result = mergeAdjacentUserMessages(msgs as any)

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('user')
      expect(result[1].type).toBe('assistant')
    })

    test('不相邻的 user 消息不合并', async () => {
      const { mergeAdjacentUserMessages } = await import('../../../src/utils/messages/normalize.js')
      const msgs = [
        makeUserMsg('a'),
        makeAssistantMsg([{ type: 'text', text: 'r' }]),
        makeUserMsg('b'),
      ]
      const result = mergeAdjacentUserMessages(msgs as any)

      expect(result).toHaveLength(3)
    })
  })
})
