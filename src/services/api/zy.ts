// @ts-nocheck
// @ts-ignore - Some types not exported in current SDK version
import type {
  ContentBlock,
  ImageBlock,
  Response as LLMMessage,
  TokenUsage,
  StopReason,
  ToolResultBlock,
  ToolDefinition,
  ToolChoice,
  TextBlock,
  Message as LLMMessageParam,
  DocumentBlock,
  ProviderExtras,
} from '../../types/llm.js'
import {
  isAPIError,
  isAbortError
} from '../../types/llm.js'

// 以下类型仅用于 Anthropic SDK 请求构建，保留为局部类型
type BetaOutputConfig = Record<string, unknown>
type BetaJSONOutputFormat = { type: 'json_schema'; json_schema?: unknown; schema?: unknown }

import { randomUUID } from 'crypto'
import {
  getAPIProvider,
  isAnthropicBaseUrl,
  isOpenAIProvider,
} from 'src/utils/model/providers.js'
import { getLLMAdapter } from './client.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
// @ts-ignore - ConnectorTextDelta may not be exported
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
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
import {
  getDefaultAdvancedModel,
  getDefaultStandardModel,
  getDefaultCompactModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../zyAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
// LLMConnectionError 用于流式超时回退时创建错误实例
import { LLMConnectionError } from '../../types/llm.js'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeExperimentalBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
// @ts-ignore
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
// @ts-ignore
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'

import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
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
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// 定义表示合法 JSON 值的类型
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * 根据 ZY_CODE_EXTRA_BODY 环境变量（如果存在）和 beta
 * header（主要用于 Bedrock 请求）组装 API 请求的额外 body 参数。
 *
 * @param betaHeaders - 请求中包含的 beta header 数组。
 * @returns 表示额外 body 参数的 JSON 对象。
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 首先解析用户的额外 body 参数
  const extraBodyStr = process.env.ZY_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // 解析为 JSON，可以是 null、布尔值、数字、字符串、数组或对象
      const parsed = safeParseJSON(extraBodyStr)
      // 我们期望得到一个键值对对象，以便展开到 API 参数中
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅克隆 — safeParseJSON 使用 LRU 缓存，对相同字符串返回同一对象引用。
        // 修改 `result` 会污染缓存，导致值过期。
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `ZY_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing ZY_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // 反蒸馏：仅对直接 API CLI 发送 fake_tools  opt-in
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.ZY_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeExperimentalBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'zy_anti_distill_fake_tool_injection',
          false,
        )
      : false
  ) {
    result.anti_distillation = ['fake_tools']
  }

  // 处理 beta headers（如果提供）
    if (betaHeaders && betaHeaders.length > 0) {
      if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
        // 添加到现有数组，避免重复
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // 用 beta headers 创建新数组
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 检查是否应对 compact 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const compactModel = getDefaultCompactModel()
    if (model === compactModel) return false
  }

  // 检查是否应对 standard 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const standardModel = getDefaultStandardModel()
    if (model === standardModel) return false
  }

  // 检查是否应对 advanced 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const advancedModel = getDefaultAdvancedModel()
    if (model === advancedModel) return false
  }

  return true
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 判断提示词缓存是否应使用 1h TTL。
 *
 * 仅在以下情况下应用：
 * 1. 用户符合条件（ant 用户或在限额内的订阅者）
 * 2. 查询来源匹配 GrowthBook 允许列表中的模式
 *
 * GrowthBook 配置结构：{ allowlist: string[] }
 * 模式支持尾随 '*' 用于前缀匹配。
 * 示例：
 * - { allowlist: ["repl_main_thread*", "sdk"] } — 仅主线程 + SDK
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } — 还包括子代理
 * - { allowlist: ["*"] } — 所有来源
 *
 * 允许列表缓存在 STATE 中以保证会话稳定性 — 防止 GrowthBook
 * 的磁盘缓存在请求中途更新时导致混合 TTL。
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 第三方 Bedrock 用户通过环境变量选择 1h TTL — 他们自行管理计费
  // 无需 GrowthBook 控制，因为第三方用户没有配置 GrowthBook
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // 将资格状态锁存到引导状态中以保证会话稳定性 — 防止
  // 会话中途的超额变更导致 cache_control TTL 变化，这会
  // 破坏服务端提示词缓存（每次变更约 ~20K 令牌）。
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      isInternalBuild()
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // 缓存允许列表到引导状态中以保证会话稳定性 — 防止
  // GrowthBook 的磁盘缓存在请求中途更新时导致混合 TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('zy_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/**
 * 配置 API 请求的 effort 参数。
 *
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    // 发送字符串 effort 级别
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else if (isInternalBuild()) {
    // 数值 effort 覆盖 - 仅限 ant 用户（使用 anthropic_internal）
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

// output_config.task_budget — API 端的令牌预算感知。
// Stainless SDK 类型尚未包含 BetaOutputConfig 上的 task_budget，
// 因此我们在此处定义线路形状并进行类型转换。API 在接收时进行验证；
// 参见 monorepo 中的 api/api/schemas/messages/request/output_config.py:12-39。
// Beta：task-budgets-2026-03-13（EAP，截至 2026 年 3 月仅限 zy-strudel-eap）。
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeExperimentalBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.ZY_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `ZY_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // 仅在主动使用 OAuth 认证时包含 OAuth 账户 UUID
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // 使用 OpenAI SDK 的平台（百炼、Ollama、智谱、Kimi、OpenAI 等）- 跳过验证
  if (isOpenAIProvider(getAPIProvider())) {
    return true
  }
  // 如果在打印模式（非交互会话）下运行，跳过 API 验证
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // 警告：如果改用非 compact 模型，此请求在直接 API 调用中将失败，除非使用 getCLISyspromptPrefix。
    const model = getDefaultCompactModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: LLMMessageParam[] = [{ role: 'user', content: 'test' }]

          // biome-ignore lint/plugin: API key verification is intentionally a minimal direct call
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // API 密钥验证使用较少重试
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // 检查认证错误
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): LLMMessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // 克隆数组内容以防止原地修改（例如 insertCacheEditsBlock 的
  // splice）污染原始消息。如果不克隆，多次调用
  // addCacheBreakpoints 会共享同一数组，每次都在其中插入重复的 cache_edits。
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): LLMMessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

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
  outputFormat?: BetaJSONOutputFormat
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
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
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
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * 判断是否应延迟 LSP 工具（工具以 defer_loading: true 出现），
 * 因为 LSP 初始化尚未完成。
 */
