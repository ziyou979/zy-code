import { randomUUID } from 'node:crypto'
import type { PromptRequest, PromptResponse } from '../../../types/hooks.js'
// FileSuggestionCommandInput 在 ../../../types/fileSuggestion.js 实际不导出，用 any 替代
// biome-ignore lint/suspicious/noExplicitAny: 类型缺失的临时占位
type FileSuggestionCommandInput = any
import { TOOL_HOOK_EXECUTION_TIMEOUT_MS, createBaseHookInput } from '../config.js'
import { executeHooks } from '../executeEngine.js'
import {
  executeHooksOutsideREPL,
} from '../outsideRepl.js'
import { hasHookForEvent } from '../matcher.js'
import { getSessionId } from '../../../bootstrap/state.js'
import type {
  NotificationHookInput,
  UserPromptSubmitHookInput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AggregatedHookResult, } from '../types.js'

export async function executeNotificationHooks(
  notificationData: {
    message: string
    title?: string
    notificationType: string
  },
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const { message, title, notificationType } = notificationData
  const hookInput: NotificationHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Notification',
    message,
    title,
    notification_type: notificationType,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: notificationType,
  })
}

export async function* executeUserPromptSubmitHooks(
  prompt: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptSubmit', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptSubmitHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptSubmit',
    prompt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
    requestPrompt,
  })
}

/**
 * Execute session start hooks if configured
 * @param source The source of the session start (startup, resume, clear)
 * @param sessionId Optional The session id to use as hook input
 * @param agentType Optional The agent type (from --agent flag) running this session
 * @param model Optional The model being used for this session
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and hook results
 */
