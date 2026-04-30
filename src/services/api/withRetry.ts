import { feature } from 'bun:bundle'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import {
  isAPIError,
  isConnectionError,
  isAbortError,
  createAbortError,
  getErrorStatus,
  getErrorMessage as getLLMErrorMessage,
  getErrorHeader,
  type APIErrorLike,
} from '../../types/llm.js'

import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  getZyAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

const abortError = () => createAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// 前台查询来源，用户正在等待结果——这些会重试 529。其他所有（摘要、标题、建议、分类器）立即放弃：
// 在容量级联期间，每次重试都会在网关上放大 3-10 倍，而用户反正也看不到这些失败。
// 新来源默认不重试——仅在用户等待结果时才添加到此处。
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread' as any,
  'repl_main_thread:outputStyle:custom' as any,
  'repl_main_thread:outputStyle:Explanatory' as any,
  'repl_main_thread:outputStyle:Learning' as any,
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // 安全分类器——必须完成以保证 auto-mode 的正确性。
  // yoloClassifier.ts 使用 'auto_mode'（而非 'yolo_classifier'——后者
  // 仅为类型）。bash_classifier 是 ant 专用；通过 feature-gate 使该字符串
  // 在外部构建中被 tree-shake 掉（excluded-strings.txt）。
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → 重试（对未标记的调用路径保守处理）
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// ZY_CODE_UNATTENDED_RETRY：用于无人值守会话（仅 ant）。以更高的退避和定期
// keep-alive 无限重试 429/529，使主机环境不会在等待中将会话标记为空闲。
// TODO(ANT-344)：通过 SystemAPIErrorMessage yield 的 keep-alive 是临时方案，
// 直到有专用的 keep-alive 通道。
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.ZY_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (isAPIError(error) && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!isConnectionError(error)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * 预设置连续 529 计数器。当此重试循环是流式 529 之后的
   * 非流式回退时使用——流式 529 应计入 MAX_529_RETRIES，
   * 这样无论哪种请求模式遇到过载，回退前的 529 总数保持一致。
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // 保留原始堆栈跟踪（如果可用）
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T, TClient = unknown>(
  getClient: () => Promise<TClient>,
  operation: (
    client: TClient,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
  }
  let client: TClient | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw createAbortError()
    }

    try {
      // 检查模拟限速（供 Ant 员工使用 /mock-limits 命令）
      if (isInternalBuild()) {
        const mockError = checkMockRateLimitError(
          retryContext.model,
        )
        if (mockError) {
          throw mockError
        }
      }

      // 在首次尝试或认证错误后获取新的客户端实例
      // - 401：API 认证失败
      // - 403 "OAuth token has been revoked"（另一个进程刷新了 token）
      // - Bedrock 特定认证错误（403 或 CredentialsProviderError）
      // - Vertex 特定认证错误（凭证刷新失败、401）
      // - ECONNRESET/EPIPE：陈旧的 keep-alive socket；禁用连接池并重新连接
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'zy_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (isAPIError(lastError) && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isStaleConnection
      ) {
        // 遇到 401 "token expired" 或 403 "token revoked" 时，强制刷新 token
        if (
          (isAPIError(lastError) && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getZyAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${isAPIError(error) ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // 非前台来源在 529 时立即放弃——容量级联期间不重试放大
      // 用户永远不会看到这些失败
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('zy_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // 跟踪连续 529 错误
      if (is529Error(error)) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('zy_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // 抛出特殊错误以指示回退已触发
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('zy_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // 仅在错误表明应该重试时才重试
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      if (!isAPIError(error) || !shouldRetry(error)) {
        throw new CannotRetryError(error, retryContext)
      }

      // 通过调整下一次尝试的 max_tokens 来处理最大 token 上下文溢出错误
      // NOTE: 使用扩展上下文窗口 beta 后，此 400 错误不应再出现。
      // API 现在返回 'model_context_window_exceeded' stop_reason。
      // 保留以向后兼容。
      if (isAPIError(error)) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // 确保有足够的 token 用于 thinking + 至少 1 个输出 token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('zy_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // 对于其他错误，使用正常的重试逻辑
      // 如果有 retry-after header 则获取
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && isAPIError(error) && error.status === 429) {
        persistentAttempt++
        // 基于窗口的限制（例如 5 小时 Max/Pro）包含重置时间戳。
        // 等待直到重置，而不是每 5 分钟无效轮询。
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After 是服务器的指令，会绕过 getRetryDelay 内部的 maxDelayMs
        //（这是有意为之——遵循它是正确的）。在此处以 6 小时重置上限封顶，
        // 这样病态的 header 不会导致无限等待。
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // 在持久模式下，for 循环的 `attempt` 被限制在 maxRetries+1；
      // 使用 persistentAttempt 进行遥测/yield，以显示真实计数。
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('zy_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: getLLMErrorMessage(error) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: getErrorStatus(error),
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('zy_api_persistent_retry_wait', {
            status: getErrorStatus(error),
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // 分块长睡眠，使主机看到定期的 stdout 活动
        // 不会将会话标记为空闲。每次 yield 通过 QueryEngine
        // 以 {type:'system', subtype:'api_retry'} 的形式出现在 stdout 上。
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw createAbortError()
          if (isAPIError(error)) {
            yield createSystemAPIErrorMessage(
              error as any,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 封顶，确保 for 循环不会终止。退避使用单独的
        // persistentAttempt 计数器，持续增长到 5 分钟上限。
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (isAPIError(error)) {
          yield createSystemAPIErrorMessage(error as any, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as any).headers as any)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function parseMaxTokensContextOverflowError(error: APIErrorLike):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

export function is529Error(error: unknown): boolean {
  if (!isAPIError(error)) {
    return false
  }

  // 检查 529 状态码或消息中的 overloaded 错误
  return (
    error.status === 529 ||
    // 见下方：SDK 在流式传输时有时无法正确传递 529 状态码
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    isAPIError(error) &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}



function shouldRetry(error: APIErrorLike): boolean {
  // 永不重试用例模拟错误——它们来自 /mock-limits 命令用于测试
  if (isMockRateLimitError(error as any)) {
    return false
  }

  // 持久模式：429/529 始终可重试，绕过订阅者门控和
  // x-should-retry header。
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR 模式：认证来自基础设施提供的 JWT，因此 401/403 是
  // 瞬时问题（认证服务抖动、网络小故障）而非错误凭证。
  // 绕过 x-should-retry:false——服务器假设我们会重试相同的坏 key，
  // 但我们的 key 没问题。
  if (
    isEnvTruthy(process.env.ZY_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // 首先检查 overloaded 错误，通过检查消息内容
  // SDK 在流式传输时有时无法正确传递 529 状态码，
  // 因此我们需要直接检查错误消息
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // 检查我们可以处理的最大 token 上下文溢出错误
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // 注意这不是标准 header。
  const shouldRetryHeader = getErrorHeader(error, 'x-should-retry')

  // 如果服务器明确指示是否重试，则遵循。
  if ((shouldRetryHeader as any) === 'true') {
    return true
  }

  // Ant 可以忽略 x-should-retry: false 仅针对 5xx 服务器错误。
  // 对于其他状态码（401、403、400、429 等），遵循 header。
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(isInternalBuild() && is5xxError)) {
      return false
    }
  }

  if (isConnectionError(error)) {
    return true
  }

  if (!error.status) return false

  // 重试请求超时。
  if (error.status === 408) return true

  // 重试锁超时。
  if (error.status === 409) return true

  // 重试限速。
  if (error.status === 429) {
    return true
  }

  // 遇到 401 时清除 API 密钥缓存并允许重试。
  // OAuth token 处理通过主重试循环中的 handleOAuth401Error 完成。
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // 重试 403 "token revoked"（与 401 相同的刷新逻辑，见上方）
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // 重试内部错误。
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  if (process.env.ZY_CODE_MAX_RETRIES) {
    return parseInt(process.env.ZY_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

let DEFAULT_FAST_MODE_FALLBACK_HOLD_MS;
DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
let SHORT_RETRY_THRESHOLD_MS;
SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
let MIN_COOLDOWN_MS;
MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIErrorLike): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIErrorLike): number | null {
  const resetHeader = getErrorHeader(error, 'anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
