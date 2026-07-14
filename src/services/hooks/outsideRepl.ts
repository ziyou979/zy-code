import { randomUUID } from 'node:crypto'
import { isAsyncHookJSONOutput, isSyncHookJSONOutput } from 'src/types/hooks/index.js'
import type { HookInput } from 'src/types/index.js'
import { getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createDebugLog } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { execCommandHook, parseHookOutput, parseHttpHookOutput } from './commandRunner.js'
import { shouldSkipHookDueToTrust, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from './config.js'
import { execHttpHook } from './execHttpHook.js'
import { shouldDisableAllHooksIncludingManaged } from './hooksConfigSnapshot.js'
import {
  getHookTypeCounts,
  getMatchingHooks,
  getPluginHookCounts,
  isInternalHook,
} from './matcher.js'

const hookLog = createDebugLog('hooks')

export type HookOutsideReplResult = {
  command: string
  succeeded: boolean
  output: string
  blocked: boolean
  watchPaths?: string[]
  systemMessage?: string
}

export function hasBlockingResult(results: HookOutsideReplResult[]): boolean {
  return results.some((r) => r.blocked)
}

/**
 * Execute hooks outside of the REPL (e.g. notifications, session end)
 *
 * Unlike executeHooks() which yields messages that are exposed to the model as
 * system messages, this function only logs errors via logForDebugging (visible
 * with --debug). Callers that need to surface errors to users should handle
 * the returned results appropriately (e.g. executeSessionEndHooks writes to
 * stderr during shutdown).
 *
 * @param getAppState Optional function to get the current app state (for session hooks)
 * @param hookInput The structured hook input that will be validated and converted to JSON
 * @param matchQuery The query to match against hook matchers
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Array of HookOutsideReplResult objects containing command, succeeded, and output
 */
export async function executeHooksOutsideREPL({
  getAppState,
  hookInput,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
}: {
  getAppState?: () => AppState
  hookInput: HookInput
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<HookOutsideReplResult[]> {
  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    return []
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent
  if (shouldDisableAllHooksIncludingManaged()) {
    hookLog(`Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`)
    return []
  }

  // SECURITY: ALL hooks require workspace trust in interactive mode
  // This centralized check prevents RCE vulnerabilities for all current and future hooks
  if (shouldSkipHookDueToTrust()) {
    hookLog(`Skipping ${hookName} hook execution - workspace trust not accepted`)
    return []
  }

  const appState = getAppState ? getAppState() : undefined
  // 对 REPL 外部 hook 使用主会话 ID
  const sessionId = getSessionId()
  const matchingHooks = await getMatchingHooks(appState, sessionId, hookEvent, hookInput)
  if (matchingHooks.length === 0) {
    return []
  }

  if (signal?.aborted) {
    return []
  }

  const userHooks = matchingHooks.filter((h) => !isInternalHook(h))
  if (userHooks.length > 0) {
    const pluginHookCounts = getPluginHookCounts(userHooks)
    const hookTypeCounts = getHookTypeCounts(userHooks)
    logEvent(`zy_run_hook`, {
      hookName: hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numCommands: userHooks.length,
      hookTypeCounts: jsonStringify(
        hookTypeCounts,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(pluginHookCounts && {
        pluginHookCounts: jsonStringify(
          pluginHookCounts,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }

  // 校验并序列化 hook 输入
  let jsonInput: string
  try {
    jsonInput = jsonStringify(hookInput)
  } catch (error) {
    logError(error)
    return []
  }

  // 以各自的超时并行运行所有 hook
  const hookPromises = matchingHooks.map(async ({ hook, pluginRoot, pluginId }, hookIndex) => {
    // 处理 callback hook
    if (hook.type === 'callback') {
      const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
        timeoutMs: callbackTimeoutMs,
      })

      try {
        const toolUseID = randomUUID()
        const json = await hook.callback(hookInput, toolUseID, abortSignal, hookIndex)

        cleanup?.()

        if (isAsyncHookJSONOutput(json)) {
          hookLog(`${hookName} [callback] returned async response, returning empty output`)
          return {
            command: 'callback',
            succeeded: true,
            output: '',
            blocked: false,
          }
        }

        const output =
          hookEvent === 'WorktreeCreate' &&
          isSyncHookJSONOutput(json) &&
          json.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
            ? json.hookSpecificOutput.worktreePath
            : json.systemMessage || ''
        const blocked = isSyncHookJSONOutput(json) && json.decision === 'block'

        hookLog(`${hookName} [callback] completed successfully`)

        return {
          command: 'callback',
          succeeded: true,
          output,
          blocked,
        }
      } catch (error) {
        cleanup?.()

        const errorMessage = error instanceof Error ? error.message : String(error)
        hookLog(`${hookName} [callback] failed to run: ${errorMessage}`, { level: 'error' })
        return {
          command: 'callback',
          succeeded: false,
          output: errorMessage,
          blocked: false,
        }
      }
    }

    // TODO: 实现 REPL 外部的 prompt stop hook
    if (hook.type === 'prompt') {
      return {
        command: hook.prompt,
        succeeded: false,
        output: 'Prompt stop hooks are not yet supported outside REPL',
        blocked: false,
      }
    }

    // TODO: 实现 REPL 外部的 agent stop hook
    if (hook.type === 'agent') {
      return {
        command: hook.prompt,
        succeeded: false,
        output: 'Agent stop hooks are not yet supported outside REPL',
        blocked: false,
      }
    }

    // 函数 hook 需要 messages 数组（仅在 REPL 上下文中可用）
    // 对于 -p 模式的 Stop hook，使用支持函数 hook 的 executeStopHooks
    if (hook.type === 'function') {
      logError(
        new Error(
          `Function hook reached executeHooksOutsideREPL for ${hookEvent}. Function hooks should only be used in REPL context (Stop hooks).`,
        ),
      )
      return {
        command: 'function',
        succeeded: false,
        output: 'Internal error: function hook executed outside REPL context',
        blocked: false,
      }
    }

    // Handle HTTP hooks (no toolUseContext needed - just HTTP POST).
    // execHttpHook handles its own timeout internally via hook.timeout or
    // DEFAULT_HTTP_HOOK_TIMEOUT_MS, so we pass signal directly.
    if (hook.type === 'http') {
      try {
        const httpResult = await execHttpHook(hook, hookEvent, jsonInput, signal)

        if (httpResult.aborted) {
          hookLog(`${hookName} [${hook.url}] cancelled`)
          return {
            command: hook.url,
            succeeded: false,
            output: 'Hook cancelled',
            blocked: false,
          }
        }

        if (httpResult.error || !httpResult.ok) {
          const errMsg = httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          hookLog(`${hookName} [${hook.url}] failed: ${errMsg}`, {
            level: 'error',
          })
          return {
            command: hook.url,
            succeeded: false,
            output: errMsg,
            blocked: false,
          }
        }

        // HTTP hooks must return JSON — parse and validate through Zod
        const { json: httpJson, validationError: httpValidationError } = parseHttpHookOutput(
          httpResult.body,
        )
        if (httpValidationError) {
          throw new Error(httpValidationError)
        }
        if (httpJson && !isAsyncHookJSONOutput(httpJson)) {
          hookLog(`Parsed JSON output from HTTP hook: ${jsonStringify(httpJson)}`, {
            level: 'verbose',
          })
        }
        const jsonBlocked =
          httpJson &&
          !isAsyncHookJSONOutput(httpJson) &&
          isSyncHookJSONOutput(httpJson) &&
          httpJson.decision === 'block'

        // WorktreeCreate's consumer reads `output` as the bare filesystem
        // path. Command hooks provide it via stdout; http hooks provide it
        // via hookSpecificOutput.worktreePath. Without worktreePath, emit ''
        // so the consumer's length filter skips it instead of treating the
        // raw '{}' body as a path.
        const output =
          hookEvent === 'WorktreeCreate'
            ? httpJson &&
              isSyncHookJSONOutput(httpJson) &&
              httpJson.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
              ? httpJson.hookSpecificOutput.worktreePath
              : ''
            : httpResult.body

        return {
          command: hook.url,
          succeeded: true,
          output,
          blocked: !!jsonBlocked,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        hookLog(`${hookName} [${hook.url}] failed to run: ${errorMessage}`, {
          level: 'error',
        })
        return {
          command: hook.url,
          succeeded: false,
          output: errorMessage,
          blocked: false,
        }
      }
    }

    // mcp_tool hooks need the connected MCP clients from toolUseContext, which is
    // unavailable on the outside-REPL path (lifecycle events). Not supported here.
    if (hook.type === 'mcp_tool') {
      return {
        command: `${hook.server}/${hook.tool}`,
        succeeded: false,
        output: 'mcp_tool hooks are not yet supported outside REPL',
        blocked: false,
      }
    }

    // Handle command hooks
    const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
    const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: commandTimeoutMs,
    })
    try {
      const result = await execCommandHook(
        hook,
        hookEvent,
        hookName,
        jsonInput,
        abortSignal,
        randomUUID(),
        hookIndex,
        pluginRoot,
        pluginId,
      )

      // hook 完成后清除超时
      cleanup?.()

      if (result.aborted) {
        hookLog(`${hookName} [${hook.command}] cancelled`)
        return {
          command: hook.command,
          succeeded: false,
          output: 'Hook cancelled',
          blocked: false,
        }
      }

      hookLog(`${hookName} [${hook.command}] completed with status ${result.status}`)

      // 解析 JSON 以获取要输出的消息。
      const { json, validationError } = parseHookOutput(result.stdout)
      if (validationError) {
        // 校验错误通过 logForDebugging 记录并在 output 中返回
        throw new Error(validationError)
      }
      if (json && !isAsyncHookJSONOutput(json)) {
        hookLog(`Parsed JSON output from hook: ${jsonStringify(json)}`, {
          level: 'verbose',
        })
      }

      // Blocked if exit code 2 or JSON decision: 'block'
      const jsonBlocked =
        json &&
        !isAsyncHookJSONOutput(json) &&
        isSyncHookJSONOutput(json) &&
        json.decision === 'block'
      const blocked = result.status === 2 || !!jsonBlocked

      // 对于成功的 hook（退出码 0），使用 stdout；对于失败的 hook，使用 stderr
      const output = result.status === 0 ? result.stdout || '' : result.stderr || ''

      const watchPaths =
        json &&
        isSyncHookJSONOutput(json) &&
        json.hookSpecificOutput &&
        'watchPaths' in json.hookSpecificOutput
          ? json.hookSpecificOutput.watchPaths
          : undefined

      const systemMessage = json && isSyncHookJSONOutput(json) ? json.systemMessage : undefined

      return {
        command: hook.command,
        succeeded: result.status === 0,
        output,
        blocked,
        watchPaths,
        systemMessage,
      }
    } catch (error) {
      // Clean up on error
      cleanup?.()

      const errorMessage = error instanceof Error ? error.message : String(error)
      hookLog(`${hookName} [${hook.command}] failed to run: ${errorMessage}`, {
        level: 'error',
      })
      return {
        command: hook.command,
        succeeded: false,
        output: errorMessage,
        blocked: false,
      }
    }
  })

  // 等待所有 hook 完成并收集结果
  return await Promise.all(hookPromises)
}

/**
 * Execute pre-tool hooks if configured
 * @param toolName The name of the tool (e.g., 'Write', 'Edit', 'Bash')
 * @param toolUseID The ID of the tool use
 * @param toolInput The input that will be passed to the tool
 * @param permissionMode Optional permission mode from toolPermissionContext
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @param toolUseContext Optional ToolUseContext for prompt-based hooks
 * @returns Async generator that yields progress messages and returns blocking errors
 */
