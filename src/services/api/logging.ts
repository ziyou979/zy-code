import { feature } from 'bun:bundle'
import { isAPIError, type TokenUsage as Usage } from '../../types/llm.js'
import {
  addToTotalDurationState,
  consumePostCompaction,
  getIsNonInteractiveSession,
  getLastApiCompletionTimestamp,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QueryChainTracking } from 'src/Tool.js'
import { isConnectorTextBlock } from 'src/types/connectorText.js'
import type { AssistantMessage } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { EffortLevel } from 'src/utils/effort.js'
import { logError } from 'src/utils/log.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from 'src/utils/telemetry/sessionTracing.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { classifyAPIError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// 用于全局提示缓存的策略
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

function getErrorMessage(error: unknown): string {
  if (isAPIError(error)) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// 用于从响应头检测 AI 网关的网关指纹
const GATEWAY_FINGERPRINTS: Partial<
  Record<KnownGateway, { prefixes: string[] }>
> = {
  // https://docs.litellm.ai/docs/proxy/response_headers
  litellm: {
    prefixes: ['x-litellm-'],
  },
  // https://docs.helicone.ai/helicone-headers/header-directory
  helicone: {
    prefixes: ['helicone-'],
  },
  // https://portkey.ai/docs/api-reference/response-schema
  portkey: {
    prefixes: ['x-portkey-'],
  },
  // https://developers.cloudflare.com/ai-gateway/evaluations/add-human-feedback-api/
  'cloudflare-ai-gateway': {
    prefixes: ['cf-aig-'],
  },
  // https://developer.konghq.com/ai-gateway/ — X-Kong-Upstream-Latency, X-Kong-Proxy-Latency
  kong: {
    prefixes: ['x-kong-'],
  },
  // https://www.braintrust.dev/docs/guides/proxy — x-bt-used-endpoint, x-bt-cached
  braintrust: {
    prefixes: ['x-bt-'],
  },
}

// 使用提供商自有域名（非自托管）的网关，因此
// ANTHROPIC_BASE_URL 主机名是可靠的信号，即使没有
// 特征性响应头也能识别。
const GATEWAY_HOST_SUFFIXES: Partial<Record<KnownGateway, string[]>> = {
  // https://docs.databricks.com/aws/en/ai-gateway/
  databricks: [
    '.cloud.databricks.com',
    '.azuredatabricks.net',
    '.gcp.databricks.com',
  ],
}

function detectGateway({
  headers,
  baseUrl,
}: {
  headers?: globalThis.Headers
  baseUrl?: string
}): KnownGateway | undefined {
  if (headers) {
    // Headers API 返回的 header 名称已是小写
    // 兼容百炼 API：headers 可能是普通对象而非 Headers 实例
    const headerNames: string[] = []
    if (typeof headers.forEach === 'function') {
      headers.forEach((_, key) => headerNames.push(key))
    } else {
      // headers 是普通对象，使用 Object.keys 获取键名
      Object.keys(headers).forEach(key => headerNames.push(key))
    }
    for (const [gw, { prefixes }] of Object.entries(GATEWAY_FINGERPRINTS)) {
      if (prefixes.some(p => headerNames.some(h => h.startsWith(p)))) {
        return gw as KnownGateway
      }
    }
  }

  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [gw, suffixes] of Object.entries(GATEWAY_HOST_SUFFIXES)) {
        if (suffixes.some(s => host.endsWith(s))) {
          return gw as KnownGateway
        }
      }
    } catch {
      // URL 格式错误 — 忽略
    }
  }

  return undefined
}

