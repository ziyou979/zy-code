import { randomUUID } from 'node:crypto'
import { getAPIProvider, isAnthropicBaseUrl } from 'src/services/model/providers.js'
import { resolveModel } from 'src/services/model/resolvedModel.js'
import { getCLISyspromptPrefix } from '../../constants/system.js'
import {
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { type ConnectorTextBlock, type ConnectorTextDelta } from '../../types/connectorText.js'
import type {
  AssistantContentBlock,
  ChunkDeltaEvent,
  ChunkStartEvent,
  ChunkStopEvent,
  ContentBlock,
  CreateParams,
  JSONOutputFormat,
  LLMAssistantMessage,
  LLMError,
  LLMResponse,
  ProviderExtras,
  ResponseDeltaEvent,
  ResponseStartEvent,
  SignatureDelta,
  StopReason,
  TextDelta,
  ThinkingDelta,
  ToolCallInputDelta,
  ToolChoice,
  ToolDefinition,
} from '../../types/llm.js'
import { isAbortError, isAPIError } from '../../types/llm.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import { logAPIPrefix, toolToAPISchema } from '../../utils/api.js'
import { getMergedBetas } from '../../utils/betas.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { captureAPIRequest } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../zyAiLimits.js'
import type { TaskBudgetParam } from './apiHelpers.js'
import { getLLMAdapter } from './client.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const apiLog = createDebugLog('api')
const streamLog = createDebugLog('api:stream')

const autoModeStateModule = true
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getLastApiCompletionTimestamp,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setLastMainRequestId,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import { AFK_MODE_BETA_HEADER, CONTEXT_MANAGEMENT_BETA_HEADER } from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/services/claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/services/claudeInChrome/prompt.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { getToolSearchBetaHeader, shouldIncludeExperimentalBetas } from 'src/utils/betas.js'
import { createDebugLog, logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue } from 'src/utils/effort.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import { type ThinkingConfig } from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModel } from '../../services/model/model.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../services/telemetry/sessionTracing.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
// LLMConnectionError 用于流式超时回退时创建错误实例
import { LLMConnectionError } from '../../types/llm.js'
import { count } from '../../utils/array.js'
import { startSessionActivity, stopSessionActivity } from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR } from '../vcr.js'
// Sub-module imports (用于 queryModel/executeNonStreamingRequest 内部调用)
import {
  adjustParamsForNonStreaming,
  configureEffortParams,
  configureTaskBudgetParams,
  getAPIMetadata,
  getExtraBodyParams,
  MAX_NON_STREAMING_TOKENS,
} from './apiHelpers.js'
import { buildSystemPromptBlocks, getPromptCachingEnabled } from './cacheControl.js'
import { getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import { addCacheBreakpoints, stripExcessMediaItems } from './messageTransforms.js'
import { probeThinkingFromError } from './modelCapabilityProbe.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import { cleanupStream, updateUsage } from './usageTracker.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: ToolChoice | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: ToolDefinition[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // 仅子代理设置
  outputFormat?: JSONOutputFormat
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  /** Provider 专属扩展参数，用于传递非标准参数（如百炼的 enable_search） */
  providerExtras?: ProviderExtras
  // API 端任务预算（output_config.task_budget）。区别于
  // tokenBudget.ts 的 +500k 自动续传功能 — 这个会发送给 API，
  // 让模型自行控制节奏。`remaining` 由调用方计算
  //（query.ts 在代理循环中递减）。
  taskBudget?: { total: number; remaining?: number }
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // 存储助手消息但继续消费生成器以确保
  // logAPISuccessAndDuration 被调用（在所有 yield 之后发生）
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // 如果信号被中止，抛出中止错误而非通用错误
    // 这允许调用方优雅地处理中止场景
    if (signal.aborted) {
      const abortErr = new Error('Request aborted')
      abortErr.name = 'AbortError'
      throw abortErr
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)
  })
}

/**
 * 判断是否应延迟 LSP 工具（工具以 defer_loading: true 出现），
 * 因为 LSP 初始化尚未完成。
 */
