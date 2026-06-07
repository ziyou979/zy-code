import { randomUUID } from 'node:crypto'
import chalk from 'chalk'
import {
  isAsyncHookJSONOutput,
  isSyncHookJSONOutput,
  type SyncHookJSONOutput,
} from 'src/types/hooks/index.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { parseHookOutput, parseHttpHookOutput, processHookJSONOutput } from './commandRunner.js'
import { emitHookResponse, emitHookStarted } from './hookEvents.js'
import { getHookDisplayText } from './hooksSettings.js'

/**
 * 私有 helper：将 matched hooks 转换为 OTel/telemetry 用的简化 schema。
 */
function getHookDefinitionsForTelemetry(
  matchedHooks: MatchedHook[],
): Array<{ type: string; command?: string; prompt?: string; name?: string }> {
  return matchedHooks.map(({ hook }) => {
    if (hook.type === 'command') {
      return { type: 'command', command: hook.command }
    } else if (hook.type === 'prompt') {
      return { type: 'prompt', prompt: hook.prompt }
    } else if (hook.type === 'http') {
      return { type: 'http', command: hook.url }
    } else if (hook.type === 'mcp_tool') {
      return { type: 'mcp_tool', name: `${hook.server}/${hook.tool}` }
    } else if (hook.type === 'function') {
      return { type: 'function', name: 'function' }
    } else if (hook.type === 'callback') {
      return { type: 'callback', name: 'callback' }
    }
    return { type: 'unknown' }
  })
}