function getAnthropicEnvMetadata() {
  return {
    ...(process.env.ANTHROPIC_BASE_URL
      ? {
          baseUrl: process.env
            .ANTHROPIC_BASE_URL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ZY_CODE_MODEL
      ? {
          envModel: process.env
            .ZY_CODE_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL
      ? {
          envSmallFastModel: process.env
            .ANTHROPIC_SMALL_FAST_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
  }
}

function getBuildAgeMinutes(): number | undefined {
  if (!MACRO.BUILD_TIME) return undefined
  const buildTime = new Date(MACRO.BUILD_TIME).getTime()
  if (isNaN(buildTime)) return undefined
  return Math.floor((Date.now() - buildTime) / 60000)
}

export function logAPIQuery({
  model,
  messagesLength,
  temperature,
  betas,
  permissionMode,
  querySource,
  queryTracking,
  thinkingType,
  effortValue,
  previousRequestId,
}: {
  model: string
  messagesLength: number
  temperature: number
  betas?: string[]
  permissionMode?: PermissionMode
  querySource: string
  queryTracking?: QueryChainTracking
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  effortValue?: EffortLevel | null
  previousRequestId?: string | null
}): void {
  logEvent('zy_api_query', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messagesLength,
    temperature: temperature,
    provider: getAPIProviderForStatsig(),
    buildAgeMins: getBuildAgeMinutes(),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    thinkingType:
      thinkingType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    effortValue:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })
}

export function logAPIError({
  error,
  model,
  messageCount,
  messageTokens,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  requestId,
  clientRequestId,
  didFallBackToNonStreaming,
  promptCategory,
  headers,
  queryTracking,
  querySource,
  llmSpan,
  previousRequestId,
}: {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
  /** 客户端生成的 ID，作为 x-client-request-id header 发送（在超时时仍可存活） */
  clientRequestId?: string
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  headers?: globalThis.Headers
  queryTracking?: QueryChainTracking
  querySource?: string
  /** 来自 startLLMRequestSpan 的 span，传递它以正确匹配请求和响应 */
  llmSpan?: Span
  previousRequestId?: string | null
}): void {
  const gateway = detectGateway({
    headers: headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  const errStr = getErrorMessage(error)
  const status = isAPIError(error) ? String(error.status) : undefined
  const errorType = classifyAPIError(error)

  // 将详细连接错误信息记录到调试日志（通过 --debug 可见）
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL 错误)' : ''
    logForDebugging(
      `连接错误详情：code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  const invocation = consumeInvokingRequestId()

  if (clientRequestId) {
    logForDebugging(
      `API 错误 x-client-request-id=${clientRequestId}（提供给 API 团队用于服务端日志查找）`,
      { level: 'error' },
    )
  }

  logError(error as Error)
  logEvent('zy_api_error', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error: errStr as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    status:
      status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    errorType:
      errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messageCount,
    messageTokens,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    clientRequestId:
      (clientRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    didFallBackToNonStreaming,
    ...(promptCategory
      ? {
          promptCategory:
            promptCategory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    ...(querySource
      ? {
          querySource:
            querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })

  // 记录 API 错误事件到 OTLP
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
  })

  // 传递 span 以在启用 beta tracing 时正确匹配请求和响应
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })

  // 记录远程传送会话的首次错误（可靠性跟踪）
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('zy_teleport_first_message_error', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_type:
        errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}

function logAPISuccess({
  model,
  preNormalizedModel,
  messageCount,
  messageTokens,
  usage,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  ttftMs,
  requestId,
  stopReason,
  costUSD,
  didFallBackToNonStreaming,
  querySource,
  gateway,
  queryTracking,
  permissionMode,
  globalCacheStrategy,
  textContentLength,
  thinkingContentLength,
  toolUseContentLengths,
  connectorTextBlockCount,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  messageCount: number
  messageTokens: number
  usage: Usage | NonNullableUsage
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  ttftMs: number | null
  requestId: string | null
  // @ts-ignore
  stopReason: BetaStopReason | null
  costUSD: number
  didFallBackToNonStreaming: boolean
  querySource: string
  gateway?: KnownGateway
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  globalCacheStrategy?: GlobalCacheStrategy
  textContentLength?: number
  thinkingContentLength?: number
  toolUseContentLengths?: Record<string, number>
  connectorTextBlockCount?: number
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()
  const isPostCompaction = consumePostCompaction()
  const hasPrintFlag =
    process.argv.includes('-p') || process.argv.includes('--print')

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  const timeSinceLastApiCallMs =
    lastCompletion !== null ? now - lastCompletion : undefined

  const invocation = consumeInvokingRequestId()

  logEvent('zy_api_success', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(preNormalizedModel !== model
      ? {
          preNormalizedModel:
            preNormalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    messageCount,
    messageTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: 'extras' in usage ? usage.extras?.cacheReadInputTokens ?? 0 : (usage as NonNullableUsage).cacheReadInputTokens ?? 0,
    uncachedInputTokens: 'extras' in usage ? usage.extras?.cacheCreationInputTokens ?? 0 : (usage as NonNullableUsage).cacheCreationInputTokens ?? 0,
    durationMs: durationMs,
    durationMsIncludingRetries: durationMsIncludingRetries,
    attempt: attempt,
    ttftMs: ttftMs ?? undefined,
    buildAgeMins: getBuildAgeMinutes(),
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    stop_reason:
      (stopReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    costUSD,
    didFallBackToNonStreaming,
    isNonInteractiveSession,
    print: hasPrintFlag,
    isTTY: process.stdout.isTTY ?? false,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(globalCacheStrategy
      ? {
          globalCacheStrategy:
            globalCacheStrategy as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(textContentLength !== undefined
      ? ({
          textContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(thinkingContentLength !== undefined
      ? ({
          thinkingContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(toolUseContentLengths !== undefined
      ? ({
          toolUseContentLengths: jsonStringify(
            toolUseContentLengths,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(connectorTextBlockCount !== undefined
      ? ({
          connectorTextBlockCount,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    // 记录 cache_deleted_input_tokens 用于缓存编辑分析。需要类型转换，
    // 因为该字段有意不在 NonNullableUsage 上（外部构建已排除）。
    // 在缓存编辑激活时由 updateUsage() 设置。
    ...(feature('CACHED_MICROCOMPACT') &&
    ((usage as unknown as { cache_deleted_input_tokens?: number })
      .cache_deleted_input_tokens ?? 0) > 0
      ? {
          cacheDeletedInputTokens: (
            usage as unknown as { cache_deleted_input_tokens: number }
          ).cache_deleted_input_tokens,
        }
      : {}),
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(isPostCompaction ? { isPostCompaction } : {}),
    ...getAnthropicEnvMetadata(),
    timeSinceLastApiCallMs,
  })

  setLastApiCompletionTimestamp(now)
}

export function logAPISuccessAndDuration({
  model,
  preNormalizedModel,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  messageCount,
  messageTokens,
  requestId,
  stopReason,
  didFallBackToNonStreaming,
  querySource,
  headers,
  costUSD,
  queryTracking,
  permissionMode,
  newMessages,
  llmSpan,
  globalCacheStrategy,
  requestSetupMs,
  attemptStartTimes,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  messageCount: number
  messageTokens: number
  requestId: string | null
  // @ts-ignore
  stopReason: BetaStopReason | null
  didFallBackToNonStreaming: boolean
  querySource: string
  headers?: globalThis.Headers
  costUSD: number
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  /** 来自响应的助手消息 — 用于在启用 beta tracing 时提取 model_output 和 thinking_output */
  newMessages?: AssistantMessage[]
  /** 来自 startLLMRequestSpan 的 span，传递它以正确匹配请求和响应 */
  llmSpan?: Span
  /** 用于全局提示缓存的策略：'tool_based'、'system_prompt' 或 'none' */
  globalCacheStrategy?: GlobalCacheStrategy
  /** 成功尝试前用于请求准备的时间 */
  requestSetupMs?: number
  /** 每次尝试开始的时间戳 (Date.now()) — 用于 Perfetto 中的重试子 span */
  attemptStartTimes?: number[]
  /** 此会话中上一次 API 调用的请求 ID */
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const gateway = detectGateway({
    headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  let textContentLength: number | undefined
  let thinkingContentLength: number | undefined
  let toolUseContentLengths: Record<string, number> | undefined
  let connectorTextBlockCount: number | undefined

  if (newMessages) {
    let textLen = 0
    let thinkingLen = 0
    let hasToolUse = false
    const toolLengths: Record<string, number> = {}
    let connectorCount = 0

    for (const msg of newMessages) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          textLen += block.text.length
        } else if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(block)) {
          connectorCount++
        } else if (block.type === 'thinking') {
          thinkingLen += block.thinking.length
        // @ts-ignore
        } else if (
          (block.type as any) === 'tool_call' ||
          (block.type as any) === 'server_tool_use' ||
          (block.type as any) === 'mcp_tool_use'
        ) {
          const inputLen = jsonStringify((block as any).input).length
          const sanitizedName = sanitizeToolNameForAnalytics((block as any).name)
          toolLengths[sanitizedName] =
            (toolLengths[sanitizedName] ?? 0) + inputLen
          hasToolUse = true
        }
      }
    }

    textContentLength = textLen
    thinkingContentLength = thinkingLen > 0 ? thinkingLen : undefined
    toolUseContentLengths = hasToolUse ? toolLengths : undefined
    connectorTextBlockCount = connectorCount > 0 ? connectorCount : undefined
  }

  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  logAPISuccess({
    model,
    preNormalizedModel,
    messageCount,
    messageTokens,
    usage,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    ttftMs,
    requestId,
    stopReason,
    costUSD,
    didFallBackToNonStreaming,
    querySource,
    gateway,
    queryTracking,
    permissionMode,
    globalCacheStrategy,
    textContentLength,
    thinkingContentLength,
    toolUseContentLengths,
    connectorTextBlockCount,
    previousRequestId,
    betas,
  })
  // 记录 API 请求事件到 OTLP
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    cache_read_tokens: String(usage.cacheReadInputTokens),
    cache_creation_tokens: String(usage.cacheCreationInputTokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
  })

  // 提取模型输出、思考输出和工具调用标志（启用 beta tracing 时）
  let modelOutput: string | undefined
  let thinkingOutput: string | undefined
  let hasToolCall: boolean | undefined

  if (isBetaTracingEnabled() && newMessages) {
    // 模型输出 — 所有用户可见
    modelOutput =
      newMessages
        .flatMap(m =>
          m.message.content
            .filter(c => c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text),
        )
        .join('\n') || undefined

    // 思考输出 — 仅 Ant（构建时门控）
    if (isInternalBuild()) {
      thinkingOutput =
        newMessages
          .flatMap(m =>
            m.message.content
              .filter(c => c.type === 'thinking')
              .map(c => (c as { type: 'thinking'; thinking: string }).thinking),
          )
          .join('\n') || undefined
    }

    // 检查输出中是否包含 tool_use 块
    hasToolCall = newMessages.some(m =>
      m.message.content.some(c => c.type === 'tool_call'),
    )
  }

  // 传递 span 以在启用 beta tracing 时正确匹配请求和响应
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheCreationTokens: usage.cacheCreationInputTokens,
    attempt,
    modelOutput,
    thinkingOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  // 记录远程传送会话的首次成功消息（可靠性跟踪）
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('zy_teleport_first_message_success', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}
