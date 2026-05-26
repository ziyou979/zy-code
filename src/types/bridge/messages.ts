/**
 * Bridge wire/IPC message types.
 *
 * TypeScript types for the messages CLI yields across process boundaries
 * (subprocess, remote-control, replBridge). Renamed from SDK*Message as part
 * of the SDK-removal cleanup. Schemas live in ./messageSchemas.ts.
 */

import type {
  ApiKeySource,
  ModelUsage,
  PermissionMode,
} from '../coreTypes.generated.js'

// ============================================================================
// SDK Message Types
// ============================================================================

export type BridgeAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type BridgeStatus = 'compacting' | null

export interface BridgeUserMessage {
  type: 'user'
  message: unknown
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: 'now' | 'next' | 'later'
  timestamp?: string
  uuid?: string
  session_id?: string
}

export interface BridgeUserMessageReplay {
  type: 'user'
  message: unknown
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: 'now' | 'next' | 'later'
  timestamp?: string
  uuid: string
  session_id: string
  isReplay: true
}

export interface BridgeRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
  utilization?: number
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'
  overageResetsAt?: number
  overageDisabledReason?:
    | 'overage_not_provisioned'
    | 'org_level_disabled'
    | 'org_level_disabled_until'
    | 'out_of_credits'
    | 'seat_tier_level_disabled'
    | 'member_level_disabled'
    | 'seat_tier_zero_credit_limit'
    | 'group_zero_credit_limit'
    | 'member_zero_credit_limit'
    | 'org_service_level_disabled'
    | 'org_service_zero_credit_limit'
    | 'no_limits_configured'
    | 'unknown'
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

export interface BridgeAssistantMessage {
  type: 'assistant'
  message: unknown
  parent_tool_use_id: string | null
  error?: BridgeAssistantMessageError
  uuid: string
  session_id: string
}

export interface BridgeRateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: BridgeRateLimitInfo
  uuid: string
  session_id: string
}

export interface BridgeStreamlinedTextMessage {
  type: 'streamlined_text'
  text: string
  session_id: string
  uuid: string
}

export interface BridgeStreamlinedToolUseSummaryMessage {
  type: 'streamlined_tool_use_summary'
  tool_summary: string
  session_id: string
  uuid: string
}

export interface BridgePermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export interface BridgeResultSuccess {
  type: 'result'
  subtype: 'success'
  duration_ms: number
  duration_api_ms: number
  isError: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: unknown
  modelUsage: Record<string, ModelUsage>
  permission_denials: BridgePermissionDenial[]
  structured_output?: unknown
  fast_mode_state?: FastModeState
  uuid: string
  session_id: string
}

export interface BridgeResultError {
  type: 'result'
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
  duration_ms: number
  duration_api_ms: number
  isError: boolean
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: unknown
  modelUsage: Record<string, ModelUsage>
  permission_denials: BridgePermissionDenial[]
  errors: string[]
  fast_mode_state?: FastModeState
  uuid: string
  session_id: string
}

export type BridgeResultMessage = BridgeResultSuccess | BridgeResultError

export interface BridgeSystemMessage {
  type: 'system'
  subtype: 'init'
  agents?: string[]
  apiKeySource: ApiKeySource
  betas?: string[]
  zy_code_version: string
  cwd: string
  tools: string[]
  mcp_servers: Array<{
    name: string
    status: string
  }>
  model: string
  permissionMode: PermissionMode
  slash_commands: string[]
  output_style: string
  skills: string[]
  plugins: Array<{
    name: string
    path: string
    source?: string
  }>
  fast_mode_state?: FastModeState
  uuid: string
  session_id: string
}

export interface BridgePartialAssistantMessage {
  type: 'stream_event'
  event: unknown
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export interface BridgeCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  compact_metadata: {
    trigger: 'manual' | 'auto'
    pre_tokens: number
    preserved_segment?: {
      head_uuid: string
      anchor_uuid: string
      tail_uuid: string
    }
  }
  uuid: string
  session_id: string
}

export interface BridgeStatusMessage {
  type: 'system'
  subtype: 'status'
  status: BridgeStatus
  permissionMode?: PermissionMode
  uuid: string
  session_id: string
}