import type { PromptRequest, PromptResponse } from 'src/types/hooks/index.js'
import type { HookInput } from 'src/types/index.js'
import { addToTurnHookDuration, getSessionId, getStatsStore } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logOTelEvent } from '../../services/telemetry/events.js'
import {
  endHookSpan,
  isBetaTracingEnabled,
  startHookSpan,
} from '../../services/telemetry/sessionTracing.js'
import type { ToolUseContext } from '../../Tool.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { createDebugLog } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { all } from '../../utils/generators.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { execCommandHook } from './commandRunner.js'
import { shouldSkipHookDueToTrust, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from './config.js'
import { execAgentHook } from './execAgentHook.js'
import { execHttpHook } from './execHttpHook.js'
import { execMcpToolHook } from './execMcpToolHook.js'
import { execPromptHook } from './execPromptHook.js'
import { executeFunctionHook, executeHookCallback } from './functionHooks.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooksConfigSnapshot.js'
import {
  getHookTypeCounts,
  getMatchingHooks,
  getPluginHookCounts,
  isInternalHook,
  type MatchedHook,
} from './matcher.js'
import { getSessionHookCallback } from './sessionHooks.js'
import { maybeSpillHookOutput } from './spillOutput.js'
import { validateTerminalSequence } from './terminalSequence.js'
import type { AggregatedHookResult, HookResult } from './types.js'

const hookLog = createDebugLog('hooks')

/**
 * 将 createAttachmentMessage 的返回值转换为 HookResultMessage。
 * hook 引擎构造的消息在运行时是 AttachmentMessage 但需要作为
 * HookResultMessage 传递给调用方。
 */
// biome-ignore lint/suspicious/noExplicitAny: AttachmentMessage → HookResultMessage 跨类型桥接
function hookAttachment(attachment: Record<string, unknown>): any {
  return createAttachmentMessage(attachment as Parameters<typeof createAttachmentMessage>[0])
}

export async function* executeHooks({
  hookInput,
  toolUseID,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext,
  messages,
  forceSyncExecution,
  requestPrompt,
  toolInputSummary,
}: {
  hookInput: HookInput
  toolUseID: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
}): AsyncGenerator<AggregatedHookResult> {
  if (shouldDisableAllHooksIncludingManaged()) {
    return
  }

  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    return
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent

  // Bind the prompt callback to this hook's name and tool input summary so the UI can display context
  const boundRequestPrompt = requestPrompt?.(hookName, toolInputSummary)

  // SECURITY: ALL hooks require workspace trust in interactive mode
  // This centralized check prevents RCE vulnerabilities for all current and future hooks
  if (shouldSkipHookDueToTrust()) {
    hookLog(`Skipping ${hookName} hook execution - workspace trust not accepted`)
    return
  }

  const appState = toolUseContext ? toolUseContext.getAppState() : undefined
  // Use the agent's session ID if available, otherwise fall back to main session
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
    toolUseContext?.options?.tools,
  )
  if (matchingHooks.length === 0) {
    return
  }

  if (signal?.aborted) {
    return
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
  } else {
    // Fast-path: all hooks are internal callbacks (sessionFileAccessHooks,
    // attributionHooks). These return {} and don't use the abort signal, so we
    // can skip span/progress/abortSignal/processHookJSONOutput/resultLoop.
    // Measured: 6.01µs → ~1.8µs per PostToolUse hit (-70%).
    const batchStartTime = Date.now()
    const context = toolUseContext
      ? {
          getAppState: toolUseContext.getAppState,
          updateAttributionState: toolUseContext.updateAttributionState,
        }
      : undefined
    for (const [i, { hook }] of matchingHooks.entries()) {
      if (hook.type === 'callback') {
        await hook.callback(hookInput, toolUseID, signal, i, context)
      }
    }
    const totalDurationMs = Date.now() - batchStartTime
    getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
    addToTurnHookDuration(totalDurationMs)
    logEvent(`zy_repl_hook_finished`, {
      hookName: hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numCommands: matchingHooks.length,
      numSuccess: matchingHooks.length,
      numBlocking: 0,
      numNonBlockingError: 0,
      numCancelled: 0,
      totalDurationMs,
    })
    return
  }

  // Collect hook definitions for beta tracing telemetry
  const hookDefinitionsJson = isBetaTracingEnabled()
    ? jsonStringify(getHookDefinitionsForTelemetry(matchingHooks))
    : '[]'

  // Log hook execution start to OTEL (only for beta tracing)
  if (isBetaTracingEnabled()) {
    void logOTelEvent('hook_execution_start', {
      hook_event: hookEvent,
      hook_name: hookName,
      num_hooks: String(matchingHooks.length),
      managed_only: String(shouldAllowManagedHooksOnly()),
      hook_definitions: hookDefinitionsJson,
      hook_source: shouldAllowManagedHooksOnly() ? 'policySettings' : 'merged',
    })
  }

  // Start hook span for beta tracing
  const hookSpan = startHookSpan(hookEvent, hookName, matchingHooks.length, hookDefinitionsJson)

  // Yield progress messages for each hook before execution
  for (const { hook } of matchingHooks) {
    yield {
      // biome-ignore lint/suspicious/noExplicitAny: hook 引擎消息构造需要动态类型
      message: {
        type: 'progress',
        data: {
          type: 'hook_progress',
          hookEvent,
          hookName,
          command: getHookDisplayText(hook),
          ...(hook.type === 'prompt' && { promptText: hook.prompt }),
          ...('statusMessage' in hook &&
            hook.statusMessage != null && {
              statusMessage: hook.statusMessage,
            }),
        },
        parentToolUseID: toolUseID,
        toolUseID,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
      } as unknown as HookResultMessage,
    }
  }

  // Track wall-clock time for the entire hook batch
  const batchStartTime = Date.now()

  // Lazy-once stringify of hookInput. Shared across all command/prompt/agent/http
  // hooks in this batch (hookInput is never mutated). Callback/function hooks
  // return before reaching this, so batches with only those pay no stringify cost.
  let jsonInputResult: { ok: true; value: string } | { ok: false; error: unknown } | undefined
  function getJsonInput() {
    if (jsonInputResult !== undefined) {
      return jsonInputResult
    }
    try {
      return (jsonInputResult = { ok: true, value: jsonStringify(hookInput) })
    } catch (error) {
      logError(Error(`Failed to stringify hook ${hookName} input`, { cause: error }))
      return (jsonInputResult = { ok: false, error })
    }
  }

  // Run all hooks in parallel with individual timeouts
  const hookPromises = matchingHooks.map(async function* (
    { hook, pluginRoot, pluginId, skillRoot },
    hookIndex,
  ): AsyncGenerator<HookResult> {
    if (hook.type === 'callback') {
      const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
        timeoutMs: callbackTimeoutMs,
      })
      yield executeHookCallback({
        toolUseID,
        hook,
        hookEvent,
        hookInput,
        signal: abortSignal,
        hookIndex,
        toolUseContext,
      }).finally(cleanup)
      return
    }

    if (hook.type === 'function') {
      if (!messages) {
        yield {
          message: hookAttachment({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: 'Messages not provided for function hook',
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        return
      }

      // Function hooks only come from session storage with callback embedded
      yield executeFunctionHook({
        hook,
        messages,
        hookName,
        toolUseID,
        hookEvent,
        timeoutMs,
        signal,
      })
      return
    }

    // Command and prompt hooks need jsonInput
    const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
    const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: commandTimeoutMs,
    })
    const hookId = randomUUID()
    const hookStartMs = Date.now()
    const hookCommand = getHookDisplayText(hook)

    try {
      const jsonInputRes = getJsonInput()
      if (!jsonInputRes.ok) {
        yield {
          message: hookAttachment({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: `Failed to prepare hook input: ${errorMessage((jsonInputRes as { ok: false; error: unknown }).error)}`,
            command: hookCommand,
            durationMs: Date.now() - hookStartMs,
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        cleanup()
        return
      }
      const jsonInput = jsonInputRes.value

      if (hook.type === 'prompt') {
        if (!toolUseContext) {
          throw new Error('ToolUseContext is required for prompt hooks. This is a bug.')
        }
        const promptResult = await execPromptHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          messages,
          toolUseID,
        )
        // Inject timing fields for hook visibility
        // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
        if ((promptResult.message as any)?.type === 'attachment') {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
          const att = (promptResult.message as any).attachment
          if (att.type === 'hook_success' || att.type === 'hook_non_blocking_error') {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield promptResult
        cleanup?.()
        return
      }

      if (hook.type === 'agent') {
        if (!toolUseContext) {
          throw new Error('ToolUseContext is required for agent hooks. This is a bug.')
        }
        if (!messages) {
          throw new Error('Messages are required for agent hooks. This is a bug.')
        }
        const agentResult = await execAgentHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          toolUseID,
          messages,
          'agent_type' in hookInput ? (hookInput.agent_type as string) : undefined,
        )
        // Inject timing fields for hook visibility
        // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
        if ((agentResult.message as any)?.type === 'attachment') {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
          const att = (agentResult.message as any).attachment
          if (att.type === 'hook_success' || att.type === 'hook_non_blocking_error') {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield agentResult
        cleanup?.()
        return
      }

      if (hook.type === 'mcp_tool') {
        if (!toolUseContext) {
          throw new Error('ToolUseContext is required for mcp_tool hooks. This is a bug.')
        }
        const mcpResult = await execMcpToolHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          toolUseID,
        )
        // Inject timing fields for hook visibility
        // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
        if ((mcpResult.message as any)?.type === 'attachment') {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时消息类型可能是 AttachmentMessage
          const att = (mcpResult.message as any).attachment
          if (att.type === 'hook_success' || att.type === 'hook_non_blocking_error') {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield mcpResult
        cleanup?.()
        return
      }

      if (hook.type === 'http') {
        emitHookStarted(hookId, hookName, hookEvent)

        // execHttpHook manages its own timeout internally via hook.timeout or
        // DEFAULT_HTTP_HOOK_TIMEOUT_MS, so pass the parent signal directly
        // to avoid double-stacking timeouts with abortSignal.
        const httpResult = await execHttpHook(hook, hookEvent, jsonInput, signal)
        cleanup?.()

        if (httpResult.aborted) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: 'Hook cancelled',
            stdout: '',
            stderr: '',
            exitCode: undefined,
            outcome: 'cancelled',
          })
          yield {
            message: hookAttachment({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent,
            }),
            outcome: 'cancelled' as const,
            hook,
          }
          return
        }

        if (httpResult.error || !httpResult.ok) {
          const stderr = httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: stderr,
            stdout: '',
            stderr,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: hookAttachment({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr,
              stdout: '',
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        // HTTP hooks must return JSON — parse and validate through Zod
        const { json: httpJson, validationError: httpValidationError } = parseHttpHookOutput(
          httpResult.body,
        )

        if (httpValidationError) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: `JSON validation failed: ${httpValidationError}`,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: hookAttachment({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: `JSON validation failed: ${httpValidationError}`,
              stdout: httpResult.body,
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        if (httpJson && isAsyncHookJSONOutput(httpJson)) {
          // Async response: treat as success (no further processing)
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        if (httpJson) {
          const processed = processHookJSONOutput({
            json: httpJson as SyncHookJSONOutput,
            command: hook.url,
            hookName,
            toolUseID,
            hookEvent,
            expectedHookEvent: hookEvent,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
          })
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            ...processed,
            outcome: 'success' as const,
            hook,
          }
          return
        }

        return
      }

      emitHookStarted(hookId, hookName, hookEvent)

      const result = await execCommandHook(
        hook,
        hookEvent,
        hookName,
        jsonInput,
        abortSignal,
        hookId,
        hookIndex,
        pluginRoot,
        pluginId,
        skillRoot,
        forceSyncExecution,
        boundRequestPrompt,
        hookInput.effort?.level,
      )
      cleanup?.()
      const durationMs = Date.now() - hookStartMs

      if (result.backgrounded) {
        yield {
          outcome: 'success' as const,
          hook,
        }
        return
      }

      if (result.aborted) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'cancelled',
        })
        yield {
          message: hookAttachment({
            type: 'hook_cancelled',
            hookName,
            toolUseID,
            hookEvent,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'cancelled' as const,
          hook,
        }
        return
      }

      // 首先尝试 JSON 解析
      const { json, plainText, validationError } = parseHookOutput(result.stdout)

      if (validationError) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: `JSON validation failed: ${validationError}`,
          exitCode: 1,
          outcome: 'error',
        })
        yield {
          message: hookAttachment({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID,
            hookEvent,
            stderr: `JSON validation failed: ${validationError}`,
            stdout: result.stdout,
            exitCode: 1,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'non_blocking_error' as const,
          hook,
        }
        return
      }

      if (json) {
        // 异步响应在执行期间已被后台化
        if (isAsyncHookJSONOutput(json)) {
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        // Process JSON output
        const processed = processHookJSONOutput({
          json,
          command: hookCommand,
          hookName,
          toolUseID,
          hookEvent,
          expectedHookEvent: hookEvent,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
        })

        // Handle suppressOutput (skip for async responses)
        if (
          isSyncHookJSONOutput(json) &&
          !json.suppressOutput &&
          plainText &&
          result.status === 0
        ) {
          // Still show non-JSON output if not suppressed
          const content = `${chalk.bold(hookName)} completed`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            outcome: 'success',
          })
          yield {
            ...processed,
            message:
              processed.message ||
              hookAttachment({
                type: 'hook_success',
                hookName,
                toolUseID,
                hookEvent,
                content,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.status,
                command: hookCommand,
                durationMs,
              }),
            outcome: 'success' as const,
            hook,
          }
          return
        }

        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: result.status === 0 ? 'success' : 'error',
        })
        yield {
          ...processed,
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 对非 JSON 输出回退到现有逻辑
      if (result.status === 0) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'success',
        })
        yield {
          message: hookAttachment({
            type: 'hook_success',
            hookName,
            toolUseID,
            hookEvent,
            // 非 JSON 的 hook stdout 会作为 content 注入模型上下文：超阈值落盘，
            // 只留预览+路径，防止写错的 hook 撑爆上下文。
            content: maybeSpillHookOutput(hookName, result.stdout.trim()).inline,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 退出码为 2 的 hook 提供阻塞反馈
      if (result.status === 2) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'error',
        })
        yield {
          blockingError: {
            blockingError: `[${hook.command}]: ${result.stderr || 'No stderr output'}`,
            command: hook.command,
          },
          outcome: 'blocking' as const,
          hook,
        }
        return
      }

      // 任何其他非零退出码都是非关键错误，
      // 应仅展示给用户。
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        outcome: 'error',
      })
      yield {
        message: hookAttachment({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`,
          stdout: result.stdout,
          exitCode: result.status,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    } catch (error) {
      // Clean up on error
      cleanup?.()

      const errorMessage = error instanceof Error ? error.message : String(error)
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: `Failed to run: ${errorMessage}`,
        stdout: '',
        stderr: `Failed to run: ${errorMessage}`,
        exitCode: 1,
        outcome: 'error',
      })
      yield {
        message: hookAttachment({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed to run: ${errorMessage}`,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    }
  })

  // 跟踪结果用于日志记录
  const outcomes = {
    success: 0,
    blocking: 0,
    non_blocking_error: 0,
    cancelled: 0,
  }

  let permissionBehavior: PermissionResult['behavior'] | undefined

  // 并行运行所有 hook 并等待全部完成
  for await (const result of all(hookPromises)) {
    outcomes[result.outcome]++

    // 尽早检查 preventContinuation
    if (result.preventContinuation) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) requested preventContinuation`,
      )
      yield {
        preventContinuation: true,
        stopReason: result.stopReason,
      }
    }

    // 处理不同的结果类型
    if (result.blockingError) {
      yield {
        blockingError: result.blockingError,
      }
    }

    if (result.message) {
      yield { message: result.message }
    }

    // 如果存在，单独产出系统消息
    if (result.systemMessage) {
      yield {
        message: hookAttachment({
          type: 'hook_system_message',
          content: result.systemMessage,
          hookName,
          toolUseID,
          hookEvent,
        }),
      }
    }

    // 终端控制序列：所有 hook 事件的统一写入点。白名单校验后直接写 stdout
    // （仅放行 OSC 0/9 + BEL，CSI 被丢弃，避免破坏 Ink 渲染）。
    if (result.terminalSequence) {
      const safe = validateTerminalSequence(result.terminalSequence)
      if (safe) {
        process.stdout.write(safe)
      } else {
        hookLog(
          `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) terminalSequence rejected by whitelist`,
        )
      }
    }

    // 从 hook 收集附加上下文
    if (result.additionalContext) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
      )
      yield {
        additionalContexts: [result.additionalContext],
      }
    }

    if (result.initialUserMessage) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided initialUserMessage (${result.initialUserMessage.length} chars)`,
      )
      yield {
        initialUserMessage: result.initialUserMessage,
      }
    }

    if (result.watchPaths && result.watchPaths.length > 0) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided ${result.watchPaths.length} watchPaths`,
      )
      yield {
        watchPaths: result.watchPaths,
      }
    }

    // 如果提供了 updatedToolOutput 则产出（来自 PostToolUse hook，全工具）
    if (result.updatedToolOutput !== undefined) {
      hookLog(`Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced tool output`)
      yield {
        updatedToolOutput: result.updatedToolOutput,
      }
    }

    // 如果提供了 updatedMCPToolOutput 则产出（来自 PostToolUse hook）
    if (result.updatedMCPToolOutput) {
      hookLog(`Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced MCP tool output`)
      yield {
        updatedMCPToolOutput: result.updatedMCPToolOutput,
      }
    }

    // 按优先级检查权限行为：deny > ask > allow
    if (result.permissionBehavior) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) returned permissionDecision: ${result.permissionBehavior}${result.hookPermissionDecisionReason ? ` (reason: ${result.hookPermissionDecisionReason})` : ''}`,
      )
      // 应用优先级规则
      switch (result.permissionBehavior) {
        case 'deny':
          // deny 始终具有最高优先级
          permissionBehavior = 'deny'
          break
        case 'ask':
          // ask 优先于 allow 但不优先于 deny
          if (permissionBehavior !== 'deny') {
            permissionBehavior = 'ask'
          }
          break
        case 'allow':
          // 仅在未设置其他行为时才允许
          if (!permissionBehavior) {
            permissionBehavior = 'allow'
          }
          break
        case 'passthrough':
          // passthrough 不设置权限行为
          break
      }
    }

    // 如果提供了权限行为和 updatedInput 则产出（来自 allow 或 ask 行为）
    if (permissionBehavior !== undefined) {
      const updatedInput =
        result.updatedInput &&
        (result.permissionBehavior === 'allow' || result.permissionBehavior === 'ask')
          ? result.updatedInput
          : undefined
      if (updatedInput) {
        hookLog(
          `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(updatedInput).join(', ')}]`,
        )
      }
      yield {
        permissionBehavior,
        hookPermissionDecisionReason: result.hookPermissionDecisionReason,
        hookSource: matchingHooks.find((m) => m.hook === result.hook)?.hookSource,
        updatedInput,
      }
    }

    // Yield updatedInput separately for passthrough case (no permission decision)
    // This allows hooks to modify input without making a permission decision
    // Note: Check result.permissionBehavior (this hook's behavior), not the aggregated permissionBehavior
    if (result.updatedInput && result.permissionBehavior === undefined) {
      hookLog(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(result.updatedInput).join(', ')}]`,
      )
      yield {
        updatedInput: result.updatedInput,
      }
    }
    // 如果提供了权限请求结果则产出（来自 PermissionRequest hook）
    if (result.permissionRequestResult) {
      yield {
        permissionRequestResult: result.permissionRequestResult,
      }
    }
    // 如果提供了 retry 标志则产出（来自 PermissionDenied hook）
    if (result.retry) {
      yield {
        retry: result.retry,
      }
    }
    // MessageDisplay：产出显示变换/隐藏决策
    if (result.transformedText !== undefined || result.hide !== undefined) {
      yield {
        ...(result.transformedText !== undefined && { transformedText: result.transformedText }),
        ...(result.hide !== undefined && { hide: result.hide }),
      }
    }
    // 如果提供了 elicitation 响应则产出（来自 Elicitation hook）
    if (result.elicitationResponse) {
      yield {
        elicitationResponse: result.elicitationResponse,
      }
    }
    // 如果提供了 elicitation 结果响应则产出（来自 ElicitationResult hook）
    if (result.elicitationResultResponse) {
      yield {
        elicitationResultResponse: result.elicitationResultResponse,
      }
    }

    // 如果这是 command/prompt/function hook（非 callback hook）则调用会话 hook 回调
    if (appState && result.hook.type !== 'callback') {
      const sessionId = getSessionId()
      // 当 matchQuery 为 undefined 时使用空字符串作为匹配器（如 Stop hook）
      const matcher = matchQuery ?? ''
      const hookEntry = getSessionHookCallback(appState, sessionId, hookEvent, matcher, result.hook)
      // 仅在成功结果时调用 onHookSuccess
      if (hookEntry?.onHookSuccess && result.outcome === 'success') {
        try {
          hookEntry.onHookSuccess(result.hook, result as AggregatedHookResult)
        } catch (error) {
          logError(Error('Session hook success callback failed', { cause: error }))
        }
      }
    }
  }

  const totalDurationMs = Date.now() - batchStartTime
  getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
  addToTurnHookDuration(totalDurationMs)

  logEvent(`zy_repl_hook_finished`, {
    hookName: hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    numCommands: matchingHooks.length,
    numSuccess: outcomes.success,
    numBlocking: outcomes.blocking,
    numNonBlockingError: outcomes.non_blocking_error,
    numCancelled: outcomes.cancelled,
    totalDurationMs,
  })

  // Log hook execution completion to OTEL (only for beta tracing)
  if (isBetaTracingEnabled()) {
    const hookDefinitionsComplete = getHookDefinitionsForTelemetry(matchingHooks)

    void logOTelEvent('hook_execution_complete', {
      hook_event: hookEvent,
      hook_name: hookName,
      num_hooks: String(matchingHooks.length),
      num_success: String(outcomes.success),
      num_blocking: String(outcomes.blocking),
      num_non_blocking_error: String(outcomes.non_blocking_error),
      num_cancelled: String(outcomes.cancelled),
      managed_only: String(shouldAllowManagedHooksOnly()),
      hook_definitions: jsonStringify(hookDefinitionsComplete),
      hook_source: shouldAllowManagedHooksOnly() ? 'policySettings' : 'merged',
    })
  }

  // End hook span for beta tracing
  endHookSpan(hookSpan, {
    numSuccess: outcomes.success,
    numBlocking: outcomes.blocking,
    numNonBlockingError: outcomes.non_blocking_error,
    numCancelled: outcomes.cancelled,
  })
}