function shouldDeferLspTool(tool: Tool): boolean {
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
  if (override) return override
  return isEnvTruthy(process.env.ZY_CODE_REMOTE) ? 120_000 : 300_000
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
  paramsFromContext: (context: RetryContext) => any,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: any) => void,
  /**
   * 此回退正在恢复的失败流式尝试的请求 ID。
   * 在 zy_nonstreaming_fallback_error 中发出，用于漏斗关联。
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, LLMMessage> {
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

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        // biome-ignore lint/plugin: non-streaming API call
        // 统一的非流式请求路径（Anthropic SDK / OpenAI SDK 由适配器自动选择）
        const adapter = getLLMAdapter({ anthropicClient: anthropic })
        return await adapter.createMessage(
          adjustedParams,
          retryOptions.signal,
          fallbackTimeoutMs,
        )
      } catch (err) {
        // 用户中止不是错误 — 立即重新抛出，不记录日志
        if (isAbortError(err)) throw err

        //  instrumentation：记录非流式请求出错（包括超时）的情况。
        // 让我们区分"回退卡在容器杀除之后"（无事件）
        // 和"回退触发了有界超时"（此事件）。
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('zy_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as LLMMessage
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
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

function isMedia(
  block: ContentBlock,
): block is ImageBlock | DocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(
  block: ContentBlock,
): block is ToolResultBlock {
  return block.type === 'tool_result'
}

/**
 * 确保消息最多包含 `limit` 个媒体项（图片 + 文档）。
 * 首先移除最旧的媒体以保留最新的。
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 从此查询链中最后的助手消息派生之前的请求 ID。
  // 每个消息数组作用域独立（主线程、子代理、队友各有自己的），
  // 因此并发代理不会互相覆盖请求链跟踪。
  // 同时天然处理回滚/撤销，因为被移除的消息不在数组中。
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel = options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    (options.querySource as any) === 'hook_agent' ||
    (options.querySource as any) === 'verification_agent'
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
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
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
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // 即使启用了工具搜索模式，如果没有延迟工具
  // 并且没有 MCP 服务器仍在连接中，也跳过。当服务器挂起时，保留
  // ToolSearch 以便模型在它们连接后发现工具。
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
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

    filteredTools = tools.filter(tool => {
      // 始终包含非延迟工具
      if (!deferredToolNames.has(tool.name)) return true
      // 始终包含 ToolSearchTool（以便它能发现更多工具）
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      // 仅包含已发现的延迟工具
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
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
    const cachedMicrocompact = await import('../compact/cachedMicrocompact.js') as any
    const betas = await import('src/constants/betas.js') as any
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

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP 工具是每用户的 → 动态工具部分 → 无法全局缓存。
  // 仅在 MCP 工具实际渲染（非 defer_loading）时才进行门控。
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // 启用全局缓存时，确保存在 prompt_caching_scope beta header。
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 确定全局缓存策略以用于日志记录
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // 构建工具 schema，在启用工具搜索时为 MCP 工具添加 defer_loading
  // 注意：我们传递完整的 `tools` 列表（而非 filteredTools）给 toolToAPISchema，以便
  // ToolSearchTool 的 prompt 能列出所有可用的 MCP 工具。过滤仅影响
  // 实际发送给 API 的工具，不影响模型在工具描述中看到的内容。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
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
    messagesForAPI = messagesForAPI.map(msg => {
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
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  //  instrumentation：跟踪规范化后的消息数量
  logEvent('zy_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // 从第一个用户消息计算指纹以用于归属。
  // 必须在注入合成消息（例如延迟工具名称）之前运行，
  // 以便指纹反映实际的用户输入。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // 启用延迟附件时，延迟工具通过持久化的
  // deferred_tools_delta 附件宣布，而非此临时前置
  //（每当工具池变化时会破坏缓存）。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
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
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // filter(Boolean) 通过将每个元素转换为布尔值来工作 - 空字符串变为 false 并被过滤掉。
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
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

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
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
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeExperimentalBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'anthropic' &&
      (options.querySource as any) === 'repl_main_thread'
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
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
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
      t => !('defer_loading' in t && t.defer_loading),
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
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: AsyncIterable<StreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined

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

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 将 outputFormat 合并到 extraBodyParams.output_config 中，与 effort 并列
    // 需要 structured-outputs beta header（参见 SDK 中的 messages.mjs parse()）
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // 如果不存在且提供商支持，添加 beta header
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // 重试上下文优先，因为它会在超出上下文窗口限制时尝试纠正
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.ZY_CODE_DISABLE_THINKING)
    let thinking: any | undefined = undefined

    // 重要：不要更改下面的自适应与预算 thinking 选择，
    // 除非通知模型发布 DRI 和研究团队。这是一个敏感的
    // 设置，会极大影响模型质量和打磨。
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.ZY_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // 对于支持自适应 thinking 的模型，始终使用自适应
        // thinking 而不设预算。
        thinking = {
          type: 'adaptive',
        } as any
      } else {
        // 对于不支持自适应 thinking 的模型，使用默认
        // thinking 预算，除非明确指定。
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } as any
      }
    }

    // 如果启用，获取 API 上下文管理策略
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // AFK 模式 beta：自动模式首次激活时锁存一次。仍由
    // isAgenticQuery 每次调用门控，以便分类器/压缩不会获得它。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeExperimentalBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // 缓存编辑 beta：header 是会话稳定的锁存；useCachedMC
    //（控制 cache_edits body 行为）保持活跃，以便功能禁用时编辑停止，
    // 但 header 不会翻转。
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'anthropic' &&
      (options.querySource as any) === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'anthropic' &&
      (options.querySource as any) === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // 仅在 thinking 禁用时发送 temperature — API 要求
    // thinking 启用时 temperature: 1，这已经是默认值。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits,
        consumedPinnedEdits,
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
    void options.getToolPermissionContext().then(permissionContext => {
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
  let ttftMs = 0
  let partialMessage: LLMMessage | undefined = undefined
  const contentBlocks: (ContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: StopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
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
        captureAPIRequest(params, options.querySource) // Capture for bug reports

        maxOutputTokens = params.max_tokens

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
          getAPIProvider() === 'anthropic' && isAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // 使用原始流而非 BetaMessageStream，避免 O(n²) 的部分 JSON 解析
        // BetaMessageStream 在每个 input_json_delta 上调用 partialParse()，我们不需要它
        // 因为我们自己处理工具输入累积
        // biome-ignore lint/plugin: main conversation loop handles attribution separately
        
        // 统一的流式请求路径（Anthropic SDK / OpenAI SDK 由适配器自动选择）
        const adapter = getLLMAdapter({ anthropicClient: anthropic })
        const streamResult = await adapter.createStream(params, signal, clientRequestId)
        queryCheckpoint('query_response_headers_received')
        streamRequestId = streamResult.request_id
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

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as AsyncIterable<StreamEvent>

    // reset state
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
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
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
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('zy_streaming_idle_timeout', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('zy_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        switch (part.type) {
          case 'response_start': {
            // response_start 不包含完整 message，需要构造 partialMessage
            partialMessage = {
              id: (part as any).responseId ?? '',
              type: 'message',
              role: 'assistant',
              content: [],
              model: (part as any).model ?? resolvedModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            } as any
            ttftMs = Date.now() - start
            break
          }
          case 'chunk_start': {
            // v2: part.chunk 替代了 part.content_block
            const startChunk = (part as any).chunk ?? (part as any).content_block
            switch (startChunk.type) {
              case 'tool_use':
              case 'tool_call':
                contentBlocks[(part as any).index] = {
                  ...startChunk,
                  input: '',
                }
                break
              case 'server_tool_use':
                contentBlocks[(part as any).index] = {
                  ...startChunk,
                  input: '' as unknown as { [key: string]: unknown },
                }
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
                contentBlocks[(part as any).index] = {
                  ...startChunk,
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[(part as any).index] = {
                  ...startChunk,
                  thinking: '',
                  signature: '',
                }
                break
              default:
                contentBlocks[(part as any).index] = { ...startChunk }
                if (
                  (startChunk.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          }
          case 'chunk_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('zy_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
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
              contentBlock.connector_text += delta.connector_text
            } else {
              switch (delta.type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_call' &&
                    contentBlock.type !== 'server_tool_use'
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
                  if (typeof contentBlock.input !== 'string') {
                    logEvent('zy_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  // 标准层统一使用驼峰 partialJson（见 types/llm.ts ToolCallInputDelta）
                  contentBlock.input += (delta as any).partialJson ?? ''
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
                  contentBlock.text += delta.text
                  break
                case 'signature_delta':
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
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
                  contentBlock.signature = delta.signature
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
                  contentBlock.thinking += delta.thinking
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
            // Always overwrite with the latest value.
            if (isInternalBuild() && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              logEvent('zy_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('zy_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as ContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(isInternalBuild() &&
                research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'response_delta': {
            // v2: part.stopReason / part.usage（驼峰）
            const v2Delta = part as any
            const stopReasonV2 = v2Delta.stopReason
            // v2 usage 是驼峰(outputTokens)，updateUsage 期望 snake_case(output_tokens)
            const rawUsage = v2Delta.usage
            const usageForUpdate = rawUsage
              ? {
                  output_tokens: rawUsage.outputTokens ?? 0,
                  input_tokens: rawUsage.inputTokens,
                  cache_creation_input_tokens: rawUsage.extras?.cacheCreationInputTokens,
                  cache_read_input_tokens: rawUsage.extras?.cacheReadInputTokens,
                }
              : undefined

            usage = updateUsage(usage, usageForUpdate)
            // Capture research from response_delta if available (internal only).
            // Always overwrite with the latest value. Also write back to
            // already-yielded messages since message_delta arrives after
            // content_block_stop.
            if (
              isInternalBuild() &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

            // Write final usage and stop_reason back to the last yielded
            // message. Messages are created at content_block_stop from
            // partialMessage, which was set at message_start before any tokens
            // were generated (output_tokens: 0, stop_reason: null).
            // message_delta arrives after content_block_stop with the real
            // values.
            //
            // IMPORTANT: Use direct property mutation, not object replacement.
            // The transcript write queue holds a reference to message.message
            // and serializes it lazily (100ms flush interval). Object
            // replacement ({ ...lastMsg.message, usage }) would disconnect
            // the queued reference; direct mutation ensures the transcript
            // captures the final values.
            stopReason = stopReasonV2

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stopReason = stopReason
            }

            // Update cost
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              stopReasonV2,
              options.model,
            )
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
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              logEvent('zy_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.outputTokens,
              })
              // Reuse the max_output_tokens recovery path — from the model's
              // perspective, both mean "response was cut off, continue from
              // where you left off."
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
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
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'response_start' ? { ttftMs } : undefined),
        }
      }
      // Clear the idle timeout watchdog now that the stream loop has exited
      clearStreamIdleTimers()

      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('zy_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // Prevent double-emit: this throw lands in the catch block below,
        // whose exit_path='error' probe guards on streamWatchdogFiredAt.
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // Detect when the stream completed without producing any assistant messages.
      // This covers two proxy failure modes:
      // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
      // 2. Partial events (partialMessage set but no content blocks completed AND
      //    no stop_reason received): proxy returned message_start but stream ended
      //    before content_block_stop and before message_delta with stop_reason
      // BetaMessageStream had the first check in _endRequest() but the raw Stream
      // does not - without it the generator silently returns no assistant messages,
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('zy_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // Log summary if any stalls occurred during streaming
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('zy_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // Check if the cache actually broke based on response tokens
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

      // Process fallback percentage header and quota status if available
      // streamResponse is set when the stream is created in the withRetry callback above
      // TypeScript's control flow analysis can't track that streamResponse is set in the callback
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        // Store headers for gateway detection
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // Clear the idle timeout watchdog on error path too
      clearStreamIdleTimers()

      // Instrumentation: if the watchdog had already fired and the for-await
      // threw (rather than exiting cleanly), record that the loop DID exit and
      // how long after the watchdog. Distinguishes true hangs from error exits.
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('zy_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (isAbortError(streamingError)) {
        // Check if the abort signal was triggered by the user (ESC key)
        // If the signal is aborted, it's a user-initiated abort
        // If not, it's likely a timeout from the SDK
        if (signal.aborted) {
          // This is a real user abort (ESC key was pressed)
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            logEvent('zy_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // The SDK threw APIUserAbortError but our signal wasn't aborted
          // This means it's a timeout from the SDK's internal timeout
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // Throw a more specific error for timeout
          throw new LLMConnectionError('Request timed out')
        }
      }

      // When the flag is enabled, skip the non-streaming fallback and let the
      // error propagate to withRetry. The mid-stream fallback causes double tool
      // execution when streaming tool execution is active: the partial stream
      // starts a tool, then the non-streaming retry produces the same tool_use
      // and runs it again. See inc-4258.
      const disableFallback =
        isEnvTruthy(process.env.ZY_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'zy_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('zy_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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

      // Fall back to non-streaming mode with retries.
      // If the streaming failure was itself a 529, count it toward the
      // consecutive-529 budget so total 529s-before-model-fallback is the
      // same whether the overload was hit in streaming or non-streaming mode.
      // This is a speculative fix for https://github.com/anthropics/zy-code/issues/1513
      // Instrumentation: proves executeNonStreamingRequest was entered (vs. the
      // fallback event firing but the call itself hanging at dispatch).
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('zy_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(isInternalBuild() &&
          research !== undefined && {
            research,
          }),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError must propagate to query.ts, which performs the
    // actual model switch. Swallowing it here would turn the fallback into a
    // no-op — the user would just see "Model fallback triggered: X -> Y" as
    // an error message with no actual retry on the fallback model.
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      isAPIError(errorFromRetry.originalError) &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId =
        (errorFromRetry.originalError as any).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('zy_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // Fall back to non-streaming mode
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
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(isInternalBuild() &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        // Propagate model-fallback signal to query.ts (see comment above).
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (isAPIError(error)) {
          extractQuotaStatusFromError(error)
        }

        const requestId =
          streamRequestId ||
          (isAPIError(error) ? (error as any).requestID : undefined) ||
          (isAPIError(error)
            ? ((error as any).error as { request_id?: string })?.request_id
            : undefined)

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
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // 如果是限流错误，从错误头中提取配额状态
      if (isAPIError(error)) {
        extractQuotaStatusFromError(error)
      }

      // 从流、错误头或错误体中提取 requestId
      const requestId =
        streamRequestId ||
        (isAPIError(error) ? (error as any).requestID : undefined) ||
        (isAPIError(error)
          ? ((error as any).error as { request_id?: string })?.request_id
          : undefined)

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
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stopReason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
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
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // 预计算标量值，避免即发即弃的 .then() 闭包在
  // getToolPermissionContext() 解析前持有完整的 messagesForAPI 数组
  //（上下文窗口限制内的整个会话）。
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
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

/**
 * 清理流资源以防止内存泄漏。
 * @internal 导出用于测试
 */
