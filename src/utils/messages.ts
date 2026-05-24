import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'node:crypto'
import isObject from 'lodash-es/isObject.js'
import last from 'lodash-es/last.js'
import type { HookEvent, SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { areExplorePlanAgentsEnabled } from 'src/tools/AgentTool/builtInAgents.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FILE_READ_TOOL_NAME, MAX_LINES_TO_READ } from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import type { AgentId } from 'src/types/ids.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { getStrictToolResultPairing } from '../bootstrap/state.js'
import type { SpinnerMode } from '../components/Spinner.js'
import { NO_CONTENT_MESSAGE } from '../constants/messages.js'
import { OUTPUT_STYLE_CONFIG } from '../constants/outputStyles.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../constants/xml.js'
import { isAutoMemoryEnabled } from '../memdir/paths.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import {
  getImageTooLargeErrorMessage,
  getPdfInvalidErrorMessage,
  getPdfPasswordProtectedErrorMessage,
  getPdfTooLargeErrorMessage,
  getRequestTooLargeErrorMessage,
} from '../services/api/errors.js'
import { DiagnosticTrackingService } from '../services/diagnosticTracking.js'
import type { AnyObject, Progress } from '../Tool.js'
import { findToolByName, type Tool, type Tools, toolMatchesName } from '../Tool.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
} from '../tools/FileReadTool/FileReadTool.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { isConnectorTextBlock } from '../types/connectorText.js'
import type {
  APIErrorLike,
  AssistantContentBlock,
  ContentBlock,
  RedactedThinkingBlock,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  ToolCallBlock,
  ToolResultBlock,
  TokenUsage as Usage,
  UserContentBlock,
} from '../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  MessageOrigin,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  PartialCompactDirection,
  ProgressMessage,
  RequestStartEvent,
  StopHookInfo,
  StreamEvent,
  SystemAgentsKilledMessage,
  SystemAPIErrorMessage,
  SystemAwaySummaryMessage,
  SystemBridgeStatusMessage,
  SystemCompactBoundaryMessage,
  SystemInformationalMessage,
  SystemLocalCommandMessage,
  SystemMemorySavedMessage,
  SystemMessage,
  SystemMessageLevel,
  SystemMicrocompactBoundaryMessage,
  SystemPermissionRetryMessage,
  SystemScheduledTaskFireMessage,
  SystemStopHookSummaryMessage,
  SystemTurnDurationMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../types/message.js'
import type { PermissionMode } from '../types/permissions.js'
import { isAdvisorBlock } from './advisor.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { normalizeToolInput, normalizeToolInputForAPI } from './api.js'
import { count } from './array.js'
import { type Attachment, memoryHeader } from './attachments.js'
import { quote } from 'src/shell-eval/bash/shellQuote.js'
import { getCurrentProjectConfig } from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import { stripIdeContextTags } from './displayTags.js'
import { hasEmbeddedSearchTools } from './embeddedTools.js'
import { isInternalBuild } from './envUtils.js'
import { formatFileSize, formatNumber, formatTokens } from './format.js'
import { validateImagesForAPI } from './imageValidation.js'
import { safeParseJSON } from './json.js'
import { logError, logMCPDebug } from './log.js'
import { normalizeLegacyToolName } from './permissions/permissionRuleParser.js'
import {
  getPewterLedgerVariant,
  getPlanModeV2AgentCount,
  getPlanModeV2ExploreAgentCount,
  isPlanModeInterviewPhaseEnabled,
} from './planModeV2.js'
import { jsonStringify } from './slowOperations.js'
import { escapeRegExp } from './stringUtils.js'
import { isTodoV2Enabled } from './tasks.js'
import { isToolReferenceBlock, isToolSearchEnabledOptimistic } from './toolSearch.js'

