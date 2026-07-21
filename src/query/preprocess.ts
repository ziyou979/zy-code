import { feature } from 'bun:bundle'
import type { QuerySource } from '../constants/querySource.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js'
import type { PendingCacheEdits } from '../services/compact/microCompact.js'
import type { ToolUseContext } from '../tools/tool.js'
import type { Message } from '../types/message.js'
import { logError } from '../services/infra/log.js'
import { getMessagesAfterCompactBoundary } from '../services/messages/./predicates.js'
import { queryCheckpoint } from '../services/query/queryProfiler.js'
import { recordContentReplacement } from '../services/sessionStorage.js'
import { applyToolResultBudget } from '../services/mcp/toolResultStorage.js'
import type { QueryDeps } from './deps.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// -- 结果类型

export interface PreprocessResult {
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  tracking: AutoCompactTrackingState | undefined
  queryTracking: { chainId: string; depth: number }
  queryChainIdForAnalytics: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  pendingCacheEdits: PendingCacheEdits | undefined
}

// -- 主函数

export async function preprocessMessages(
  messages: Message[],
  toolUseContext: ToolUseContext,
  autoCompactTracking: AutoCompactTrackingState | undefined,
  querySource: QuerySource,
  deps: Pick<QueryDeps, 'microcompact' | 'uuid'>,
): Promise<PreprocessResult> {
  // 1. 初始化或递增查询链跟踪
  const queryTracking = toolUseContext.queryTracking
    ? {
        chainId: toolUseContext.queryTracking.chainId,
        depth: toolUseContext.queryTracking.depth + 1,
      }
    : {
        chainId: deps.uuid(),
        depth: 0,
      }

  const queryChainIdForAnalytics =
    queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  const updatedToolUseContext: ToolUseContext = {
    ...toolUseContext,
    queryTracking,
  }

  let messagesForQuery = getMessagesAfterCompactBoundary(messages)

  const tracking = autoCompactTracking

  // 2. 工具结果预算
  const persistReplacements =
    querySource.startsWith('agent:') || querySource.startsWith('repl_main_thread')
  messagesForQuery = await applyToolResultBudget(
    messagesForQuery,
    updatedToolUseContext.contentReplacementState,
    persistReplacements
      ? (records) =>
          void recordContentReplacement(records, updatedToolUseContext.agentId).catch(logError)
      : undefined,
    new Set(
      updatedToolUseContext.options.tools
        .filter((t) => !Number.isFinite(t.maxResultSizeChars))
        .map((t) => t.name),
    ),
  )

  // 3. Microcompact
  queryCheckpoint('query_microcompact_start')
  const microcompactResult = await deps.microcompact(
    messagesForQuery,
    updatedToolUseContext,
    querySource,
  )
  messagesForQuery = microcompactResult.messages
  const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
    ? microcompactResult.compactionInfo?.pendingCacheEdits
    : undefined
  queryCheckpoint('query_microcompact_end')

  // 4. Context Collapse — 投射折叠视图
  if (feature('CONTEXT_COLLAPSE')) {
    if (contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        updatedToolUseContext,
        querySource,
      )
      messagesForQuery = (collapseResult as { messages: typeof messagesForQuery }).messages
    }
  }

  return {
    messagesForQuery,
    toolUseContext: updatedToolUseContext,
    tracking,
    queryTracking,
    queryChainIdForAnalytics,
    pendingCacheEdits,
  }
}
