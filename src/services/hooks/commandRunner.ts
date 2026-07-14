import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { formatShellPrefixCommand } from 'src/shell-eval/bash/shellPrefix.js'
import { getCachedPowerShellPath } from 'src/shell-eval/shared/powershellDetection.js'
import { buildPowerShellArgs } from 'src/shell-eval/shared/powershellProvider.js'
import { DEFAULT_HOOK_SHELL } from 'src/shell-eval/shared/shellProvider.js'
import {
  hookJSONOutputSchema,
  isAsyncHookJSONOutput,
  type PromptRequest,
  type PromptResponse,
  promptRequestSchema,
} from 'src/types/hooks/index.js'
import type {
  AsyncHookJSONOutput,
  HookEvent,
  HookJSONOutput,
  SyncHookJSONOutput,
} from 'src/types/index.js'
import { getOriginalCwd, getProjectRoot } from '../../bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { TaskOutput } from '../task-runtime/taskOutput.js'
import { createAttachmentMessage } from '../attachments/attachments.js'
import { getCwd } from '../../utils/cwd.js'
import { createDebugLog } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { pathExists } from '../../utils/file.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { wrapInSystemReminder } from '../messages/api.js'
import { getPlatform } from '../shell/platform.js'
import { getPluginDataDir } from '../plugins/pluginDirectories.js'
import {
  containsUserConfigRef,
  loadPluginOptions,
  substituteUserConfigVariables,
} from '../plugins/pluginOptionsStorage.js'
import { type ShellCommand, wrapSpawn } from '../shell/shellCommand.js'
import { getHookEnvFilePath } from '../../utils/sessionEnvironment.js'
import type { HookCommand } from '../settings/types.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { findGitBashPath, windowsPathToPosixPath } from '../shell/windowsPaths.js'
import { registerPendingAsyncHook } from './asyncHookRegistry.js'
import { TOOL_HOOK_EXECUTION_TIMEOUT_MS } from './config.js'
import { emitHookResponse, startHookProgressInterval } from './hookEvents.js'
import { maybeSpillHookOutput } from './spillOutput.js'
import type { ElicitationResponse, HookResult } from './types.js'

const hookLog = createDebugLog('hooks')

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

function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    hookLog('Successfully parsed and validated hook JSON output')
    // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
    return { json: validation.data as any }
  }
  const errors = validation.error.issues
    .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

export function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) {
    hookLog('Hook output does not start with {, treating as plain text')
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
    hookLog(errorMessage)
    return { plainText: stdout, validationError: errorMessage }
  } catch (e) {
    hookLog(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

export function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      hookLog('HTTP hook returned empty body, treating as empty JSON object')
      // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
      return { json: validation.data as any }
    }
  }

  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}\u2026` : trimmed}`
    hookLog(validationError)
    return { validationError }
  }

  try {
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    hookLog(result.validationError)
    return result
  } catch (e) {
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    hookLog(validationError)
    return { validationError }
  }
}

