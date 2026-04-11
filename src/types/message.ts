/**
 * Reconstructed message types for the ZY Code CLI.
 * Derived from usage patterns across the codebase.
 */

import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { APIError } from '@anthropic-ai/sdk'
import type { UUID } from 'crypto'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type { Progress } from '../Tool.js'

// ============================================================
// Core Message Types
// ============================================================

export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; channel: string }
  | { kind: 'skill'; skill: string }
  | { kind: 'hook'; hookName: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'teammate'; agentId: string; teamName: string }

export type PartialCompactDirection = 'forward' | 'backward'

export interface BaseMessage {
  uuid: UUID | string
  timestamp: string
  isMeta?: true
}

// ============================================================
// Assistant Message
// ============================================================

export interface AssistantMessage extends BaseMessage {
  type: 'assistant'
  message: BetaMessage & {
    container: null
    context_management: null | Record<string, unknown>
  }
  requestId?: string
  isApiErrorMessage?: boolean
  apiError?: APIError
  error?: unknown
  errorDetails?: string
  isVirtual?: true
  advisorModel?: string
}

export interface NormalizedAssistantMessage extends BaseMessage {
  type: 'assistant'
  message: Omit<BetaMessage, 'content'> & {
    content: BetaContentBlock[]
    context_management: null | Record<string, unknown>
  }
  requestId?: string
  isApiErrorMessage?: boolean
  apiError?: APIError
  error?: unknown
  isVirtual?: true
  isMeta?: true
  advisorModel?: string
}

// ============================================================
// User Message
// ============================================================

export interface UserMessage extends BaseMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | BetaContentBlockParam[]
  }
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
  permissionMode?: PermissionMode
  origin?: MessageOrigin
}

export interface NormalizedUserMessage extends BaseMessage {
  type: 'user'
  message: {
    role: 'user'
    content: BetaContentBlockParam[]
  }
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
  permissionMode?: PermissionMode
  origin?: MessageOrigin
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

export interface AttachmentMessage extends BaseMessage {
  type: 'attachment'
  attachment: {
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
  content: string
  level: 'error'
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
}

export interface SystemScheduledTaskFireMessage extends BaseMessage {
  type: 'system'
  subtype: 'scheduled_task_fire'
  content: string
}

export interface SystemTurnDurationMessage extends BaseMessage {
  type: 'system'
  subtype: 'turn_duration'
  content: string
  durationMs: number
}

export interface SystemAgentsKilledMessage extends BaseMessage {
  type: 'system'
  subtype: 'agents_killed'
  content: string
}

export interface ToolUseSummaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'tool_use_summary'
  content: string
}

export interface TombstoneMessage extends BaseMessage {
  type: 'system'
  subtype: 'tombstone'
  content: string
}

export interface SystemApiMetricsMessage extends BaseMessage {
  type: 'system'
  subtype: 'api_metrics'
  content: string
}

export interface SystemStopHookSummaryMessage extends BaseMessage {
  type: 'system'
  subtype: 'stop_hook_summary'
  content: string
  hookInfos: StopHookInfo[]
}

export interface SystemMemorySavedMessage extends BaseMessage {
  type: 'system'
  subtype: 'memory_saved'
  content: string
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
  | SystemApiMetricsMessage
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
  event: string
  data: unknown
}

export interface RequestStartEvent extends BaseMessage {
  type: 'request_start'
  requestId: string
  model: string
}

export interface StopHookInfo {
  hookName: string
  status: string
  duration?: number
}

// ============================================================
// Grouped / Collapsed Messages
// ============================================================

export interface GroupedToolUseMessage extends BaseMessage {
  type: 'grouped_tool_use'
  toolUses: BetaToolUseBlock[]
}

export interface CollapsedReadSearchGroup extends BaseMessage {
  type: 'collapsed_read_search'
  content: string
  collapsedCount: number
}

export interface GroupedToolUseMessageWithMessages extends BaseMessage {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
}

export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | GroupedToolUseMessageWithMessages

// ============================================================
// Compact Metadata
// ============================================================

export interface CompactMetadata {
  trigger: string
  preTokens: number
  preservedSegment?: {
    headUuid: string
    anchorUuid: string
    tailUuid: string
  }
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

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage

// ============================================================
// Main Message Union
// ============================================================

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
