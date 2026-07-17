import { getProviderForModel } from 'src/services/model/model.js'
import { resolveModel } from 'src/services/model/resolvedModel.js'
import { getCLISyspromptPrefix } from '../../../constants/system.js'
import { type Tools, toolMatchesName } from '../../../tools/tool.js'
import { type ConnectorTextBlock } from '../../../types/connectorText.js'
import type {
  ContentBlock,
  LLMAssistantMessage,
  StopReason,
  TaskBudgetParam,
} from '../../../types/llm.js'
import type { AssistantMessage, Message, StreamEvent } from '../../../types/message.js'
import { logAPIPrefix, toolToAPISchema } from '../../utils/api.js'
import { getMergedBetas } from '../../../services/feature-flags/betas.js'
import { resolveAppliedEffort } from '../../../services/effort/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { createUserMessage } from '../../messages/constructors.js'
import { ensureToolResultPairing, normalizeMessagesForAPI } from '../../messages/api.js'
import {
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../messages/prune.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import { getAPIContextManagement } from '../../compact/apiMicrocompact.js'
import { currentLimits } from '../../zyAiLimits.js'
import { feature } from 'bun:bundle'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getLastApiCompletionTimestamp,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setThinkingClearLatched,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { AFK_MODE_BETA_HEADER, CONTEXT_MANAGEMENT_BETA_HEADER } from 'src/constants/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/services/claude-in-chrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/services/claude-in-chrome/prompt.js'
import { getToolSearchBetaHeader, shouldIncludeExperimentalBetas } from 'src/services/feature-flags/betas.js'
import { logForDebugging } from 'src/utils/debug.js'
import { type EffortLevel } from 'src/services/effort/effort.js'
import { isMcpInstructionsDeltaEnabled } from 'src/services/mcp/mcpInstructionsDelta.js'
import { queryCheckpoint } from 'src/utils/queryProfiler.js'
import { type ThinkingConfig } from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/services/tool-runtime/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../../constants/apiLimits.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../telemetry/sessionTracing.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { jsonStringify } from '../../utils/slowOperations.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { logEvent } from '../../analytics/index.js'
import { consumePendingCacheEdits, getPinnedCacheEdits } from '../../compact/microCompact.js'
import { isToolFromMcpServer } from '../../mcp/utils.js'
// Sub-module imports (用于 queryModel/executeNonStreamingRequest 内部调用)
import {
  configureEffortParams,
  configureTaskBudgetParams,
  getAPIMetadata,
  getExtraBodyParams,
} from '../apiHelpers.js'
import { buildSystemPromptBlocks, getPromptCachingEnabled } from '../cacheControl.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIQuery,
  type NonNullableUsage,
} from '../logging.js'
import { addCacheBreakpoints, stripExcessMediaItems } from '../messageTransforms.js'
import { CACHE_TTL_1HOUR_MS, recordPromptState } from '../promptCacheBreakDetection.js'
import { cleanupStream } from '../usageTracker.js'
import { type RetryContext } from '../withRetry.js'
import { Options, autoModeStateModule, getPreviousRequestIdFromMessages } from './nonStreaming.js'
export async function prepareStreamingQuery(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
) {
  // 从此查询链中最后的助手消息派生之前的请求 ID。
  // 每个消息数组作用域独立（主线程、子代理、队友各有自己的），
  // 因此并发代理不会互相覆盖请求链跟踪。
  // 同时天然处理回滚/撤销，因为被移除的消息不在数组中。
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolved = resolveModel(options.model)

  const resolvedModel = options.model

  queryCheckpoint('query_tool_schema_build_start')

  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'

  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // 检查工具搜索是否启用（检查模式、模型支持和自动模式的阈值）
  // 这是异步的，因为可能需要计算 MCP 工具描述大小以用于 TstAuto 模式
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  const apiProvider = getProviderForModel(options.model)

  // 预计算一次 — isDeferredTool 每次调用执行 2 次 GrowthBook 查找
  const deferredToolNames = new Set<string>()

  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) {
        deferredToolNames.add(t.name)
      }
    }
  }

  // 即使启用了工具搜索模式，如果没有延迟工具
  // 并且没有 MCP 服务器仍在连接中，也跳过。当服务器挂起时，保留
  // ToolSearch 以便模型在它们连接后发现工具。
  if (useToolSearch && deferredToolNames.size === 0 && !options.hasPendingMcpServers) {
    logForDebugging('Tool search disabled: no deferred tools available to search')
    useToolSearch = false
  }

  // 如果此模型未启用工具搜索，过滤掉 ToolSearchTool
  // ToolSearchTool 返回 tool_reference 块，不支持的模型无法处理
  let filteredTools: Tools

  if (useToolSearch) {
    // 动态工具加载：仅包含已通过消息历史中
    // tool_reference 块发现的延迟工具。这消除了
    // 预先声明所有延迟工具的需要，并移除了工具数量限制。
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter((tool) => {
      // 始终包含非延迟工具
      if (!deferredToolNames.has(tool.name)) {
        return true
      }
      // 始终包含 ToolSearchTool（以便它能发现更多工具）
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) {
        return true
      }
      // 仅包含已发现的延迟工具
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter((t) => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME))
  }

  // 如果启用，添加工具搜索 beta header — defer_loading 被接受所必需
  // Header 因提供商而异：直接 API/Foundry 使用 advanced-tool-use，Vertex/Bedrock 使用 tool-search-tool
  // 对于 Bedrock，此 header 必须放在 extraBodyParams 中，而非 betas 数组
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null

  if (toolSearchHeader && apiProvider !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // 确定此模型是否启用了缓存的微压缩。
  // 在此处计算一次（在异步上下文中中）并由 paramsFromContext 捕获。
  // beta header 也在此处捕获，以避免在顶层导入
  // ant 专用的 CACHE_EDITING_BETA_HEADER 常量。
  let cachedMCEnabled = false

  let cacheEditingBetaHeader = ''

  if (feature('CACHED_MICROCOMPACT')) {
    // 动态模块加载 — 被导入模块的导出随构建宏变化，无法静态确定
    const cachedMicrocompact = (await import(
      '../../compact/cachedMicrocompact.js'
    )) as unknown as Record<string, unknown>
    const betas = (await import('src/constants/betas.js')) as unknown as Record<string, unknown>
    const isCachedMicrocompactEnabled =
      cachedMicrocompact.isCachedMicrocompactEnabled as unknown as () => boolean
    const isModelSupportedForCacheEditing =
      cachedMicrocompact.isModelSupportedForCacheEditing as unknown as (model: string) => boolean
    const getCachedMCConfig = cachedMicrocompact.getCachedMCConfig as unknown as () => {
      supportedModels: string[]
    }
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER as unknown as string
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    cachedMCEnabled = featureEnabled && modelSupported
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} model=${options.model} supportedModels=${jsonStringify(config.supportedModels)}`,
    )
  }

  // 全局缓存策略：始终使用 system_prompt 模式（基于边界标记的静态/动态拆分）
  const globalCacheStrategy: GlobalCacheStrategy = 'system_prompt'

  // 构建工具 schema，在启用工具搜索时为 MCP 工具添加 defer_loading
  // 注意：我们传递完整的 `tools` 列表（而非 filteredTools）给 toolToAPISchema，以便
  // ToolSearchTool 的 prompt 能列出所有可用的 MCP 工具。过滤仅影响
  // 实际发送给 API 的工具，不影响模型在工具描述中看到的内容。
  const toolSchemas = await Promise.all(
    filteredTools.map((tool) =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: deferredToolNames.has(tool.name),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, (t) => deferredToolNames.has(t.name))
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // 在构建系统提示之前规范化消息（指纹识别需要）
  //  instrumentation：跟踪规范化前的消息数量
  logEvent('zy_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')

  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)

  queryCheckpoint('query_message_normalization_end')

  // 模型特定的后处理：如果选定的模型不支持工具搜索，
  // 则剥离工具搜索特定字段。
  //
  // 为什么除了 normalizeMessagesForAPI 还需要这个？
  // - normalizeMessagesForAPI 使用 isToolSearchEnabledNoModelCheck()，因为它从
  //   约 20 个地方调用（分析、反馈、分享等），其中许多没有模型上下文。
  //   给它的签名添加模型将是一个大规模重构。
  // - 此后处理使用感知模型的 isToolSearchEnabled() 检查
  // - 这处理会话中途的模型切换（例如 Sonnet → Haiku），此时
  //   来自前一个模型的过时 tool-search 字段会导致 400 错误
  //
  // 注意：对于助手消息，normalizeMessagesForAPI 已经规范化了
  // 工具输入，所以 stripCallerFieldFromAssistantMessage 只需移除
  // 'caller' 字段（无需重新规范化输入）。
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map((msg) => {
      switch (msg.type) {
        case 'user':
          // 从 tool_result 内容中剥离 tool_reference 块
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // 从 tool_use 块中剥离 'caller' 字段
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // 修复 tool_use/tool_result 配对不匹配，这可能发生在恢复
  // 远程/传送会话时。为孤立的 tool_use 插入合成错误 tool_results，
  // 并剥离引用不存在的 tool_use 的孤立 tool_results。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // 在 API 调用之前剥离过多的媒体项。
  // API 会拒绝包含 >100 个媒体项的请求，但返回的错误令人困惑。
  // 与其报错（在 Cowork/CCD 中难以恢复），我们
  // 静默移除最旧的媒体项以保持在限制内。
  messagesForAPI = stripExcessMediaItems(messagesForAPI, API_MAX_MEDIA_PER_REQUEST)

  //  instrumentation：跟踪规范化后的消息数量
  logEvent('zy_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // 启用延迟附件时，延迟工具通过持久化的
  // deferred_tools_delta 附件宣布，而非此临时前置
  //（每当工具池变化时会破坏缓存）。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter((t) => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: [
            {
              type: 'text' as const,
              text: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
            },
          ],
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // Chrome 工具搜索说明：启用延迟附件时，
  // 这些作为客户端块携带在 mcp_instructions_delta 中
  //（attachments.ts），而非此处。此每次请求的系统提示追加
  // 会在 chrome 延迟连接时破坏提示词缓存。
  const hasChromeTools = filteredTools.some((t) =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )

  const injectChromeHere = useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // filter(Boolean) 通过将每个元素转换为布尔值来工作 - 空字符串变为 false 并被过滤掉。
  systemPrompt = asSystemPrompt(
    [
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // 前置系统提示块，便于 API 识别
  logAPIPrefix(systemPrompt)

  const enablePromptCaching = options.enablePromptCaching ?? getPromptCachingEnabled(options.model)

  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching)

  const useBetas = betas.length > 0

  // 构建用于详细追踪的最小上下文（启用 beta 追踪时）
  // 注意：实际的 new_context 消息提取在 sessionTracing.ts 中使用
  // 基于 messagesForAPI 数组中每个 querySource（代理）的哈希追踪
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]

  const allTools = [...toolSchemas, ...extraToolSchemas]

  // 动态 beta header 的 sticky-on 锁存。每个 header 一旦首次
  // 发送，就会在会话剩余时间内持续发送，这样会话中途的
  // 切换就不会改变服务端缓存键并破坏 ~50-70K 令牌。
  // 锁存在 /clear 和 /compact 时通过 clearBetaHeaderLatches() 清除。
  // 每次调用门控（isAgenticQuery、querySource===repl_main_thread）保持
  // 每次调用，以便非代理查询保持自己稳定的 header 集合。

  let afkHeaderLatched = getAfkModeHeaderLatched() === true

  if (
    !afkHeaderLatched &&
    isAgenticQuery &&
    shouldIncludeExperimentalBetas(options.model) &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    afkHeaderLatched = true
    setAfkModeHeaderLatched(true)
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true

  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      apiProvider === 'anthropic' &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  // 仅从代理查询锁存，这样分类器调用不会在回合中途
  // 翻转主线程的 context_management。
  let thinkingClearLatched = getThinkingClearLatched() === true

  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (lastCompletion !== null && Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // 从哈希中排除 defer_loading 工具 — API 会从提示词中剥离它们，
    // 所以它们永远不会影响实际的缓存键。包含它们会在工具被发现或
    // MCP 服务器重新连接时创建误报的"工具 schema 变更"破坏。
    const toolsForCacheDetection = allTools.filter(
      (t) => !('defer_loading' in t && t.defer_loading),
    )
    // 捕获所有可能影响服务端缓存键的内容。
    // 传递锁存的 header 值（而非实时状态），以便破坏检测
    // 反映我们实际发送的内容，而非用户切换的内容。
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      cachedMCEnabled: cacheEditingHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // 捕获 span 以便稍后传递给 endLLMRequestSpan
  // 这确保在多个请求并行运行时，响应能匹配到正确的请求
  const llmSpan = startLLMRequestSpan(options.model, newContext, messagesForAPI)

  const startIncludingRetries = Date.now()

  const start = Date.now()

  const attemptNumber = 0

  const attemptStartTimes: number[] = []

  let stream: AsyncIterable<StreamEvent> | undefined

  let streamRequestId: string | null | undefined

  let clientRequestId: string | undefined

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined

  // 释放所有流资源以防止原生内存泄漏。
  // Response 对象持有 V8 堆外的原生 TLS/socket 缓冲区
  //（在 Node.js/npm 路径上观察到；见 GH #32920），所以我们必须
  // 显式取消并释放它，无论生成器如何退出。
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // 在定义 paramsFromContext 之前消费待处理的缓存编辑一次。
  // paramsFromContext 会被多次调用（日志、重试），所以在
  // 其中消费会导致第一次调用从后续调用中窃取编辑。
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null

  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // 捕获最后一次 API 请求发送的 betas，包括动态添加的，
  // 以便我们记录日志并发送给遥测。
  let lastRequestBetas: string[] | undefined

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    const extraBodyParams = getExtraBodyParams([])

    // taskBudget 直接由 conversion 层构造成 provider 格式
    const taskBudgetArg: TaskBudgetParam | undefined = configureTaskBudgetParams(
      options.taskBudget,
      betasParams,
    )

    // responseFormat 直接传入，由 conversion 层自行映射
    const responseFormat = options.outputFormat

    // 重试上下文优先，因为它会在超出上下文窗口限制时尝试纠正
    const maxOutputTokens =
      retryContext?.maxTokensOverride || options.maxOutputTokensOverride || resolved.maxOutputTokens

    // 重要：不要更改下面的自适应与预设 thinking 选择，
    // 这是一个敏感的设置，会极大影响模型质量。
    const hasThinking =
      effort !== 'off' &&
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.ZY_CODE_DISABLE_THINKING)
    let reasoningEffort: string | undefined
    let thinking: ThinkingConfig | undefined

    if (resolved.supportsThinking) {
      // 开启了思考
      if (hasThinking) {
        // 配置思考强度（使用临时 target，仅用于提取 reasoningEffort）
        const effortTarget: Record<string, unknown> = {}
        configureEffortParams(effort, effortTarget, extraBodyParams, betasParams, options.model)
        reasoningEffort = effortTarget.effort as string | undefined

        // 支持自适应思考的模型
        if (
          !isEnvTruthy(process.env.ZY_CODE_DISABLE_ADAPTIVE_THINKING) &&
          resolved.supportsAdaptiveThinking
        ) {
          // 对于支持自适应 thinking 的模型，始终使用自适应 thinking
          thinking = {
            type: 'adaptive',
          }
        } else {
          // 对于不支持自适应 thinking 的模型，使用默认
          // thinking 预设，除非明确指定。
          let thinkingBudget = resolved.maxThinkingTokens
          if (thinkingConfig.type === 'enabled' && thinkingConfig.budgetTokens !== undefined) {
            thinkingBudget = thinkingConfig.budgetTokens
          }
          thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
          thinking = {
            budgetTokens: thinkingBudget,
            type: 'enabled',
          }
        }
      } else {
        thinking = { type: 'disabled' }
      }
    }

    // 如果启用，获取 API 上下文管理策略
    const contextManagement = getAPIContextManagement({
      hasThinking,
      // redact-thinking beta 已移除;现代模型默认就是 omitted thinking。
      // 保留「思考块保留」(clear_thinking)作为安全默认。
      isRedactThinkingActive: false,
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // AFK 模式 beta：自动模式首次激活时锁存一次。仍由
    // isAgenticQuery 每次调用门控，以便分类器/压缩不会获得它。
    if (
      afkHeaderLatched &&
      shouldIncludeExperimentalBetas(options.model) &&
      isAgenticQuery &&
      !betasParams.includes(AFK_MODE_BETA_HEADER)
    ) {
      betasParams.push(AFK_MODE_BETA_HEADER)
    }

    // 缓存编辑 beta：header 是会话稳定的锁存；useCachedMC
    //（控制 cache_edits body 行为）保持活跃，以便功能禁用时编辑停止，
    // 但 header 不会翻转。
    const useCachedMC =
      cachedMCEnabled && apiProvider === 'anthropic' && options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      apiProvider === 'anthropic' &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging('Cache editing beta header enabled for cached microcompact')
    }

    // 仅在 thinking 禁用时发送 temperature — API 要求
    // thinking 启用时 temperature: 1，这已经是默认值。
    const temperature = !hasThinking ? (options.temperatureOverride ?? 1) : undefined

    lastRequestBetas = betasParams

    return {
      model: resolved.apiModelId,
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits,
        consumedPinnedEdits as unknown as import('../messageTransforms.js').CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      maxTokens: maxOutputTokens,
      thinking,
      ...(reasoningEffort !== undefined && { reasoningEffort }),
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      // extraBodyParams 中可能含 extra_body 等来自 ZY_CODE_EXTRA_BODY 的字段，
      // 提取 extra_body 到标准 extraBody 字段后展开其余字段
      ...(() => {
        const { extra_body, ...rest } = extraBodyParams
        return rest
      })(),
      ...(extraBodyParams.extra_body && { extraBody: extraBodyParams.extra_body }),
      // 拍平后的通用字段，由各 conversion 层自行映射
      ...(responseFormat !== undefined && { responseFormat }),
      ...(taskBudgetArg !== undefined && { taskBudget: taskBudgetArg }),
      // 透传调用方传入的 providerExtras（如百炼的 enable_search）
      ...(options.providerExtras && { providerExtras: options.providerExtras }),
    }
  }

  // 同步计算日志标量，以便异步 .then() 闭包
  // 只捕获基本类型，而不是 paramsFromContext 的完整闭包作用域
  //（messagesForAPI、system、allTools、betas — 整个请求构建
  // 上下文），否则会在 Promise 解析前一直被固定。
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue: EffortLevel = queryParams.reasoningEffort as EffortLevel
    void options.getToolPermissionContext().then((permissionContext) => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []

  const ttftMs = 0

  let partialMessage: LLMAssistantMessage | undefined

  const contentBlocks: (ContentBlock | ConnectorTextBlock)[] = []

  const usage: NonNullableUsage = EMPTY_USAGE

  const cost = 0

  const stopReason: StopReason | null = null

  const didFallBackToNonStreaming = false

  let fallbackMessage: AssistantMessage | undefined

  const maxOutputTokens = 0

  let responseHeaders: globalThis.Headers | undefined

  let research: unknown
  return {
    messages,
    systemPrompt,
    thinkingConfig,
    tools,
    signal,
    options,
    previousRequestId,
    resolved,
    resolvedModel,
    isAgenticQuery,
    betas,
    useToolSearch,
    apiProvider,
    deferredToolNames,
    filteredTools,
    toolSearchHeader,
    cachedMCEnabled,
    cacheEditingBetaHeader,
    globalCacheStrategy,
    toolSchemas,
    messagesForAPI,
    hasChromeTools,
    injectChromeHere,
    enablePromptCaching,
    system,
    useBetas,
    extraToolSchemas,
    allTools,
    afkHeaderLatched,
    cacheEditingHeaderLatched,
    thinkingClearLatched,
    effort,
    newContext,
    llmSpan,
    startIncludingRetries,
    start,
    attemptNumber,
    attemptStartTimes,
    stream,
    streamRequestId,
    clientRequestId,
    streamResponse,
    releaseStreamResources,
    consumedCacheEdits,
    consumedPinnedEdits,
    lastRequestBetas,
    paramsFromContext,
    newMessages,
    ttftMs,
    partialMessage,
    contentBlocks,
    usage,
    cost,
    stopReason,
    didFallBackToNonStreaming,
    fallbackMessage,
    maxOutputTokens,
    responseHeaders,
    research,
  }
}
