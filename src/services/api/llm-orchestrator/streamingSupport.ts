import { randomUUID } from 'node:crypto'
import { isAnthropicBaseUrl } from 'src/services/model/providers.js'
import { type Tools } from '../../../tools/tool.js'
import { type ConnectorTextBlock, type ConnectorTextDelta } from '../../../types/connectorText.js'
import type {
  AssistantContentBlock,
  ChunkDeltaEvent,
  ChunkStartEvent,
  ChunkStopEvent,
  ContentBlock,
  CreateParams,
  LLMError,
  ResponseDeltaEvent,
  ResponseStartEvent,
  SignatureDelta,
  StopReason,
  TextDelta,
  ThinkingDelta,
  ToolCallInputDelta,
} from '../../../types/llm.js'
import { isAbortError, isAPIError } from '../../../types/llm.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { captureAPIRequest } from '../../utils/log.js'
import { createAssistantAPIErrorMessage } from '../../messages/constructors.js'
import { normalizeContentFromAPI } from '../../messages/normalize.js'
import { type SystemPrompt } from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { extractQuotaStatusFromError, extractQuotaStatusFromHeaders } from '../../zyAiLimits.js'
import { getLLMAdapter } from '../client.js'
import { feature } from 'bun:bundle'
import { setLastMainRequestId } from 'src/bootstrap/runtime/runtimeContext.js'
import { addToTotalSessionCost } from 'src/services/cost/costTracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAgentContext } from 'src/services/agent/agentContext.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { headlessProfilerCheckpoint } from 'src/services/analytics/headlessProfiler.js'
import { calculateCost, getModelCurrency } from 'src/services/model/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import { type ThinkingConfig } from 'src/utils/thinking.js'
// LLMConnectionError 用于流式超时回退时创建错误实例
import { LLMConnectionError } from '../../../types/llm.js'
import { startSessionActivity, stopSessionActivity } from '../../utils/sessionActivity.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../analytics/index.js'
import { markToolsSentToAPIState } from '../../compact/microCompact.js'
import {
  MalformedAssistantCompletionError,
  sanitizeAssistantCompletionContent,
  validateAssistantCompletion,
} from '../assistantCompletionValidator.js'
import { getAnthropicClient } from '../client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getAPIErrorSeverity,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from '../errors.js'
import {
  EMPTY_USAGE,
  logAPIError,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from '../logging.js'
import { probeThinkingFromError } from '../modelCapabilityProbe.js'
import { checkResponseForCacheBreak } from '../promptCacheBreakDetection.js'
import { updateUsage } from '../usageTracker.js'
import { CannotRetryError, FallbackTriggeredError, is529Error, withRetry } from '../withRetry.js'
import {
  Options,
  apiLog,
  buildNonStreamingAssistantMessage,
  executeNonStreamingRequest,
  streamLog,
} from './nonStreaming.js'
import { prepareStreamingQuery } from './prepareStreamingQuery.js'
import { createStreamIdleWatchdog } from './streamIdleWatchdog.js'
export async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const prepared = await prepareStreamingQuery(
    messages,
    systemPrompt,
    thinkingConfig,
    tools,
    signal,
    options,
  )
  let {
    previousRequestId,
    resolvedModel,
    betas,
    apiProvider,
    filteredTools,
    cachedMCEnabled,
    globalCacheStrategy,
    messagesForAPI,
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
    lastRequestBetas,
    paramsFromContext,
    newMessages,
    ttftMs,
    partialMessage,
    contentBlocks,
    usage,
    cost,
    stopReason: preparedStopReason,
    didFallBackToNonStreaming,
    fallbackMessage,
    maxOutputTokens,
    responseHeaders,
    research,
  } = prepared
  let stopReason: StopReason | null = preparedStopReason

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
          apiProvider === 'anthropic' && isAnthropicBaseUrl() ? randomUUID() : undefined

        // 使用原始流而非 BetaMessageStream，避免 O(n²) 的部分 JSON 解析
        // BetaMessageStream 在每个 input_json_delta 上调用 partialParse()，我们不需要它
        // 因为我们自己处理工具输入累积
        // biome-ignore lint/plugin: main conversation loop handles attribution separately

        // 统一的流式请求路径（Anthropic SDK / OpenAI SDK 由适配器自动选择）
        const requestParams = params as unknown as CreateParams
        const adapter = getLLMAdapter({
          anthropicClient: anthropic,
          model: requestParams.model,
        })
        const streamResult = await adapter.createStream(requestParams, signal, clientRequestId)
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

    const streamIdleWatchdog = createStreamIdleWatchdog({
      model: options.model,
      getRequestId: () => streamRequestId,
      releaseStreamResources,
    })
    streamIdleWatchdog.reset()

    startSessionActivity('api_call')
    try {
      // stream in and accumulate state
      let isFirstChunk = true
      let lastEventTime: number | null = null // 在首个数据块后设置，避免将 TTFB 计为停顿
      const STALL_THRESHOLD_MS = 30_000 // 30 秒
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        streamIdleWatchdog.reset()
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
            // （advisor_tool_result 等），所以类型标注需要足够宽泛
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
            if (feature('CONNECTOR_TEXT') ? delta.type === 'connector_text_delta' : false) {
              const connectorDelta = delta as ConnectorTextDelta
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
              contentBlock.connectorText += connectorDelta.connectorText
            } else {
              switch ((delta as { type: string }).type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
                case 'input_json_delta':
                  if (contentBlock.type !== 'tool_call') {
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
                  if (feature('CONNECTOR_TEXT') ? contentBlock.type === 'connector_text' : false) {
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
            const normalizedContent = normalizeContentFromAPI(
              [contentBlock] as unknown as ContentBlock[],
              tools,
              options.agentId,
            ) as unknown as AssistantContentBlock[]
            const sanitizedContent = sanitizeAssistantCompletionContent(normalizedContent)
            if (sanitizedContent.length === 0) {
              break
            }

            const assistantMsg: AssistantMessage = {
              message: {
                ...partialMessage!,
                context_management: null,
                content: sanitizedContent,
                ...(streamExtras && { extras: streamExtras }),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(isInternalBuild() && research !== undefined && { research }),
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
            const costForPart = calculateCost(resolvedModel, usage)
            const currency = getModelCurrency(resolvedModel)
            cost += addToTotalSessionCost(costForPart, usage, options.model, currency)

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
      streamIdleWatchdog.clear()

      // 如果流被空闲超时看门狗中止，则回退到非流式重试，
      // 而不是将其视为已完成的流。
      if (streamIdleWatchdog.aborted) {
        // 埋点：证明 for-await 在看门狗触发后退出（而非永远挂起）。
        // exit_delay_ms 测量中止传播延迟：
        // 0-10ms = 中止生效；>>1000ms = 其他原因唤醒了循环。
        const exitDelayMs =
          streamIdleWatchdog.firedAt !== null
            ? Math.round(performance.now() - streamIdleWatchdog.firedAt)
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
        streamIdleWatchdog.resetFiredAt()
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

      const validation = validateAssistantCompletion({
        content: newMessages.flatMap((msg) => msg.message.content),
        stopReason,
      })
      if (!validation.ok) {
        logForDebugging(
          `Malformed streaming assistant completion (${validation.reason}) - triggering fallback retry`,
          { level: 'error' },
        )
        logEvent('zy_malformed_assistant_completion', {
          mode: 'streaming' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          reason: validation.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new MalformedAssistantCompletionError(validation.reason)
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
      streamIdleWatchdog.clear()

      // 埋点：如果看门狗已经触发且 for-await 抛出（而非干净退出），
      // 记录循环确实退出以及看门狗触发后多久。区分真正的挂起和错误退出。
      if (streamIdleWatchdog.aborted && streamIdleWatchdog.firedAt !== null) {
        const exitDelayMs = Math.round(performance.now() - streamIdleWatchdog.firedAt)
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
        getFeatureValue_CACHED_MAY_BE_STALE(
          'zy_disable_streaming_to_non_streaming_fallback',
          false,
        ) ||
        // terminal 错误（认证、参数错误等）不会因为重试/回退而成功
        getAPIErrorSeverity(streamingError) === 'terminal'

      if (disableFallback) {
        // 如果有部分内容，产出 incomplete 标记的部分消息而非直接抛错
        if (partialMessage) {
          logForDebugging(
            `Streaming error (terminal/fallback disabled), yielding partial content: ${errorMessage(streamingError)}`,
          )
          // 将 partialMessage 中未完成的 content blocks 补齐
          partialMessage.content = contentBlocks as AssistantContentBlock[]
          yield {
            type: 'assistant',
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
            message: {
              ...partialMessage,
              incomplete: true,
            },
          } as AssistantMessage
          releaseStreamResources()
          return
        }

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
          fallback_cause: (streamIdleWatchdog.aborted
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
        fallback_cause: (streamIdleWatchdog.aborted
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
        fallback_cause: (streamIdleWatchdog.aborted
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
      })
      newMessages.push(assistantMsg)
      fallbackMessage = assistantMsg
      yield assistantMsg
    } finally {
      streamIdleWatchdog.clear()
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
      const failedRequestId = (errorFromRetry.originalError as unknown as { requestID?: string }).requestID ?? 'unknown'
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

        const requestId =
          streamRequestId ||
          (isAPIError(error) ? (error as unknown as { requestID?: string }).requestID : undefined) ||
          (isAPIError(error) ? ((error as unknown as { error?: { request_id?: string } }).error?.request_id) : undefined)

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

      // 从流、错误头或错误体中提取 requestId
      const requestId =
        streamRequestId ||
        (isAPIError(error) ? (error as unknown as { requestID?: string }).requestID : undefined) ||
        (isAPIError(error) ? ((error as unknown as { error?: { request_id?: string } }).error?.request_id) : undefined)

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
        const fallbackCost = calculateCost(resolvedModel, fallbackUsage)
        const fallbackCurrency = getModelCurrency(resolvedModel)
        cost += addToTotalSessionCost(fallbackCost, fallbackUsage, options.model, fallbackCurrency)
      }
      stopReason = fallbackMessage.message.stopReason ?? null
    }
  }

  // 标记所有已注册工具为已发送到 API，使其符合删除条件
  if (feature('CACHED_MICROCOMPACT') ? cachedMCEnabled : false) {
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
      cost,
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