export {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  CANCEL_MESSAGE,
  DENIAL_WORKAROUND_GUIDANCE,
  DONT_ASK_REJECT_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isClassifierDenial,
  isSyntheticMessage,
  NO_RESPONSE_REQUESTED,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_MODEL,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from './messages/constants.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SYNTHETIC_MODEL,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from './messages/constants.js'
export {
  countToolCalls,
  deriveShortMessageId,
  deriveUUID,
  extractTag,
  extractTextContent,
  findLastCompactBoundaryIndex,
  getAssistantMessageText,
  getContentText,
  getLastAssistantMessage,
  getMessagesAfterCompactBoundary,
  getToolUseID,
  getUserMessageText,
  hasSuccessfulToolCall,
  hasToolCallsInLastAssistantTurn,
  isCompactBoundaryMessage,
  isEmptyMessageText,
  isNotEmptyMessage,
  isSystemLocalCommandMessage,
  isThinkingMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  shouldShowUserMessage,
  stripPromptXMLTags,
  textForResubmit,
  withMemoryCorrectionHint,
} from './messages/predicates.js'
export type {
  ToolUseRequestMessage,
  ToolUseResultMessage,
} from './messages/predicates.js'
export {
  createAgentsKilledMessage,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createAwaySummaryMessage,
  createBridgeStatusMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMemorySavedMessage,
  createMicrocompactBoundaryMessage,
  createModelSwitchBreadcrumbs,
  createPermissionRetryMessage,
  createProgressMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createSyntheticUserCaveatMessage,
  createSystemAPIErrorMessage,
  createSystemMessage,
  createToolResultStopMessage,
  createToolUseSummaryMessage,
  createTurnDurationMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  prepareUserContent,
} from './messages/constructors.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createToolUseMessage,
  createUserMessage,
} from './messages/constructors.js'
export {
  buildMessageLookups,
  buildSubagentLookups,
  EMPTY_LOOKUPS,
  EMPTY_STRING_SET,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDs,
  getSiblingToolUseIDsFromLookup,
  getToolResultIDs,
  getToolUseIDs,
  hasUnresolvedHooks,
  hasUnresolvedHooksFromLookup,
} from './messages/lookups.js'
export type { MessageLookups } from './messages/lookups.js'
export {
  isThinkingBlock,
  pruneCompletedTurnArtifacts,
  shrinkHistoricalProgress,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripSignatureBlocks,
  stripToolReferenceBlocksFromUserMessage,
} from './messages/prune.js'
export type { PruneResult } from './messages/prune.js'
import {
  isThinkingBlock,
  stripToolReferenceBlocksFromUserMessage,
} from './messages/prune.js'
export {
  ensureNonEmptyAssistantContent,
  filterOrphanedThinkingOnlyMessages,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistantMessages,
  mergeAdjacentUserMessages,
  mergeAssistantMessages,
  mergeUserContentBlocks,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
  normalizeContentFromAPI,
  normalizeMessages,
} from './messages/normalize.js'
import {
  ensureNonEmptyAssistantContent,
  filterOrphanedThinkingOnlyMessages,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistantMessages,
  isToolResultMessage,
  mergeAdjacentUserMessages,
  mergeAssistantMessages,
  mergeUserMessages,
  mergeUserMessagesAndToolResults,
  smooshIntoToolResult,
} from './messages/normalize.js'
import {
  buildMessageLookups,
  EMPTY_LOOKUPS,
  EMPTY_STRING_SET,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDs,
  getSiblingToolUseIDsFromLookup,
  getToolUseIDs,
  hasUnresolvedHooks,
  hasUnresolvedHooksFromLookup,
  type MessageLookups,
} from './messages/lookups.js'
import {
  deriveShortMessageId,
  deriveUUID,
  extractTag,
  extractTextContent,
  findLastCompactBoundaryIndex,
  getContentText,
  getMessagesAfterCompactBoundary,
  getToolUseID,
  getUserMessageText,
  isCompactBoundaryMessage,
  isHookAttachmentMessage,
  isNotEmptyMessage,
  isSystemLocalCommandMessage,
  isThinkingMessage,
  isToolUseRequestMessage,
  isToolUseResultMessage,
  stripPromptXMLTags,
  type ToolUseRequestMessage,
  type ToolUseResultMessage,
} from './messages/predicates.js'

export {
  ensureToolResultPairing,
  filterUnresolvedToolUses,
  normalizeAttachmentForAPI,
  normalizeMessagesForAPI,
  reorderAttachmentsForAPI,
  reorderMessagesInUI,
  wrapCommandText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
} from './messages/api.js'

/**
 * 从内容块数组中提取文本，用给定分隔符连接文本块。
 * 通过结构化类型兼容 ContentBlock 及其 readonly/DeepImmutable 变体。
 */
export type StreamingToolUse = {
  index: number
  contentBlock: ToolCallBlock
  unparsedToolInput: string
}

export type StreamingThinking = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}

/**
 * 处理来自流的消息，更新增量的响应长度并追加已完成的消息
 */
