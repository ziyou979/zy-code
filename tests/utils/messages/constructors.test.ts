/**
 * 消息构造函数测试 — snapshot 验证输出结构。
 *
 * 覆盖 src/services/messages/constructors.ts 中所有导出函数，
 * 验证消息结构、content 转换、UUID 生成、元数据设置。
 *
 * 动态字段（timestamp、uuid）通过正则验证格式后替换为固定值，
 * 使 snapshot 可重复。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---- Mock 重依赖模块（阻断 analytics/i18n 等副作用链） ----
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

// ---- 测试辅助 ----

/** 将动态字段替换为固定值，使 snapshot 可重复 */
function stabilize(msg: Record<string, unknown>): Record<string, unknown> {
  const result = { ...msg }
  if (typeof result.uuid === 'string') {
    result.uuid = '<UUID>'
  }
  if (typeof result.timestamp === 'string') {
    result.timestamp = '<TIMESTAMP>'
  }
  // assistant 消息内嵌 message.id
  if (result.message && typeof result.message === 'object') {
    const inner = { ...(result.message as Record<string, unknown>) }
    if (typeof inner.id === 'string') {
      inner.id = '<ID>'
    }
    // 去除 usage 中的大量零值字段以简化 snapshot
    if (inner.usage && typeof inner.usage === 'object') {
      inner.usage = '<USAGE>'
    }
    result.message = inner
  }
  return result
}

