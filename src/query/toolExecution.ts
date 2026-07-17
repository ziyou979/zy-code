import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { StreamingToolExecutor } from '../services/tool-runtime/streamingToolExecutor.js'
import { runTools } from '../services/tool-runtime/toolOrchestration.js'
import { generateToolUseSummary } from '../services/tool-use-summary/toolUseSummaryGenerator.js'
import type { ToolUseContext } from '../tools/tool.js'
import type { TextBlock, ToolCallBlock, ToolResultBlock } from '../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ToolUseSummaryMessage,
  UserMessage,
} from '../types/message.js'
import { executePostToolBatchHooks } from '../services/hooks/executors/tool.js'
import { hasHookForEvent } from '../services/hooks/matcher.js'
import { createToolUseSummaryMessage } from '../services/messages/./constructors.js'
import { normalizeMessagesForAPI } from '../services/messages/./api.js'
import { queryCheckpoint } from '../utils/queryProfiler.js'
import type { QueryConfig } from './config.js'

// -- 结果类型

export interface ToolExecutionResult {
  toolResults: (UserMessage | AttachmentMessage)[]
  updatedToolUseContext: ToolUseContext
  shouldPreventContinuation: boolean
  nextPendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
}

// -- 主函数

export async function* executeToolsAndBatch(
  toolUseBlocks: ToolCallBlock[],
  assistantMessages: AssistantMessage[],
  toolResults: (UserMessage | AttachmentMessage)[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  streamingToolExecutor: StreamingToolExecutor | null,
  queryTracking: { chainId: string; depth: number },
  config: QueryConfig,
): AsyncGenerator<Message | ToolUseSummaryMessage, ToolExecutionResult> {
  let shouldPreventContinuation = false
  let updatedToolUseContext = toolUseContext
  const collectedToolResults = [...toolResults]

  const queryChainIdForAnalytics =
    queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  queryCheckpoint('query_tool_execution_start')

  if (streamingToolExecutor) {
    logEvent('zy_streaming_tool_execution_used', {
      tool_count: toolUseBlocks.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })
  } else {
    logEvent('zy_streaming_tool_execution_not_used', {
      tool_count: toolUseBlocks.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })
  }

  const toolUpdates = streamingToolExecutor
    ? streamingToolExecutor.getRemainingResults()
    : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

  for await (const update of toolUpdates) {
    if (update.message) {
      yield update.message

      if (
        update.message.type === 'attachment' &&
        update.message.attachment.type === 'hook_stopped_continuation'
      ) {
        shouldPreventContinuation = true
      }

      collectedToolResults.push(
        ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools).filter(
          (_) => _.type === 'user',
        ),
      )
    }
    if (update.newContext) {
      updatedToolUseContext = {
        ...update.newContext,
        queryTracking,
      }
    }
  }
  queryCheckpoint('query_tool_execution_end')

  // PostToolBatch：一轮工具全部完成后触发一次，避免并行工具调用的 N+1 hook 抖动
  if (
    toolUseBlocks.length > 0 &&
    !toolUseContext.abortController.signal.aborted &&
    hasHookForEvent(
      'PostToolBatch',
      updatedToolUseContext.getAppState(),
      updatedToolUseContext.agentId ?? getSessionId(),
    )
  ) {
    const batchToolUses = toolUseBlocks.map((block) => {
      const resultMsg = collectedToolResults.find(
        (r) =>
          r.type === 'user' &&
          Array.isArray(r.message.content) &&
          r.message.content.some((c) => c.type === 'tool_result' && c.toolCallId === block.id),
      )
      const resultBlock =
        resultMsg?.type === 'user' && Array.isArray(resultMsg.message.content)
          ? resultMsg.message.content.find(
              (c): c is ToolResultBlock => c.type === 'tool_result' && c.toolCallId === block.id,
            )
          : undefined
      return {
        tool_name: block.name,
        tool_use_id: block.id,
        status: (resultBlock?.isError ? 'error' : 'success') as 'success' | 'error',
      }
    })
    for await (const update of executePostToolBatchHooks(batchToolUses, updatedToolUseContext)) {
      yield update.message
      if (
        update.message.type === 'attachment' &&
        update.message.attachment.type === 'hook_stopped_continuation'
      ) {
        shouldPreventContinuation = true
      }
      collectedToolResults.push(
        ...normalizeMessagesForAPI([update.message], updatedToolUseContext.options.tools).filter(
          (_) => _.type === 'user',
        ),
      )
    }
  }

  // 工具使用摘要生成
  let nextPendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  if (
    config.gates.emitToolUseSummaries &&
    toolUseBlocks.length > 0 &&
    !toolUseContext.abortController.signal.aborted &&
    !toolUseContext.agentId
  ) {
    const lastAssistantMessage = assistantMessages.at(-1)
    let lastAssistantText: string | undefined
    if (lastAssistantMessage) {
      const content = lastAssistantMessage.message.content
      const textBlocks = Array.isArray(content)
        ? content.filter(
            (block): block is TextBlock => typeof block !== 'string' && block.type === 'text',
          )
        : []
      if (textBlocks.length > 0) {
        const lastTextBlock = textBlocks.at(-1)
        if (lastTextBlock && 'text' in lastTextBlock) {
          lastAssistantText = lastTextBlock.text
        }
      }
    }

    const toolUseIds = toolUseBlocks.map((block) => block.id)
    const toolInfoForSummary = toolUseBlocks.map((block) => {
      const toolResult = collectedToolResults.find(
        (result) =>
          result.type === 'user' &&
          Array.isArray(result.message.content) &&
          result.message.content.some(
            (content) => content.type === 'tool_result' && content.toolCallId === block.id,
          ),
      )
      const resultContent =
        toolResult?.type === 'user' && Array.isArray(toolResult.message.content)
          ? toolResult.message.content.find(
              (c): c is ToolResultBlock => c.type === 'tool_result' && c.toolCallId === block.id,
            )
          : undefined
      return {
        name: block.name,
        input: block.input,
        output: resultContent && 'content' in resultContent ? resultContent.content : null,
      }
    })

    nextPendingToolUseSummary = generateToolUseSummary({
      tools: toolInfoForSummary,
      signal: toolUseContext.abortController.signal,
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
      lastAssistantText,
    })
      .then((summary) => {
        if (summary) {
          return createToolUseSummaryMessage(summary, toolUseIds)
        }
        return null
      })
      .catch(() => null)
  }

  return {
    toolResults: collectedToolResults,
    updatedToolUseContext,
    shouldPreventContinuation,
    nextPendingToolUseSummary,
  }
}
