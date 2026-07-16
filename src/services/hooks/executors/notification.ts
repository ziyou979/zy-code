import { randomUUID } from 'node:crypto'
import type { PromptRequest, PromptResponse } from 'src/types/hooks/index.js'
import type {
  NotificationHookInput,
  UserPromptExpansionHookInput,
  UserPromptSubmitHookInput,
} from 'src/types/index.js'
import { getSessionId } from '../../../bootstrap/runtime/runtimeContext.js'
import type { ToolUseContext } from '../../../tools/Tool.js'
import { createBaseHookInput, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from '../config.js'
import { executeHooks } from '../executeEngine.js'
import { hasHookForEvent } from '../matcher.js'
import { executeHooksOutsideREPL } from '../outsideRepl.js'
import type { AggregatedHookResult } from '../types.js'

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
 * Execute UserPromptExpansion hooks: fired after @mention/$var/slash expansion, just before
 * UserPromptSubmit. Lets hooks audit the fully expanded content the model will actually see
 * (e.g. the contents injected by @file references), which UserPromptSubmit cannot — it only sees
 * the original prompt text.
 */
export async function* executeUserPromptExpansionHooks(
  prompt: string,
  expandedText: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptExpansion', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptExpansionHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptExpansion',
    prompt,
    expanded_text: expandedText,
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