export function cleanupStream(
  stream: AsyncIterable<StreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // 通过控制器中止流（如果尚未中止）
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // 忽略 — 流可能已关闭
  }
}

/**
 * 使用流式 API 事件的新值更新使用量统计。
 * 注意：Anthropic 的流式 API 提供累积使用量总计，而非增量。
 * 每个事件包含流中截至该点的完整使用量。
 *
 * 输入相关令牌（input_tokens、cache_creation_input_tokens、cache_read_input_tokens）
 * 通常在 message_start 中设置并保持不变。message_delta 事件可能会发送
 * 这些字段的显式 0 值，不应覆盖 message_start 中的值。
 * 仅当这些字段具有非空、非零值时才更新。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: any | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    inputTokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.inputTokens,
    cacheCreationInputTokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cacheReadInputTokens,
    outputTokens: partUsage.output_tokens ?? usage.outputTokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK 类型 DeltaUsage 缺少 cache_creation，但实际存在！
      ephemeral_1h_input_tokens:
        (partUsage as TokenUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as TokenUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // cache_deleted_input_tokens：缓存编辑删除 KV 缓存内容时
    // API 返回该值，但不在 SDK 类型中。从 NonNullableUsage 中移除
    // 以便该字符串通过死代码消除从外部构建中剔除。
    // 使用与其他令牌字段相同的 > 0 守卫，防止 message_delta
    // 用 0 覆盖真实值。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
  }
}

/**
 * 累积消息的使用量到总量对象。
 * 用于跟踪多个助手轮次间的累积使用量。
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    inputTokens: totalUsage.inputTokens + messageUsage.inputTokens,
    cacheCreationInputTokens:
      totalUsage.cacheCreationInputTokens +
      messageUsage.cacheCreationInputTokens,
    cacheReadInputTokens:
      totalUsage.cacheReadInputTokens + messageUsage.cacheReadInputTokens,
    outputTokens: totalUsage.outputTokens + messageUsage.outputTokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // 使用最新的 service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 见 updateUsage 中的注释 — 该字段不在 NonNullableUsage 上，
    // 以保持字符串不出现在外部构建中。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // 使用最新的
    iterations: messageUsage.iterations, // 使用最新的
  }
}

function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; toolCallId: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// 导出用于测试 cache_reference 放置约束
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): LLMMessageParam[] {
  logEvent('zy_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // 每个请求恰好一个消息级 cache_control 标记。Mycro 的
  // 逐轮驱逐（page_manager/index.rs: Index::insert）会释放
  // 不在 cache_store_int_token_boundaries 中的缓存前缀位置
  // 的局部注意力 KV 页面。如果有两个标记，倒数第二个
  // 位置会被保护，其局部页面会多存活一轮，尽管
  // 永远不会从那里恢复 — 如果只有一个标记则立即释放。
  // 对于即发即弃的分叉（skipCacheWrite），我们将标记移到
  // 倒数第二个消息：那是最后的共享前缀点，因此写入对 mycro
  // 是空合并（条目已存在），分叉也不会在 KVCC 中留下自己的尾部。
  // Dense 页面无论如何都会通过新哈希被引用计数并保留。
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  if (!useCachedMC) {
    return result
  }

  // 跟踪所有被删除的 cache_references，防止跨块重复。
  const seenDeleteRefs = new Set<string>()

  // 辅助函数：对 cache_edits 块去重，排除已见过的删除项
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // 在原始位置重新插入所有之前固定的 cache_edits
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // 将新的 cache_edits 插入最后一条用户消息并固定
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // 固定以便在将来的调用中在同一位置重新发送此块
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // 向缓存前缀范围内的 tool_result 块添加 cache_reference。
  // 必须在 cache_edits 插入之后执行，因为那会修改 content 数组。
  if (enablePromptCaching) {
    // 查找包含 cache_control 标记的最后一条消息
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // 向严格位于最后 cache_control 标记之前的 tool_result 块
    // 添加 cache_reference。API 要求 cache_reference 出现在
    // 最后一个 cache_control"之前或之上" — 我们使用严格"之前"
    // 以避免 cache_edits 拼接改变块索引的边界情况。
    //
    // 创建新对象而非原地修改，以避免污染被
    // 不支持 cache_editing 的模型的次要查询复用的块。
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.toolCallId,
            })
          }
        }
      }
    }
  }

  return result
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlock[] {
  // 重要：不要再添加任何用于缓存的块，否则会收到 400 错误
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

type CompactModelOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/**
 * 使用 compact 能力层级的模型进行非流式查询。
 * 适用于轻量级任务：标题生成、摘要、日期解析等。
 */
