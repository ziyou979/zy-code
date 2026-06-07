import type { PostCompactHookInput, PreCompactHookInput } from 'src/types/index.js'
import { createDebugLog } from '../../../utils/debug.js'
import { createBaseHookInput, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from '../config.js'
import { executeHooksOutsideREPL, hasBlockingResult } from '../outsideRepl.js'

const hookLog = createDebugLog('hooks')

export async function executePreCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    customInstructions: string | null
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  newCustomInstructions?: string
  userDisplayMessage?: string
  blocked?: boolean
}> {
  const hookInput: PreCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PreCompact',
    trigger: compactData.trigger,
    custom_instructions: compactData.customInstructions,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  // 检查是否有 hook 请求阻止压缩（退出码 2 或 JSON {"decision":"block"}）
  if (hasBlockingResult(results)) {
    const blockingHook = results.find((r) => r.blocked)
    hookLog(
      `PreCompact hook blocked compaction: [${blockingHook?.command}] output=${blockingHook?.output}`,
    )
    return { blocked: true }
  }

  // 从输出非空的成功 hook 中提取自定义指令
  const successfulOutputs = results
    .filter((result) => result.succeeded && result.output.trim().length > 0)
    .map((result) => result.output.trim())

  // 构建带有命令信息的用户显示消息
  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PreCompact [${result.command}] completed successfully`)
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(`PreCompact [${result.command}] failed: ${result.output.trim()}`)
      } else {
        displayMessages.push(`PreCompact [${result.command}] failed`)
      }
    }
  }

  return {
    newCustomInstructions:
      successfulOutputs.length > 0 ? successfulOutputs.join('\n\n') : undefined,
    userDisplayMessage: displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * Execute post-compact hooks if configured
 * @param compactData The compact data to pass to hooks, including the summary
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Object with optional userDisplayMessage
 */
export async function executePostCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    compactSummary: string
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  userDisplayMessage?: string
}> {
  const hookInput: PostCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PostCompact',
    trigger: compactData.trigger,
    compact_summary: compactData.compactSummary,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PostCompact [${result.command}] completed successfully`)
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(`PostCompact [${result.command}] failed: ${result.output.trim()}`)
      } else {
        displayMessages.push(`PostCompact [${result.command}] failed`)
      }
    }
  }

  return {
    userDisplayMessage: displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * Execute session end hooks if configured
 * @param reason The reason for ending the session
 * @param options Optional parameters including app state functions and signal
 * @returns Promise that resolves when all hooks complete
 */