function _shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // 挂起或未启动时延迟
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * 非流式回退请求的每次尝试超时时间（毫秒）。
 * 设置 API_TIMEOUT_MS 时读取该值，使慢速后端和流式路径
 * 共享同一上限。
 *
 * 远程会话默认 120 秒，以保持在 CCR 容器空闲杀除
 *（~5 分钟）之下，这样挂起的回退到卡住的后端会产生干净的
 * APIConnectionTimeoutError，而不是阻塞超过 SIGKILL。
 *
 * 否则默认 300 秒 — 足够慢速后端使用，又不会接近 API
 * 的 10 分钟非流式边界。
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) {
    return override
  }
  return isEnvTruthy(process.env.ZY_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * 从非流式响应构造 AssistantMessage。
 * 统一两处回退路径的重复逻辑。
 */
function buildNonStreamingAssistantMessage(
  result: LLMResponse,
  opts: {
    requestId: string | null | undefined
    tools: Tools
    agentId?: AgentId
    research?: unknown
    advisorModel?: string
  },
): AssistantMessage {
  return {
    message: {
      ...result,
      context_management: null,
      content: normalizeContentFromAPI(
        result.content as unknown as ContentBlock[],
        opts.tools,
        opts.agentId,
      ) as AssistantContentBlock[],
    },
    requestId: opts.requestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(isInternalBuild() && opts.research !== undefined && { research: opts.research }),
    ...(opts.advisorModel && { advisorModel: opts.advisorModel }),
  }
}

/**
 * 非流式 API 请求的辅助生成器。
 * 封装了创建 withRetry 生成器、迭代以产出系统消息、
 * 并返回最终 BetaMessage 的常见模式。
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
  paramsFromContext: (context: RetryContext) => any,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
  captureRequest: (params: any) => void,
  /**
   * 此回退正在恢复的失败流式尝试的请求 ID。
   * 在 zy_nonstreaming_fallback_error 中发出，用于漏斗关联。
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, LLMResponse> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(retryParams, MAX_NON_STREAMING_TOKENS)

      try {
        // biome-ignore lint/plugin: non-streaming API call
        // 统一的非流式请求路径（Anthropic SDK / OpenAI SDK 由适配器自动选择）
        const adapter = getLLMAdapter({ anthropicClient: anthropic })
        return await adapter.createMessage(adjustedParams, retryOptions.signal, fallbackTimeoutMs)
      } catch (err) {
        // 用户中止不是错误 — 立即重新抛出，不记录日志
        if (isAbortError(err)) {
          throw err
        }

        //  instrumentation：记录非流式请求出错（包括超时）的情况。
        // 让我们区分"回退卡在容器杀除之后"（无事件）
        // 和"回退触发了有界超时"（此事件）。
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('zy_nonstreaming_fallback_error', {
          model: clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let iterResult
  do {
    iterResult = await generator.next()
    if (!iterResult.done && iterResult.value.type === 'system') {
      yield iterResult.value
    }
  } while (!iterResult.done)

  return iterResult.value as LLMResponse
}

/**
 * 从对话中最近的助手消息中提取请求 ID。用于在分析中
 * 关联连续的 API 请求，以便进行缓存命中率分析和
 * 增量令牌追踪。
 *
 * 从消息数组派生（而非全局状态）确保每个查询链
 *（主线程、子代理、队友）独立跟踪自己的请求链，
 * 回滚/撤销自然会更新该值。
 */
function getPreviousRequestIdFromMessages(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
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

  // 启用 advisor 时始终发送 advisor beta header，以便
  // 非代理查询（compact、side_question、extract_memories 等）
  // 能够解析对话历史中已有的 advisor server_tool_use 块。
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (normalizeModelStringForAPI(advisorExperiment.baseModel) === resolved.apiModelId) {
        // 如果基础模型匹配，覆盖 advisor 模型。只有在用户无法
        // 自行配置时，我们才应该有实验模型。
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  // 检查工具搜索是否启用（检查模式、模型支持和自动模式的阈值）
  // 这是异步的，因为可能需要计算 MCP 工具描述大小以用于 TstAuto 模式
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

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
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
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
    // biome-ignore lint/suspicious/noExplicitAny: 动态模块加载
    const cachedMicrocompact = (await import('../compact/cachedMicrocompact.js')) as any
    // biome-ignore lint/suspicious/noExplicitAny: 动态模块加载
    const betas = (await import('src/constants/betas.js')) as any
    const isCachedMicrocompactEnabled = cachedMicrocompact.isCachedMicrocompactEnabled
    const isModelSupportedForCacheEditing = cachedMicrocompact.isModelSupportedForCacheEditing
    const getCachedMCConfig = cachedMicrocompact.getCachedMCConfig
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
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

  // 剥离 advisor 块 — 没有 beta header 时 API 会拒绝它们。
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

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
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
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
  if (advisorModel) {
    // 服务器工具必须在 tools 数组中，这是 API 契约要求。追加到
    // toolSchemas 之后（它带有 cache_control 标记），这样切换 /advisor
    // 只会改变小的后缀，不会破坏缓存的前缀。
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as ToolDefinition)
  }
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
      getAPIProvider() === 'anthropic' &&
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
  let start = Date.now()
  let attemptNumber = 0
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

    const outputConfig: Record<string, unknown> = {
      ...((extraBodyParams.output_config as Record<string, unknown>) ?? {}),
    }

    configureEffortParams(effort, outputConfig, extraBodyParams, betasParams, options.model)

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as Record<string, unknown> & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 将 outputFormat 合并到 extraBodyParams.output_config 中，与 effort 并列。
    // structured outputs 已 GA，作为 output_config.format 参数直接下发，不再发 beta header。
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat
    }

    // 重试上下文优先，因为它会在超出上下文窗口限制时尝试纠正
    const maxOutputTokens =
      retryContext?.maxTokensOverride || options.maxOutputTokensOverride || resolved.maxOutputTokens

    const effortOff = effort === 'off'
    const hasThinking =
      !effortOff &&
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.ZY_CODE_DISABLE_THINKING)
    let thinking:
      | { type: 'adaptive' }
      | { type: 'enabled'; budget_tokens: number }
      | { type: 'disabled' }
      | undefined

    // 重要：不要更改下面的自适应与预算 thinking 选择，
    // 除非通知模型发布 DRI 和研究团队。这是一个敏感的
    // 设置，会极大影响模型质量和打磨。
    if (hasThinking && resolved.supportsThinking) {
      if (
        !isEnvTruthy(process.env.ZY_CODE_DISABLE_ADAPTIVE_THINKING) &&
        resolved.supportsAdaptiveThinking
      ) {
        // 对于支持自适应 thinking 的模型，始终使用自适应
        // thinking 而不设预算。
        thinking = {
          type: 'adaptive',
        }
      } else {
        // 对于不支持自适应 thinking 的模型，使用默认
        // thinking 预算，除非明确指定。
        let thinkingBudget = resolved.maxThinkingTokens
        if (thinkingConfig.type === 'enabled' && thinkingConfig.budgetTokens !== undefined) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        }
      }
    }

    if (effortOff && resolved.supportsThinking) {
      thinking = { type: 'disabled' }
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
      cachedMCEnabled &&
      getAPIProvider() === 'anthropic' &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'anthropic' &&
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
        consumedPinnedEdits as unknown as import('./messageTransforms.js').CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
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
    const logEffortValue = queryParams.output_config?.effort
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
        effortValue: logEffortValue as import('src/utils/effort.js').EffortLevel | undefined,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: LLMAssistantMessage | undefined
  const contentBlocks: (ContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: StopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined
  let research: unknown
  let isAdvisorInProgress = false

  try {
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // 禁用自动重试，改用手动实现
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        start = Date.now()
        attemptStartTimes.push(start)
        // withRetry 的 getClient() 调用已创建客户端。这在
        // 每次尝试时触发一次；重试时客户端通常是缓存的（withRetry
        // 仅在认证错误后才再次调用 getClient()），所以第一次尝试时
        // 从 client_creation_start 的差值是有意义的。
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params as unknown as CreateParams, options.querySource) // 捕获用于 bug 报告

        apiLog(
          `request start model=${options.model} messages=${messagesForAPI.length} tools=${filteredTools.length} attempt=${attempt}`,
        )

        maxOutputTokens = (params as { max_tokens: number }).max_tokens

        // 在 fetch 发出前立即触发。下方的 .withResponse()
        // 会等到响应头到达，所以这必须在 await 之前，
        // 否则"网络 TTFB"阶段测量就不准确。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // 生成并跟踪客户端请求 ID，使超时（不返回服务端请求 ID）
        // 仍可与服务端日志关联。仅限第一方 — 第三方提供商不记录它
        //（inc-4029 类）。
        clientRequestId =
          getAPIProvider() === 'anthropic' && isAnthropicBaseUrl() ? randomUUID() : undefined

        // 使用原始流而非 BetaMessageStream，避免 O(n²) 的部分 JSON 解析
        // BetaMessageStream 在每个 input_json_delta 上调用 partialParse()，我们不需要它
        // 因为我们自己处理工具输入累积
        // biome-ignore lint/plugin: main conversation loop handles attribution separately

        // 统一的流式请求路径（Anthropic SDK / OpenAI SDK 由适配器自动选择）
        const adapter = getLLMAdapter({ anthropicClient: anthropic })
        const streamResult = await adapter.createStream(
          params as unknown as CreateParams,
          signal,
          clientRequestId,
        )
        queryCheckpoint('query_response_headers_received')
        streamRequestId = streamResult.requestId
        streamResponse = streamResult.response
        return streamResult.stream
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // 产出 API 错误消息（流具有 'controller' 属性，而错误消息没有）
      if (!('controller' in e.value)) {
        yield e.value as SystemAPIErrorMessage
      }
    } while (!e.done)
    stream = e.value as AsyncIterable<StreamEvent>

    // 重置状态
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null
    isAdvisorInProgress = false

    // 流式空闲超时看门狗：如果 STREAM_IDLE_TIMEOUT_MS 内没有数据块到达，
    // 中止流。与下方的停顿检测（仅在*下一个*数据块到达时触发）不同，
    // 此机制使用 setTimeout 主动杀死挂起的流。没有这个，静默断开的
    // 连接会无限期挂起会话，因为 SDK 的请求超时仅覆盖初始 fetch()，
    // 不覆盖流式响应体。
    const streamWatchdogEnabled = isEnvTruthy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)
    // 显式启用看门狗时使用配置的超时（默认 90s），否则使用 5 分钟安全兜底
    const STREAM_STALL_FALLBACK_TIMEOUT_MS = 300_000
    const STREAM_IDLE_TIMEOUT_MS = streamWatchdogEnabled
      ? parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
      : STREAM_STALL_FALLBACK_TIMEOUT_MS
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // 看门狗触发时的 performance.now() 快照，用于测量中止传播延迟
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      // 始终启用流式停滞检测：显式看门狗模式使用配置超时，否则使用 5 分钟兜底
      streamIdleWarningTimer = setTimeout(
        (warnMs) => {
          streamLog(`idle warning: no chunks received for ${warnMs / 1000}s`, {
            level: 'warn',
          })
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        streamLog(
          `idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('zy_streaming_idle_timeout', {
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        })
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    startSessionActivity('api_call')
    try {
      // stream in and accumulate state
      let isFirstChunk = true
      let lastEventTime: number | null = null // 在首个数据块后设置，避免将 TTFB 计为停顿
      const STALL_THRESHOLD_MS = 30_000 // 30 秒
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        resetStreamIdleTimer()
        const now = Date.now()

        // 检测并记录流式停顿（仅在首个事件后，避免将 TTFB 计为停顿）
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            streamLog(
              `stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('zy_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type: part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          streamLog(`first chunk ${Date.now() - start}ms`)
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        // 显式标注为 string 以保留 default 分支可达性（实际 stream 可能返回扩展事件类型）
        const eventType: string = part.type
        switch (eventType) {
          case 'response_start': {
            // response_start 不包含完整 message，需要构造 partialMessage
            const startEvent = part as unknown as ResponseStartEvent
            partialMessage = {
              role: 'assistant',
              id: startEvent.responseId ?? '',
              model: startEvent.model ?? resolvedModel,
              content: [],
              stopReason: null,
            }
            ttftMs = Date.now() - start
            break
          }
          case 'chunk_start': {
            // chunk 可能包含标准类型（text/tool_call/thinking）以及 Anthropic 内部扩展类型
            // （server_tool_use/advisor_tool_result 等），所以类型标注需要足够宽泛
            const chunkStartEvent = part as unknown as ChunkStartEvent
            const startChunk: Record<string, unknown> & { type: string } =
              chunkStartEvent.chunk as unknown as Record<string, unknown> & { type: string }
            const chunkIndex = chunkStartEvent.index
            switch (startChunk.type) {
              case 'tool_use':
              case 'tool_call':
                contentBlocks[chunkIndex] = {
                  ...startChunk,
                  input: '',
                } as unknown as ContentBlock
                break
              case 'server_tool_use':
                contentBlocks[chunkIndex] = {
                  ...startChunk,
                  input: '' as unknown as { [key: string]: unknown },
                } as ContentBlock
                if ((startChunk.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('zy_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
              case 'text':
                contentBlocks[chunkIndex] = {
                  ...startChunk,
                  text: '',
                } as ContentBlock
                break
              case 'thinking':
                contentBlocks[chunkIndex] = {
                  ...startChunk,
                  thinking: '',
                  signature: '',
                } as ContentBlock
                break
              default:
                contentBlocks[chunkIndex] = { ...startChunk } as ContentBlock
                if (startChunk.type === 'advisor_tool_result') {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          }
          case 'chunk_delta': {
            const chunkDeltaEvent = part as unknown as ChunkDeltaEvent
            const contentBlock = contentBlocks[chunkDeltaEvent.index]
            const delta = chunkDeltaEvent.delta as typeof chunkDeltaEvent.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('zy_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type: part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: chunkDeltaEvent.index,
              })
              throw new RangeError('Content block not found')
            }
            if (feature('CONNECTOR_TEXT') && delta.type === 'connector_text_delta') {
              if (contentBlock.type !== 'connector_text') {
                logEvent('zy_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              contentBlock.connectorText += delta.connectorText
            } else {
              switch ((delta as { type: string }).type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_call' &&
                    (contentBlock as { type: string }).type !== 'server_tool_use'
                  ) {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof (contentBlock as unknown as { input: unknown }).input !== 'string') {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type: typeof (contentBlock as unknown as { input: unknown })
                        .input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  // 标准层统一使用驼峰 partialJson（见 types/llm.ts ToolCallInputDelta）
                  ;(contentBlock as unknown as { input: string }).input +=
                    (delta as unknown as ToolCallInputDelta).partialJson ?? ''
                  break
                case 'text_delta':
                  if (contentBlock.type !== 'text') {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  contentBlock.text += (delta as unknown as TextDelta).text
                  break
                case 'signature_delta':
                  if (feature('CONNECTOR_TEXT') && contentBlock.type === 'connector_text') {
                    ;(contentBlock as ConnectorTextBlock).signature = (
                      delta as unknown as SignatureDelta
                    ).signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = (delta as unknown as { signature: string }).signature
                  break
                case 'thinking_delta':
                  if (contentBlock.type !== 'thinking') {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.thinking += (delta as unknown as ThinkingDelta).thinking
                  break
                default:
                  logForDebugging(
                    `Unknown delta type received: ${(delta as { type: string }).type}`,
                    { level: 'warn' },
                  )
                  logEvent('zy_streaming_unknown_delta', {
                    delta_type: (delta as { type: string })
                      .type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    request_id: (streamRequestId ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                  break
              }
            }
            break
          }
          case 'chunk_stop': {
            const chunkStopEvent = part as unknown as ChunkStopEvent
            const streamExtras = chunkStopEvent.extras
            // Always overwrite with the latest value.
            if (isInternalBuild() && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            const contentBlock = contentBlocks[chunkStopEvent.index]
            if (!contentBlock) {
              logEvent('zy_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type: part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: chunkStopEvent.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('zy_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type: part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            const assistantMsg: AssistantMessage = {
              message: {
                ...partialMessage!,
                context_management: null,
                content: normalizeContentFromAPI(
                  [contentBlock] as unknown as ContentBlock[],
                  tools,
                  options.agentId,
                ) as unknown as AssistantContentBlock[],
                ...(streamExtras && { extras: streamExtras }),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(isInternalBuild() && research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(assistantMsg)
            yield assistantMsg
            break
          }
          case 'response_delta': {
            // 标准格式：part.stopReason / part.usage（驼峰）
            const responseDelta = part as unknown as ResponseDeltaEvent
            const stopReasonV2 = responseDelta.stopReason
            const streamExtras = responseDelta.extras
            // 标准 usage 是驼峰(outputTokens)，updateUsage 期望 snake_case(output_tokens)
            const rawUsage = responseDelta.usage
            const usageForUpdate = rawUsage
              ? {
                  output_tokens: rawUsage.outputTokens ?? 0,
                  input_tokens: rawUsage.inputTokens,
                  cache_creation_input_tokens: rawUsage.cacheCreationInputTokens,
                  cache_read_input_tokens: rawUsage.cacheReadInputTokens,
                }
              : undefined

            usage = updateUsage(usage, usageForUpdate as Partial<NonNullableUsage> | undefined)
            // 从 response_delta 捕获 research（仅限内部使用）。
            // 始终用最新值覆盖。同时回写到已产出的消息，
            // 因为 message_delta 在 content_block_stop 之后到达。
            if (isInternalBuild() && 'research' in (part as unknown as Record<string, unknown>)) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                ;(msg as unknown as Record<string, unknown>).research = research
              }
            }

            // 将最终 usage 和 stop_reason 写回最后一个已产出的 message。
            // 消息在 content_block_stop 时从 partialMessage 创建，
            // partialMessage 在 message_start 时设置，此时尚未生成任何 token
            //（output_tokens: 0, stop_reason: null）。
            // message_delta 在 content_block_stop 之后到达，携带真实值。
            //
            // 重要：使用直接属性修改，而非对象替换。
            // 转录写入队列持有对 message.message 的引用并惰性序列化
            //（100ms 刷新间隔）。对象替换（{ ...lastMsg.message, usage }）
            // 会断开队列中的引用；直接修改确保转录捕获最终值。
            stopReason = stopReasonV2

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stopReason = stopReason
              if (streamExtras) {
                lastMsg.message.extras = streamExtras
              }
            }

            // 更新成本
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(costUSDForPart, usage, options.model)

            const refusalMessage = getErrorMessageIfRefusal(stopReasonV2, options.model)
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              logEvent('zy_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Zy's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the ZY_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens' as unknown as LLMError,
                error: 'max_output_tokens',
              })
            }

            if ((stopReason as string) === 'model_context_window_exceeded') {
              logEvent('zy_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.outputTokens,
              })
              // 复用 max_output_tokens 恢复路径——从模型视角来看，
              // 两者都意味着"响应被截断，从上次停止的地方继续"。
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens' as unknown as LLMError,
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'response_stop':
            break
          default:
            logForDebugging(
              `Unknown stream event type received: ${(part as { type: string }).type}`,
              { level: 'warn' },
            )
            logEvent('zy_streaming_unknown_event', {
              event_type: (part as { type: string })
                .type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            break
        }

        yield {
          type: 'stream_event',
          event: part as unknown as StreamEvent['event'],
          ...((part as unknown as { type: string }).type === 'response_start'
            ? { ttftMs }
            : undefined),
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        } as StreamEvent
      }
      // 流循环已退出，清除空闲超时看门狗
      clearStreamIdleTimers()

      // 如果流被空闲超时看门狗中止，则回退到非流式重试，
      // 而不是将其视为已完成的流。
      if (streamIdleAborted) {
        // 埋点：证明 for-await 在看门狗触发后退出（而非永远挂起）。
        // exit_delay_ms 测量中止传播延迟：
        // 0-10ms = 中止生效；>>1000ms = 其他原因唤醒了循环。
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII('info', 'cli_stream_loop_exited_after_watchdog_clean')
        logEvent('zy_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path: 'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 防止双重产出：此 throw 会落入下方的 catch 块，
        // 其 exit_path='error' 探针会检查 streamWatchdogFiredAt。
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // 检测流完成但未产生任何助手消息的情况。
      // 这涵盖两种代理失败模式：
      // 1. 完全没有事件（!partialMessage）：代理返回 200 但 body 非 SSE
      // 2. 部分事件（partialMessage 已设置但没有 content block 完成且
      //    未收到 stop_reason）：代理返回 message_start 但流在
      //    content_block_stop 和带 stop_reason 的 message_delta 之前结束
      // BetaMessageStream 在 _endRequest() 中有此检查，但原始 Stream 没有——
      // 没有它，生成器会静默返回无助手消息，导致 -p 模式下出现 "Execution error"。
      // 注意：我们必须检查 stopReason 以避免误报。例如，使用结构化输出
      //（--json-schema）时，模型在第 1 轮调用 StructuredOutput 工具，
      // 然后在第 2 轮响应 end_turn 且无 content block。
      // 那是合法的空响应，而非不完整的流。
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('zy_stream_no_events', {
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // 如果流式传输期间发生了停顿，记录汇总日志
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('zy_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // 根据响应 token 检查 cache 是否实际被打破
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cacheReadInputTokens,
          usage.cacheCreationInputTokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // 处理回退百分比 header 和配额状态（如果可用）
      // streamResponse 在上方 withRetry 回调中创建流时设置
      // TypeScript 的控制流分析无法追踪 streamResponse 在回调中被设置
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        // 存储 header 用于网关检测
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // 在错误路径上也清除空闲超时看门狗
      clearStreamIdleTimers()

      // 埋点：如果看门狗已经触发且 for-await 抛出（而非干净退出），
      // 记录循环确实退出以及看门狗触发后多久。区分真正的挂起和错误退出。
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(performance.now() - streamWatchdogFiredAt)
        logForDiagnosticsNoPII('info', 'cli_stream_loop_exited_after_watchdog_error')
        logEvent('zy_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path: 'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (isAbortError(streamingError)) {
        // 检查中止信号是否由用户触发（ESC 键）
        // 如果信号已中止，则是用户发起的中止
        // 如果不是，则可能是 SDK 的超时
        if (signal.aborted) {
          // 这是真正的用户中止（按下了 ESC 键）
          logForDebugging(`Streaming aborted by user: ${errorMessage(streamingError)}`)
          if (isAdvisorInProgress) {
            logEvent('zy_advisor_tool_interrupted', {
              model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // SDK 抛出了 APIUserAbortError 但我们的信号未被中止
          // 这意味着是 SDK 内部超时
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError instanceof Error ? streamingError.message : String(streamingError)}`,
            {
              level: 'error',
            },
          )
          // 为超时抛出更具体的错误
          throw new LLMConnectionError('Request timed out')
        }
      }

      // 当标志启用时，跳过非流式回退并让错误传播到 withRetry。
      // 中途流回退在流式工具执行活跃时会导致双重工具执行：
      // 部分流启动一个工具，然后非流式重试产生相同的 tool_use
      // 并再次运行它。参见 inc-4258。
      const disableFallback =
        isEnvTruthy(process.env.ZY_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE('zy_disable_streaming_to_non_streaming_fallback', false)

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('zy_streaming_fallback_to_non_streaming', {
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('zy_streaming_fallback_to_non_streaming', {
        model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 回退到带重试的非流式模式。
      // 如果流式失败本身是 529，则将其计入连续 529 预算，
      // 使模型回退前的总 529 次数无论在流式还是非流式模式下命中都相同。
      // 这是对 https://github.com/anthropics/zy-code/issues/1513 的推测性修复。
      // 埋点：证明 executeNonStreamingRequest 已进入
      //（而非回退事件触发但调用本身在分发时挂起）。
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('zy_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        (params) => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      const assistantMsg = buildNonStreamingAssistantMessage(result, {
        requestId: streamRequestId,
        tools,
        agentId: options.agentId,
        research,
        advisorModel,
      })
      newMessages.push(assistantMsg)
      fallbackMessage = assistantMsg
      yield assistantMsg
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError 必须传播到 query.ts，它执行实际的模型切换。
    // 在这里吞掉它会使回退变成空操作——用户只会看到
    // "Model fallback triggered: X -> Y" 作为错误消息，
    // 而在回退模型上没有实际重试。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // 检查这是否是流创建期间的 404 错误，应该触发非流式回退。
    // 这处理那些对流式端点返回 404 但非流式端点正常工作的网关。
    // 在 v2.1.8 之前，BetaMessageStream 在迭代期间抛出 404
    //（被内部 catch 捕获并回退），但现在使用原始流，
    // 404 在创建期间抛出（在此处捕获）。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      isAPIError(errorFromRetry.originalError) &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 在分配 streamRequestId 之前在 .withResponse() 处抛出，
      // 且 CannotRetryError 意味着每次重试都失败——所以从错误 header 中获取
      // 失败的请求 ID。
      // biome-ignore lint/suspicious/noExplicitAny: SDK 扩展字段 requestID 未在类型中声明
      const failedRequestId = (errorFromRetry.originalError as any).requestID ?? 'unknown'
      logForDebugging('Streaming endpoint returned 404, falling back to non-streaming mode', {
        level: 'warn',
      })
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('zy_streaming_fallback_to_non_streaming', {
        model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error: '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id: failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // 回退到非流式模式
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          (params) => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        const assistantMsg = buildNonStreamingAssistantMessage(result, {
          requestId: streamRequestId,
          tools,
          agentId: options.agentId,
          research,
          advisorModel,
        })
        newMessages.push(assistantMsg)
        fallbackMessage = assistantMsg
        yield assistantMsg

        // 继续到下方的成功日志记录
      } catch (fallbackError) {
        // 将模型回退信号传播到 query.ts（见上方注释）。
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // 回退也失败了，按正常错误处理
        logForDebugging(`Non-streaming fallback also failed: ${errorMessage(fallbackError)}`, {
          level: 'error',
        })

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (isAPIError(error)) {
          extractQuotaStatusFromError(error)
          probeThinkingFromError(errorModel, error.message)
        }

        // biome-ignore lint/suspicious/noExplicitAny: SDK 扩展字段 requestID/error 未在类型中声明
        const errorAny = error as any
        const requestId =
          streamRequestId ||
          (isAPIError(error) ? errorAny.requestID : undefined) ||
          (isAPIError(error) ? (errorAny.error as { request_id?: string })?.request_id : undefined)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          previousRequestId,
        })

        if (isAbortError(error)) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // 非 404 错误的原始错误处理
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      if (isAPIError(error)) {
        extractQuotaStatusFromError(error)
        probeThinkingFromError(errorModel, error.message)
      }

      // biome-ignore lint/suspicious/noExplicitAny: SDK 扩展字段 requestID/error 未在类型中声明
      const errorAny2 = error as any
      // 从流、错误头或错误体中提取 requestId
      const requestId =
        streamRequestId ||
        (isAPIError(error) ? errorAny2.requestID : undefined) ||
        (isAPIError(error) ? (errorAny2.error as { request_id?: string })?.request_id : undefined)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        previousRequestId,
      })

      // 用户中止不生成助手错误消息
      // 中断消息在 query.ts 中处理
      if (isAbortError(error)) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    stopSessionActivity('api_call')
    // 必须在 finally 块中：如果生成器被提前终止
    // 通过 .return()（例如消费者跳出 for-await-of，或 query.ts
    // 遇到中止），try/finally 之后的代码将不会执行。
    // 没有这个，Response 对象的原生 TLS/socket 缓冲区会泄漏
    // 直到生成器被 GC 回收（见 GH #32920）。
    releaseStreamResources()

    // 非流式回退成本：流式路径在 message_delta 处理器中
    // yield 之前跟踪成本。回退推送到 newMessages 然后 yield，
    // 所以必须在这里跟踪才能在 yield 处被 .return() 捕获。
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      if (fallbackUsage) {
        usage = updateUsage(EMPTY_USAGE, fallbackUsage)
        const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
        costUSD += addToTotalSessionCost(fallbackCost, fallbackUsage, options.model)
      }
      stopReason = fallbackMessage.message.stopReason ?? null
    }
  }

  // 标记所有已注册工具为已发送到 API，使其符合删除条件
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // 跟踪主会话链的最后 requestId，以便关闭时
  // 向推理发送缓存驱逐提示。排除后台会话
  //（Ctrl+B），它们共享 repl_main_thread querySource 但
  // 在代理上下文中运行 — 它们是独立的会话链，
  // 前台会话清理时不应驱逐其缓存。
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') || options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // 预计算标量值，避免即发即弃的 .then() 闭包在
  // getToolPermissionContext() 解析前持有完整的 messagesForAPI 数组
  //（上下文窗口限制内的整个会话）。
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)

  const totalDurationMs = Date.now() - startIncludingRetries
  apiLog(
    `request completed ${totalDurationMs}ms model=${options.model} tokens=in:${usage.inputTokens ?? 0}/out:${usage.outputTokens ?? 0}/cache:${usage.cacheReadInputTokens ?? 0} stop=${stopReason ?? 'unknown'} ttft=${ttftMs}ms`,
  )

  void options.getToolPermissionContext().then((permissionContext) => {
    logAPISuccessAndDuration({
      model:
        (newMessages[0]?.message as unknown as { model?: string })?.model ??
        (partialMessage as unknown as { model?: string })?.model ??
        options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // 传递 newMessages 用于 beta 追踪 — 提取在 logging.ts 中
      // 仅在启用 beta 追踪时执行
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // 防御性措施：正常完成时也释放（如果 finally 已运行则无影响）。
  releaseStreamResources()
}