export function processHookJSONOutput({
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

  // 终端控制序列（raw）。白名单校验延后到 executeEngine 写 stdout 前统一做。
  if (json.terminalSequence !== undefined) {
    result.terminalSequence = json.terminalSequence
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
      case 'UserPromptExpansion':
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
        // 通用结果覆盖（全工具，string），优先于 updatedMCPToolOutput
        if (json.hookSpecificOutput.updatedToolOutput !== undefined) {
          result.updatedToolOutput = json.hookSpecificOutput.updatedToolOutput
        }
        // 如果提供了 updatedMCPToolOutput 则提取
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput = json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolBatch':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'MessageDisplay':
        if (json.hookSpecificOutput.transformedText !== undefined) {
          result.transformedText = json.hookSpecificOutput.transformedText
        }
        if (json.hookSpecificOutput.hide !== undefined) {
          result.hide = json.hookSpecificOutput.hide
        }
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

  // additionalContext 会被直接注入模型上下文：超阈值时落盘，只保留预览+路径，
  // 防止写错的 hook 撑爆上下文。覆盖所有事件（含 HTTP hook 路径）。
  if (result.additionalContext) {
    result.additionalContext = maybeSpillHookOutput(hookName, result.additionalContext).inline
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
          // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
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
export async function execCommandHook(
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
  // 当前 turn 的 effort 等级（来自 hookInput.effort.level）。作为 $ZY_CODE_EFFORT
  // 暴露给 hook 子进程，便于 bash hook 无需解析 stdin JSON 即可差异化逻辑。
  effortLevel?: string,
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
  //
  // shell-form（无 args）禁止展开 ${user_config.*}：替换值会经 shell
  // 二次解析，构成命令注入面（对齐 Claude Code 2.1.207）。请改用
  // exec form 的 args 数组，或脚本内读 $CLAUDE_PLUGIN_OPTION_<KEY>。
  let command = hook.command
  let pluginOpts: ReturnType<typeof loadPluginOptions> | undefined
  const isShellForm = hook.args === undefined
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
      if (isShellForm && containsUserConfigRef(command)) {
        const source = pluginId ? `plugin ${pluginId}` : 'a plugin'
        throw new Error(
          tSync('plugin.errors.userConfigShellForm', {
            source,
            command: hook.command,
          }),
        )
      }
      // exec form：argv 字面传递，展开安全。shell-form 已在上方拒绝 user_config 引用。
      // 若引用的 key 缺失则抛出——意味着 hook 使用了未在 manifest.userConfig
      // 中声明或尚未配置的 key（上游作为普通 hook 执行失败捕获）。
      if (!isShellForm) {
        command = substituteUserConfigVariables(command, pluginOpts)
      }
    }
  }

  // 在 Windows（仅 bash、仅 shell form）上，为 .sh 脚本自动前缀 `bash`，使其
  // 执行而非用默认文件处理器打开。exec form（hook.args）直接 spawn 可执行文件，
  // 不经 shell，无需前缀。PowerShell 原生运行 .ps1 文件——无需前缀。
  if (
    isWindows &&
    !isPowerShell &&
    hook.args === undefined &&
    command.trim().match(/\.sh(\s|$|")/)
  ) {
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
    ...(effortLevel && { ZY_CODE_EFFORT: effortLevel }),
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
    hookLog(`Hooks: cwd ${hookCwd} not found, falling back to original cwd`, {
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
  } else if (hook.args !== undefined) {
    // Exec form：直接 spawn 可执行文件，不经 shell——路径含空格无需转义。
    // command 已做 ${CLAUDE_PLUGIN_ROOT}/user_config 替换；args 同样展开 user_config
    //（argv 字面，无 shell 二次解析）。跳过 .sh 前缀与 ZY_CODE_SHELL_PREFIX。
    // Windows 下用原生可执行路径（不经 Git Bash POSIX 转换）。
    const resolvedArgs = pluginOpts
      ? hook.args.map((arg) => substituteUserConfigVariables(arg, pluginOpts!))
      : hook.args
    child = spawn(command, resolvedArgs, {
      env: envVars,
      cwd: safeCwd,
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
    hookLog(`Hooks: Config-based async hook, backgrounding process ${processId}`)

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
            hookLog(`Hooks: Detected prompt request from hook: ${trimmed}`)
            // 链式处理以序列化 prompt 响应
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(`${jsonStringify(response)}\n`, 'utf8')
              } catch (err) {
                hookLog(`Hooks: Prompt request handling failed: ${err}`)
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
      hookLog(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        hookLog(`Hooks: Parsed initial response: ${jsonStringify(parsed)}`)
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          hookLog(`Hooks: Detected async hook, backgrounding process ${processId}`)

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
          hookLog(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          hookLog(`Hooks: Initial response is not async, continuing normal processing`)
        }
      } catch (e) {
        hookLog(`Hooks: Failed to parse initial response as JSON: ${e}`)
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
            hookLog(`Hooks: stdin error during prompt flow (likely process exited): ${err}`)
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
      hookLog('EPIPE error while writing to hook stdin (hook command likely closed early)')
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
