import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import type { HookCallback, PermissionRequestResult } from 'src/types/hooks/index.js'
import type { HookResultMessage, Message } from 'src/types/message.js'
import type { PermissionResult } from '../permissions/permissionResult.js'
import type { HookCommand } from '../settings/types.js'
import type { FunctionHook } from './sessionHooks.js'

export interface HookBlockingError {
  blockingError: string
  command: string
}

/** 从 MCP SDK 重新导出 ElicitResult 作为 ElicitationResponse，用于向后兼容。 */
export type ElicitationResponse = ElicitResult

export interface HookResult {
  message?: HookResultMessage
  systemMessage?: string
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  /** 原始终端控制序列（由 executeEngine 校验后写入 stdout）。 */
  terminalSequence?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  /** 通用工具结果覆盖（string，全工具）。优先于 updatedMCPToolOutput。 */
  updatedToolOutput?: string
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: ElicitationResponse
  watchPaths?: string[]
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  /** MessageDisplay：替换显示文本（display-only）。 */
  transformedText?: string
  /** MessageDisplay：隐藏该消息的显示。 */
  hide?: boolean
  /** SessionStart hook 可请求重扫技能 */
  reloadSkills?: boolean
  /** SessionStart hook 可设置会话标题 */
  sessionTitle?: string
  hook: HookCommand | HookCallback | FunctionHook
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

/** Result of an elicitation hook execution (non-REPL path). */
export type ElicitationHookResult = {
  elicitationResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** Result of an elicitation-result hook execution (non-REPL path). */
export type ElicitationResultHookResult = {
  elicitationResultResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

export type AggregatedHookResult = {
  message?: Message
  blockingError?: HookBlockingError
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  hookSource?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  /** 通用工具结果覆盖（string，全工具）。优先于 updatedMCPToolOutput。 */
  updatedToolOutput?: string
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  watchPaths?: string[]
  elicitationResponse?: ElicitationResponse
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  /** MessageDisplay：替换显示文本（display-only）。 */
  transformedText?: string
  /** MessageDisplay：隐藏该消息的显示。 */
  hide?: boolean
  /** SessionStart hook 请求重扫技能 */
  reloadSkills?: boolean
  /** SessionStart hook 设置会话标题 */
  sessionTitle?: string
}
