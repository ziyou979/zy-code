// SDK Control Protocol Types - used by SDK builders for the bridge control protocol.
// These are the TypeScript type equivalents of the Zod schemas in controlSchemas.ts.

import type {
  SDKMessage,
  SDKPostTurnSummaryMessage,
  SDKStreamlinedTextMessage,
  SDKStreamlinedToolUseSummaryMessage,
  SDKUserMessage,
} from './coreTypes.generated.js'

// ============================================================
// Control Request Subtypes
// ============================================================

export interface SDKControlInitializeRequest {
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

export interface SDKControlInitializeResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  output_style: string
  available_output_styles: string[]
  models: Array<{ id: string; displayName: string }>
  account: { type: string; name?: string }
  pid?: number
  fast_mode_state?: unknown
}

export interface SDKControlInterruptRequest {
  subtype: 'interrupt'
}

export interface SDKControlPermissionRequest {
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

export interface SDKControlSetPermissionModeRequest {
  subtype: 'set_permission_mode'
  mode: string
  ultraplan?: boolean
}

export interface SDKControlSetModelRequest {
  subtype: 'set_model'
  model?: string
}

export interface SDKControlSetMaxThinkingTokensRequest {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number | null
}

export interface SDKControlMcpStatusRequest {
  subtype: 'mcp_status'
}

export interface SDKControlMcpStatusResponse {
  mcpServers: Array<{ name: string; status: string; error?: string }>
}

export interface SDKControlGetContextUsageRequest {
  subtype: 'get_context_usage'
}

export interface SDKControlGetContextUsageResponse {
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

export interface SDKControlRewindFilesRequest {
  subtype: 'rewind_files'
  user_message_id: string
  dry_run?: boolean
}

export interface SDKControlRewindFilesResponse {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export interface SDKControlCancelAsyncMessageRequest {
  subtype: 'cancel_async_message'
  message_uuid: string
}

export interface SDKControlCancelAsyncMessageResponse {
  cancelled: boolean
}

export interface SDKControlSeedReadStateRequest {
  subtype: 'seed_read_state'
  path: string
  mtime: number
}

export interface SDKControlHookCallbackRequest {
  subtype: 'hook_callback'
  callback_id: string
  input: unknown
  tool_use_id?: string
}

export interface SDKControlMcpMessageRequest {
  subtype: 'mcp_message'
  server_name: string
  message: unknown
}

export interface SDKControlMcpSetServersRequest {
  subtype: 'mcp_set_servers'
  servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
}

export interface SDKControlMcpSetServersResponse {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export interface SDKControlReloadPluginsRequest {
  subtype: 'reload_plugins'
}

export interface SDKControlReloadPluginsResponse {
  commands: Array<{ name: string; description: string }>
  agents: Array<{ name: string; description?: string }>
  plugins: Array<{ name: string; path: string; source?: string }>
  mcpServers: Array<{ name: string; status: string }>
  error_count: number
}

export interface SDKControlMcpReconnectRequest {
  subtype: 'mcp_reconnect'
  serverName: string
}

export interface SDKControlMcpToggleRequest {
  subtype: 'mcp_toggle'
  serverName: string
  enabled: boolean
}

export interface SDKControlStopTaskRequest {
  subtype: 'stop_task'
  task_id: string
}

export interface SDKControlApplyFlagSettingsRequest {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export interface SDKControlGetSettingsRequest {
  subtype: 'get_settings'
}

export interface SDKControlGetSettingsResponse {
  effective: Record<string, unknown>
  sources: Array<{ source: string; settings: Record<string, unknown> }>
  applied?: { model: string; effort: string | null }
}

export interface SDKControlElicitationRequest {
  subtype: 'elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type SDKControlElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type SDKControlRequestInner =
  | SDKControlInitializeRequest
  | SDKControlInterruptRequest
  | SDKControlPermissionRequest
  | SDKControlSetPermissionModeRequest
  | SDKControlSetModelRequest
  | SDKControlSetMaxThinkingTokensRequest
  | SDKControlMcpStatusRequest
  | SDKControlGetContextUsageRequest
  | SDKControlHookCallbackRequest
  | SDKControlMcpMessageRequest
  | SDKControlRewindFilesRequest
  | SDKControlCancelAsyncMessageRequest
  | SDKControlSeedReadStateRequest
  | SDKControlMcpSetServersRequest
  | SDKControlReloadPluginsRequest
  | SDKControlMcpReconnectRequest
  | SDKControlMcpToggleRequest
  | SDKControlStopTaskRequest
  | SDKControlApplyFlagSettingsRequest
  | SDKControlGetSettingsRequest
  | SDKControlElicitationRequest

// ============================================================
// Control Request / Response Envelopes
// ============================================================

export interface SDKControlRequest {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
}

export interface SDKControlResponse {
  type: 'control_response'
  response:
    | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
    | {
        subtype: 'error'
        request_id: string
        error: string
        pending_permission_requests?: SDKControlRequest[]
      }
}

export interface SDKControlCancelRequest {
  type: 'control_cancel_request'
  request_id: string
}

export interface SDKKeepAliveMessage {
  type: 'keep_alive'
}

export interface SDKUpdateEnvironmentVariablesMessage {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

// ============================================================
// Stdin / Stdout Message Unions
// ============================================================

export type StdoutMessage =
  | SDKMessage
  | SDKStreamlinedTextMessage
  | SDKStreamlinedToolUseSummaryMessage
  | SDKPostTurnSummaryMessage
  | SDKControlResponse
  | SDKControlRequest
  | SDKControlCancelRequest
  | SDKKeepAliveMessage

export type StdinMessage =
  | SDKUserMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKKeepAliveMessage
  | SDKUpdateEnvironmentVariablesMessage

// ============================================================
// Re-export SDKPartialAssistantMessage for convenience
// (some transport files import it from here instead of coreTypes)
// ============================================================

export { SDKPartialAssistantMessage } from './coreTypes.generated.js'