export async function queryCompactModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: CompactModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getDefaultCompactModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // compact 模型不使用流式，所以这里是安全的
  return result[0]! as AssistantMessage
}


type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 ZY Code 基础设施查询特定模型。
 * 这会经过完整的查询流水线，包括正确的认证、
 * beta 功能和请求头 — 与直接 API 调用不同。
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// 非流式请求根据文档有 10 分钟上限：
// https://platform.zy.com/docs/en/api/errors#long-requests
// SDK 的 21333 令牌上限由 10 分钟 × 128k 令牌/小时推导，但我们
// 通过设置客户端级超时绕过它，因此可以设置更高的上限。
export let MAX_NON_STREAMING_TOKENS;
MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 当 max_tokens 在非流式回退中被限制时调整思考预算。
 * 确保满足 API 约束：max_tokens > thinking.budget_tokens
 *
 * @param params - 将发送给 API 的参数
 * @param maxTokensCap - 允许的最大令牌数（MAX_NON_STREAMING_TOKENS）
 * @returns 调整后的参数，必要时已限制思考预算
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: any
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // 如果思考预算超过限制的 max_tokens 则调整
  // 以维护约束：max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // 必须至少比 max_tokens 少 1
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

/**
 * 获取模型的默认 max_output_tokens。
 * 允许通过环境变量 ZY_CODE_MAX_OUTPUT_TOKENS 覆盖。
 * default/upperLimit 的计算逻辑已由 getModelMaxOutputTokens() 处理。
 */
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  const result = validateBoundedIntEnvVar(
    'ZY_CODE_MAX_OUTPUT_TOKENS',
    process.env.ZY_CODE_MAX_OUTPUT_TOKENS,
    maxOutputTokens.default,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
