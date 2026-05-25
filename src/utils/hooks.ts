export { getSessionEndHookTimeoutMs } from './hooks/config.js'

import { getMatchingHooks } from './hooks/matcher.js'

export { getMatchingHooks }

import { createBaseHookInput, shouldSkipHookDueToTrust } from './hooks/config.js'

export { createBaseHookInput, shouldSkipHookDueToTrust }

import type {
  AggregatedHookResult,
  ElicitationResponse,
  HookBlockingError,
  HookResult,
} from './hooks/types.js'

export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
} from './hooks/messages.js'
export type { AggregatedHookResult, ElicitationResponse, HookBlockingError, HookResult }

/**
 * 解析 JSON 字符串并根据 hook 输出的 Zod schema 进行校验。
 * 返回校验通过的输出或格式化的校验错误信息。
 */

import { type HookOutsideReplResult, hasBlockingResult } from './hooks/outsideRepl.js'

export { executePostCompactHooks, executePreCompactHooks } from './hooks/executors/compact.js'
export {
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeFileChangedHooks,
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
} from './hooks/executors/config.js'
export {
  executeElicitationHooks,
  executeElicitationResultHooks,
} from './hooks/executors/elicitation.js'
export { executeFileSuggestionCommand } from './hooks/executors/fileSuggestion.js'
export {
  executeSessionEndHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeStopFailureHooks,
  executeStopHooks,
} from './hooks/executors/lifecycle.js'
export {
  executeNotificationHooks,
  executeUserPromptSubmitHooks,
} from './hooks/executors/notification.js'
export {
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
} from './hooks/executors/teammate.js'
// H7: 17 个 execute*Hooks + 2 个私有 helper 已下沉到 executors/
export {
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreToolHooks,
} from './hooks/executors/tool.js'
export {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from './hooks/executors/worktree.js'
export type {
  ConfigChangeSource,
  ElicitationHookResult,
  ElicitationResultHookResult,
  InstructionsLoadReason,
  InstructionsMemoryType,
} from './hooks/types.js'
export type { HookOutsideReplResult }
export { hasBlockingResult }