export interface BridgePostTurnSummaryMessage {
  type: 'system'
  subtype: 'post_turn_summary'
  summarizes_uuid: string
  status_category: 'blocked' | 'waiting' | 'completed' | 'review_ready' | 'failed'
  status_detail: string
  is_noteworthy: boolean
  title: string
  description: string
  recent_action: string
  needs_action: string
  artifact_urls: string[]
  uuid: string
  session_id: string
}

export interface BridgeAPIRetryMessage {
  type: 'system'
  subtype: 'api_retry'
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: BridgeAssistantMessageError
  uuid: string
  session_id: string
}

export interface BridgeLocalCommandOutputMessage {
  type: 'system'
  subtype: 'local_command_output'
  content: string
  uuid: string
  session_id: string
}

export interface BridgeHookStartedMessage {
  type: 'system'
  subtype: 'hook_started'
  hook_id: string
  hook_name: string
  hook_event: string
  uuid: string
  session_id: string
}

export interface BridgeHookProgressMessage {
  type: 'system'
  subtype: 'hook_progress'
  hook_id: string
  hook_name: string
  hook_event: string
  stdout: string
  stderr: string
  output: string
  uuid: string
  session_id: string
}

export interface BridgeHookResponseMessage {
  type: 'system'
  subtype: 'hook_response'
  hook_id: string
  hook_name: string
  hook_event: string
  output: string
  stdout: string
  stderr: string
  exit_code?: number
  outcome: 'success' | 'error' | 'cancelled'
  uuid: string
  session_id: string
}

export interface BridgeToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: string
  session_id: string
}

export interface BridgeAuthStatusMessage {
  type: 'auth_status'
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid: string
  session_id: string
}

export interface BridgeFilesPersistedEvent {
  type: 'system'
  subtype: 'files_persisted'
  files: Array<{
    filename: string
    file_id: string
  }>
  failed: Array<{
    filename: string
    error: string
  }>
  processed_at: string
  uuid: string
  session_id: string
}

export interface BridgeTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  uuid: string
  session_id: string
}

export interface BridgeTaskStartedMessage {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  uuid: string
  session_id: string
}

export interface BridgeSessionStateChangedMessage {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
  uuid: string
  session_id: string
}

export interface BridgeTaskProgressMessage {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}

export interface BridgeToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  preceding_tool_use_ids: string[]
  uuid: string
  session_id: string
}

export interface BridgeElicitationCompleteMessage {
  type: 'system'
  subtype: 'elicitation_complete'
  mcp_server_name: string
  elicitation_id: string
  uuid: string
  session_id: string
}

export interface BridgePromptSuggestionMessage {
  type: 'prompt_suggestion'
  suggestion: string
  uuid: string
  session_id: string
}

// ============================================================================
// Session Listing Types
// ============================================================================

export interface BridgeSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

// ============================================================================
// Fast Mode State
// ============================================================================

export type FastModeState = 'off' | 'cooldown' | 'on'

// ============================================================================
// SDK Message Union Type
// ============================================================================

export type BridgeMessage =
  | BridgeAssistantMessage
  | BridgeUserMessage
  | BridgeUserMessageReplay
  | BridgeResultMessage
  | BridgeSystemMessage
  | BridgePartialAssistantMessage
  | BridgeCompactBoundaryMessage
  | BridgeStatusMessage
  | BridgeAPIRetryMessage
  | BridgeLocalCommandOutputMessage
  | BridgeHookStartedMessage
  | BridgeHookProgressMessage
  | BridgeHookResponseMessage
  | BridgeToolProgressMessage
  | BridgeAuthStatusMessage
  | BridgeTaskNotificationMessage
  | BridgeTaskStartedMessage
  | BridgeTaskProgressMessage
  | BridgeSessionStateChangedMessage
  | BridgeFilesPersistedEvent
  | BridgeToolUseSummaryMessage
  | BridgeRateLimitEvent
  | BridgeElicitationCompleteMessage
  | BridgePromptSuggestionMessage

// ============================================================================
// Post Turn Summary Message (re-export for convenience)
// ============================================================================

export type BridgePostTurnSummaryMessageType = BridgePostTurnSummaryMessage
