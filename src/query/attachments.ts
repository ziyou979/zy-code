import { feature } from 'bun:bundle'
import type { QuerySource } from '../constants/querySource.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { ToolUseContext } from '../tool.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import type { ToolCallBlock } from '../types/llm.js'
import type { AssistantMessage, AttachmentMessage, Message, UserMessage } from '../types/message.js'
import { count } from '../utils/array.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../services/attachments/attachments.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import {
  getCommandsByMaxPriority,
  isSlashCommand,
  remove as removeFromQueue,
} from '../utils/messageQueueManager.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('../utils/taskSummary.js') as typeof import('../utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// -- 结果类型

export interface AttachmentInjectionResult {
  toolResults: (UserMessage | AttachmentMessage)[]
  updatedToolUseContext: ToolUseContext
  consumedCommandUuids: string[]
}

// -- 主函数

export async function* injectAttachments(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  toolResults: (UserMessage | AttachmentMessage)[],
  toolUseBlocks: ToolCallBlock[],
  toolUseContext: ToolUseContext,
  queryTracking: { chainId: string; depth: number },
  querySource: QuerySource,
  params: {
    systemPrompt: import('../utils/systemPromptType.js').SystemPrompt
    userContext: Record<string, string>
    systemContext: Record<string, string>
  },
): AsyncGenerator<Message, AttachmentInjectionResult> {
  let updatedToolUseContext = toolUseContext
  const collectedToolResults = [...toolResults]
  const consumedCommandUuids: string[] = []

  const queryChainIdForAnalytics =
    queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  logEvent('zy_query_before_attachments', {
    messagesForQueryCount: messagesForQuery.length,
    assistantMessagesCount: assistantMessages.length,
    toolResultsCount: collectedToolResults.length,
    queryChainId: queryChainIdForAnalytics,
    queryDepth: queryTracking.depth,
  })

  // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolCallBlock.name has no aliases
  const sleepRan = toolUseBlocks.some((b) => b.name === SLEEP_TOOL_NAME)
  const isMainThread = querySource.startsWith('repl_main_thread') || querySource === 'sdk'
  const currentAgentId = toolUseContext.agentId
  const queuedCommandsSnapshot = getCommandsByMaxPriority(sleepRan ? 'later' : 'next').filter(
    (cmd) => {
      if (isSlashCommand(cmd)) {
        return false
      }
      if (isMainThread) {
        return cmd.agentId === undefined
      }
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    },
  )

  for await (const attachment of getAttachmentMessages(
    null,
    updatedToolUseContext,
    null,
    queuedCommandsSnapshot,
    [...messagesForQuery, ...assistantMessages, ...collectedToolResults],
    querySource,
  )) {
    yield attachment
    collectedToolResults.push(attachment)
  }

  const consumedCommands = queuedCommandsSnapshot.filter(
    (cmd) => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
  )
  if (consumedCommands.length > 0) {
    for (const cmd of consumedCommands) {
      if (cmd.uuid) {
        consumedCommandUuids.push(cmd.uuid)
        notifyCommandLifecycle(cmd.uuid, 'started')
      }
    }
    removeFromQueue(consumedCommands)
  }

  const fileChangeAttachmentCount = count(
    collectedToolResults,
    (tr) => tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
  )

  logEvent('zy_query_after_attachments', {
    totalToolResultsCount: collectedToolResults.length,
    fileChangeAttachmentCount,
    queryChainId: queryChainIdForAnalytics,
    queryDepth: queryTracking.depth,
  })

  // 刷新工具列表
  if (updatedToolUseContext.options.refreshTools) {
    const refreshedTools = updatedToolUseContext.options.refreshTools()
    if (refreshedTools !== updatedToolUseContext.options.tools) {
      updatedToolUseContext = {
        ...updatedToolUseContext,
        options: {
          ...updatedToolUseContext.options,
          tools: refreshedTools,
        },
      }
    }
  }

  // 任务摘要
  if (feature('BG_SESSIONS')) {
    if (!toolUseContext.agentId && taskSummaryModule!.shouldGenerateTaskSummary()) {
      taskSummaryModule!.maybeGenerateTaskSummary({
        systemPrompt: params.systemPrompt,
        userContext: params.userContext,
        systemContext: params.systemContext,
        toolUseContext,
        forkContextMessages: [...messagesForQuery, ...assistantMessages, ...collectedToolResults],
      })
    }
  }

  return {
    toolResults: collectedToolResults,
    updatedToolUseContext,
    consumedCommandUuids,
  }
}
