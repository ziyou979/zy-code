// biome-ignore-all assist/source/organizeImports: ANT-ONLY 的 import 标记不得被重新排序
/**
 * Hook 是用户自定义的 shell 命令，可在 ZY Code 生命周期的各个节点执行。
 */
import { basename } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathExists } from './file.js'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from 'src/services/task/TaskOutput.js'
import { getCwd } from './cwd.js'
import { randomUUID } from 'node:crypto'
import { formatShellPrefixCommand } from 'src/shell-eval/bash/shellPrefix.js'
import { getHookEnvFilePath, invalidateSessionEnvCache } from './sessionEnvironment.js'
import { subprocessEnv } from './subprocessEnv.js'
import { getPlatform } from './platform.js'
import { findGitBashPath, windowsPathToPosixPath } from './windowsPaths.js'
import { getCachedPowerShellPath } from 'src/shell-eval/shared/powershellDetection.js'
import { DEFAULT_HOOK_SHELL } from 'src/shell-eval/shared/shellProvider.js'
import { buildPowerShellArgs } from 'src/shell-eval/shared/powershellProvider.js'
import { loadPluginOptions, substituteUserConfigVariables } from './plugins/pluginOptionsStorage.js'
import { getPluginDataDir } from './plugins/pluginDirectories.js'
import {
  getSessionId,
  getProjectRoot,
  getIsNonInteractiveSession,
  getRegisteredHooks,
  getStatsStore,
  addToTurnHookDuration,
  getOriginalCwd,
  getMainThreadAgentType,
} from '../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from './config.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooks/hooksConfigSnapshot.js'
import { getTranscriptPathForSession, getAgentTranscriptPath } from './sessionStorage.js'
import type { AgentId } from '../types/ids.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { logOTelEvent } from 'src/services/telemetry/events.js'
import { ALLOWED_OFFICIAL_MARKETPLACE_NAMES } from './plugins/schemas.js'
import {
  startHookSpan,
  endHookSpan,
  isBetaTracingEnabled,
} from 'src/services/telemetry/sessionTracing.js'
import {
  hookJSONOutputSchema,
  promptRequestSchema,
  type HookCallback,
  type HookCallbackMatcher,
  type PromptRequest,
  type PromptResponse,
  isAsyncHookJSONOutput,
  isSyncHookJSONOutput,
  type PermissionRequestResult,
} from '../types/hooks.js'
import type {
  HookEvent,
  HookInput,
  HookJSONOutput,
  NotificationHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PermissionDeniedHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  SetupHookInput,
  StopHookInput,
  StopFailureHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TeammateIdleHookInput,
  TaskCreatedHookInput,
  TaskCompletedHookInput,
  ConfigChangeHookInput,
  CwdChangedHookInput,
  FileChangedHookInput,
  InstructionsLoadedHookInput,
  UserPromptSubmitHookInput,
  PermissionRequestHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  PermissionUpdate,
  ExitReason,
  SyncHookJSONOutput,
  AsyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
// @ts-expect-error
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import type { HookResultMessage } from 'src/types/message.js'
import chalk from 'chalk'
import type {
  HookMatcher,
  HookCommand,
  PluginHookMatcher,
  SkillHookMatcher,
} from './settings/types.js'
import { getHookDisplayText } from './hooks/hooksSettings.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { firstLineOf } from './stringUtils.js'
import {
  normalizeLegacyToolName,
  getLegacyToolNames,
  permissionRuleValueFromString,
} from './permissions/permissionRuleParser.js'
import { logError } from './log.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import type { PermissionResult } from './permissions/PermissionResult.js'
import { registerPendingAsyncHook } from './hooks/AsyncHookRegistry.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import { extractTextContent, getLastAssistantMessage, wrapInSystemReminder } from './messages.js'
import { emitHookStarted, emitHookResponse, startHookProgressInterval } from './hooks/hookEvents.js'
import { createAttachmentMessage } from './attachments.js'
import { all } from './generators.js'
import { findToolByName, type Tools, type ToolUseContext } from '../Tool.js'
import { execPromptHook } from './hooks/execPromptHook.js'
import type { Message, AssistantMessage } from '../types/message.js'
import { execAgentHook } from './hooks/execAgentHook.js'
import { execHttpHook } from './hooks/execHttpHook.js'
import type { ShellCommand } from './ShellCommand.js'
import {
  getSessionHooks,
  getSessionFunctionHooks,
  getSessionHookCallback,
  clearSessionHooks,
  type SessionDerivedHookMatcher,
  type FunctionHook,
} from './hooks/sessionHooks.js'
import type { AppState } from '../state/AppState.js'
import { jsonStringify, jsonParse } from './slowOperations.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'

const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd hook 在关闭/清除期间运行，需要比 TOOL_HOOK_EXECUTION_TIMEOUT_MS
 * 更短的超时时间。此值同时作为单个 hook 的默认超时和整体 AbortSignal 上限
 * （hook 并行运行，因此一个值即可）。可通过环境变量覆盖，以满足需要更多
 * 时间的清理脚本。
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.ZY_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  pluginId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  pluginId?: string
}): boolean {
  if (asyncRewake) {
    // asyncRewake hook 完全绕过注册表。完成时，如果退出码为 2（阻塞错误），
    // 将以 task-notification 形式入队，通过 useQueueProcessor（空闲时）唤醒
    // 模型，或通过 queued_command 附件注入到正在进行的查询中（忙碌时）。
    //
    // 注意：我们故意不在此调用 shellCommand.background()，因为它会调用
    // taskOutput.spillToDisk()，从而破坏内存中的 stdout/stderr 捕获
    // （在磁盘模式下 getStderr() 返回 ''）。StreamWrapper 保持挂载并将
    // 数据通过管道传入内存中的 TaskOutput 缓冲区。abort handler 在
    // 'interrupt' 原因（用户提交了新消息）时已经是空操作，因此 hook 能
    // 在新提示下存活。强制取消（Escape）会通过 abort handler 终止 hook，
    // 这是预期行为。
    void shellCommand.result.then(async (result) => {
      // result 在 'exit' 时 resolve，但 stdio 的 'data' 事件可能仍在等待处理。
      // 让出 I/O 以便 StreamWrapper 的 data handler 将数据排入 TaskOutput 后再读取。
      await new Promise((resolve) => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  // ShellCommand 上的 TaskOutput 会累积数据——不需要流监听器
  if (!shellCommand.background(processId)) {
    return false
  }

  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    pluginId,
  })

  return true
}

/**
 * 检查是否因缺乏工作区信任而应跳过 hook。
 *
 * 所有 hook 都需要工作区信任，因为它们会执行来自 .zy/settings.json 的任意命令。
 * 这是一种纵深防御安全措施。
 *
 * 背景：Hook 通过 captureHooksConfigSnapshot() 在信任对话框显示之前被捕获。
 * 虽然大多数 hook 通过正常程序流在信任建立后才会执行，但对所有 hook 强制
 * 信任检查可以防止：
 * - 未来的 bug 导致 hook 在信任之前意外执行
 * - 任何可能在信任对话框之前触发 hook 的代码路径
 * - 在不受信任的工作区中执行 hook 的安全问题
 *
 * 促成此检查的历史漏洞：
 * - 用户拒绝信任对话框时 SessionEnd hook 仍会执行
 * - 子代理在信任之前完成时 SubagentStop hook 仍会执行
 *
 * @returns 如果应跳过 hook 返回 true，如果应执行返回 false
 */
export function shouldSkipHookDueToTrust(): boolean {
  // 在非交互模式（SDK）下，信任是隐式的——始终执行
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // 在交互模式下，所有 hook 都需要信任
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * 创建所有 hook 类型通用的基础 hook 输入
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // 窄类型声明（非 ToolUseContext），以便调用者可通过结构类型直接传入
  // toolUseContext，而无需本函数依赖 Tool.ts。
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  // agent_type: 子代理类型（来自 toolUseContext）优先于会话的 --agent 标志。
  // Hook 通过 agent_id 是否存在来区分子代理调用与 --agent 会话中的主线程调用。
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}

import type {
  AggregatedHookResult,
  ElicitationResponse,
  HookBlockingError,
  HookResult,
} from './hooks/types.js'
export type { AggregatedHookResult, ElicitationResponse, HookBlockingError, HookResult }

/**
 * 解析 JSON 字符串并根据 hook 输出的 Zod schema 进行校验。
 * 返回校验通过的输出或格式化的校验错误信息。
 */
function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    logForDebugging('Successfully parsed and validated hook JSON output')
    return { json: validation.data as any }
  }
  const errors = validation.error.issues
    .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    logForDebugging('Hook output does not start with {, treating as plain text')
    return { plainText: stdout }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    // 对于 command hook，在错误消息中包含 schema 提示
    const errorMessage = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        permissionDecision: '"allow" | "deny" | "ask" (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision: '"allow" | "deny" | "ask" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (required)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    logForDebugging(errorMessage)
    return { plainText: stdout, validationError: errorMessage }
  } catch (e) {
    logForDebugging(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      logForDebugging('HTTP hook returned empty body, treating as empty JSON object')
      return { json: validation.data as any }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}\u2026` : trimmed}`
    logForDebugging(validationError)
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    logForDebugging(result.validationError)
    return result
  } catch (e) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    logForDebugging(validationError)
    return { validationError }
  }
}

function processHookJSONOutput({
  json,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  // 此时我们确定这是一个同步响应
  const syncJson = json

  // 处理通用元素
  if (syncJson.continue === false) {
    result.preventContinuation = true
    if (syncJson.stopReason) {
      result.stopReason = syncJson.stopReason
    }
  }

  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        // 将未知的 decision 类型作为错误处理
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  // 处理 systemMessage 字段
  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  // 处理 PreToolUse 特定逻辑
  if (
    json.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
    json.hookSpecificOutput.permissionDecision
  ) {
    switch (json.hookSpecificOutput.permissionDecision) {
      case 'allow':
        result.permissionBehavior = 'allow'
        break
      case 'deny':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      case 'ask':
        result.permissionBehavior = 'ask'
        break
      default:
        // 将未知的 decision 类型作为错误处理
        throw new Error(
          `Unknown hook permissionDecision type: ${json.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask`,
        )
    }
  }
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  // 处理 hookSpecificOutput
  if (json.hookSpecificOutput) {
    // 校验 hook 事件名称是否与预期匹配（如果提供了预期值）
    if (expectedHookEvent && json.hookSpecificOutput.hookEventName !== expectedHookEvent) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        // 如果提供了更具体的权限决策则覆盖
        if (json.hookSpecificOutput.permissionDecision) {
          switch (json.hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  json.hookSpecificOutput.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
          }
        }
        result.hookPermissionDecisionReason = json.hookSpecificOutput.permissionDecisionReason
        // 如果提供了 updatedInput 则提取
        if (json.hookSpecificOutput.updatedInput) {
          result.updatedInput = json.hookSpecificOutput.updatedInput
        }
        // 如果提供了 additionalContext 则提取
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'UserPromptSubmit':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if ('watchPaths' in json.hookSpecificOutput && json.hookSpecificOutput.watchPaths) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'Setup':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SubagentStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolUse':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        // 如果提供了 updatedMCPToolOutput 则提取
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput = json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'PermissionRequest':
        // 提取权限请求决策
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          // 同时更新 permissionBehavior 以保持一致
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow' ? 'allow' : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as ElicitationResponse['content'] | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as ElicitationResponse['content'] | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  return {
    ...result,
    message: result.blockingError
      ? (createAttachmentMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        }) as any)
      : createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          // JSON 输出的 hook 通过 additionalContext → hook_additional_context
          // 注入上下文，而非此字段。空内容会抑制那个无意义的
          // "X hook success: Success" system-reminder，否则它会污染每个
          // 回合（messages.ts:3577 在 '' 时跳过）。
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

/**
 * 使用 bash 或 PowerShell 执行基于命令的 hook。
 *
 * Shell 解析顺序：hook.shell → 'bash'。PowerShell hook 使用 pwsh 启动，
 * 带 -NoProfile -NonInteractive -Command 参数，并跳过 bash 特有的准备工作
 * （POSIX 路径转换、.sh 自动前缀、ZY_CODE_SHELL_PREFIX）。
 * 参见 docs/design/ps-shell-selection.md §5.1。
 */
async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  pluginRoot?: string,
  pluginId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>,
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}> {
  // 仅在每会话一次的事件中触发，以控制 diag_log 日志量。
  // started/completed 在 try/finally 内部，因此 setup 路径抛出异常时
  // 不会留下孤立的 started 标记——那将无法与挂起区分。
  const shouldEmitDiag =
    hookEvent === 'SessionStart' || hookEvent === 'Setup' || hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  // --
  // 每个 hook 的 shell 选择（docs/design/ps-shell-selection.md 的阶段 1）。
  // 解析顺序：hook.shell → DEFAULT_HOOK_SHELL。defaultShell
  // 回退（settings.defaultShell）是阶段 2——尚未接入。
  //
  // bash 路径是历史默认值且保持不变。PowerShell 路径故意跳过
  // Windows 特有的 bash 适配（cygpath 转换、.sh 自动前缀、
  // POSIX 引号化的 SHELL_PREFIX）。
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  // --
  // Windows bash 路径：hook 通过 Git Bash（Cygwin）运行，而非 cmd.exe。
  //
  // 这意味着我们放入环境变量或替换到命令字符串中的每个路径
  // 都必须是 POSIX 路径（/c/Users/foo），而非 Windows 路径
  // （C:\Users\foo 或 C:/Users/foo）。Git Bash 无法解析 Windows 路径。
  //
  // windowsPathToPosixPath() 是纯 JS 正则转换（无需调用 cygpath）：
  // C:\Users\foo -> /c/Users/foo，UNC 保留，斜杠翻转。已做缓存
  // （LRU-500），重复调用开销很小。
  //
  // PowerShell 路径：使用原生路径——完全跳过转换。
  // PowerShell 在 Windows 上使用 Windows 路径（在 Unix 上
  // 也可用 pwsh 并使用原生路径）。
  const toHookPath =
    isWindows && !isPowerShell ? (p: string) => windowsPathToPosixPath(p) : (p: string) => p

  // 将 CLAUDE_PROJECT_DIR 设为稳定的项目根目录（非 worktree 路径）。
  // getProjectRoot() 在进入 worktree 时不会更新，因此引用
  // $CLAUDE_PROJECT_DIR 的 hook 始终相对于真实的仓库根目录解析。
  const projectDir = getProjectRoot()

  // 替换命令字符串中的 ${CLAUDE_PLUGIN_ROOT} 和 ${user_config.X}。
  // 顺序与 MCP/LSP 一致（先插件变量，后用户配置），因此用户
  // 输入的值如果包含字面文本 ${CLAUDE_PLUGIN_ROOT}，将被视为
  // 不透明值——不会作为模板重新解析。
  let command = hook.command
  let pluginOpts: ReturnType<typeof loadPluginOptions> | undefined
  if (pluginRoot) {
    // 插件目录不存在（孤立 GC 竞态、并发会话删除了它）：
    // 抛出异常让调用者产生非阻塞错误。直接运行会失败——且
    // `python3 <missing>.py` 退出码为 2（hook 协议的 "block" 码），
    // 会卡住 UserPromptSubmit/Stop 直到重启。预检查是必要的，
    // 因为脚本缺失导致的 exit-2 与 spawn 后的故意阻塞无法区分。
    if (!(await pathExists(pluginRoot))) {
      throw new Error(
        `Plugin directory does not exist: ${pluginRoot}` +
          (pluginId ? ` (${pluginId} — run /plugin to reinstall)` : ''),
      )
    }
    // 内联 ROOT 和 DATA 替换，而非调用 substitutePluginVariables()。
    // 该辅助函数无条件地在 Windows 上将 \ 规范化为 /——对 bash
    // 来说是正确的（toHookPath 已生成 /c/... 所以是空操作），但对
    // PS 来说是错误的，因为 toHookPath 是恒等映射，我们需要原生的
    // C:\... 反斜杠。内联还允许使用函数形式的 .replace()，避免
    // 路径中的 $ 被 $-模式解释所破坏（虽少见但可能：\\server\c$\plugin）。
    const rootPath = toHookPath(pluginRoot)
    command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
    if (pluginId) {
      const dataPath = toHookPath(getPluginDataDir(pluginId))
      command = command.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => dataPath)
    }
    if (pluginId) {
      pluginOpts = loadPluginOptions(pluginId)
      // 如果引用的 key 缺失则抛出——意味着 hook 使用了一个
      // 未在 manifest.userConfig 中声明或尚未配置的 key。
      // 在上游作为普通 hook 执行失败捕获。
      command = substituteUserConfigVariables(command, pluginOpts)
    }
  }

  // 在 Windows（仅 bash）上，为 .sh 脚本自动前缀 `bash`，使其
  // 执行而非用默认文件处理器打开。PowerShell 原生运行 .ps1
  // 文件——无需前缀。
  if (isWindows && !isPowerShell && command.trim().match(/\.sh(\s|$|")/)) {
    if (!command.trim().startsWith('bash ')) {
      command = `bash ${command}`
    }
  }

  // ZY_CODE_SHELL_PREFIX 通过 POSIX 引号包裹命令
  // （formatShellPrefixCommand 使用 shell-quote）。这对 PowerShell
  // 没有意义——参见设计文档 §8.1。目前 PS hook 忽略此前缀；
  // ZY_CODE_PS_SHELL_PREFIX（或 shell 感知前缀）是后续工作。
  const finalCommand =
    !isPowerShell && process.env.ZY_CODE_SHELL_PREFIX
      ? formatShellPrefixCommand(process.env.ZY_CODE_SHELL_PREFIX, command)
      : command

  const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : TOOL_HOOK_EXECUTION_TIMEOUT_MS

  // 构建环境变量——所有路径通过 toHookPath 进行 Windows POSIX 转换
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    CLAUDE_PROJECT_DIR: toHookPath(projectDir),
  }

  // 插件和技能 hook 都设置 CLAUDE_PLUGIN_ROOT（技能使用相同
  // 的名称以保持一致——技能可以无需改代码即可迁移到插件）
  if (pluginRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(pluginRoot)
    if (pluginId) {
      envVars.CLAUDE_PLUGIN_DATA = toHookPath(getPluginDataDir(pluginId))
    }
  }
  // 同时将插件选项暴露为环境变量，这样 hook 无需在命令字符串中
  // 使用 ${user_config.X} 即可读取。包含敏感值——hook 运行用户
  // 自己的代码，与直接读取密钥链处于相同的信任边界。
  if (pluginOpts) {
    for (const [key, value] of Object.entries(pluginOpts)) {
      // 清理非标识符字符（bash 无法引用 $FOO-BAR）。schemas.ts:611
      // 的 schema 已将 key 限制为 /^[A-Za-z_]\w*$/，这里是
      // 双重保险，以防有人绕过 schema。
      const envKey = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
      envVars[`CLAUDE_PLUGIN_OPTION_${envKey}`] = String(value)
    }
  }
  if (skillRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(skillRoot)
  }

  // CLAUDE_ENV_FILE 指向一个 .sh 文件，hook 将环境变量定义写入其中；
  // getSessionEnvironmentScript() 会拼接它们，bashProvider 将内容
  // 注入到 bash 命令中。PS hook 自然会写 PS 语法（$env:FOO = 'bar'），
  // bash 无法解析。对 PS 跳过——与上面 .sh 前缀和 SHELL_PREFIX
  // 已经是 bash 专有一致。
  if (
    !isPowerShell &&
    (hookEvent === 'SessionStart' ||
      hookEvent === 'Setup' ||
      hookEvent === 'CwdChanged' ||
      hookEvent === 'FileChanged') &&
    hookIndex !== undefined
  ) {
    envVars.CLAUDE_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
  }

  // 当代理 worktree 被移除时，getCwd() 可能通过 AsyncLocalStorage
  // 返回已删除的路径。在 spawn 前验证，因为 spawn() 对缺失的 cwd
  // 会发出异步 'error' 事件而非同步抛出。
  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(`Hooks: cwd ${hookCwd} not found, falling back to original cwd`, {
      level: 'warn',
    })
  }

  // --
  // 启动子进程。两条完全独立的路径：
  //
  //   Bash: spawn(cmd, [], { shell: <gitBashPath | true> })——shell
  //   选项让 Node 将整个字符串传递给 shell 解析。
  //
  //   PowerShell: spawn(pwshPath, ['-NoProfile', '-NonInteractive',
  //   '-Command', cmd])——显式 argv，无 shell 选项。-NoProfile
  //   跳过用户配置脚本（更快、确定性）。
  //   -NonInteractive 在需要提示时直接失败。
  //
  // findGitBashPath() 中的 Git Bash 强制退出对 bash hook 仍然
  // 有效。PowerShell hook 不会调用它，因此理论上一个 Windows 用户
  // 如果只有 pwsh 且所有 hook 都设为 shell: 'powershell'，可以在
  // 没有 Git Bash 的情况下运行——但 init.ts 启动时仍会调用
  // setShellIfWindows() 并先退出。放宽该限制是设计实现顺序的
  // 阶段 1（单独的 PR）。
  let child: ChildProcessWithoutNullStreams
  if (shellType === 'powershell') {
    const pwshPath = await getCachedPowerShellPath()
    if (!pwshPath) {
      throw new Error(
        `Hook "${hook.command}" has shell: 'powershell' but no PowerShell ` +
          `executable (pwsh or powershell) was found on PATH. Install ` +
          `PowerShell, or remove "shell": "powershell" to use bash.`,
      )
    }
    child = spawn(pwshPath, buildPowerShellArgs(finalCommand), {
      env: envVars,
      cwd: safeCwd,
      // 在 Windows 上防止显示控制台窗口（在其他平台上无效）
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  } else {
    // 在 Windows 上显式使用 Git Bash（cmd.exe 无法运行 bash 语法）。
    // 在其他平台上，shell: true 使用 /bin/sh。
    const shell = isWindows ? findGitBashPath() : true
    child = spawn(finalCommand, [], {
      env: envVars,
      cwd: safeCwd,
      shell,
      // 在 Windows 上防止显示控制台窗口（在其他平台上无效）
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  }

  // Hook 使用管道模式——stdout 必须流式传入 JS，以便解析
  // 第一行响应来检测异步 hook（{"async": true}）。
  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  // 跟踪 shellCommand 所有权是否已转移（如转移到异步 hook 注册表）
  let shellCommandTransferred = false
  // 跟踪 stdin 是否已写入（以避免 "write after end" 错误）
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(`Hooks: Config-based async hook, backgrounding process ${processId}`)

    // 在后台化之前写入 stdin，以便 hook 接收到输入。
    // 尾部换行符与同步路径（L1000）一致。如果没有它，
    // bash `read -r line` 返回退出码 1（定界符前遇到 EOF）——
    // 变量确实被填充了，但 `if read -r line; then ...` 会跳过
    // 该分支。参见 gh-30509 / CC-161。
    child.stdin.write(`${jsonInput}\n`, 'utf8')
    child.stdin.end()
    stdinWritten = true

    const backgrounded = executeInBackground({
      processId,
      hookId,
      shellCommand,
      asyncResponse: { async: true, asyncTimeout: hookTimeoutMs },
      hookEvent,
      hookName,
      command: hook.command,
      asyncRewake: hook.asyncRewake,
      pluginId,
    })
    if (backgrounded) {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: 0,
        backgrounded: true,
      }
    }
  }

  let stdout = ''
  let stderr = ''
  let output = ''

  // 设置输出数据收集，使用显式 UTF-8 编码
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let initialResponseChecked = false

  let asyncResolve:
    | ((result: { stdout: string; stderr: string; output: string; status: number }) => void)
    | null = null
  const childIsAsyncPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>((resolve) => {
    asyncResolve = resolve
  })

  // 跟踪已处理的 prompt 请求行（按内容匹配去除），
  // 无需索引跟踪从而避免索引偏移
  const processedPromptLines = new Set<string>()
  // 序列化异步 prompt 处理，确保响应按顺序发送
  let promptChain = Promise.resolve()
  // 行缓冲区，用于在流式输出中检测 prompt 请求
  let lineBuffer = ''

  child.stdout.on('data', (data) => {
    stdout += data
    output += data

    // 当提供了 requestPrompt 时，逐行解析 stdout 以检测 prompt 请求
    if (requestPrompt) {
      lineBuffer += data
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? '' // last element is an incomplete line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }

        try {
          const parsed = jsonParse(trimmed)
          const validation = promptRequestSchema().safeParse(parsed)
          if (validation.success) {
            processedPromptLines.add(trimmed)
            logForDebugging(`Hooks: Detected prompt request from hook: ${trimmed}`)
            // 链式处理以序列化 prompt 响应
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(`${jsonStringify(response)}\n`, 'utf8')
              } catch (err) {
                logForDebugging(`Hooks: Prompt request handling failed: ${err}`)
                // 用户取消或 prompt 失败——关闭 stdin 以防 hook
                // 进程挂起等待输入
                child.stdin.destroy()
              }
            })
          }
        } catch {
          // 非 JSON，只是普通行
        }
      }
    }

    // Check for async response on first line of output. The async protocol is:
    // hook emits {"async":true,...} as its FIRST line, then its normal output.
    // We must parse ONLY the first line — if the process is fast and writes more
    // before this 'data' event fires, parsing the full accumulated stdout fails
    // and an async hook blocks for its full duration instead of backgrounding.
    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      if (!firstLine.includes('}')) {
        return
      }
      initialResponseChecked = true
      logForDebugging(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        logForDebugging(`Hooks: Parsed initial response: ${jsonStringify(parsed)}`)
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          logForDebugging(`Hooks: Detected async hook, backgrounding process ${processId}`)

          const backgrounded = executeInBackground({
            processId,
            hookId,
            shellCommand,
            asyncResponse: parsed,
            hookEvent,
            hookName,
            command: hook.command,
            pluginId,
          })
          if (backgrounded) {
            shellCommandTransferred = true
            asyncResolve?.({
              stdout,
              stderr,
              output,
              status: 0,
            })
          }
        } else if (isAsyncHookJSONOutput(parsed) && forceSyncExecution) {
          logForDebugging(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          logForDebugging(`Hooks: Initial response is not async, continuing normal processing`)
        }
      } catch (e) {
        logForDebugging(`Hooks: Failed to parse initial response as JSON: ${e}`)
      }
    }
  })

  child.stderr.on('data', (data) => {
    stderr += data
    output += data
  })

  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => ({ stdout, stderr, output }),
  })

  // Wait for stdout and stderr streams to finish before considering output complete
  // This prevents a race condition where 'close' fires before all 'data' events are processed
  const stdoutEndPromise = new Promise<void>((resolve) => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>((resolve) => {
    child.stderr.on('end', () => resolve())
  })

  // Write to stdin, making sure to handle EPIPE errors that can happen when
  // the hook command exits before reading all input.
  // Note: EPIPE handling is difficult to set up in testing since Bun and Node
  // have different behaviors.
  // TODO: Add tests for EPIPE handling.
  // Skip if stdin was already written (e.g., by config-based async hook path)
  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', (err) => {
          // When requestPrompt is provided, stdin stays open for prompt responses.
          // EPIPE errors from later writes (after process exits) are expected -- suppress them.
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(`Hooks: stdin error during prompt flow (likely process exited): ${err}`)
          }
        })
        // Explicitly specify UTF-8 encoding to ensure proper handling of Unicode characters
        child.stdin.write(`${jsonInput}\n`, 'utf8')
        // When requestPrompt is provided, keep stdin open for prompt responses
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  // 为子进程错误创建 Promise
  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  // Create promise for child process close - but only resolve after streams end
  // to ensure all output has been collected
  const childClosePromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>((resolve) => {
    let exitCode: number | null = null

    child.on('close', (code) => {
      exitCode = code ?? 1

      // Wait for both streams to end before resolving with the final output
      void Promise.all([stdoutEndPromise, stderrEndPromise]).then(() => {
        // Strip lines we processed as prompt requests so parseHookOutput
        // only sees the final hook result. Content-matching against the set
        // of actually-processed lines means prompt JSON can never leak
        // through (fail-closed), regardless of line positioning.
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter((line) => !processedPromptLines.has(line.trim()))
                .join('\n')

        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: exitCode!,
          aborted: signal.aborted,
        })
      })
    })
  })

  // stdin 写入、异步检测和进程完成之间的竞争
  try {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_started', {
        hook_event_name: hookEvent,
        index: hookIndex,
      })
    }
    await Promise.race([stdinWritePromise, childErrorPromise])

    // 等待所有待处理的 prompt 响应后再 resolve
    const result = await Promise.race([childIsAsyncPromise, childClosePromise, childErrorPromise])
    // 确保所有排队的 prompt 响应已发送
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    // 处理来自 stdin 写入或子进程的错误
    const code = getErrnoCode(error)
    diagExitCode = 1

    if (code === 'EPIPE') {
      logForDebugging('EPIPE error while writing to hook stdin (hook command likely closed early)')
      const errMsg = 'Hook command closed stdin before hook input was fully written (EPIPE)'
      return {
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        status: 1,
      }
    } else if (code === 'ABORT_ERR') {
      diagAborted = true
      return {
        stdout: '',
        stderr: 'Hook cancelled',
        output: 'Hook cancelled',
        status: 1,
        aborted: true,
      }
    } else {
      const errorMsg = errorMessage(error)
      const errOutput = `Error occurred while executing hook command: ${errorMsg}`
      return {
        stdout: '',
        stderr: errOutput,
        output: errOutput,
        status: 1,
      }
    }
  } finally {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_completed', {
        hook_event_name: hookEvent,
        index: hookIndex,
        duration_ms: Date.now() - diagStartMs,
        exit_code: diagExitCode,
        aborted: diagAborted,
      })
    }
    stopProgressInterval()
    // 清理流资源，除非所有权已转移（如转移到异步 hook 注册表）
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
  }
}

/**
 * 检查匹配查询是否匹配 hook 的匹配器模式
 * @param matchQuery 要匹配的查询（如 'Write'、'Edit'、'Bash'）
 * @param matcher 匹配器模式，可以是：
 *   - 简单字符串用于精确匹配（如 'Write'）
 *   - 管道分隔的列表用于多个精确匹配（如 'Write|Edit'）
 *   - 正则表达式模式（如 '^Write.*'、'.*'、'^(Write|Edit)$'）
 * @returns 如果查询匹配模式则返回 true
 */
function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') {
    return true
  }
  // 检查是否为简单字符串或管道分隔列表（除 | 外无正则特殊字符）
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    // 处理管道分隔的精确匹配
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map((p) => normalizeLegacyToolName(p.trim()))
      return patterns.includes(matchQuery)
    }
    // 简单精确匹配
    return matchQuery === normalizeLegacyToolName(matcher)
  }

  // 否则视为正则表达式
  try {
    const regex = new RegExp(matcher)
    if (regex.test(matchQuery)) {
      return true
    }
    // 也对旧版名称进行测试，使 "^Task$" 等模式仍然匹配
    for (const legacyName of getLegacyToolNames(matchQuery)) {
      if (regex.test(legacyName)) {
        return true
      }
    }
    return false
  } catch {
    // 如果正则表达式无效，记录错误并返回 false
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

type IfConditionMatcher = (ifCondition: string) => boolean

/**
 * 为 hook 的 `if` 条件准备匹配器。昂贵的操作（工具查找、
 * Zod 校验、Bash 的 tree-sitter 解析）在此处执行一次；
 * 返回的闭包会对每个 hook 调用。对非工具事件返回 undefined。
 */
async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (
    hookInput.hook_event_name !== 'PreToolUse' &&
    hookInput.hook_event_name !== 'PostToolUse' &&
    hookInput.hook_event_name !== 'PostToolUseFailure' &&
    hookInput.hook_event_name !== 'PermissionRequest'
  ) {
    return undefined
  }

  const toolName = normalizeLegacyToolName(hookInput.tool_name)
  const tool = tools && findToolByName(tools, hookInput.tool_name)
  const input = tool?.inputSchema.safeParse(hookInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return (ifCondition) => {
    const parsed = permissionRuleValueFromString(ifCondition)
    if (normalizeLegacyToolName(parsed.toolName) !== toolName) {
      return false
    }
    if (!parsed.ruleContent) {
      return true
    }
    return patternMatcher ? patternMatcher(parsed.ruleContent) : false
  }
}

type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 与可选插件上下文配对的 hook。
 * 返回匹配的 hook 时使用，以便在执行时应用插件环境变量。
 */
type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  hookSource?: string
}

function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

/**
 * 为匹配的 hook 构建去重 key，按来源上下文命名空间化。
 *
 * 设置文件 hook（无 pluginRoot/skillRoot）共享 '' 前缀，因此
 * 在 user/project/local 中定义的相同命令仍会合并为一个——这是
 * 去重的原始意图。插件/技能 hook 以其根目录作为前缀，因此
 * 两个插件共享未展开的 `${CLAUDE_PLUGIN_ROOT}/hook.sh` 模板
 * 不会合并：展开后它们指向不同的文件。
 */
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

/**
 * 从匹配的 hook 构建 {sanitizedPluginName: hookCount} 映射。
 * 仅记录官方市场插件的实际名称；其他归为 'third-party'。
 */
function getPluginHookCounts(hooks: MatchedHook[]): Record<string, number> | undefined {
  const pluginHooks = hooks.filter((h) => h.pluginId)
  if (pluginHooks.length === 0) {
    return undefined
  }
  const counts: Record<string, number> = {}
  for (const h of pluginHooks) {
    const atIndex = h.pluginId!.lastIndexOf('@')
    const isOfficial =
      atIndex > 0 && ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(h.pluginId!.slice(atIndex + 1))
    const key = isOfficial ? h.pluginId! : 'third-party'
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

/**
 * 从匹配的 hook 构建 {hookType: count} 映射。
 */
function getHookTypeCounts(hooks: MatchedHook[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const h of hooks) {
    counts[h.hook.type] = (counts[h.hook.type] || 0) + 1
  }
  return counts
}

function getHooksConfig(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
): Array<
  | HookMatcher
  | HookCallbackMatcher
  | FunctionHookMatcher
  | PluginHookMatcher
  | SkillHookMatcher
  | SessionDerivedHookMatcher
> {
  // HookMatcher 是经过 zod 剥离的 {matcher, hooks}，因此快照匹配器
  // 可以直接 push 而无需重新包装。
  const hooks: Array<
    | HookMatcher
    | HookCallbackMatcher
    | FunctionHookMatcher
    | PluginHookMatcher
    | SkillHookMatcher
    | SessionDerivedHookMatcher
  > = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  // 检查是否只应运行托管 hook（用于注册 hook 和会话 hook）
  const managedOnly = shouldAllowManagedHooksOnly()

  // 处理已注册的 hook（SDK callback 和插件原生 hook）
  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      // 当限制为仅托管 hook 时跳过插件 hook
      // 插件 hook 设置了 pluginRoot，SDK callback 则没有
      if (managedOnly && 'pluginRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  // Merge session hooks for the current session only
  // Function hooks (like structured output enforcement) must be scoped to their session
  // to prevent hooks from one agent leaking to another (e.g., verification agent to main agent)
  // Skip session hooks entirely when allowManagedHooksOnly is set —
  // this prevents frontmatter hooks from agents/skills from bypassing the policy.
  // strictPluginOnlyCustomization does NOT block here — it gates at the
  // REGISTRATION sites (runAgent.ts:526 for agent frontmatter hooks) where
  // agentDefinition.source is known. A blanket block here would also kill
  // plugin-provided agents' frontmatter hooks, which is too broad.
  // Also skip if appState not provided (for backwards compatibility)
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(hookEvent)
    if (sessionHooks) {
      // SessionDerivedHookMatcher 已包含可选的 skillRoot
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    // 单独合并会话函数 hook（无法持久化为 HookMatcher 格式）
    const sessionFunctionHooks = getSessionFunctionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionFunctionHooks) {
      for (const matcher of sessionFunctionHooks) {
        hooks.push(matcher)
      }
    }
  }

  return hooks
}

/**
 * Lightweight existence check for hooks on a given event. Mirrors the sources
 * assembled by getHooksConfig() but stops at the first hit without building
 * the full merged config.
 *
 * Intentionally over-approximates: returns true if any matcher exists for the
 * event, even if managed-only filtering or pattern matching would later
 * discard it. A false positive just means we proceed to the full matching
 * path; a false negative would skip a hook, so we err on the side of true.
 *
 * Used to skip createBaseHookInput (getTranscriptPathForSession path joins)
 * and getMatchingHooks on hot paths where hooks are typically unconfigured.
 * See hasInstructionsLoadedHook / hasWorktreeCreateHook for the same pattern.
 */
function hasHookForEvent(
  hookEvent: HookEvent,
  appState: AppState | undefined,
  sessionId: string,
): boolean {
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) {
    return true
  }
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) {
    return true
  }
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) {
    return true
  }
  return false
}

