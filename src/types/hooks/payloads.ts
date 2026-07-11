/**
 * Hook input/output payload types.
 *
 * TypeScript types for the data shapes exchanged between the agent and hook
 * callbacks. Schemas live in ./schemas.ts. Runtime callback machinery lives
 * in ./runtime.ts.
 */

import type { PermissionBehavior, PermissionUpdate } from '../coreTypes.generated.js'
import type { WireAssistantMessageError } from '../wire/messages.js'

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
  /** 当前 turn 生效的 effort 等级（已含模型 silent downgrade）。模型不支持 effort 时缺省。 */
  effort?: { level: string }
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
  /** 工具 execute（tool.call）净时长（ms），不含权限弹窗与 PreToolUse hook。 */
  duration_ms?: number
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

export type UserPromptExpansionHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptExpansion'
  /** 原始用户输入（展开前）。 */
  prompt: string
  /** 展开后模型实际看到的完整内容（含 @file 注入、$var/slash 展开）。 */
  expanded_text: string
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

export interface BackgroundTaskInfo {
  id: string
  type: string
  status: string
  description: string
}

export interface SessionCronInfo {
  id: string
  /** 5-field cron string (local time) */
  schedule: string
  recurring?: boolean
  /** ISO timestamp of the next scheduled run, if known */
  next_run?: string
}

export type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop'
  stop_hook_active: boolean
  last_assistant_message?: string
  background_tasks?: BackgroundTaskInfo[]
  session_crons?: SessionCronInfo[]
}

export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: 'StopFailure'
  error: WireAssistantMessageError
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
  background_tasks?: BackgroundTaskInfo[]
  session_crons?: SessionCronInfo[]
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

export type MessageDisplayHookInput = BaseHookInput & {
  hook_event_name: 'MessageDisplay'
  message_id: string
  message_role: 'assistant' | 'user' | 'system'
  text: string
}

export interface PostToolBatchToolUse {
  tool_name: string
  tool_use_id: string
  status: 'success' | 'error'
}

export type PostToolBatchHookInput = BaseHookInput & {
  hook_event_name: 'PostToolBatch'
  tool_uses: PostToolBatchToolUse[]
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
  | MessageDisplayHookInput
  | PostToolBatchHookInput
  | UserPromptExpansionHookInput

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

export interface UserPromptExpansionHookSpecificOutput {
  hookEventName: 'UserPromptExpansion'
  additionalContext?: string
}

export interface SessionStartHookSpecificOutput {
  hookEventName: 'SessionStart'
  additionalContext?: string
  initialUserMessage?: string
  watchPaths?: string[]
  /** 设为 true 时，hook 执行后自动重扫技能目录并使新技能在当前 session 中可见 */
  reloadSkills?: boolean
  /** hook 可在启动时设置/建议会话标题 */
  sessionTitle?: string
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
  /** 通用工具结果覆盖（string，全工具）。重写 model 看到的 tool result，优先于 updatedMCPToolOutput。 */
  updatedToolOutput?: string
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

export interface MessageDisplayHookSpecificOutput {
  hookEventName: 'MessageDisplay'
  /** Replace the displayed text (display-only; does not change context/transcript). */
  transformedText?: string
  /** Hide the message from display entirely. */
  hide?: boolean
}

export interface PostToolBatchHookSpecificOutput {
  hookEventName: 'PostToolBatch'
  additionalContext?: string
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
  /** 原始终端控制序列，由主进程写入 stdout（仅放行 OSC 0/9 + BEL，CSI 被丢弃）。 */
  terminalSequence?: string
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
    | MessageDisplayHookSpecificOutput
    | PostToolBatchHookSpecificOutput
    | UserPromptExpansionHookSpecificOutput
}

export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput
