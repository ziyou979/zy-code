/**
 * Auto-generated TypeScript types from Zod schemas in coreSchemas.ts.
 *
 * DO NOT EDIT MANUALLY.
 * To regenerate: bun scripts/generate-sdk-types.ts
 */

// ============================================================================
// Usage & Model Types
// ============================================================================

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

// ============================================================================
// Output Format Types
// ============================================================================

export type OutputFormatType = 'json_schema'

export interface BaseOutputFormat {
  type: OutputFormatType
}

export interface JsonSchemaOutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

export type OutputFormat = JsonSchemaOutputFormat

// ============================================================================
// Config Types
// ============================================================================

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth'

export type ConfigScope = 'local' | 'user' | 'project'

export type SdkBeta = 'context-1m-2025-08-07'

export interface ThinkingAdaptive {
  type: 'adaptive'
}

export interface ThinkingEnabled {
  type: 'enabled'
  budgetTokens?: number
}

export interface ThinkingDisabled {
  type: 'disabled'
}

export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled

// ============================================================================
// MCP Server Config Types
// ============================================================================

export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSSEServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export interface McpSdkServerConfig {
  type: 'sdk'
  name: string
}

export type McpServerConfigForProcessTransport =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig

export interface McpZyAIProxyServerConfig {
  type: 'zyai-proxy'
  url: string
  id: string
}

export type McpServerStatusConfig = McpServerConfigForProcessTransport | McpZyAIProxyServerConfig

export interface McpServerStatus {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
  config?: McpServerStatusConfig
  scope?: string
  tools?: Array<{
    name: string
    description?: string
    annotations?: {
      readOnly?: boolean
      destructive?: boolean
      openWorld?: boolean
    }
  }>
  capabilities?: {
    experimental?: Record<string, unknown>
  }
}

export interface McpSetServersResult {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

// ============================================================================
// Permission Types
// ============================================================================

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate =
  | {
      type: 'addRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'replaceRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: PermissionMode
      destination: PermissionUpdateDestination
    }
  | {
      type: 'addDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }

export type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject'

export type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }
  | {
      behavior: 'deny'
      message: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

// ============================================================================
// Hook Input Types
// ============================================================================

export interface BaseHookInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

export type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

export type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  permission_suggestions?: PermissionUpdate[]
}

export type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}

export type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
}

export type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
}

export type NotificationHookInput = BaseHookInput & {
  hook_event_name: 'Notification'
  message: string
  title?: string
  notification_type: string
}

export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart'
  source: 'startup' | 'resume' | 'clear' | 'compact'
  agent_type?: string
  model?: string
}

export type SetupHookInput = BaseHookInput & {
  hook_event_name: 'Setup'
  trigger: 'init' | 'maintenance'
}

export type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop'
  stop_hook_active: boolean
  last_assistant_message?: string
}

export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: 'StopFailure'
  error: SDKAssistantMessageError
  error_details?: string
  last_assistant_message?: string
}

export type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart'
  agent_id: string
  agent_type: string
}

export type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop'
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string
  agent_type: string
  last_assistant_message?: string
}

export type PreCompactHookInput = BaseHookInput & {
  hook_event_name: 'PreCompact'
  trigger: 'manual' | 'auto'
  custom_instructions: string | null
}

export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: 'PostCompact'
  trigger: 'manual' | 'auto'
  compact_summary: string
}

export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: 'TeammateIdle'
  teammate_name: string
  team_name: string
}

export type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCreated'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCompleted'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type ElicitationHookInput = BaseHookInput & {
  hook_event_name: 'Elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: 'ElicitationResult'
  mcp_server_name: string
  elicitation_id?: string
  mode?: 'form' | 'url'
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

export type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange'
  source: ConfigChangeSource
  file_path?: string
}

export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

export type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type: InstructionsMemoryType
  load_reason: InstructionsLoadReason
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
}

export type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeCreate'
  name: string
}

export type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeRemove'
  worktree_path: string
}

export type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
}

export type FileChangedHookInput = BaseHookInput & {
  hook_event_name: 'FileChanged'
  file_path: string
  event: 'change' | 'add' | 'unlink'
}

export type ExitReason =
  | 'clear'
  | 'resume'
  | 'logout'
  | 'prompt_input_exit'
  | 'other'
  | 'bypass_permissions_disabled'

export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd'
  reason: ExitReason
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PermissionDeniedHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | ConfigChangeHookInput
  | InstructionsLoadedHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | CwdChangedHookInput
  | FileChangedHookInput

// ============================================================================
// Hook Output Types
// ============================================================================

export interface AsyncHookJSONOutput {
  async: true
  asyncTimeout?: number
}

export interface PreToolUseHookSpecificOutput {
  hookEventName: 'PreToolUse'
  permissionDecision?: PermissionBehavior
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export interface UserPromptSubmitHookSpecificOutput {
  hookEventName: 'UserPromptSubmit'
  additionalContext?: string
}

export interface SessionStartHookSpecificOutput {
  hookEventName: 'SessionStart'
  additionalContext?: string
  initialUserMessage?: string
  watchPaths?: string[]
}

export interface SetupHookSpecificOutput {
  hookEventName: 'Setup'
  additionalContext?: string
}

export interface SubagentStartHookSpecificOutput {
  hookEventName: 'SubagentStart'
  additionalContext?: string
}

export interface PostToolUseHookSpecificOutput {
  hookEventName: 'PostToolUse'
  additionalContext?: string
  updatedMCPToolOutput?: unknown
}

export interface PostToolUseFailureHookSpecificOutput {
  hookEventName: 'PostToolUseFailure'
  additionalContext?: string
}

export interface PermissionDeniedHookSpecificOutput {
  hookEventName: 'PermissionDenied'
  retry?: boolean
}

export interface NotificationHookSpecificOutput {
  hookEventName: 'Notification'
  additionalContext?: string
}

export interface PermissionRequestHookSpecificOutput {
  hookEventName: 'PermissionRequest'
  decision:
    | {
        behavior: 'allow'
        updatedInput?: Record<string, unknown>
        updatedPermissions?: PermissionUpdate[]
      }
    | {
        behavior: 'deny'
        message?: string
        interrupt?: boolean
      }
}

export interface CwdChangedHookSpecificOutput {
  hookEventName: 'CwdChanged'
  watchPaths?: string[]
}

export interface FileChangedHookSpecificOutput {
  hookEventName: 'FileChanged'
  watchPaths?: string[]
}

export interface ElicitationHookSpecificOutput {
  hookEventName: 'Elicitation'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface ElicitationResultHookSpecificOutput {
  hookEventName: 'ElicitationResult'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface WorktreeCreateHookSpecificOutput {
  hookEventName: 'WorktreeCreate'
  worktreePath: string
}

export interface SyncHookJSONOutput {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  systemMessage?: string
  reason?: string
  hookSpecificOutput?:
    | PreToolUseHookSpecificOutput
    | UserPromptSubmitHookSpecificOutput
    | SessionStartHookSpecificOutput
    | SetupHookSpecificOutput
    | SubagentStartHookSpecificOutput
    | PostToolUseHookSpecificOutput
    | PostToolUseFailureHookSpecificOutput
    | PermissionDeniedHookSpecificOutput
    | NotificationHookSpecificOutput
    | PermissionRequestHookSpecificOutput
    | ElicitationHookSpecificOutput
    | ElicitationResultHookSpecificOutput
    | CwdChangedHookSpecificOutput
    | FileChangedHookSpecificOutput
    | WorktreeCreateHookSpecificOutput
}

export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput

// ============================================================================
// Prompt Types
// ============================================================================

export interface PromptRequestOption {
  key: string
  label: string
  description?: string
}

export interface PromptRequest {
  prompt: string
  message: string
  options: PromptRequestOption[]
}

export interface PromptResponse {
  prompt_response: string
  selected: string
}

// ============================================================================
// Skill/Command Types
// ============================================================================

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
}

export interface AgentInfo {
  name: string
  description: string
  model?: string
}

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?:
    | 'anthropic'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'dashscope'
    | 'openrouter'
    | 'generic'
}

// ============================================================================
// Agent Definition Types
// ============================================================================

export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>

export interface AgentDefinition {
  description: string
  tools?: string[]
  disallowedTools?: string[]
  prompt: string
  model?: string
  mcpServers?: AgentMcpServerSpec[]
  criticalSystemReminder_EXPERIMENTAL?: string
  skills?: string[]
  initialPrompt?: string
  maxTurns?: number
  background?: boolean
  memory?: 'user' | 'project' | 'local'
  effort?: 'low' | 'medium' | 'high' | 'max' | number
  permissionMode?: PermissionMode
}

// ============================================================================
// Settings Types
// ============================================================================

export type SettingSource = 'user' | 'project' | 'local'

export interface SdkPluginConfig {
  type: 'local'
  path: string
}

// ============================================================================
// Rewind Types
// ============================================================================

export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

// ============================================================================
// SDK Message Types
// ============================================================================

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export type SDKStatus = 'compacting' | null

export interface SDKUserMessage {
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

export interface SDKUserMessageReplay {
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

export interface SDKRateLimitInfo {
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

export interface SDKAssistantMessage {
  type: 'assistant'
  message: unknown
  parent_tool_use_id: string | null
  error?: SDKAssistantMessageError
  uuid: string
  session_id: string
}

export interface SDKRateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: SDKRateLimitInfo
  uuid: string
  session_id: string
}

export interface SDKStreamlinedTextMessage {
  type: 'streamlined_text'
  text: string
  session_id: string
  uuid: string
}

export interface SDKStreamlinedToolUseSummaryMessage {
  type: 'streamlined_tool_use_summary'
  tool_summary: string
  session_id: string
  uuid: string
}

export interface SDKPermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export interface SDKResultSuccess {
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
  permission_denials: SDKPermissionDenial[]
  structured_output?: unknown
  fast_mode_state?: FastModeState
  uuid: string
  session_id: string
}

export interface SDKResultError {
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
  permission_denials: SDKPermissionDenial[]
  errors: string[]
  fast_mode_state?: FastModeState
  uuid: string
  session_id: string
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError

export interface SDKSystemMessage {
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

export interface SDKPartialAssistantMessage {
  type: 'stream_event'
  event: unknown
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export interface SDKCompactBoundaryMessage {
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

export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  status: SDKStatus
  permissionMode?: PermissionMode
  uuid: string
  session_id: string
}

export interface SDKPostTurnSummaryMessage {
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

export interface SDKAPIRetryMessage {
  type: 'system'
  subtype: 'api_retry'
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: SDKAssistantMessageError
  uuid: string
  session_id: string
}

export interface SDKLocalCommandOutputMessage {
  type: 'system'
  subtype: 'local_command_output'
  content: string
  uuid: string
  session_id: string
}

export interface SDKHookStartedMessage {
  type: 'system'
  subtype: 'hook_started'
  hook_id: string
  hook_name: string
  hook_event: string
  uuid: string
  session_id: string
}

export interface SDKHookProgressMessage {
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

export interface SDKHookResponseMessage {
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

export interface SDKToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: string
  session_id: string
}

export interface SDKAuthStatusMessage {
  type: 'auth_status'
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid: string
  session_id: string
}

export interface SDKFilesPersistedEvent {
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

export interface SDKTaskNotificationMessage {
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

export interface SDKTaskStartedMessage {
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

export interface SDKSessionStateChangedMessage {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
  uuid: string
  session_id: string
}

export interface SDKTaskProgressMessage {
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

export interface SDKToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  preceding_tool_use_ids: string[]
  uuid: string
  session_id: string
}

export interface SDKElicitationCompleteMessage {
  type: 'system'
  subtype: 'elicitation_complete'
  mcp_server_name: string
  elicitation_id: string
  uuid: string
  session_id: string
}

export interface SDKPromptSuggestionMessage {
  type: 'prompt_suggestion'
  suggestion: string
  uuid: string
  session_id: string
}

// ============================================================================
// Session Listing Types
// ============================================================================

export interface SDKSessionInfo {
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

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKAPIRetryMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKSessionStateChangedMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPromptSuggestionMessage

// ============================================================================
// Post Turn Summary Message (re-export for convenience)
// ============================================================================

export type SDKPostTurnSummaryMessageType = SDKPostTurnSummaryMessage
