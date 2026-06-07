import { randomUUID } from 'node:crypto'
import type { PromptRequest, PromptResponse } from 'src/types/hooks/index.js'
import type {
  BackgroundTaskInfo,
  ExitReason,
  SessionCronInfo,
  SessionEndHookInput,
  SessionStartHookInput,
  SetupHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStopHookInput,
} from 'src/types/index.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { getRunningTasks } from '../../task/framework.js'
import type { AppState } from '../../../state/AppState.js'
import type { ToolUseContext } from '../../../Tool.js'
import { isBackgroundTask } from '../../../tasks/types.js'
import type { AgentId } from '../../../types/ids.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { hasCronTasksSync, nextCronRunMs, readCronTasks } from '../../../utils/cronTasks.js'
import { extractTextContent, getLastAssistantMessage } from '../../../utils/messages.js'
import { getAgentTranscriptPath } from '../../../utils/sessionStorage.js'
import { createBaseHookInput, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from '../config.js'
import { executeHooks } from '../executeEngine.js'
import { hasHookForEvent } from '../matcher.js'
import { executeHooksOutsideREPL } from '../outsideRepl.js'
import { clearSessionHooks } from '../sessionHooks.js'
import type { AggregatedHookResult } from '../types.js'

/**
 * 收集 Stop/SubagentStop hook input 的扩展上下文：运行中的后台任务 + 会话 cron。
 * 仅在确有内容时返回对应字段（保持对老 hook 的向后兼容）。cron 读盘前先用
 * hasCronTasksSync() 短路，避免每个轮次都读磁盘。
 */
async function collectStopHookContext(
  appState: AppState | undefined,
): Promise<{ background_tasks?: BackgroundTaskInfo[]; session_crons?: SessionCronInfo[] }> {
  const out: { background_tasks?: BackgroundTaskInfo[]; session_crons?: SessionCronInfo[] } = {}

  if (appState) {
    const tasks = getRunningTasks(appState)
      .filter(isBackgroundTask)
      .map((t) => ({ id: t.id, type: t.type, status: t.status, description: t.description }))
    if (tasks.length > 0) {
      out.background_tasks = tasks
    }
  }

  if (hasCronTasksSync()) {
    try {
      const now = Date.now()
      const crons = (await readCronTasks()).map((t) => {
        const nextMs = nextCronRunMs(t.cron, now)
        return {
          id: t.id,
          schedule: t.cron,
          ...(t.recurring !== undefined && { recurring: t.recurring }),
          ...(nextMs != null && { next_run: new Date(nextMs).toISOString() }),
        }
      })
      if (crons.length > 0) {
        out.session_crons = crons
      }
    } catch {
      // cron 文件损坏/读失败不应阻断 stop hook —— 静默跳过该字段
    }
  }

  return out
}

export async function executeStopFailureHooks(
  lastMessage: AssistantMessage,
  toolUseContext?: ToolUseContext,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const appState = toolUseContext?.getAppState()
  // executeHooksOutsideREPL hardcodes main sessionId (:2738). Agent frontmatter
  // hooks (registerFrontmatterHooks) key by agentId; gating with agentId here
  // would pass the gate but fail execution. Align gate with execution.
  const sessionId = getSessionId()
  if (!hasHookForEvent('StopFailure', appState, sessionId)) {
    return
  }

  const contentBlocks = Array.isArray(lastMessage.message.content)
    ? lastMessage.message.content
    : []
  const lastAssistantText = extractTextContent(contentBlocks, '\n').trim() || undefined

  // Some createAssistantAPIErrorMessage call sites omit `error` (e.g.
  // image-size at errors.ts:431). Default to 'unknown' so matcher filtering
  // at getMatchingHooks:1525 always applies.
  const error = lastMessage.error ?? 'unknown'
  const hookInput: StopFailureHookInput = {
    ...createBaseHookInput(undefined, undefined, toolUseContext),
    hook_event_name: 'StopFailure',
    // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
    error: error as any,
    error_details: lastMessage.errorDetails,
    last_assistant_message: lastAssistantText,
  }

  await executeHooksOutsideREPL({
    getAppState: toolUseContext?.getAppState,
    hookInput,
    timeoutMs,
    // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
    matchQuery: error as any,
  })
}

/**
 * Execute stop hooks if configured
 * @param toolUseContext ToolUseContext for prompt-based hooks
 * @param permissionMode permission mode from toolPermissionContext
 * @param signal AbortSignal to cancel hook execution
 * @param stopHookActive Whether this call is happening within another stop hook
 * @param isSubagent Whether the current execution context is a subagent
 * @param messages Optional conversation history for prompt/function hooks
 * @returns Async generator that yields progress messages and blocking errors
 */
export async function* executeStopHooks(
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  stopHookActive: boolean = false,
  subagentId?: AgentId,
  toolUseContext?: ToolUseContext,
  messages?: Message[],
  agentType?: string,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const hookEvent = subagentId ? 'SubagentStop' : 'Stop'
  const appState = toolUseContext?.getAppState()
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  if (!hasHookForEvent(hookEvent, appState, sessionId)) {
    return
  }

  // Extract text content from the last assistant message so hooks can
  // inspect the final response without reading the transcript file.
  const lastAssistantMessage = messages ? getLastAssistantMessage(messages) : undefined
  const lastAssistantText = lastAssistantMessage
    ? (() => {
        const contentBlocks = Array.isArray(lastAssistantMessage.message.content)
          ? lastAssistantMessage.message.content
          : []
        return extractTextContent(contentBlocks, '\n').trim() || undefined
      })()
    : undefined

  // 让 Stop/SubagentStop hook 看到「轮次结束时还有什么在跑」：运行中的后台任务
  // 与本会话/项目的 cron。hook 可据此决定是否阻止结束（等任务完成）或放行。
  const stopContext = await collectStopHookContext(appState)

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode, undefined, toolUseContext),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
        ...stopContext,
      }
    : {
        ...createBaseHookInput(permissionMode, undefined, toolUseContext),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
        ...stopContext,
      }

  // 信任检查现已集中在 executeHooks() 中
  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
    messages,
    requestPrompt,
  })
}

