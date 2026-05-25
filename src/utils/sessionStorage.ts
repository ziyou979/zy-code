// sessionStorage.ts 是 sessionStorage/ 子目录的 barrel。S1-S8 重构后，所有实现下沉到：
//   paths.ts           - 项目 / transcript / agent 路径解析（含 memoized getProjectDir）
//   env.ts             - NODE_ENV / USER_TYPE / entrypoint getters
//   predicates.ts      - transcript / chain / ephemeral 谓词
//   agentMetadata.ts   - sidecar JSON 元数据 (AgentMetadata / RemoteAgentMetadata)
//   chain.ts           - buildConversationChain + 保留段 / snip / 孤儿恢复
//   logLoading.ts      - 全部从磁盘读：loadTranscriptFile / 列表 / 修复 UUID 链
//   project.ts         - Project singleton + 内存 ring buffer + flush 调度
//   transcript.ts      - 写路径：record* / hydrate* / appendEntryToFile
//   sessionMetadata.ts - save* / get* / restore* / cache* 标题 / 标签 / 模式
// 此文件仅做公共 API re-export。

export {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  MAX_TRANSCRIPT_READ_BYTES,
  setAgentTranscriptSubdir,
} from './sessionStorage/paths.js'

export {
  getNodeEnv,
  getUserType,
  isCustomTitleEnabled,
} from './sessionStorage/env.js'

export {
  isChainParticipant,
  isEphemeralToolProgress,
  isTranscriptMessage,
  sessionIdExists,
} from './sessionStorage/predicates.js'

export {
  deleteRemoteAgentMetadata,
  listRemoteAgentMetadata,
  readAgentMetadata,
  readRemoteAgentMetadata,
  writeAgentMetadata,
  writeRemoteAgentMetadata,
} from './sessionStorage/agentMetadata.js'
export type {
  AgentMetadata,
  RemoteAgentMetadata,
} from './sessionStorage/agentMetadata.js'

export {
  buildConversationChain,
  checkResumeConsistency,
  getFirstMeaningfulUserMessageTextContent,
  removeExtraFields,
} from './sessionStorage/chain.js'

export {
  cleanMessagesForLogging,
  clearSessionMessagesCache,
  doesMessageExistInSession,
  enrichLogs,
  extractAgentIdsFromMessages,
  extractTeammateTranscriptsFromTasks,
  findUnresolvedToolUse,
  getAgentTranscript,
  getLastSessionLog,
  getLogByIndex,
  getSessionFilesLite,
  getSessionFilesWithMtime,
  getSessionIdFromLog,
  isLiteLog,
  isLoggableMessage,
  loadAllLogsFromSessionFile,
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadAllSubagentTranscriptsFromDisk,
  loadFullLog,
  loadMessageLogs,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
  loadSubagentTranscripts,
  loadTranscriptFile,
  loadTranscriptFromFile,
  searchSessionsByCustomTitle,
} from './sessionStorage/logLoading.js'
export type { SessionLogResult } from './sessionStorage/logLoading.js'

export {
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  setInternalEventReader,
  setInternalEventWriter,
  setRemoteIngressUrlForTesting,
  setSessionFileForTesting,
} from './sessionStorage/project.js'

export {
  adoptResumedSessionFile,
  appendEntryToFile,
  flushSessionStorage,
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  readFileTailSync,
  recordAttributionSnapshot,
  recordContentReplacement,
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
  recordFileHistorySnapshot,
  recordQueueOperation,
  recordSidechainTranscript,
  recordTranscript,
  removeTranscriptMessage,
  resetSessionFilePointer,
} from './sessionStorage/transcript.js'
export type { TeamInfo } from './sessionStorage/transcript.js'

export {
  cacheSessionTitle,
  clearSessionMetadata,
  getCurrentSessionAgentColor,
  getCurrentSessionTag,
  getCurrentSessionTitle,
  linkSessionToPR,
  reAppendSessionMetadata,
  restoreSessionMetadata,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveMode,
  saveTag,
  saveTaskSummary,
  saveWorktreeState,
} from './sessionStorage/sessionMetadata.js'