export function handleMessageFromStream(
  message: Message | TombstoneMessage | StreamEvent | RequestStartEvent | ToolUseSummaryMessage,
  onMessage: (message: Message) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: SpinnerMode) => void,
  onStreamingToolUses: (f: (streamingToolUse: StreamingToolUse[]) => StreamingToolUse[]) => void,
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: (
    f: (current: StreamingThinking | null) => StreamingThinking | null,
  ) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void {
  if (message.type !== 'stream_event' && message.type !== 'stream_request_start') {
    const _msg = message as Message | StreamEvent | RequestStartEvent | TombstoneMessage
    // 处理 tombstone 消息 — 移除目标消息而非添加
    if (message.type === 'system' && message.subtype === 'tombstone') {
      onTombstone?.(message.message)
      return
    }
    // Tool use summary 消息仅限 SDK，流处理中忽略它们
    if (message.type === 'tool_use_summary') {
      return
    }
    // 在 transcript 模式下捕获完整的 thinking 块用于实时显示
    if (message.type === 'assistant') {
      const content = message.message.content
      const thinkingBlock = Array.isArray(content)
        ? content.find((block) => block.type === 'thinking')
        : undefined
      if (thinkingBlock && thinkingBlock.type === 'thinking') {
        onStreamingThinking?.(() => ({
          thinking: thinkingBlock.thinking,
          isStreaming: false,
          streamingEndedAt: Date.now(),
        }))
      }
    }
    // 立即清除流式 text，使渲染能在同一批中将 displayedMessages
    // 从 deferredMessages 切换到 messages，让流式 text → 最终消息的
    // 过渡是原子的（无间隙、无重复）。
    onStreamingText?.(() => null)
    onMessage(message)
    return
  }

  if (message.type === 'stream_request_start') {
    onSetStreamMode('requesting')
    return
  }

  if (message.event.type === 'message_stop' || message.event.type === 'response_stop') {
    onSetStreamMode('tool-use')
    onStreamingToolUses(() => [])
    return
  }

  switch (message.event.type) {
    // 标准格式（adapter 转换后）
    case 'chunk_start': {
      onStreamingText?.(() => null)
      const startEvent = message.event as unknown as import('../types/llm.js').ChunkStartEvent
      const chunk = startEvent.chunk
      if (!chunk) {
        return
      }
      if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(chunk)) {
        onSetStreamMode('responding')
        return
      }
      // chunk.type 可能包含扩展类型（server_tool_use 等），用 string 避免穷举
      const chunkType: string = chunk.type
      switch (chunkType) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use':
        case 'tool_call': {
          onSetStreamMode('tool-input')
          onStreamingToolUses((_) => [
            ..._,
            {
              index: startEvent.index,
              contentBlock: chunk as import('../types/llm.js').ToolCallBlock,
              unparsedToolInput: '',
            },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    }
    case 'chunk_delta': {
      const deltaEvent = message.event as unknown as import('../types/llm.js').ChunkDeltaEvent
      const delta = deltaEvent.delta
      if (!delta) {
        return
      }
      switch (delta.type) {
        case 'text_delta': {
          const deltaText = delta.text
          onUpdateLength(deltaText)
          onStreamingText?.((text) => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          const partialJson = delta.partialJson ?? ''
          onUpdateLength(partialJson)
          onStreamingToolUses((_) => {
            const element = _.find((_) => _.index === deltaEvent.index)
            if (!element) {
              return _
            }
            return [
              ..._.filter((_) => _ !== element),
              {
                ...element,
                unparsedToolInput: element.unparsedToolInput + partialJson,
              },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(delta.thinking)
          return
        case 'signature_delta':
          return
        default:
          return
      }
    }
    case 'chunk_stop':
      return
    case 'response_delta':
      onSetStreamMode('responding')
      return
    case 'response_start':
      return

    // 旧格式（向后兼容）
    case 'content_block_start':
      onStreamingText?.(() => null)
      if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(message.event.content_block)) {
        onSetStreamMode('responding')
        return
      }
      switch (message.event.content_block.type) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use': {
          onSetStreamMode('tool-input')
          const contentBlock = message.event.content_block
          const index = message.event.index
          onStreamingToolUses((_) => [
            ..._,
            {
              index,
              contentBlock,
              unparsedToolInput: '',
            },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    case 'content_block_delta':
      switch (message.event.delta.type) {
        case 'text_delta': {
          const deltaText = message.event.delta.text
          onUpdateLength(deltaText)
          onStreamingText?.((text) => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          // 标准层统一使用驼峰 partialJson（见 types/llm.ts ToolCallInputDelta）
          const delta = message.event.delta.partialJson ?? ''
          const index = message.event.index
          onUpdateLength(delta)
          onStreamingToolUses((_) => {
            const element = _.find((_) => _.index === index)
            if (!element) {
              return _
            }
            return [
              ..._.filter((_) => _ !== element),
              {
                ...element,
                unparsedToolInput: element.unparsedToolInput + delta,
              },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(message.event.delta.thinking)
          return
        case 'signature_delta':
          // Signature 是加密认证字符串，不是模型输出。将其排除在 onUpdateLength 之外
          // 可防止它们膨胀 OTPS 指标和动画 token 计数器。
          return
        default:
          return
      }
    case 'content_block_stop':
      return
    case 'message_delta':
      onSetStreamMode('responding')
      return
    default:
      onSetStreamMode('responding')
      return
  }
}