/**
 * Execute TeammateIdle hooks when a teammate is about to go idle.
 * If a hook blocks (exit code 2), the teammate should continue working instead of going idle.
 * @param teammateName The name of the teammate going idle
 * @param teamName The team this teammate belongs to
 * @param permissionMode Optional permission mode
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and blocking errors
 */
export async function* executeSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  sessionId?: string,
  agentType?: string,
  model?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SessionStartHookInput = {
    ...createBaseHookInput(undefined, sessionId),
    hook_event_name: 'SessionStart',
    source,
    agent_type: agentType,
    model,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: source,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * Execute setup hooks if configured
 * @param trigger The trigger type ('init' or 'maintenance')
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @param forceSyncExecution If true, async hooks will not be backgrounded
 * @returns Async generator that yields progress messages and hook results
 */
export async function* executeSetupHooks(
  trigger: 'init' | 'maintenance',
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SetupHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Setup',
    trigger,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: trigger,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * Execute subagent start hooks if configured
 * @param agentId The unique identifier for the subagent
 * @param agentType The type/name of the subagent being started
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and hook results
 */
export async function executeSessionEndHooks(
  reason: ExitReason,
  options?: {
    getAppState?: () => AppState
    setAppState?: (updater: (prev: AppState) => AppState) => void
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<void> {
  const {
    getAppState,
    setAppState,
    signal,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options || {}

  const hookInput: SessionEndHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SessionEnd',
    reason,
  }

  const results = await executeHooksOutsideREPL({
    getAppState,
    hookInput,
    matchQuery: reason,
    signal,
    timeoutMs,
  })

  // 关闭期间 Ink 已卸载，因此可以直接写入 stderr
  for (const result of results) {
    if (!result.succeeded && result.output) {
      process.stderr.write(`SessionEnd hook [${result.command}] failed: ${result.output}\n`)
    }
  }

  // 执行后清除会话 hook
  if (setAppState) {
    const sessionId = getSessionId()
    clearSessionHooks(setAppState, sessionId)
  }
}

/**
 * Execute permission request hooks if configured
 * These hooks are called when a permission dialog would be displayed to the user.
 * Hooks can approve or deny the permission request programmatically.
 * @param toolName The name of the tool requesting permission
 * @param toolUseID The ID of the tool use
 * @param toolInput The input that would be passed to the tool
 * @param toolUseContext ToolUseContext for the request
 * @param permissionMode Optional permission mode from toolPermissionContext
 * @param permissionSuggestions Optional permission suggestions (the "always allow" options)
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and returns aggregated result
 */