/**
 * Get hook commands that match the given query
 * @param appState The current app state (optional for backwards compatibility)
 * @param sessionId The current session ID (main session or agent ID)
 * @param hookEvent The hook event
 * @param hookInput The hook input for matching
 * @returns Array of matched hooks with optional plugin context
 */
export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): Promise<MatchedHook[]> {
  try {
    const hookMatchers = getHooksConfig(appState, sessionId, hookEvent)

    // 如果更改以下条件，必须同时更改
    // src/utils/hooks/hooksConfigManager.ts。
    let matchQuery: string | undefined
    switch (hookInput.hook_event_name) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionRequest':
      case 'PermissionDenied':
        matchQuery = hookInput.tool_name
        break
      case 'SessionStart':
        matchQuery = hookInput.source
        break
      case 'Setup':
        matchQuery = hookInput.trigger
        break
      case 'PreCompact':
      case 'PostCompact':
        matchQuery = hookInput.trigger
        break
      case 'Notification':
        matchQuery = hookInput.notification_type
        break
      case 'SessionEnd':
        matchQuery = hookInput.reason
        break
      case 'StopFailure':
        matchQuery = hookInput.error
        break
      case 'SubagentStart':
        matchQuery = hookInput.agent_type
        break
      case 'SubagentStop':
        matchQuery = hookInput.agent_type
        break
      case 'TeammateIdle':
      case 'TaskCreated':
      case 'TaskCompleted':
        break
      case 'Elicitation':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ElicitationResult':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ConfigChange':
        matchQuery = hookInput.source
        break
      case 'InstructionsLoaded':
        matchQuery = hookInput.load_reason
        break
      case 'FileChanged':
        matchQuery = basename(hookInput.file_path)
        break
      default:
        break
    }

    logForDebugging(`Getting matching hook commands for ${hookEvent} with query: ${matchQuery}`, {
      level: 'verbose',
    })
    logForDebugging(`Found ${hookMatchers.length} hook matchers in settings`, {
      level: 'verbose',
    })

    // 提取 hook 及其插件上下文（如有）
    const filteredMatchers = matchQuery
      ? hookMatchers.filter(
          (matcher) => !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
        )
      : hookMatchers

    const matchedHooks: MatchedHook[] = filteredMatchers.flatMap((matcher) => {
      // 检查是否为 PluginHookMatcher（有 pluginRoot）或 SkillHookMatcher（有 skillRoot）
      const pluginRoot = 'pluginRoot' in matcher ? matcher.pluginRoot : undefined
      const pluginId = 'pluginId' in matcher ? matcher.pluginId : undefined
      const skillRoot = 'skillRoot' in matcher ? matcher.skillRoot : undefined
      const hookSource = pluginRoot
        ? 'pluginName' in matcher
          ? `plugin:${matcher.pluginName}`
          : 'plugin'
        : skillRoot
          ? 'skillName' in matcher
            ? `skill:${matcher.skillName}`
            : 'skill'
          : 'settings'
      return matcher.hooks.map((hook) => ({
        hook,
        pluginRoot,
        pluginId,
        skillRoot,
        hookSource,
      }))
    })

    // Deduplicate hooks by command/prompt/url within the same source context.
    // Key is namespaced by pluginRoot/skillRoot (see hookDedupKey above) so
    // cross-plugin template collisions don't drop hooks (gh-29724).
    //
    // Note: new Map(entries) keeps the LAST entry on key collision, not first.
    // For settings hooks this means the last-merged scope wins; for
    // same-plugin duplicates the pluginRoot is identical so it doesn't matter.
    // Fast-path: callback/function hooks don't need dedup (each is unique).
    // Skip the 6-pass filter + 4×Map + 4×Array.from below when all hooks are
    // callback/function — the common case for internal hooks like
    // sessionFileAccessHooks/attributionHooks (44x faster in microbench).
    if (matchedHooks.every((m) => m.hook.type === 'callback' || m.hook.type === 'function')) {
      return matchedHooks
    }

    // Helper to extract the `if` condition from a hook for dedup keys.
    // Hooks with different `if` conditions are distinct even if otherwise identical.
    const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

    const uniqueCommandHooks = Array.from(
      new Map(
        matchedHooks
          .filter(
            (m): m is MatchedHook & { hook: HookCommand & { type: 'command' } } =>
              m.hook.type === 'command',
          )
          // shell is part of identity: {command:'echo x', shell:'bash'}
          // and {command:'echo x', shell:'powershell'} are distinct hooks,
          // not duplicates. Default to 'bash' so legacy configs (no shell
          // field) still dedup against explicit shell:'bash'.
          .map((m) => [
            hookDedupKey(
              m,
              `${m.hook.shell ?? DEFAULT_HOOK_SHELL}\0${m.hook.command}\0${getIfCondition(m.hook)}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniquePromptHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'prompt')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueAgentHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'agent')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueHttpHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'http')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { url: string }).url}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const callbackHooks = matchedHooks.filter((m) => m.hook.type === 'callback')
    // 函数 hook 不需要去重——每个 callback 都是唯一的
    const functionHooks = matchedHooks.filter((m) => m.hook.type === 'function')
    const uniqueHooks = [
      ...uniqueCommandHooks,
      ...uniquePromptHooks,
      ...uniqueAgentHooks,
      ...uniqueHttpHooks,
      ...callbackHooks,
      ...functionHooks,
    ]

    // Filter hooks based on their `if` condition. This allows hooks to specify
    // conditions like "Bash(git *)" to only run for git commands, avoiding
    // process spawning overhead for non-matching commands.
    const hasIfCondition = uniqueHooks.some(
      (h) =>
        (h.hook.type === 'command' ||
          h.hook.type === 'prompt' ||
          h.hook.type === 'agent' ||
          h.hook.type === 'http') &&
        (h.hook as { if?: string }).if,
    )
    const ifMatcher = hasIfCondition ? await prepareIfConditionMatcher(hookInput, tools) : undefined
    const ifFilteredHooks = uniqueHooks.filter((h) => {
      if (
        h.hook.type !== 'command' &&
        h.hook.type !== 'prompt' &&
        h.hook.type !== 'agent' &&
        h.hook.type !== 'http'
      ) {
        return true
      }
      const ifCondition = (h.hook as { if?: string }).if
      if (!ifCondition) {
        return true
      }
      if (!ifMatcher) {
        logForDebugging(
          `Hook if condition "${ifCondition}" cannot be evaluated for non-tool event ${hookInput.hook_event_name}`,
        )
        return false
      }
      if (ifMatcher(ifCondition)) {
        return true
      }
      logForDebugging(`Skipping hook due to if condition "${ifCondition}" not matching`)
      return false
    })

    // HTTP hooks are not supported for SessionStart/Setup events. In headless
    // mode the sandbox ask callback deadlocks because the structuredInput
    // consumer hasn't started yet when these hooks fire.
    const filteredHooks =
      hookEvent === 'SessionStart' || hookEvent === 'Setup'
        ? ifFilteredHooks.filter((h) => {
            if (h.hook.type === 'http') {
              logForDebugging(
                `Skipping HTTP hook ${(h.hook as { url: string }).url} — HTTP hooks are not supported for ${hookEvent}`,
              )
              return false
            }
            return true
          })
        : ifFilteredHooks

    logForDebugging(
      `Matched ${filteredHooks.length} unique hooks for query "${matchQuery || 'no match query'}" (${matchedHooks.length} before deduplication)`,
      { level: 'verbose' },
    )
    return filteredHooks
  } catch {
    return []
  }
}

/**
 * Format a list of blocking errors from a PreTool hook's configured commands.
 * @param hookName The name of the hook (e.g., 'PreToolUse:Write', 'PreToolUse:Edit', 'PreToolUse:Bash')
 * @param blockingErrors Array of blocking errors from hooks
 * @returns Formatted blocking message
 */
export function getPreToolHookBlockingMessage(
  hookName: string,
  blockingError: HookBlockingError,
): string {
  return `${hookName} hook error: ${blockingError.blockingError}`
}

/**
 * Format a list of blocking errors from a Stop hook's configured commands.
 * @param blockingErrors Array of blocking errors from hooks
 * @returns Formatted message to give feedback to the model
 */
export function getStopHookMessage(blockingError: HookBlockingError): string {
  return `Stop hook feedback:\n${blockingError.blockingError}`
}

/**
 * Format a blocking error from a TeammateIdle hook.
 * @param blockingError The blocking error from the hook
 * @returns Formatted message to give feedback to the model
 */
export function getTeammateIdleHookMessage(blockingError: HookBlockingError): string {
  return `TeammateIdle hook feedback:\n${blockingError.blockingError}`
}

/**
 * Format a blocking error from a TaskCreated hook.
 * @param blockingError The blocking error from the hook
 * @returns Formatted message to give feedback to the model
 */
export function getTaskCreatedHookMessage(blockingError: HookBlockingError): string {
  return `TaskCreated hook feedback:\n${blockingError.blockingError}`
}

/**
 * Format a blocking error from a TaskCompleted hook.
 * @param blockingError The blocking error from the hook
 * @returns Formatted message to give feedback to the model
 */
export function getTaskCompletedHookMessage(blockingError: HookBlockingError): string {
  return `TaskCompleted hook feedback:\n${blockingError.blockingError}`
}

/**
 * Format a list of blocking errors from a UserPromptSubmit hook's configured commands.
 * @param blockingErrors Array of blocking errors from hooks
 * @returns Formatted blocking message
 */
export function getUserPromptSubmitHookBlockingMessage(blockingError: HookBlockingError): string {
  return `UserPromptSubmit operation blocked by hook:\n${blockingError.blockingError}`
}
/**
 * Common logic for executing hooks
 * @param hookInput The structured hook input that will be validated and converted to JSON
 * @param toolUseID The ID for tracking this hook execution
 * @param matchQuery The query to match against hook matchers
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @param toolUseContext Optional ToolUseContext for prompt-based hooks (required if using prompt hooks)
 * @param messages Optional conversation history for prompt/function hooks
 * @returns Async generator that yields progress messages and hook results
 */
async function* executeHooks({
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
    logForDebugging(`Skipping ${hookName} hook execution - workspace trust not accepted`)
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
      message: {
        type: 'progress' as any,
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
      } as any,
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
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: 'Messages not provided for function hook',
          }) as any,
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
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: `Failed to prepare hook input: ${errorMessage((jsonInputRes as any).error)}`,
            command: hookCommand,
            durationMs: Date.now() - hookStartMs,
          }) as any,
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
        if ((promptResult.message as any)?.type === 'attachment') {
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
        if ((agentResult.message as any)?.type === 'attachment') {
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
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent,
            }) as any,
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
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr,
              stdout: '',
              exitCode: httpResult.statusCode ?? 0,
            }) as any,
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
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: `JSON validation failed: ${httpValidationError}`,
              stdout: httpResult.body,
              exitCode: httpResult.statusCode ?? 0,
            }) as any,
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
            json: httpJson as any,
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
          message: createAttachmentMessage({
            type: 'hook_cancelled',
            hookName,
            toolUseID,
            hookEvent,
            command: hookCommand,
            durationMs,
          }) as any,
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
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID,
            hookEvent,
            stderr: `JSON validation failed: ${validationError}`,
            stdout: result.stdout,
            exitCode: 1,
            command: hookCommand,
            durationMs,
          }) as any,
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
            message: (processed.message ||
              createAttachmentMessage({
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
              })) as any,
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
          message: createAttachmentMessage({
            type: 'hook_success',
            hookName,
            toolUseID,
            hookEvent,
            content: result.stdout.trim(),
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            command: hookCommand,
            durationMs,
          }) as any,
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
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`,
          stdout: result.stdout,
          exitCode: result.status,
          command: hookCommand,
          durationMs,
        }) as any,
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
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed to run: ${errorMessage}`,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }) as any,
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
      logForDebugging(
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
        message: createAttachmentMessage({
          type: 'hook_system_message',
          content: result.systemMessage,
          hookName,
          toolUseID,
          hookEvent,
        }) as any,
      }
    }

    // 从 hook 收集附加上下文
    if (result.additionalContext) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
      )
      yield {
        additionalContexts: [result.additionalContext],
      }
    }

    if (result.initialUserMessage) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided initialUserMessage (${result.initialUserMessage.length} chars)`,
      )
      yield {
        initialUserMessage: result.initialUserMessage,
      }
    }

    if (result.watchPaths && result.watchPaths.length > 0) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided ${result.watchPaths.length} watchPaths`,
      )
      yield {
        watchPaths: result.watchPaths,
      }
    }

    // 如果提供了 updatedMCPToolOutput 则产出（来自 PostToolUse hook）
    if (result.updatedMCPToolOutput) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced MCP tool output`,
      )
      yield {
        updatedMCPToolOutput: result.updatedMCPToolOutput,
      }
    }

    // 按优先级检查权限行为：deny > ask > allow
    if (result.permissionBehavior) {
      logForDebugging(
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
        logForDebugging(
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
      logForDebugging(
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
async function executeHooksOutsideREPL({
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
    logForDebugging(`Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`)
    return []
  }

  // SECURITY: ALL hooks require workspace trust in interactive mode
  // This centralized check prevents RCE vulnerabilities for all current and future hooks
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(`Skipping ${hookName} hook execution - workspace trust not accepted`)
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
          logForDebugging(`${hookName} [callback] returned async response, returning empty output`)
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

        logForDebugging(`${hookName} [callback] completed successfully`)

        return {
          command: 'callback',
          succeeded: true,
          output,
          blocked,
        }
      } catch (error) {
        cleanup?.()

        const errorMessage = error instanceof Error ? error.message : String(error)
        logForDebugging(`${hookName} [callback] failed to run: ${errorMessage}`, { level: 'error' })
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
          logForDebugging(`${hookName} [${hook.url}] cancelled`)
          return {
            command: hook.url,
            succeeded: false,
            output: 'Hook cancelled',
            blocked: false,
          }
        }

        if (httpResult.error || !httpResult.ok) {
          const errMsg = httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          logForDebugging(`${hookName} [${hook.url}] failed: ${errMsg}`, {
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
          logForDebugging(`Parsed JSON output from HTTP hook: ${jsonStringify(httpJson)}`, {
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
        logForDebugging(`${hookName} [${hook.url}] failed to run: ${errorMessage}`, {
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
        logForDebugging(`${hookName} [${hook.command}] cancelled`)
        return {
          command: hook.command,
          succeeded: false,
          output: 'Hook cancelled',
          blocked: false,
        }
      }

      logForDebugging(`${hookName} [${hook.command}] completed with status ${result.status}`)

      // 解析 JSON 以获取要输出的消息。
      const { json, validationError } = parseHookOutput(result.stdout)
      if (validationError) {
        // 校验错误通过 logForDebugging 记录并在 output 中返回
        throw new Error(validationError)
      }
      if (json && !isAsyncHookJSONOutput(json)) {
        logForDebugging(`Parsed JSON output from hook: ${jsonStringify(json)}`, {
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
      logForDebugging(`${hookName} [${hook.command}] failed to run: ${errorMessage}`, {
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
export async function* executePreToolHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PreToolUse', appState, sessionId)) {
    return
  }

  logForDebugging(`executePreToolHooks called for tool: ${toolName}`, {
    level: 'verbose',
  })

  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * Execute post-tool hooks if configured
 * @param toolName The name of the tool (e.g., 'Write', 'Edit', 'Bash')
 * @param toolUseID The ID of the tool use
 * @param toolInput The input that was passed to the tool
 * @param toolResponse The response from the tool
 * @param toolUseContext ToolUseContext for prompt-based hooks
 * @param permissionMode Optional permission mode from toolPermissionContext
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and blocking errors for automated feedback
 */
export async function* executePostToolHooks<ToolInput, ToolResponse>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolResponse: ToolResponse,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: PostToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * Execute post-tool-use-failure hooks if configured
 * @param toolName The name of the tool (e.g., 'Write', 'Edit', 'Bash')
 * @param toolUseID The ID of the tool use
 * @param toolInput The input that was passed to the tool
 * @param error The error message from the failed tool call
 * @param toolUseContext ToolUseContext for prompt-based hooks
 * @param isInterrupt Whether the tool was interrupted by user
 * @param permissionMode Optional permission mode from toolPermissionContext
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Async generator that yields progress messages and blocking errors
 */
export async function* executePostToolUseFailureHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  error: string,
  toolUseContext: ToolUseContext,
  isInterrupt?: boolean,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PostToolUseFailure', appState, sessionId)) {
    return
  }

  const hookInput: PostToolUseFailureHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    error,
    is_interrupt: isInterrupt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

export async function* executePermissionDeniedHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  reason: string,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PermissionDenied', appState, sessionId)) {
    return
  }

  const hookInput: PermissionDeniedHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionDenied',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    reason,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * Execute notification hooks if configured
 * @param notificationData The notification data to pass to hooks
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Promise that resolves when all hooks complete
 */
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
    error: error as any,
    error_details: lastMessage.errorDetails,
    last_assistant_message: lastAssistantText,
  }

  await executeHooksOutsideREPL({
    getAppState: toolUseContext?.getAppState,
    hookInput,
    timeoutMs,
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

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
      }
    : {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
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
export async function* executeTeammateIdleHooks(
  teammateName: string,
  teamName: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TeammateIdleHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TeammateIdle',
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
  })
}

/**
 * Execute TaskCreated hooks when a task is being created.
 * If a hook blocks (exit code 2), the task creation should be prevented and feedback returned.
 * @param taskId The ID of the task being created
 * @param taskSubject The subject/title of the task
 * @param taskDescription Optional description of the task
 * @param teammateName Optional name of the teammate creating the task
 * @param teamName Optional team name
 * @param permissionMode Optional permission mode
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @param toolUseContext Optional ToolUseContext for resolving appState and sessionId
 * @returns Async generator that yields progress messages and blocking errors
 */
export async function* executeTaskCreatedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCreatedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCreated',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * Execute TaskCompleted hooks when a task is being marked as completed.
 * If a hook blocks (exit code 2), the task completion should be prevented and feedback returned.
 * @param taskId The ID of the task being completed
 * @param taskSubject The subject/title of the task
 * @param taskDescription Optional description of the task
 * @param teammateName Optional name of the teammate completing the task
 * @param teamName Optional team name
 * @param permissionMode Optional permission mode
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @param toolUseContext Optional ToolUseContext for resolving appState and sessionId
 * @returns Async generator that yields progress messages and blocking errors
 */
export async function* executeTaskCompletedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCompletedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCompleted',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * Execute start hooks if configured
 * @param prompt The user prompt that will be passed to the tool
 * @param permissionMode Permission mode from toolPermissionContext
 * @param toolUseContext ToolUseContext for prompt-based hooks
 * @returns Async generator that yields progress messages and hook results
 */
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
export async function* executeSubagentStartHooks(
  agentId: string,
  agentType: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SubagentStartHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: agentType,
    signal,
    timeoutMs,
  })
}

/**
 * Execute pre-compact hooks if configured
 * @param compactData The compact data to pass to hooks
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Object with optional newCustomInstructions and userDisplayMessage
 */
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
    logForDebugging(
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
export async function* executePermissionRequestHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  permissionSuggestions?: PermissionUpdate[],
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  logForDebugging(`executePermissionRequestHooks called for tool: ${toolName}`)

  const hookInput: PermissionRequestHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: permissionSuggestions,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

/**
 * Execute config change hooks when configuration files change during a session.
 * Fired by file watchers when settings, skills, or commands change on disk.
 * Enables enterprise admins to audit/log configuration changes for security.
 *
 * Policy settings are enterprise-managed and must never be blockable by hooks.
 * Hooks still fire (for audit logging) but blocking results are ignored — callers
 * will always see an empty result for policy sources.
 *
 * @param source The type of config that changed
 * @param filePath Optional path to the changed file
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 */
export async function executeConfigChangeHooks(
  source: ConfigChangeSource,
  filePath?: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<HookOutsideReplResult[]> {
  const hookInput: ConfigChangeHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'ConfigChange',
    source,
    file_path: filePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: source,
  })

  // Policy settings are enterprise-managed — hooks fire for audit logging
  // but must never block policy changes from being applied
  if (source === 'policy_settings') {
    return results.map((r) => ({ ...r, blocked: false }))
  }

  return results
}

async function executeEnvHooks(
  hookInput: HookInput,
  timeoutMs: number,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const results = await executeHooksOutsideREPL({ hookInput, timeoutMs })
  if (results.length > 0) {
    invalidateSessionEnvCache()
  }
  const watchPaths = results.flatMap((r) => r.watchPaths ?? [])
  const systemMessages = results.map((r) => r.systemMessage).filter((m): m is string => !!m)
  return { results, watchPaths, systemMessages }
}

export function executeCwdChangedHooks(
  oldCwd: string,
  newCwd: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: CwdChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'CwdChanged',
    old_cwd: oldCwd,
    new_cwd: newCwd,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

export function executeFileChangedHooks(
  filePath: string,
  event: 'change' | 'add' | 'unlink',
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: FileChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'FileChanged',
    file_path: filePath,
    event,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

/**
 * Check if InstructionsLoaded hooks are configured (without executing them).
 * Callers should check this before invoking executeInstructionsLoadedHooks to avoid
 * building hook inputs for every instruction file when no hook is configured.
 *
 * Checks both settings-file hooks (getHooksConfigFromSnapshot) and registered
 * hooks (plugin hooks + SDK callback hooks via registerHookCallbacks). Session-
 * derived hooks (structured output enforcement etc.) are internal and not checked.
 */
export function hasInstructionsLoadedHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.InstructionsLoaded
  if (snapshotHooks && snapshotHooks.length > 0) {
    return true
  }
  const registeredHooks = getRegisteredHooks()?.InstructionsLoaded
  if (registeredHooks && registeredHooks.length > 0) {
    return true
  }
  return false
}

/**
 * Execute InstructionsLoaded hooks when an instruction file (CLAUDE.md or
 * .zy/rules/*.md) is loaded into context. Fire-and-forget — this hook is
 * for observability/audit only and does not support blocking.
 *
 * Dispatch sites:
 * - Eager load at session start (getMemoryFiles in zymd.ts)
 * - Eager reload after compaction (getMemoryFiles cache cleared by
 *   runPostCompactCleanup; next call reports load_reason: 'compact')
 * - Lazy load when Zy touches a file that triggers nested CLAUDE.md or
 *   conditional rules with paths: frontmatter (memoryFilesToAttachments in
 *   attachments.ts)
 */
export async function executeInstructionsLoadedHooks(
  filePath: string,
  memoryType: InstructionsMemoryType,
  loadReason: InstructionsLoadReason,
  options?: {
    globs?: string[]
    triggerFilePath?: string
    parentFilePath?: string
    timeoutMs?: number
  },
): Promise<void> {
  const {
    globs,
    triggerFilePath,
    parentFilePath,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options ?? {}

  const hookInput: InstructionsLoadedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'InstructionsLoaded',
    file_path: filePath,
    memory_type: memoryType,
    load_reason: loadReason,
    globs,
    trigger_file_path: triggerFilePath,
    parent_file_path: parentFilePath,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: loadReason,
  })
}

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

/**
 * Parse elicitation-specific fields from a HookOutsideReplResult.
 * Mirrors the relevant branches of processHookJSONOutput for Elicitation
 * and ElicitationResult hook events.
 */
function parseElicitationHookOutput(
  result: HookOutsideReplResult,
  expectedEventName: 'Elicitation' | 'ElicitationResult',
): {
  response?: ElicitationResponse
  blockingError?: HookBlockingError
} {
  // Exit code 2 = blocking (same as executeHooks path)
  if (result.blocked && !result.succeeded) {
    return {
      blockingError: {
        blockingError: result.output || `Elicitation blocked by hook`,
        command: result.command,
      },
    }
  }

  if (!result.output.trim()) {
    return {}
  }

  // 尝试解析 JSON 输出以获取结构化的 elicitation 响应
  const trimmed = result.output.trim()
  if (!trimmed.startsWith('{')) {
    return {}
  }

  try {
    const parsed = hookJSONOutputSchema().parse(JSON.parse(trimmed))
    if (isAsyncHookJSONOutput(parsed as any)) {
      return {}
    }
    if (!isSyncHookJSONOutput(parsed as any)) {
      return {}
    }

    // 检查顶层 decision: 'block'（退出码 0 + JSON block）
    if ((parsed as any).decision === 'block' || result.blocked) {
      return {
        blockingError: {
          blockingError: (parsed as any).reason || 'Elicitation blocked by hook',
          command: result.command,
        },
      }
    }

    const specific = (parsed as any).hookSpecificOutput
    if (!specific || specific.hookEventName !== expectedEventName) {
      return {}
    }

    if (!specific.action) {
      return {}
    }

    const response: ElicitationResponse = {
      action: specific.action,
      content: specific.content as ElicitationResponse['content'] | undefined,
    }

    const out: {
      response?: ElicitationResponse
      blockingError?: HookBlockingError
    } = { response }

    if (specific.action === 'decline') {
      out.blockingError = {
        blockingError:
          (parsed as any).reason ||
          (expectedEventName === 'Elicitation'
            ? 'Elicitation denied by hook'
            : 'Elicitation result blocked by hook'),
        command: result.command,
      }
    }

    return out
  } catch {
    return {}
  }
}

export async function executeElicitationHooks({
  serverName,
  message,
  requestedSchema,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  url,
  elicitationId,
}: {
  serverName: string
  message: string
  requestedSchema?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
}): Promise<ElicitationHookResult> {
  const hookInput: ElicitationHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'Elicitation',
    mcp_server_name: serverName,
    message,
    mode,
    url,
    elicitation_id: elicitationId,
    requested_schema: requestedSchema,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'Elicitation')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResponse = parsed.response
    }
  }

  return { elicitationResponse, blockingError }
}

export async function executeElicitationResultHooks({
  serverName,
  action,
  content,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  elicitationId,
}: {
  serverName: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  elicitationId?: string
}): Promise<ElicitationResultHookResult> {
  const hookInput: ElicitationResultHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'ElicitationResult',
    mcp_server_name: serverName,
    elicitation_id: elicitationId,
    mode,
    action,
    content,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResultResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'ElicitationResult')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResultResponse = parsed.response
    }
  }

  return { elicitationResultResponse, blockingError }
}

/**
 * Execute file suggestion command if configured
 * @param fileSuggestionInput The structured input that will be converted to JSON
 * @param signal Optional AbortSignal to cancel hook execution
 * @param timeoutMs Optional timeout in milliseconds for hook execution
 * @returns Array of file paths, or empty array if no command configured
 */
export async function executeFileSuggestionCommand(
  fileSuggestionInput: FileSuggestionCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for typeahead suggestions
): Promise<string[]> {
  // 检查是否所有 hook 都被托管设置禁用
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  // SECURITY: ALL hooks require workspace trust in interactive mode
  // This centralized check prevents RCE vulnerabilities for all current and future hooks
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(`Skipping FileSuggestion command execution - workspace trust not accepted`)
    return []
  }

  // When disableAllHooks is set in non-managed settings, only managed fileSuggestion runs
  // (non-managed settings cannot disable managed commands, but non-managed commands are disabled)
  let fileSuggestion
  if (shouldAllowManagedHooksOnly()) {
    fileSuggestion = getSettingsForSource('policySettings')?.fileSuggestion
  } else {
    fileSuggestion = getInitialSettings()?.fileSuggestion
  }

  if (!fileSuggestion || fileSuggestion.type !== 'command') {
    return []
  }

  // 使用提供的 signal 或创建默认的
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    const jsonInput = jsonStringify(fileSuggestionInput)

    const hook = { type: 'command' as const, command: fileSuggestion.command }

    const result = await execCommandHook(
      hook,
      'FileSuggestion',
      'FileSuggestion',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted || result.status !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    logForDebugging(`File suggestion helper failed: ${error}`, {
      level: 'error',
    })
    return []
  }
}

async function executeFunctionHook({
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
      }) as any,
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

async function executeHookCallback({
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

/**
 * Check if WorktreeCreate hooks are configured (without executing them).
 *
 * Checks both settings-file hooks (getHooksConfigFromSnapshot) and registered
 * hooks (plugin hooks + SDK callback hooks via registerHookCallbacks).
 *
 * Must mirror the managedOnly filtering in getHooksConfig() — when
 * shouldAllowManagedHooksOnly() is true, plugin hooks (pluginRoot set) are
 * skipped at execution, so we must also skip them here. Otherwise this returns
 * true but executeWorktreeCreateHook() finds no matching hooks and throws,
 * blocking the git-worktree fallback.
 */
export function hasWorktreeCreateHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.WorktreeCreate
  if (snapshotHooks && snapshotHooks.length > 0) {
    return true
  }
  const registeredHooks = getRegisteredHooks()?.WorktreeCreate
  if (!registeredHooks || registeredHooks.length === 0) {
    return false
  }
  // 镜像 getHooksConfig()：在仅托管模式下跳过插件 hook
  const managedOnly = shouldAllowManagedHooksOnly()
  return registeredHooks.some((matcher) => !(managedOnly && 'pluginRoot' in matcher))
}

/**
 * Execute WorktreeCreate hooks.
 * Returns the worktree path from hook stdout.
 * Throws if hooks fail or produce no output.
 * Callers should check hasWorktreeCreateHook() before calling this.
 */
export async function executeWorktreeCreateHook(name: string): Promise<{ worktreePath: string }> {
  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeCreate' as const,
    name,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  // 查找第一个输出非空的成功结果
  const successfulResult = results.find((r) => r.succeeded && r.output.trim().length > 0)

  if (!successfulResult) {
    const failedOutputs = results
      .filter((r) => !r.succeeded)
      .map((r) => `${r.command}: ${r.output.trim() || 'no output'}`)
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs.join('; ') || 'no successful output'}`,
    )
  }

  const worktreePath = successfulResult.output.trim()
  return { worktreePath }
}

/**
 * Execute WorktreeRemove hooks if configured.
 * Returns true if hooks were configured and ran, false if no hooks are configured.
 *
 * Checks both settings-file hooks (getHooksConfigFromSnapshot) and registered
 * hooks (plugin hooks + SDK callback hooks via registerHookCallbacks).
 */
export async function executeWorktreeRemoveHook(worktreePath: string): Promise<boolean> {
  const snapshotHooks = getHooksConfigFromSnapshot()?.WorktreeRemove
  const registeredHooks = getRegisteredHooks()?.WorktreeRemove
  const hasSnapshotHooks = snapshotHooks && snapshotHooks.length > 0
  const hasRegisteredHooks = registeredHooks && registeredHooks.length > 0
  if (!hasSnapshotHooks && !hasRegisteredHooks) {
    return false
  }

  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: worktreePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  if (results.length === 0) {
    return false
  }

  for (const result of results) {
    if (!result.succeeded) {
      logForDebugging(`WorktreeRemove hook failed [${result.command}]: ${result.output.trim()}`, {
        level: 'error',
      })
    }
  }

  return true
}

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
    } else if (hook.type === 'function') {
      return { type: 'function', name: 'function' }
    } else if (hook.type === 'callback') {
      return { type: 'callback', name: 'callback' }
    }
    return { type: 'unknown' }
  })
}
