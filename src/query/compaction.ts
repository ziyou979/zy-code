import type { QuerySource } from '../constants/querySource.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js'
import { saveCurrentSessionCosts } from '../services/cost/costTracker.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
import type { ToolUseContext } from '../tools/tool.js'
import type { Message } from '../types/message.js'
import { appendSystemContext } from '../services/api/api.js'
import { createDebugLog } from '../services/infra/debug.js'
import { tSync } from '../i18n/index.js'
import { createAssistantAPIErrorMessage } from '../services/messages/constructors.js'
import { queryCheckpoint } from '../services/query/queryProfiler.js'
import { asSystemPrompt, type SystemPrompt } from '../services/api/systemPromptType.js'
import { finalContextTokensFromLastResponse } from '../services/api/tokens.js'
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
  const {
    compactionResult,
    consecutiveFailures,
    consecutiveRapidRefills,
    rapidRefillBreakerTripped,
  } = await deps.autocompact(
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
      // 非 rapid 成功时清零；rapid 成功则累加（由 autoCompact 计算）
      consecutiveRapidRefills: consecutiveRapidRefills ?? 0,
      rapidRefillBreakerTripped: false,
      rapidRefillBreakerNotified: false,
    }

    // 压缩会替换掉 transcript 中所有带 usage 的旧 assistant 消息，
    // resume 时的兜底恢复（reconstructCostStateFromMessages）将无源可重建
    // → 会话 cost 归零。压缩成功即持久化当前累计值
    //（sidecar + sessionCosts），使恢复优先读取持久化值。
    saveCurrentSessionCosts()

    const postCompactMessages = buildPostCompactMessages(compactionResult)

    for (const message of postCompactMessages) {
      yield message
    }

    updatedMessages = postCompactMessages
    compacted = true
  } else if (rapidRefillBreakerTripped) {
    // 熔断：停止空转 compact；文案仅首轮 yield 一次（意图对齐 CC「跳过 compact」非每轮刷屏）
    const alreadyNotified = tracking?.rapidRefillBreakerNotified === true
    updatedTracking = {
      ...(tracking ?? { compacted: true, turnId: '', turnCounter: 0 }),
      consecutiveRapidRefills: consecutiveRapidRefills ?? tracking?.consecutiveRapidRefills,
      rapidRefillBreakerTripped: true,
      rapidRefillBreakerNotified: true,
    }
    if (!alreadyNotified) {
      yield createAssistantAPIErrorMessage({
        content: tSync('compact.rapidRefillBreaker'),
      })
    }
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
