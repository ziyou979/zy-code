// Bridge control protocol types — used internally for IPC (subprocess, remote-control, replBridge).
// These are the TypeScript type equivalents of the Zod schemas in controlSchemas.ts.

import type {
  WireMessage,
  WirePostTurnSummaryMessage,
  WireStreamlinedTextMessage,
  WireStreamlinedToolUseSummaryMessage,
  WireUserMessage,
} from './messages.js'

// ============================================================
// Control Request Subtypes
// ============================================================

export interface WireControlInitializeRequest {
  subtype: 'initialize'
  hooks?: Record<string, Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>>
  sdkMcpServers?: string[]
  jsonSchema?: Record<string, unknown>
  systemPrompt?: string
  appendSystemPrompt?: string
  agents?: Record<string, unknown>
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
}

export interface WireControlInitializeResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  output_style: string
  available_output_styles: string[]
  models: Array<{ id: string; displayName: string }>
  account: { type: string; name?: string }
  pid?: number
  fast_mode_state?: unknown
}

export interface WireControlInterruptRequest {
  subtype: 'interrupt'
}

export interface WireControlPermissionRequest {
  subtype: 'can_use_tool'
  tool_name: string
  input: Record<string, unknown>
  permission_suggestions?: unknown[]
  blocked_path?: string
  decision_reason?: string
  title?: string
  display_name?: string
  tool_use_id: string
  agent_id?: string
  description?: string
}

export interface WireControlSetPermissionModeRequest {
  subtype: 'set_permission_mode'
  mode: string
  ultraplan?: boolean
}

export interface WireControlSetModelRequest {
  subtype: 'set_model'
  model?: string
}

export interface WireControlSetMaxThinkingTokensRequest {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

export interface WireControlMcpStatusRequest {
  subtype: 'mcp_status'
}

export interface WireControlMcpStatusResponse {
  mcpServers: Array<{ name: string; status: string; error?: string }>
}

export interface WireControlGetContextUsageRequest {
  subtype: 'get_context_usage'
}

export interface WireControlGetContextUsageResponse {
  categories: Array<{ name: string; tokens: number; color: string; isDeferred?: boolean }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<
    Array<{
      color: string
      isFilled: boolean
      categoryName: string
      tokens: number
      percentage: number
      squareFullness: number
    }>
  >
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  agents: Array<{ agentType: string; source: string; tokens: number }>
  isAutoCompactEnabled: boolean
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export interface WireControlRewindFilesRequest {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

export interface WireControlRewindFilesResponse {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface WireControlCancelAsyncMessageRequest {
  subtype: 'cancel_async_message'
  message_uuid: string
}

export interface WireControlCancelAsyncMessageResponse {
  cancelled: boolean
}

export interface WireControlSeedReadStateRequest {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

export interface WireControlHookCallbackRequest {
  subtype: 'hook_callback'
  callback_id: string
  input: unknown
  tool_use_id?: string
}

export interface WireControlMcpMessageRequest {
  subtype: 'mcp_message'
  server_name: string
  message: unknown
}

export interface WireControlMcpSetServersRequest {
  subtype: 'mcp_set_servers'
  servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
}

export interface WireControlMcpSetServersResponse {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export interface WireControlReloadPluginsRequest {
  subtype: 'reload_plugins'
}

export interface WireControlReloadPluginsResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: Array<{ name: string; status: string }>
  error_count: number
}

export interface WireControlMcpReconnectRequest {
  subtype: 'mcp_reconnect'
  serverName: string
}

export interface WireControlMcpToggleRequest {
  subtype: 'mcp_toggle'
  serverName: string
  enabled: boolean
}

export interface WireControlStopTaskRequest {
  subtype: 'stop_task'
  task_id: string
}

export interface WireControlApplyFlagSettingsRequest {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export interface WireControlGetSettingsRequest {
  subtype: 'get_settings'
}

export interface WireControlGetSettingsResponse {
  effective: Record<string, unknown>
  sources: Array<{ source: string; settings: Record<string, unknown> }>
  applied?: { model: string; effort: string | null }
}

export interface WireControlElicitationRequest {
  subtype: 'elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type WireControlElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type WireControlRequestInner =
  | WireControlInitializeRequest
  | WireControlInterruptRequest
  | WireControlPermissionRequest
  | WireControlSetPermissionModeRequest
  | WireControlSetModelRequest
  | WireControlSetMaxThinkingTokensRequest
  | WireControlMcpStatusRequest
  | WireControlGetContextUsageRequest
  | WireControlHookCallbackRequest
  | WireControlMcpMessageRequest
  | WireControlRewindFilesRequest
  | WireControlCancelAsyncMessageRequest
  | WireControlSeedReadStateRequest
  | WireControlMcpSetServersRequest
  | WireControlReloadPluginsRequest
  | WireControlMcpReconnectRequest
  | WireControlMcpToggleRequest
  | WireControlStopTaskRequest
  | WireControlApplyFlagSettingsRequest
  | WireControlGetSettingsRequest
  | WireControlElicitationRequest

// ============================================================
// Control Request / Response Envelopes
// ============================================================

export interface WireControlRequest {
  type: 'control_request'
  request_id: string
  request: WireControlRequestInner
}

export interface WireControlResponse {
  type: 'control_response'
  response:
    | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
    | {
        subtype: 'error'
        request_id: string
        error: string
        pending_permission_requests?: WireControlRequest[]
      }
}

export interface WireControlCancelRequest {
  type: 'control_cancel_request'
  request_id: string
}

export interface WireKeepAliveMessage {
  type: 'keep_alive'
}

export interface WireUpdateEnvironmentVariablesMessage {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

// ============================================================
// Stdin / Stdout Message Unions
// ============================================================

export type StdoutMessage =
  | WireMessage
  | WireStreamlinedTextMessage
  | WireStreamlinedToolUseSummaryMessage
  | WirePostTurnSummaryMessage
  | WireControlResponse
  | WireControlRequest
  | WireControlCancelRequest
  | WireKeepAliveMessage

export type StdinMessage =
  | WireUserMessage
  | WireControlRequest
  | WireControlResponse
  | WireKeepAliveMessage
  | WireUpdateEnvironmentVariablesMessage

// (WirePartialAssistantMessage is exported from ./messages.js — pull it from
// there directly; the bridge barrel re-exports both control.ts and messages.ts.)
