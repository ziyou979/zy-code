import type { HookCallback } from 'src/types/hooks/index.js'
import { isAsyncHookJSONOutput } from 'src/types/hooks/index.js'
import type { HookEvent, HookInput } from 'src/types/index.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments/attachments.js'
import { createCombinedAbortSignal } from '../../utils/abortController.js'
import { logError } from '../../services/infra/log.js'
import { processHookJSONOutput } from './hookOutputParser.js'
import type { FunctionHook } from './sessionHooks.js'
import type { HookResult } from './types.js'

export async function executeFunctionHook({
  hook,
  messages,
  hookName,
  toolUseID,
  hookEvent,
  timeoutMs,
  signal,
}: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
}): Promise<HookResult> {
  const callbackTimeoutMs = hook.timeout ?? timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: callbackTimeoutMs,
  })

  try {
    // 检查是否已中止
    if (abortSignal.aborted) {
      cleanup()
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // Execute callback with abort signal
    const passed = await new Promise<boolean>((resolve, reject) => {
      // 处理 abort signal
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)

      // 执行 callback
      Promise.resolve(hook.callback(messages, abortSignal))
        .then((result) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(result)
        })
        .catch((error) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })

    cleanup()

    if (passed) {
      return {
        outcome: 'success',
        hook,
      }
    }
    return {
      blockingError: {
        blockingError: hook.errorMessage,
        command: 'function',
      },
      outcome: 'blocking',
      hook,
    }
  } catch (error) {
    cleanup()

    // Handle cancellation
    if (
      error instanceof Error &&
      (error.message === 'Function hook cancelled' || error.name === 'AbortError')
    ) {
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // Log for monitoring
    logError(error)
    return {
      message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        hookName,
        toolUseID,
        hookEvent,
        content: error instanceof Error ? error.message : 'Function hook execution error',
      }) as unknown as HookResultMessage,
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

export async function executeHookCallback({
  toolUseID,
  hook,
  hookEvent,
  hookInput,
  signal,
  hookIndex,
  toolUseContext,
}: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  // 为需要状态访问的 callback 创建上下文
  const context = toolUseContext
    ? {
        getAppState: toolUseContext.getAppState,
        updateAttributionState: toolUseContext.updateAttributionState,
      }
    : undefined
  const json = await hook.callback(hookInput, toolUseID, signal, hookIndex, context)
  if (isAsyncHookJSONOutput(json)) {
    return {
      outcome: 'success',
      hook,
    }
  }

  const processed = processHookJSONOutput({
    json,
    command: 'callback',
    // TODO: 如果 hook 来自插件，使用插件的完整路径以便于调试
    hookName: `${hookEvent}:Callback`,
    toolUseID,
    hookEvent,
    expectedHookEvent: hookEvent,
    // Callback 没有 stdout/stderr/exitCode
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
  })
  return {
    ...processed,
    outcome: 'success',
    hook,
  }
}
