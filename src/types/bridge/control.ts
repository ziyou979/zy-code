// Bridge control protocol types — used internally for IPC (subprocess, remote-control, replBridge).
// These are the TypeScript type equivalents of the Zod schemas in controlSchemas.ts.

import type {
  BridgeMessage,
  BridgePostTurnSummaryMessage,
  BridgeStreamlinedTextMessage,
  BridgeStreamlinedToolUseSummaryMessage,
  BridgeUserMessage,
} from './messages.js'

// ============================================================
// Control Request Subtypes
// ============================================================

export interface BridgeControlInitializeRequest {
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

export interface BridgeControlInitializeResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  output_style: string
  available_output_styles: string[]
  models: Array<{ id: string; displayName: string }>
  account: { type: string; name?: string }
  pid?: number
  fast_mode_state?: unknown
}

export interface BridgeControlInterruptRequest {
  subtype: 'interrupt'
}

export interface BridgeControlPermissionRequest {
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

export interface BridgeControlSetPermissionModeRequest {
  subtype: 'set_permission_mode'
  mode: string
  ultraplan?: boolean
}

export interface BridgeControlSetModelRequest {
  subtype: 'set_model'
  model?: string
}

export interface BridgeControlSetMaxThinkingTokensRequest {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

export interface BridgeControlMcpStatusRequest {
  subtype: 'mcp_status'
}

export interface BridgeControlMcpStatusResponse {
  mcpServers: Array<{ name: string; status: string; error?: string }>
}

export interface BridgeControlGetContextUsageRequest {
  subtype: 'get_context_usage'
}

export interface BridgeControlGetContextUsageResponse {
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

export interface BridgeControlRewindFilesRequest {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

export interface BridgeControlRewindFilesResponse {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface BridgeControlCancelAsyncMessageRequest {
  subtype: 'cancel_async_message'
  message_uuid: string
}

export interface BridgeControlCancelAsyncMessageResponse {
  cancelled: boolean
}

export interface BridgeControlSeedReadStateRequest {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

export interface BridgeControlHookCallbackRequest {
  subtype: 'hook_callback'
  callback_id: string
  input: unknown
  tool_use_id?: string
}

export interface BridgeControlMcpMessageRequest {
  subtype: 'mcp_message'
  server_name: string
  message: unknown
}

export interface BridgeControlMcpSetServersRequest {
  subtype: 'mcp_set_servers'
  servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
}

export interface BridgeControlMcpSetServersResponse {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export interface BridgeControlReloadPluginsRequest {
  subtype: 'reload_plugins'
}

export interface BridgeControlReloadPluginsResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: Array<{ name: string; status: string }>
  error_count: number
}

export interface BridgeControlMcpReconnectRequest {
  subtype: 'mcp_reconnect'
  serverName: string
}

export interface BridgeControlMcpToggleRequest {
  subtype: 'mcp_toggle'
  serverName: string
  enabled: boolean
}

export interface BridgeControlStopTaskRequest {
  subtype: 'stop_task'
  task_id: string
}

export interface BridgeControlApplyFlagSettingsRequest {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export interface BridgeControlGetSettingsRequest {
  subtype: 'get_settings'
}

export interface BridgeControlGetSettingsResponse {
  effective: Record<string, unknown>
  sources: Array<{ source: string; settings: Record<string, unknown> }>
  applied?: { model: string; effort: string | null }
}

export interface BridgeControlElicitationRequest {
  subtype: 'elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type BridgeControlElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type BridgeControlRequestInner =
  | BridgeControlInitializeRequest
  | BridgeControlInterruptRequest
  | BridgeControlPermissionRequest
  | BridgeControlSetPermissionModeRequest
  | BridgeControlSetModelRequest
  | BridgeControlSetMaxThinkingTokensRequest
  | BridgeControlMcpStatusRequest
  | BridgeControlGetContextUsageRequest
  | BridgeControlHookCallbackRequest
  | BridgeControlMcpMessageRequest
  | BridgeControlRewindFilesRequest
  | BridgeControlCancelAsyncMessageRequest
  | BridgeControlSeedReadStateRequest
  | BridgeControlMcpSetServersRequest
  | BridgeControlReloadPluginsRequest
  | BridgeControlMcpReconnectRequest
  | BridgeControlMcpToggleRequest
  | BridgeControlStopTaskRequest
  | BridgeControlApplyFlagSettingsRequest
  | BridgeControlGetSettingsRequest
  | BridgeControlElicitationRequest

// ============================================================
// Control Request / Response Envelopes
// ============================================================

export interface BridgeControlRequest {
  type: 'control_request'
  request_id: string
  request: BridgeControlRequestInner
}

export interface BridgeControlResponse {
  type: 'control_response'
  response:
    | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
    | {
        subtype: 'error'
        request_id: string
        error: string
        pending_permission_requests?: BridgeControlRequest[]
      }
}

export interface BridgeControlCancelRequest {
  type: 'control_cancel_request'
  request_id: string
}

export interface BridgeKeepAliveMessage {
  type: 'keep_alive'
}

export interface BridgeUpdateEnvironmentVariablesMessage {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

// ============================================================
// Stdin / Stdout Message Unions
// ============================================================

export type StdoutMessage =
  | BridgeMessage
  | BridgeStreamlinedTextMessage
  | BridgeStreamlinedToolUseSummaryMessage
  | BridgePostTurnSummaryMessage
  | BridgeControlResponse
  | BridgeControlRequest
  | BridgeControlCancelRequest
  | BridgeKeepAliveMessage

export type StdinMessage =
  | BridgeUserMessage
  | BridgeControlRequest
  | BridgeControlResponse
  | BridgeKeepAliveMessage
  | BridgeUpdateEnvironmentVariablesMessage

// (BridgePartialAssistantMessage is exported from ./messages.js — pull it from
// there directly; the bridge barrel re-exports both control.ts and messages.ts.)
