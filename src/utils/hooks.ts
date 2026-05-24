
export { getSessionEndHookTimeoutMs } from './hooks/config.js'

import {
  getMatchingHooks,
} from './hooks/matcher.js'
export { getMatchingHooks }

import { createBaseHookInput, shouldSkipHookDueToTrust } from './hooks/config.js'
export { createBaseHookInput, shouldSkipHookDueToTrust }

import type {
  AggregatedHookResult,
  ElicitationResponse,
  HookBlockingError,
  HookResult,
} from './hooks/types.js'
export type { AggregatedHookResult, ElicitationResponse, HookBlockingError, HookResult }

export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
} from './hooks/messages.js'

/**
 * 解析 JSON 字符串并根据 hook 输出的 Zod schema 进行校验。
 * 返回校验通过的输出或格式化的校验错误信息。
 */

import {
  type HookOutsideReplResult,
  hasBlockingResult,
} from './hooks/outsideRepl.js'
export { hasBlockingResult }
export type { HookOutsideReplResult }


// H7: 17 个 execute*Hooks + 2 个私有 helper 已下沉到 executors/
export {
  executePreToolHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
} from './hooks/executors/tool.js'
export { executeNotificationHooks, executeUserPromptSubmitHooks } from './hooks/executors/notification.js'
export {
  executeStopFailureHooks,
  executeStopHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeSessionEndHooks,
} from './hooks/executors/lifecycle.js'
export {
  executeTeammateIdleHooks,
  executeTaskCreatedHooks,
  executeTaskCompletedHooks,
  executeSubagentStartHooks,
} from './hooks/executors/teammate.js'
export { executePreCompactHooks, executePostCompactHooks } from './hooks/executors/compact.js'
export {
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeFileChangedHooks,
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
} from './hooks/executors/config.js'
export {
  executeElicitationHooks,
  executeElicitationResultHooks,
} from './hooks/executors/elicitation.js'
export { executeFileSuggestionCommand } from './hooks/executors/fileSuggestion.js'
export {
  hasWorktreeCreateHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
} from './hooks/executors/worktree.js'
export type {
  ConfigChangeSource,
  ElicitationHookResult,
  ElicitationResultHookResult,
  InstructionsLoadReason,
  InstructionsMemoryType,
} from './hooks/types.js'
