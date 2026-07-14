import type { QuerySource } from '../constants/querySource.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
import type { ToolUseContext } from '../tool.js'
import type { Message } from '../types/message.js'
import { appendSystemContext } from '../utils/api.js'
import { createDebugLog } from '../utils/debug.js'
import { queryCheckpoint } from '../utils/queryProfiler.js'
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js'
import { finalContextTokensFromLastResponse } from '../utils/tokens.js'
import type { QueryDeps } from './deps.js'

const log = createDebugLog('query:compaction')

// -- 结果类型

export interface CompactionOutcome {
  messagesForQuery: Message[]
  tracking: AutoCompactTrackingState | undefined
  compacted: boolean
  taskBudgetConsumed: number | undefined
  fullSystemPrompt: SystemPrompt
}

// -- 主函数

export async function* runCompaction(
  messagesForQuery: Message[],
  toolUseContext: ToolUseContext,
  tracking: AutoCompactTrackingState | undefined,
  params: {
    systemPrompt: SystemPrompt
    userContext: Record<string, string>
    systemContext: Record<string, string>
    querySource: QuerySource
    taskBudget: { total: number } | undefined
  },
  analytics: {
    queryChainId: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    queryDepth: number
  },
  deps: Pick<QueryDeps, 'autocompact' | 'uuid'>,
): AsyncGenerator<Message, CompactionOutcome> {
  const fullSystemPrompt = asSystemPrompt(
    appendSystemContext(params.systemPrompt, params.systemContext),
  )

  queryCheckpoint('query_autocompact_start')
  const { compactionResult, consecutiveFailures } = await deps.autocompact(
    messagesForQuery,
    toolUseContext,
    {
      systemPrompt: params.systemPrompt,
      userContext: params.userContext,
      systemContext: params.systemContext,
      toolUseContext,
      forkContextMessages: messagesForQuery,
    },
    params.querySource,
    tracking,
  )
  queryCheckpoint('query_autocompact_end')

  let updatedMessages = messagesForQuery
  let updatedTracking = tracking
  let compacted = false
  let taskBudgetConsumed: number | undefined

  if (compactionResult) {
    const {
      preCompactTokenCount,
      postCompactTokenCount,
      truePostCompactTokenCount,
      compactionUsage,
    } = compactionResult

    log(
      `autocompact triggered: ${preCompactTokenCount} -> ${postCompactTokenCount} tokens (true=${truePostCompactTokenCount})`,
    )
    logEvent('zy_auto_compact_succeeded', {
      originalMessageCount: messagesForQuery.length,
      compactedMessageCount:
        compactionResult.summaryMessages.length +
        compactionResult.attachments.length +
        compactionResult.hookResults.length,
      preCompactTokenCount,
      postCompactTokenCount,
      truePostCompactTokenCount,
      compactionInputTokens: compactionUsage?.inputTokens,
      compactionOutputTokens: compactionUsage?.outputTokens,
      compactionCacheReadTokens: compactionUsage?.cacheReadInputTokens ?? 0,
      compactionCacheCreationTokens: compactionUsage?.cacheCreationInputTokens ?? 0,
      compactionTotalTokens: compactionUsage
        ? compactionUsage.inputTokens +
          (compactionUsage.cacheCreationInputTokens ?? 0) +
          (compactionUsage.cacheReadInputTokens ?? 0) +
          compactionUsage.outputTokens
        : 0,

      queryChainId: analytics.queryChainId,
      queryDepth: analytics.queryDepth,
    })

    if (params.taskBudget) {
      taskBudgetConsumed = finalContextTokensFromLastResponse(messagesForQuery)
    }

    updatedTracking = {
      compacted: true,
      turnId: deps.uuid(),
      turnCounter: 0,
      consecutiveFailures: 0,
    }

    const postCompactMessages = buildPostCompactMessages(compactionResult)

    for (const message of postCompactMessages) {
      yield message
    }

    updatedMessages = postCompactMessages
    compacted = true
  } else if (consecutiveFailures !== undefined) {
    updatedTracking = {
      ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
      consecutiveFailures,
    }
  }

  return {
    messagesForQuery: updatedMessages,
    tracking: updatedTracking,
    compacted,
    taskBudgetConsumed,
    fullSystemPrompt,
  }
}