describe('消息构造函数', () => {
  let constructors: typeof import('../../../src/services/messages/constructors.js')

  beforeEach(async () => {
    mock.restore()
    setupMocks()
    // bun 的 mock.module 在并行运行时可能被其他文件污染 messages.js barrel，
    // 需要用 dynamic import + 时间戳 cache buster 绕过 bun 的 module cache
    const mod = await import(`../../../src/services/messages/constructors.js?t=${Date.now()}`)
    constructors = mod as typeof import('../../../src/services/messages/constructors.js')
  })

  afterEach(() => {
    mock.restore()
  })

  // ====================================================================
  // createUserMessage
  // ====================================================================
  describe('createUserMessage', () => {
    test('string content — 保留原始字符串', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createUserMessage({ content: [{ type: 'text' as const, text: 'Hello world' }] })
      const stable = stabilize(msg as unknown as Record<string, unknown>)

      expect(stable.type).toBe('user')
      expect((stable.message as Record<string, unknown>).role).toBe('user')
      expect((stable.message as Record<string, unknown>).content).toEqual([
        { type: 'text', text: 'Hello world' },
      ])
      expect(stable.uuid).toBe('<UUID>')
      expect(stable.timestamp).toBe('<TIMESTAMP>')
    })

    test('UserContentBlock[] content — 保持 block 数组', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const blocks = [
        { type: 'text' as const, text: 'block 1' },
        { type: 'text' as const, text: 'block 2' },
      ]
      const msg = createUserMessage({ content: blocks })

      expect(msg.type).toBe('user')
      expect(msg.message.content).toEqual(blocks)
    })

    test('空 content — 回退到 NO_CONTENT_MESSAGE', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createUserMessage({ content: [] })

      expect(msg.message.content).toEqual([{ type: 'text', text: '[no content]' }])
    })

    test('元数据字段正确传递', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createUserMessage({
        content: [{ type: 'text' as const, text: 'test' }],
        isMeta: true,
        isVirtual: true,
        isVisibleInTranscriptOnly: true,
        isCompactSummary: true,
        toolUseResult: { output: 'result' },
        permissionMode: 'default',
        origin: { kind: 'human' },
      })

      expect(msg.isMeta).toBe(true)
      expect(msg.isVirtual).toBe(true)
      expect(msg.isVisibleInTranscriptOnly).toBe(true)
      expect(msg.isCompactSummary).toBe(true)
      expect(msg.toolUseResult).toEqual({ output: 'result' })
      expect(msg.permissionMode).toBe('default')
      expect(msg.origin).toEqual({ kind: 'human' })
    })

    test('自定义 uuid 和 timestamp', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createUserMessage({
        content: [{ type: 'text' as const, text: 'test' }],
        uuid: 'custom-uuid-1234',
        timestamp: '2024-01-01T00:00:00.000Z',
      })

      expect(msg.uuid).toBe('custom-uuid-1234')
      expect(msg.timestamp).toBe('2024-01-01T00:00:00.000Z')
    })

    test('summarizeMetadata 正确传递', async () => {
      const { createUserMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createUserMessage({
        content: [{ type: 'text' as const, text: 'summary' }],
        summarizeMetadata: {
          messagesSummarized: 42,
          userContext: 'context',
          direction: 'forward',
        },
      })

      expect(msg.summarizeMetadata).toEqual({
        messagesSummarized: 42,
        userContext: 'context',
        direction: 'forward',
      })
    })
  })

  // ====================================================================
  // createAssistantMessage
  // ====================================================================
  describe('createAssistantMessage', () => {
    test('string content — 自动包装为 TextBlock', () => {
      const msg = constructors.createAssistantMessage({ content: 'Hello' })

      expect(msg.type).toBe('assistant')
      expect(msg.message.role).toBe('assistant')
      expect(msg.message.content).toEqual([{ type: 'text', text: 'Hello' }])
      expect(msg.message.model).toBe('<synthetic>')
      expect(msg.message.stopReason).toBe('end_turn')
      expect(msg.isApiErrorMessage).toBe(false)
    })

    test('空字符串 content — 回退到 NO_CONTENT_MESSAGE', () => {
      const msg = constructors.createAssistantMessage({ content: '' })

      expect(msg.message.content).toEqual([{ type: 'text', text: '[no content]' }])
    })

    test('AssistantContentBlock[] content — 保持 block 数组', () => {
      const blocks = [
        { type: 'text' as const, text: 'block 1' },
        { type: 'tool_call' as const, id: 'tc_1', name: 'Bash', input: {} },
      ]
      const msg = constructors.createAssistantMessage({ content: blocks })

      expect(msg.message.content).toEqual(blocks)
    })

    test('isVirtual 正确设置', () => {
      const msg = constructors.createAssistantMessage({ content: 'test', isVirtual: true })

      expect(msg.isVirtual).toBe(true)
    })

    test('UUID 和 timestamp 自动生成', () => {
      const msg = constructors.createAssistantMessage({ content: 'test' })

      expect(msg.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  // ====================================================================
  // createAssistantAPIErrorMessage
  // ====================================================================
  describe('createAssistantAPIErrorMessage', () => {
    test('标记 isApiErrorMessage = true', async () => {
      const { createAssistantAPIErrorMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createAssistantAPIErrorMessage({
        content: 'Rate limited',
        error: 'rate_limit',
        errorDetails: 'Too many requests',
      })

      expect(msg.type).toBe('assistant')
      expect(msg.isApiErrorMessage).toBe(true)
      expect(msg.error).toBe('rate_limit')
      expect(msg.errorDetails).toBe('Too many requests')
      expect(msg.message.content).toEqual([{ type: 'text', text: 'Rate limited' }])
    })
  })

  // ====================================================================
  // createUserInterruptionMessage
  // ====================================================================
  describe('createUserInterruptionMessage', () => {
    test('默认中断消息', async () => {
      const { createUserInterruptionMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createUserInterruptionMessage({})

      expect(msg.type).toBe('user')
      expect(msg.message.content).toEqual([{ type: 'text', text: '[Request interrupted by user]' }])
    })

    test('tool use 中断消息', async () => {
      const { createUserInterruptionMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createUserInterruptionMessage({ toolUse: true })

      expect(msg.message.content).toEqual([
        { type: 'text', text: '[Request interrupted by user for tool use]' },
      ])
    })
  })

  // ====================================================================
  // createSyntheticUserCaveatMessage
  // ====================================================================
  describe('createSyntheticUserCaveatMessage', () => {
    test('isMeta = true 且包含 caveat XML 标签', async () => {
      const { createSyntheticUserCaveatMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createSyntheticUserCaveatMessage()

      expect(msg.type).toBe('user')
      expect(msg.isMeta).toBe(true)
      expect((msg.message.content[0] as { type: 'text'; text: string }).text).toContain(
        '<local-command-caveat>',
      )
    })
  })

  // ====================================================================
  // createProgressMessage
  // ====================================================================
  describe('createProgressMessage', () => {
    test('UUID 从 toolUseID + index 确定性派生', async () => {
      const { createProgressMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg1 = createProgressMessage({
        toolUseID: 'tool-123',
        parentToolUseID: '',
        data: {
          type: 'mcp_progress' as const,
          status: 'progress' as const,
          serverName: 'test',
          toolName: 'test',
        },
        index: 0,
      })
      const msg2 = createProgressMessage({
        toolUseID: 'tool-123',
        parentToolUseID: '',
        data: {
          type: 'mcp_progress' as const,
          status: 'progress' as const,
          serverName: 'test',
          toolName: 'test',
        },
        index: 0,
      })

      // 确定性：相同输入 → 相同 UUID
      expect(msg1.uuid).toBe(msg2.uuid)

      // 不同 index → 不同 UUID
      const msg3 = createProgressMessage({
        toolUseID: 'tool-123',
        parentToolUseID: '',
        data: {
          type: 'mcp_progress' as const,
          status: 'progress' as const,
          serverName: 'test',
          toolName: 'test',
        },
        index: 1,
      })
      expect(msg1.uuid).not.toBe(msg3.uuid)
    })

    test('结构正确', async () => {
      const { createProgressMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createProgressMessage({
        toolUseID: 'tu-abc',
        parentToolUseID: 'parent-xyz',
        data: {
          type: 'mcp_progress' as const,
          status: 'completed' as const,
          serverName: 'test',
          toolName: 'test',
        },
      })

      expect(msg.type).toBe('progress')
      expect(msg.toolUseID).toBe('tu-abc')
      expect(msg.parentToolUseID).toBe('parent-xyz')
      expect(msg.data).toEqual({
        type: 'mcp_progress',
        status: 'completed',
        serverName: 'test',
        toolName: 'test',
      })
    })
  })

  // ====================================================================
  // createToolResultStopMessage
  // ====================================================================
  describe('createToolResultStopMessage', () => {
    test('返回 ToolResultBlock 而非完整消息', async () => {
      const { createToolResultStopMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const block = createToolResultStopMessage('tool-use-123')

      expect(block.type).toBe('tool_result')
      expect(block.toolCallId).toBe('tool-use-123')
      expect(block.isError).toBe(true)
      expect(block.content).toContain('STOP')
    })
  })

  // ====================================================================
  // System 消息系列
  // ====================================================================
  describe('createSystemMessage', () => {
    test('info 级别', async () => {
      const { createSystemMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createSystemMessage('All good', 'info')

      expect(msg.type).toBe('system')
      expect(msg.subtype).toBe('informational')
      expect(msg.content).toBe('All good')
      expect(msg.level).toBe('info')
      expect(msg.isMeta).toBe(false)
    })

    test('preventContinuation 标志', async () => {
      const { createSystemMessage } = await import('../../../src/services/messages/constructors.js')
      const msg = createSystemMessage('Stop', 'error', 'tool-123', true)

      expect(msg.level).toBe('error')
      expect(msg.toolUseID).toBe('tool-123')
      expect(msg.preventContinuation).toBe(true)
    })
  })

  describe('createCompactBoundaryMessage', () => {
    test('auto compact', async () => {
      const { createCompactBoundaryMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createCompactBoundaryMessage('auto', 50000, undefined, 'user context', 10)

      expect(msg.type).toBe('system')
      expect(msg.subtype).toBe('compact_boundary')
      expect(msg.compactMetadata.trigger).toBe('auto')
      expect(msg.compactMetadata.preTokens).toBe(50000)
      expect(msg.compactMetadata.userContext).toBe('user context')
      expect(msg.compactMetadata.messagesSummarized).toBe(10)
    })

    test('manual compact with lastPreCompactMessageUuid', async () => {
      const { createCompactBoundaryMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createCompactBoundaryMessage(
        'manual',
        30000,
        'last-uuid-123' as unknown as undefined,
      )

      expect(msg.compactMetadata.trigger).toBe('manual')
      expect((msg as unknown as Record<string, unknown>).logicalParentUuid).toBe('last-uuid-123')
    })
  })

  describe('createWireStatusMessage', () => {
    test('结构正确', async () => {
      const { createWireStatusMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createWireStatusMessage('https://example.com', 'upgrade now')

      expect(msg.type).toBe('system')
      expect(msg.subtype).toBe('bridge_status')
      expect(msg.url).toBe('https://example.com')
      expect(msg.upgradeNudge).toBe('upgrade now')
    })
  })

  describe('createTurnDurationMessage', () => {
    test('包含 duration 和 budget', async () => {
      const { createTurnDurationMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createTurnDurationMessage(5000, { tokens: 1000, limit: 5000, nudges: 2 }, 10)

      expect(msg.type).toBe('system')
      expect(msg.subtype).toBe('turn_duration')
      expect(msg.durationMs).toBe(5000)
      expect(msg.budgetTokens).toBe(1000)
      expect(msg.messageCount).toBe(10)
    })
  })

  describe('createMemorySavedMessage', () => {
    test('包含写入路径', async () => {
      const { createMemorySavedMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createMemorySavedMessage(['/path/to/memory1.md', '/path/to/memory2.md'])

      expect(msg.type).toBe('system')
      expect(msg.subtype).toBe('memory_saved')
      expect(msg.writtenPaths).toEqual(['/path/to/memory1.md', '/path/to/memory2.md'])
      expect(msg.teamCount).toBe(0)
    })
  })

  describe('createToolUseSummaryMessage', () => {
    test('包含 summary 和 preceding IDs', async () => {
      const { createToolUseSummaryMessage } = await import(
        '../../../src/services/messages/constructors.js'
      )
      const msg = createToolUseSummaryMessage('Read 3 files', ['tu-1', 'tu-2', 'tu-3'])

      expect(msg.type).toBe('tool_use_summary')
      expect(msg.summary).toBe('Read 3 files')
      expect(msg.precedingToolUseIds).toEqual(['tu-1', 'tu-2', 'tu-3'])
    })
  })

  // ====================================================================
  // prepareUserContent
  // ====================================================================
  describe('prepareUserContent', () => {
    test('无 preceding blocks — 返回 TextBlock 数组', async () => {
      const { prepareUserContent } = await import('../../../src/services/messages/constructors.js')
      const result = prepareUserContent({
        inputString: 'Hello',
        precedingInputBlocks: [],
      })

      expect(result).toEqual([{ type: 'text', text: 'Hello' }])
    })

    test('有 preceding blocks — 返回 block 数组', async () => {
      const { prepareUserContent } = await import('../../../src/services/messages/constructors.js')
      const result = prepareUserContent({
        inputString: 'Hello',
        precedingInputBlocks: [{ type: 'image', mimeType: 'image/png', data: 'base64...' }],
      })

      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual([
        { type: 'image', mimeType: 'image/png', data: 'base64...' },
        { type: 'text', text: 'Hello' },
      ])
    })
  })
})
