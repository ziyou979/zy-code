/**
 * Reconstructed message types for the ZY Code CLI.
 * Derived from usage patterns across the codebase.
 */

import type { UUID } from 'node:crypto'
import type { Progress } from '../Tool.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type {
  AssistantContentBlock,
  LLMAssistantMessage,
  LLMError,
  ToolCallBlock,
  UserContentBlock,
} from './llm.js'

// ============================================================
// Core Message Types
// ============================================================

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; channel: string; server?: string }
  | { kind: 'skill'; skill: string }
  | { kind: 'hook'; hookName: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'teammate'; agentId: string; teamName: string }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }

export type PartialCompactDirection = 'forward' | 'backward'

export interface BaseMessage {
  uuid: string
  timestamp: string
  isMeta?: boolean
}

// ============================================================
// Assistant Message
// ============================================================

export interface AssistantMessage extends BaseMessage {
  type: 'assistant'
  message: LLMAssistantMessage

  // ── 运行时元数据 ──
  requestId?: string
  isApiErrorMessage?: boolean
  apiError?: LLMError
  error?: unknown
  errorDetails?: string
  isVirtual?: true
  advisorModel?: string
}


// ============================================================
// User Message
// ============================================================

export interface UserMessage extends BaseMessage {
  type: 'user'
  message: {
    role: 'user'
    content: UserContentBlock[]
  }

  // ── 运行时元数据 ──
  isVirtual?: true
  isVisibleInTranscriptOnly?: true
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  sourceToolUseID?: string
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  planContent?: string
}


// ============================================================
// Progress Message
// ============================================================

export interface ProgressMessage<P extends Progress = Progress> extends BaseMessage {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
}

// ============================================================
// Attachment Message
// ============================================================

export type AttachmentContent =
  | { type: 'file'; path: string; content: string }
  | { type: 'image'; path: string; data: string }
  | { type: 'diagnostics'; files: Array<{ path: string; diagnostics: unknown[] }> }
  | { type: 'hook_blocking_error'; hookName: string; error: string }
  | { type: 'hook_cancelled'; hookName: string }
  | { type: 'hook_error_during_execution'; hookName: string; error: string }
  | { type: 'hook_non_blocking_error'; hookName: string; error: string }
  | { type: 'hook_success'; hookName: string }
  | { type: 'hook_system_message'; hookName: string; message: string }
  | { type: 'hook_additional_context'; hookName: string; content: string }
  | { type: 'hook_stopped_continuation'; hookName: string }
  | { type: 'memory'; content: string }
  | { type: 'reasoning'; level: string }
  | { type: 'text'; content: string }

export interface AttachmentMessage<T extends Record<string, unknown> = { type: string }>
  extends BaseMessage {
  type: 'attachment'
  attachment: T & {
    type: string
    origin?: MessageOrigin
    content?: AttachmentContent
    files?: Array<{ path: string; diagnostics: unknown[] }>
  }
}

export type AttachmentMessageType = AttachmentMessage

// ============================================================
// System Messages
// ============================================================

export type SystemMessageLevel = 'info' | 'warn' | 'error'

export interface SystemInformationalMessage extends BaseMessage {
  type: 'system'
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  toolUseID?: string
  preventContinuation?: true
}

export interface SystemAPIErrorMessage extends BaseMessage {
  type: 'system'
  subtype: 'api_error'
  content?: string
  level: 'error'
  cause?: Error
  error?: LLMError
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
}

export interface SystemPermissionRetryMessage extends BaseMessage {
  type: 'system'
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: 'info'
}

export interface SystemBridgeStatusMessage extends BaseMessage {
  type: 'system'
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export interface SystemLocalCommandMessage extends BaseMessage {
  type: 'system'
  subtype: 'local_command'
  content: string
  level?: string
}

export interface SystemAwaySummaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'away_summary'
  content: string
}

export interface SystemCompactBoundaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'compact_boundary'
  content: string
  compactMetadata: CompactMetadata
  level?: string
}

export interface SystemFileSnapshotMessage extends BaseMessage {
  type: 'system'
  subtype: 'file_snapshot'
  content: string
  snapshotFiles: Array<{
    key: string
    path: string
    content: string
  }>
}

export interface SystemMicrocompactBoundaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'microcompact_boundary'
  content: string
  level?: string
  microcompactMetadata?: {
    trigger: string
    preTokens: number
    tokensSaved?: number
    compactedToolIds?: string[]
    clearedAttachmentUUIDs?: string[]
  }
}

