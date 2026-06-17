import { feature } from 'bun:bundle'
import type { QuerySource } from '../constants/querySource.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js'
import type { PendingCacheEdits } from '../services/compact/microCompact.js'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logError } from '../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../utils/messages.js'
import { queryCheckpoint } from '../utils/queryProfiler.js'
import { recordContentReplacement } from '../utils/sessionStorage.js'
import { applyToolResultBudget } from '../utils/toolResultStorage.js'
import type { QueryDeps } from './deps.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js'))
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

  let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

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
      // biome-ignore lint/suspicious/noExplicitAny: feature() 条件 require 的动态模块
      const collapseResult = await (contextCollapse as any).applyCollapsesIfNeeded(
        messagesForQuery,
        updatedToolUseContext,
        querySource,
      )
      // biome-ignore lint/suspicious/noExplicitAny: feature() 条件 require 的动态模块
      messagesForQuery = (collapseResult as any).messages
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
