/**
 * bridge 消息转换测试 — toSDKMessages / toInternalMessages / convertSDKMessage。
 *
 * 覆盖：
 * - src/utils/messages/mappers.ts — toSDKMessages / toInternalMessages
 * - src/remote/messageAdapter.ts — convertSDKMessage
 *
 * 验证 Message ↔ BridgeMessage 双向转换的结构正确性。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---- Mock 重依赖 ----
function setupMocks() {
  mock.module('../../../src/i18n/index.js', () => ({
    tSync: (key: string) => `[i18n:${key}]`,
    t: (key: string) => `[i18n:${key}]`,
    getUiLanguage: () => 'en',
    warmI18n: async () => {},
    SUPPORTED_UI_LANGUAGES: ['en', 'zh'],
  }))
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
  mock.module('../../../src/bootstrap/state.js', () => ({
    // === 完整 207 exports（state.ts 是 barrel 文件，Bun 要求 mock 包含全部导出） ===
    _getInitialStateForTestsOnly: () => ({}),
    addInvokedSkill: () => {},
    addSessionCronTask: () => {},
    addSlowOperation: () => {},
    addToInMemoryErrorLog: () => {},
    addToToolDuration: () => {},
    addToTotalCostState: () => {},
    addToTotalDurationState: () => {},
    addToTotalLinesChanged: () => {},
    addToTurnClassifierDuration: () => {},
    addToTurnHookDuration: () => {},
    clearBetaHeaderLatches: () => {},
    clearInvokedSkills: () => {},
    clearInvokedSkillsForAgent: () => {},
    clearRegisteredHooks: () => {},
    clearRegisteredPluginHooks: () => {},
    clearSystemPromptSectionState: () => {},
    consumePostCompaction: () => {},
    flushInteractionTime: () => {},
    getActiveTimeCounter: () => null,
    getAdditionalDirectoriesForAgentsMd: () => null,
    getAfkModeHeaderLatched: () => null,
    getAgentColorMap: () => null,
    getAllowedChannels: () => null,
    getAllowedSettingSources: () => null,
    getApiKeyFromFd: () => null,
    getBudgetContinuationCount: () => null,
    getCachedAgentsMdContent: () => null,
    getCacheEditingHeaderLatched: () => null,
    getChromeFlagOverride: () => null,
    getClientType: () => null,
    getCodeEditToolDecisionCounter: () => null,
    getCommitCounter: () => null,
    getCostCounter: () => null,
    getCurrentTurnTokenBudget: () => null,
    getCwdState: () => null,
    getDirectConnectServerUrl: () => null,
    getEventLogger: () => null,
    getFlagSettingsInline: () => null,
    getFlagSettingsPath: () => null,
    getHasDevChannels: () => null,
    getInitJsonSchema: () => null,
    getInitialMainLoopModel: () => null,
    getInlinePlugins: () => null,
    getInvokedSkills: () => null,
    getInvokedSkillsForAgent: () => null,
    getIsInteractive: () => null,
    getIsNonInteractiveSession: () => null,
    getIsRemoteMode: () => null,
    getIsScrollDraining: () => null,
    getKairosActive: () => null,
    getLastAPIRequest: () => null,
    getLastAPIRequestMessages: () => null,
    getLastApiCompletionTimestamp: () => null,
    getLastClassifierRequests: () => null,
    getLastEmittedDate: () => null,
    getLastInteractionTime: () => null,
    getLastMainRequestId: () => null,
    getLocCounter: () => null,
    getLoggerProvider: () => null,
    getMainLoopModelOverride: () => null,
    getMainThreadAgentType: () => null,
    getMeter: () => null,
    getMeterProvider: () => null,
    getModelStrings: () => null,
    getModelUsage: () => null,
    getOauthTokenFromFd: () => null,
    // 返回有效路径而非 null：真实 getOriginalCwd 永远是字符串。null 桩会经 bun 全局 mock
    // 注册表泄漏到并发运行的 hook 测试，使其真实 createBaseHookInput → getProjectDir(null)
    // → sanitizePath(null) 崩溃。给个有效路径既符合真实语义，泄漏后也无害。
    getOriginalCwd: () => '/tmp/zy-test-cwd',
    getParentSessionId: () => null,
    getPlanSlugCache: () => null,
    getPrCounter: () => null,
    getProjectRoot: () => null,
    getPromptId: () => null,
    getQuestionPreviewFormat: () => null,
    getRegisteredHooks: () => null,
    getScheduledTasksEnabled: () => null,
    getSdkAgentProgressSummariesEnabled: () => null,
    getSdkBetas: () => null,
    getSessionBypassPermissionsMode: () => null,
    getSessionCounter: () => null,
    getSessionCreatedTeams: () => null,
    getSessionCronTasks: () => null,
    getSessionId: () => 'test-session-001',
    getSessionIngressToken: () => null,
    getSessionProjectDir: () => null,
    getSessionSource: () => null,
    getSessionTrustAccepted: () => null,
    getSlowOperations: () => null,
    getStatsStore: () => null,
    getStrictToolResultPairing: () => false,
    getSystemPromptSectionCache: () => null,
    getTeleportedSessionInfo: () => null,
    getThinkingClearLatched: () => null,
    getTokenCounter: () => null,
    getTotalAPIDuration: () => null,
    getTotalAPIDurationWithoutRetries: () => null,
    getTotalCacheCreationInputTokens: () => null,
    getTotalCacheReadInputTokens: () => null,
    getTotalCost: () => null,
    getTotalDuration: () => null,
    getTotalInputTokens: () => null,
    getTotalLinesAdded: () => null,
    getTotalLinesRemoved: () => null,
    getTotalOutputTokens: () => null,
    getTotalToolDuration: () => null,
    getTotalWebSearchRequests: () => null,
    getTracerProvider: () => null,
    getTurnClassifierCount: () => null,
    getTurnClassifierDurationMs: () => null,
    getTurnHookCount: () => null,
    getTurnHookDurationMs: () => null,
    getTurnOutputTokens: () => null,
    getTurnToolCount: () => null,
    getTurnToolDurationMs: () => null,
    getUsageForModel: () => null,
    getUseCoworkPlugins: () => null,
    getUserMsgOptIn: () => null,
    handleAutoModeTransition: () => {},
    handlePlanModeTransition: () => {},
    hasExitedPlanModeInSession: () => null,
    hasShownLspRecommendationThisSession: () => null,
    hasUnknownModelCost: () => null,
    incrementBudgetContinuationCount: () => {},
    isReplBridgeActive: () => null,
    isSessionPersistenceDisabled: () => null,
    markFirstTeleportMessageLogged: () => {},
    markPostCompaction: () => {},
    markScrollActivity: () => {},
    needsAutoModeExitAttachment: () => null,
    needsPlanModeExitAttachment: () => null,
    onSessionSwitch: () => {},
    preferThirdPartyAuthentication: () => {},
    regenerateSessionId: () => {},
    registerHookCallbacks: () => {},
    removeSessionCronTasks: () => {},
    resetCostState: () => {},
    resetModelStringsForTestingOnly: () => {},
    resetSdkInitState: () => {},
    resetStateForTests: () => {},
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY: () => {},
    resetTurnClassifierDuration: () => {},
    resetTurnHookDuration: () => {},
    resetTurnToolDuration: () => {},
    setAdditionalDirectoriesForAgentsMd: () => {},
    setAfkModeHeaderLatched: () => {},
    setAllowedChannels: () => {},
    setAllowedSettingSources: () => {},
    setApiKeyFromFd: () => {},
    setCacheEditingHeaderLatched: () => {},
    setCachedAgentsMdContent: () => {},
    setChromeFlagOverride: () => {},
    setClientType: () => {},
    setCostStateForRestore: () => {},
    setCwdState: () => {},
    setDirectConnectServerUrl: () => {},
    setEventLogger: () => {},
    setFlagSettingsInline: () => {},
    setFlagSettingsPath: () => {},
    setHasDevChannels: () => {},
    setHasExitedPlanMode: () => {},
    setHasUnknownModelCost: () => {},
    setInitJsonSchema: () => {},
    setInitialMainLoopModel: () => {},
    setInlinePlugins: () => {},
    setIsInteractive: () => {},
    setIsRemoteMode: () => {},
    setKairosActive: () => {},
    setLastAPIRequest: () => {},
    setLastAPIRequestMessages: () => {},
    setLastApiCompletionTimestamp: () => {},
    setLastClassifierRequests: () => {},
    setLastEmittedDate: () => {},
    setLastMainRequestId: () => {},
    setLoggerProvider: () => {},
    setLspRecommendationShownThisSession: () => {},
    setMainLoopModelOverride: () => {},
    setMainThreadAgentType: () => {},
    setMeter: () => {},
    setMeterProvider: () => {},
    setModelStrings: () => {},
    setNeedsAutoModeExitAttachment: () => {},
    setNeedsPlanModeExitAttachment: () => {},
    setOauthTokenFromFd: () => {},
    setOriginalCwd: () => {},
    setProjectRoot: () => {},
    setPromptId: () => {},
    setQuestionPreviewFormat: () => {},
    setScheduledTasksEnabled: () => {},
    setSdkAgentProgressSummariesEnabled: () => {},
    setSdkBetas: () => {},
    setSessionBypassPermissionsMode: () => {},
    setSessionIngressToken: () => {},
    setSessionPersistenceDisabled: () => {},
    setSessionSource: () => {},
    setSessionTrustAccepted: () => {},
    setStatsStore: () => {},
    setStrictToolResultPairing: () => {},
    setSystemPromptSectionCacheEntry: () => {},
    setTeleportedSessionInfo: () => {},
    setThinkingClearLatched: () => {},
    setTracerProvider: () => {},
    setUseCoworkPlugins: () => {},
    setUserMsgOptIn: () => {},
    snapshotOutputTokensForTurn: () => {},
    switchSession: () => {},
    updateLastInteractionTime: () => {},
    waitForScrollIdle: () => {},
  }))
}

// ---- 辅助构造函数 ----

function makeUserMsg(content: string | unknown[], opts: Record<string, unknown> = {}) {
  return {
    type: 'user' as const,
    uuid: opts.uuid || 'user-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role: 'user' as const, content },
    ...opts,
  }
}

function makeAssistantMsg(content: unknown[], opts: Record<string, unknown> = {}) {
  return {
    type: 'assistant' as const,
    uuid: opts.uuid || 'asst-uuid-0001',
    timestamp: '2024-01-01T00:00:00.000Z',
    message: {
      role: 'assistant' as const,
      content,
      id: opts.messageId || 'msg-001',
      model: opts.model || 'test-model',
      stopReason: 'end_turn',
      context_management: null,
    },
    requestId: undefined,
    isApiErrorMessage: false,
    ...opts,
  }
}

describe('toSDKMessages', () => {
  beforeEach(setupMocks)
  afterEach(() => mock.restore())

  test('user message → BridgeUserMessage', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [makeUserMsg('hello')]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('user')
    expect(result[0].session_id).toBe('test-session-001')
    expect(result[0].uuid).toBe('user-uuid-0001')
  })

  test('assistant message → BridgeAssistantMessage', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const blocks = [{ type: 'text', text: 'response' }]
    const messages = [makeAssistantMsg(blocks)]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('assistant')
    expect(result[0].session_id).toBe('test-session-001')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const bridgeMsg = result[0] as any
    expect(bridgeMsg.message.content).toEqual(blocks)
  })

  test('isMeta 映射为 isSynthetic', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [makeUserMsg('meta msg', { isMeta: true })]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).isSynthetic).toBe(true)
  })

  test('isVisibleInTranscriptOnly 映射为 isSynthetic', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [makeUserMsg('transcript only', { isVisibleInTranscriptOnly: true })]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).isSynthetic).toBe(true)
  })

  test('toolUseResult 映射为 tool_use_result', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [makeUserMsg('result', { toolUseResult: { output: 'done' } })]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).tool_use_result).toEqual({ output: 'done' })
  })

  test('compact_boundary system → BridgeCompactBoundaryMessage', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [
      {
        type: 'system' as const,
        subtype: 'compact_boundary' as const,
        content: 'Conversation compacted',
        level: 'info',
        uuid: 'compact-001',
        timestamp: '2024-01-01T00:00:00.000Z',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 50000,
        },
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('system')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).subtype).toBe('compact_boundary')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).compact_metadata.pre_tokens).toBe(50000)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).compact_metadata.trigger).toBe('auto')
  })

  test('informational system → 过滤', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [
      {
        type: 'system' as const,
        subtype: 'informational' as const,
        content: 'info',
        level: 'info',
        uuid: 'sys-001',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    expect(result).toHaveLength(0)
  })

  test('progress/attachment → 过滤', async () => {
    const { toSDKMessages } = await import('../../../src/utils/messages/mappers.js')
    const messages = [
      {
        type: 'progress' as const,
        uuid: 'prog-001',
        timestamp: '2024-01-01T00:00:00.000Z',
        data: {},
        toolUseID: 'tu-1',
        parentToolUseID: '',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKMessages(messages as any)

    expect(result).toHaveLength(0)
  })
})

describe('toInternalMessages', () => {
  beforeEach(setupMocks)
  afterEach(() => mock.restore())

  test('BridgeAssistantMessage → AssistantMessage', async () => {
    const { toInternalMessages } = await import('../../../src/utils/messages/mappers.js')
    const bridgeMessages = [
      {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
        parent_tool_use_id: null,
        uuid: 'sdk-asst-001',
        session_id: 'sess-001',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toInternalMessages(bridgeMessages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('assistant')
    expect(result[0].uuid).toBe('sdk-asst-001')
  })

  test('BridgeUserMessage → UserMessage', async () => {
    const { toInternalMessages } = await import('../../../src/utils/messages/mappers.js')
    const bridgeMessages = [
      {
        type: 'user' as const,
        message: {
          role: 'user',
          content: 'hello from bridge',
        },
        parent_tool_use_id: null,
        uuid: 'sdk-user-001',
        session_id: 'sess-001',
        isSynthetic: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toInternalMessages(bridgeMessages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('user')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).isMeta).toBe(true) // isSynthetic → isMeta
  })

  test('compact_boundary bridge → system compact_boundary', async () => {
    const { toInternalMessages } = await import('../../../src/utils/messages/mappers.js')
    const bridgeMessages = [
      {
        type: 'system' as const,
        subtype: 'compact_boundary' as const,
        uuid: 'compact-001',
        session_id: 'sess-001',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 30000,
        },
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toInternalMessages(bridgeMessages as any)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('system')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).subtype).toBe('compact_boundary')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).compactMetadata.trigger).toBe('manual')
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((result[0] as any).compactMetadata.preTokens).toBe(30000)
  })

  test('unknown type → 过滤', async () => {
    const { toInternalMessages } = await import('../../../src/utils/messages/mappers.js')
    const bridgeMessages = [
      {
        type: 'result' as const,
        subtype: 'success' as const,
        uuid: 'result-001',
        session_id: 'sess-001',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toInternalMessages(bridgeMessages as any)

    expect(result).toHaveLength(0)
  })
})

describe('compact metadata 双向转换', () => {
  beforeEach(setupMocks)
  afterEach(() => mock.restore())

  test('toSDKCompactMetadata — 驼峰 → 蛇形', async () => {
    const { toSDKCompactMetadata } = await import('../../../src/utils/messages/mappers.js')
    const meta = {
      trigger: 'auto',
      preTokens: 50000,
      preservedSegment: {
        headUuid: 'head-001',
        anchorUuid: 'anchor-001',
        tailUuid: 'tail-001',
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKCompactMetadata(meta as any)

    expect(result.trigger).toBe('auto')
    expect(result.pre_tokens).toBe(50000)
    expect(result.preserved_segment?.head_uuid).toBe('head-001')
    expect(result.preserved_segment?.anchor_uuid).toBe('anchor-001')
    expect(result.preserved_segment?.tail_uuid).toBe('tail-001')
  })

  test('fromSDKCompactMetadata — 蛇形 → 驼峰', async () => {
    const { fromSDKCompactMetadata } = await import('../../../src/utils/messages/mappers.js')
    const meta = {
      trigger: 'manual' as const,
      pre_tokens: 40000,
      preserved_segment: {
        head_uuid: 'head-002',
        anchor_uuid: 'anchor-002',
        tail_uuid: 'tail-002',
      },
    }
    const result = fromSDKCompactMetadata(meta)

    expect(result.trigger).toBe('manual')
    expect(result.preTokens).toBe(40000)
    expect(result.preservedSegment?.headUuid).toBe('head-002')
    expect(result.preservedSegment?.anchorUuid).toBe('anchor-002')
    expect(result.preservedSegment?.tailUuid).toBe('tail-002')
  })

  test('round-trip: toSDK → fromSDK → 原始值', async () => {
    const { toSDKCompactMetadata, fromSDKCompactMetadata } = await import(
      '../../../src/utils/messages/mappers.js'
    )
    const original = {
      trigger: 'auto',
      preTokens: 55000,
      preservedSegment: {
        headUuid: 'h',
        anchorUuid: 'a',
        tailUuid: 't',
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const sdk = toSDKCompactMetadata(original as any)
    const roundTripped = fromSDKCompactMetadata(sdk)

    expect(roundTripped.preTokens).toBe(original.preTokens)
    expect(roundTripped.preservedSegment?.headUuid).toBe(original.preservedSegment.headUuid)
  })
})

describe('toSDKRateLimitInfo', () => {
  beforeEach(setupMocks)
  afterEach(() => mock.restore())

  test('映射内部字段到 SDK 格式', async () => {
    const { toSDKRateLimitInfo } = await import('../../../src/utils/messages/mappers.js')
    const limits = {
      status: 'allowed_warning' as const,
      resetsAt: 1700000000,
      rateLimitType: 'seven_day' as const,
      utilization: 0.85,
      overageStatus: 'allowed' as const,
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const result = toSDKRateLimitInfo(limits as any)

    expect(result).toBeDefined()
    expect(result!.status).toBe('allowed_warning')
    expect(result!.resetsAt).toBe(1700000000)
    expect(result!.rateLimitType).toBe('seven_day')
    expect(result!.utilization).toBe(0.85)
  })

  test('undefined 输入 → undefined', async () => {
    const { toSDKRateLimitInfo } = await import('../../../src/utils/messages/mappers.js')
    expect(toSDKRateLimitInfo(undefined)).toBeUndefined()
  })
})