export interface SystemScheduledTaskFireMessage extends BaseMessage {
  type: 'system'
  subtype: 'scheduled_task_fire'
  content: string
}

export interface SystemTurnDurationMessage extends BaseMessage {
  type: 'system'
  subtype: 'turn_duration'
  content?: string
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export interface SystemAgentsKilledMessage extends BaseMessage {
  type: 'system'
  subtype: 'agents_killed'
  content?: string
}

export interface ToolUseSummaryMessage extends BaseMessage {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  content?: string
}

export interface TombstoneMessage extends BaseMessage {
  type: 'system'
  subtype: 'tombstone'
  content: string
  message: Message
}

export interface SystemStopHookSummaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'stop_hook_summary'
  content: string | undefined
  hookInfos: StopHookInfo[]
  hookCount?: number
  hookErrors?: string[]
  preventedContinuation?: boolean
  stopReason?: string
  hasOutput?: boolean
  level?: string
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export interface SystemMemorySavedMessage extends BaseMessage {
  teamCount: number
  type: 'system'
  subtype: 'memory_saved'
  content?: string
  writtenPaths?: string[]
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemAPIErrorMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemLocalCommandMessage
  | SystemAwaySummaryMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemScheduledTaskFireMessage
  | SystemTurnDurationMessage
  | SystemAgentsKilledMessage
  | ToolUseSummaryMessage
  | TombstoneMessage
  | SystemStopHookSummaryMessage
  | SystemMemorySavedMessage

// ============================================================
// Hook Result / Stream Events
// ============================================================

export interface HookResultMessage extends BaseMessage {
  type: 'hook_result'
  data: {
    type: string
    hookEvent?: string
    [key: string]: unknown
  }
}

export interface StreamEvent extends BaseMessage {
  type: 'stream_event'
  event: {
    type: string
    content_block?: any
    delta?: any
    index?: number
    [key: string]: unknown
  }
  data?: unknown
  ttftMs?: number
}

export interface RequestStartEvent extends BaseMessage {
  type: 'request_start'
  requestId: string
  model: string
}

export interface StreamRequestStartEvent extends BaseMessage {
  type: 'stream_request_start'
}

export interface StopHookInfo {
  hookName: string
  status: string
  duration?: number
  durationMs?: number
  command?: string
}

// ============================================================
// Grouped / Collapsed Messages
// ============================================================

export interface GroupedToolUseMessage extends BaseMessage {
  type: 'grouped_tool_use'
  toolUses: ToolCallBlock[]
  toolName: string
  messages: AssistantMessage[]
  results: UserMessage[]
  displayMessage: AssistantMessage
  messageId?: string
}

export interface CollapsedReadSearchGroup extends BaseMessage {
  teamMemoryWriteCount: number
  teamMemoryReadCount: number
  teamMemorySearchCount: number
  type: 'collapsed_read_search'
  content: string
  collapsedCount: number
  searchCount?: number
  readCount?: number
  listCount?: number
  replCount?: number
  memorySearchCount?: number
  memoryReadCount?: number
  memoryWriteCount?: number
  messages?: AssistantMessage[]
  displayMessage?: AssistantMessage
  mcpCallCount?: number
  bashCount?: number
  gitOpBashCount?: number
  readFilePaths?: string[]
  searchArgs?: unknown
  latestDisplayHint?: string
  hookInfos?: StopHookInfo[]
  hookCount?: number
  hookTotalMs?: number
  relevantMemories?: unknown[]
  commits?: { sha: string }[]
  pushes?: { branch: string }[]
  branches?: unknown[]
  prs?: unknown[]
  mcpServerNames?: string[]
}

export interface GroupedToolUseMessageWithMessages extends BaseMessage {
  type: 'grouped_tool_use'
  toolName: string
  messages: AssistantMessage[]
}

export type CollapsibleMessage = AssistantMessage | GroupedToolUseMessageWithMessages

// ============================================================
// Compact Metadata
// ============================================================

export interface CompactMetadata {
  trigger: string
  preTokens: number
  userContext?: string
  preservedSegment?: {
    headUuid: string
    anchorUuid: string
    tailUuid: string
  }
  messagesSummarized?: number
}

// ============================================================
// Renderable / Normalized Message Union
// ============================================================

export type RenderableMessage =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage
  | CollapsedReadSearchGroup
  | GroupedToolUseMessage
  | GroupedToolUseMessageWithMessages


// ============================================================
// Main Message Union
// ============================================================

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | StreamEvent
  | StreamRequestStartEvent
  | RequestStartEvent
  | HookResultMessage
  | ToolUseSummaryMessage
  | TombstoneMessage
