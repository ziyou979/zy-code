// messages.ts 是 messages/ 子目录的 barrel。M1-M8 重构后，所有实现已下沉到：
//   constants.ts  - 文案常量 / 分类器辅助 / SYNTHETIC_*
//   predicates.ts - 谓词 / 文本提取 / 短 ID 派生
//   constructors.ts - assistant/user/progress/system/27 个构造器
//   lookups.ts    - MessageLookups + O(1) 查询
//   prune.ts      - 内存回收 + API 兼容 strip 系列
//   normalize.ts  - normalizeMessages + merge + filter 系列
//   api.ts        - normalizeMessagesForAPI 全家 + plan/auto-mode 模板
//   streaming.ts  - handleMessageFromStream + StreamingToolUse/Thinking
// 此文件仅做公共 API re-export。

export type {
  AggregatedHookResult,
  ElicitationResponse,
  HookBlockingError,
  HookResult,
} from './hooks.js'
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
export {
  createAgentsKilledMessage,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createAwaySummaryMessage,
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
  createWireStatusMessage,
  formatCommandInputTags,
  prepareUserContent,
} from './messages/constructors.js'
export type { MessageLookups } from './messages/lookups.js'

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
export type {
  ToolUseRequestMessage,
  ToolUseResultMessage,
} from './messages/predicates.js'
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
export type { PruneResult } from './messages/prune.js'
export {
  isThinkingBlock,
  pruneCompletedTurnArtifacts,
  shrinkHistoricalProgress,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripSignatureBlocks,
  stripToolReferenceBlocksFromUserMessage,
} from './messages/prune.js'
export type { StreamingThinking, StreamingToolUse } from './messages/streaming.js'
export { handleMessageFromStream } from './messages/streaming.js'
