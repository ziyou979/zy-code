import { randomUUID } from 'node:crypto'
import {
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
} from '../../../tools/tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantContentBlock,
  ContentBlock,
  JSONOutputFormat,
  LLMResponse,
  ProviderExtras,
  ToolChoice,
  ToolDefinition,
} from '../../../types/llm.js'
import { isAbortError } from '../../../types/llm.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { isEnvTruthy, isInternalBuild } from '../../../services/infra/envUtils.js'
import { normalizeContentFromAPI } from '../../messages/normalize.js'
import { type SystemPrompt } from '../systemPromptType.js'
import { getLLMAdapter } from '../client.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import type { AgentId } from 'src/types/ids.js'
import { createDebugLog, logForDebugging } from 'src/services/infra/debug.js'
import { logForDiagnosticsNoPII } from 'src/services/telemetry/diagLogs.js'
import { type EffortLevel } from 'src/services/effort/effort.js'
import { type ThinkingConfig } from 'src/services/messages/thinking.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../analytics/index.js'
import { getInitializationStatus } from '../../lsp/manager.js'
import { withStreamingVCR } from '../../vcr.js'
// Sub-module imports (用于 queryModel/executeNonStreamingRequest 内部调用)
import { adjustParamsForNonStreaming, MAX_NON_STREAMING_TOKENS } from '../apiHelpers.js'
import {
  MalformedAssistantCompletionError,
  sanitizeAssistantCompletionContent,
  validateAssistantCompletion,
} from '../assistantCompletionValidator.js'
import { getAnthropicClient } from '../client.js'
import { type RetryContext, withRetry } from '../withRetry.js'
/* eslint-disable @typescript-eslint/no-require-imports */
export const apiLog = createDebugLog('api')

export const streamLog = createDebugLog('api:stream')

export const autoModeStateModule = true
  ? (require('../../permissions/autoModeState.js') as typeof import('../../permissions/autoModeState.js'))
  : null

import type { Options } from './queryOptions.js'
export type { Options }

/**
 * 判断是否应延迟 LSP 工具（工具以 defer_loading: true 出现），
 * 因为 LSP 初始化尚未完成。
 */
export function _shouldDeferLspTool(tool: Tool): boolean {
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
export function getNonstreamingFallbackTimeoutMs(): number {
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
export function buildNonStreamingAssistantMessage(
  result: LLMResponse,
  opts: {
    requestId: string | null | undefined
    tools: Tools
    agentId?: AgentId
    research?: unknown
  },
): AssistantMessage {
  const normalizedContent = normalizeContentFromAPI(
    result.content as unknown as ContentBlock[],
    opts.tools,
    opts.agentId,
  ) as AssistantContentBlock[]

  return {
    message: {
      ...result,
      context_management: null,
      content: sanitizeAssistantCompletionContent(normalizedContent),
    },
    requestId: opts.requestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(isInternalBuild() && opts.research !== undefined && { research: opts.research }),
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
        const adapter = getLLMAdapter({
          anthropicClient: anthropic,
          model: adjustedParams.model,
        })
        const result = await adapter.createMessage(
          adjustedParams,
          retryOptions.signal,
          fallbackTimeoutMs,
        )
        const validation = validateAssistantCompletion({
          content: result.content,
          stopReason: result.stopReason,
        })
        if (!validation.ok) {
          logForDebugging(
            `Malformed non-streaming assistant completion (${validation.reason}) - retrying`,
            { level: 'error' },
          )
          logEvent('zy_malformed_assistant_completion', {
            mode: 'non_streaming' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            reason: validation.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            model: retryOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new MalformedAssistantCompletionError(validation.reason)
        }
        return result
      } catch (err) {
        // 用户中止不是错误 — 立即重新抛出，不记录日志
        if (isAbortError(err)) {
          throw err
        }

        if (err instanceof MalformedAssistantCompletionError) {
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
export function getPreviousRequestIdFromMessages(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}
