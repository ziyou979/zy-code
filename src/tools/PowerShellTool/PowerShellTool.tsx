import { feature } from 'bun:bundle'
import { copyFile, stat as fsStat, truncate as fsTruncate, link } from 'node:fs/promises'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { AppState } from 'src/state/AppStateStore.js'
import { z } from 'zod/v4'
import { getKairosActive } from 'src/bootstrap/runtime/runtimeContext.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { SandboxManager } from '../../services/sandbox/sandboxAdapter.js'
import { getTaskOutputPath } from '../../services/task-runtime/diskOutput.js'
import { TaskOutput } from '../../services/task-runtime/taskOutput.js'
import { getCachedPowerShellPath } from '../../shell-eval/shared/powershellDetection.js'
import { tSync } from '../../i18n/index.js'
import type { SetToolJSXFn, Tool, ToolCallProgress, ValidationResult } from '../../tools/tool.js'
import { buildTool, type ToolDef } from '../../tools/tool.js'
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from '../../tasks/local-shell-task/LocalShellTask.js'
import type { AgentId } from '../../types/ids.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { AssistantMessage } from '../../types/message.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { errorMessage as getErrorMessage, ShellError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../services/infra/log.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { getPlatform } from '../../services/shell/platform.js'
import { maybeRecordPluginHint } from '../../services/plugins/hintRecommendation.js'
import { exec } from '../../services/shell/shell.js'
import type { ExecResult } from '../../services/shell/shellCommand.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js'
import { isOutputLineTruncated } from '../../terminal-ui/terminal.js'
import {
  buildLargeToolResultMessage,
  ensureToolResultsDir,
  generatePreview,
  getToolResultPath,
  PREVIEW_SIZE_BYTES,
} from '../../services/mcp/toolResultStorage.js'
import { extractZyCodeHints } from '../../services/hints/zyCodeHints.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'
import { BackgroundHint } from '../BashTool/UI.js'
import {
  buildImageToolResult,
  isImageOutput,
  resetCwdIfOutsideProject,
  resizeShellImageOutput,
  stdErrAppendShellResetMessage,
  stripEmptyLines,
} from '../BashTool/utils.js'
import { trackGitOperations } from '../shared/gitOperationTracking.js'
import { interpretCommandResult } from './commandSemantics.js'
import { powershellToolHasPermission } from './powershellPermissions.js'
import { getDefaultTimeoutMs, getMaxTimeoutMs, getPrompt } from './prompt.js'
import {
  hasSyncSecurityConcerns,
  isReadOnlyCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js'

// 终端输出绝不能使用 os.EOL；Windows 上的 \r\n 会破坏 Ink 渲染。
const EOL = '\n'

/**
 * 用于折叠展示的 PowerShell 搜索命令（等同于 grep），以规范小写 cmdlet 名保存。
 */
const PS_SEARCH_COMMANDS = new Set([
  'select-string',
  // 等同于 grep。
  'get-childitem',
  // 带 -Recurse 时等同于 find。
  'findstr',
  // Windows 原生搜索。
  'where.exe', // native Windows which
])

/**
 * 用于折叠展示的 PowerShell 读取或查看命令，以规范小写 cmdlet 名保存。
 */
const PS_READ_COMMANDS = new Set([
  'get-content',
  // 等同于 cat。
  'get-item',
  // 文件信息。
  'test-path',
  // 等同于 test -e。
  'resolve-path',
  // 等同于 realpath。
  'get-process',
  // 等同于 ps。
  'get-service',
  // 系统信息。
  'get-childitem',
  // 等同于 ls/dir；递归时也属于搜索。
  'get-location',
  // 等同于 pwd。
  'get-filehash',
  // checksum。
  'get-acl',
  // 权限信息。
  'format-hex', // hexdump equivalent
])

/**
 * 不改变搜索或读取性质的 PowerShell 语义中性命令。
 */
const PS_SEMANTIC_NEUTRAL_COMMANDS = new Set([
  'write-output',
  // 等同于 echo。
  'write-host',
])

/**
 * 检查 PowerShell 命令是否为搜索或读取操作，用于判断 UI 是否应折叠该命令。
 */
function isSearchOrReadPowerShellCommand(command: string): {
  isSearch: boolean
  isRead: boolean
} {
  const trimmed = command.trim()
  if (!trimmed) {
    return {
      isSearch: false,
      isRead: false,
    }
  }

  // 按语句分隔符和管道运算符简单拆分；此函数为同步实现，因此采用轻量方式。
  const parts = trimmed.split(/\s*[;|]\s*/).filter(Boolean)
  if (parts.length === 0) {
    return {
      isSearch: false,
      isRead: false,
    }
  }
  let hasSearch = false
  let hasRead = false
  let hasNonNeutralCommand = false
  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0]
    if (!baseCommand) {
      continue
    }
    const canonical = resolveToCanonical(baseCommand)
    if (PS_SEMANTIC_NEUTRAL_COMMANDS.has(canonical)) {
      continue
    }
    hasNonNeutralCommand = true
    const isPartSearch = PS_SEARCH_COMMANDS.has(canonical)
    const isPartRead = PS_READ_COMMANDS.has(canonical)
    if (!isPartSearch && !isPartRead) {
      return {
        isSearch: false,
        isRead: false,
      }
    }
    if (isPartSearch) {
      hasSearch = true
    }
    if (isPartRead) {
      hasRead = true
    }
  }
  if (!hasNonNeutralCommand) {
    return {
      isSearch: false,
      isRead: false,
    }
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead,
  }
}

// 进度显示常量。
const PROGRESS_THRESHOLD_MS = 2000
const PROGRESS_INTERVAL_MS = 1000
// assistant 模式下，主 agent 的阻塞命令经过此毫秒数后自动转到后台。
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000

// 不应自动转到后台的命令（规范小写形式）。
// 'sleep' is a PS built-in alias for Start-Sleep but not in COMMON_ALIASES,
// so list both forms.
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = [
  'start-sleep',
  // 除非显式要求后台运行，否则 Start-Sleep 应在前台运行。
  'sleep',
]

/**
 * 检查命令是否允许自动转到后台。
 * @param command 要检查的命令
 * @returns Start-Sleep 等不应自动转后台的命令返回 false
 */
function isAutobackgroundingAllowed(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0]
  if (!firstWord) {
    return true
  }
  const canonical = resolveToCanonical(firstWord)
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(canonical)
}

/**
 * PS-flavored port of BashTool's detectBlockedSleepPattern.
 * Catches `Start-Sleep N`, `Start-Sleep -Seconds N`, `sleep N` (built-in alias)
 * as the first statement. Does NOT block `Start-Sleep -Milliseconds` (sub-second
 * pacing is fine) or float seconds (legit rate limiting).
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // First statement only — split on PS statement separators: `;`, `|`,
  // `&`/`&&`/`||` (pwsh 7+), and newline (PS's primary separator). This is
  // intentionally shallow — sleep inside script blocks, subshells, or later
  // pipeline stages is fine. Matches BashTool's splitCommandWithOperators
  // intent (src/shell-eval/bash/commands.ts) without a full PS parser.
  const first =
    command
      .trim()
      .split(/[;|&\r\n]/)[0]
      ?.trim() ?? ''
  // Match: Start-Sleep N, Start-Sleep -Seconds N, Start-Sleep -s N, sleep N
  // (case-insensitive; -Seconds can be abbreviated to -s per PS convention)
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first)
  if (!m) {
    return null
  }
  const secs = parseInt(m[1]!, 10)
  if (secs < 2) {
    return null // sub-2s sleeps are fine (rate limiting, pacing)
  }

  const rest = command
    .trim()
    .slice(first.length)
    .replace(/^[\s;|&]+/, '')
  return rest ? `Start-Sleep ${secs} followed by: ${rest}` : `standalone Start-Sleep ${secs}`
}

/**
 * On Windows native, sandbox is unavailable (bwrap/sandbox-exec are
 * POSIX-only). If enterprise policy has sandbox.enabled AND forbids
 * unsandboxed commands, PowerShell cannot comply — refuse execution
 * rather than silently bypass the policy. On Linux/macOS/WSL2, pwsh
 * runs as a native binary under the sandbox same as bash, so this
 * gate does not apply.
 *
 * Checked in BOTH validateInput (clean tool-runner error) and call()
 * (covers direct callers like promptShellExecution.ts that skip
 * validateInput). The call() guard is the load-bearing one.
 */
const WINDOWS_SANDBOX_POLICY_REFUSAL =
  'Enterprise policy requires sandboxing, but sandboxing is not available on native Windows. Shell command execution is blocked on this platform by policy.'
function isWindowsSandboxPolicyViolation(): boolean {
  return (
    getPlatform() === 'windows' &&
    SandboxManager.isSandboxEnabledInSettings() &&
    !SandboxManager.areUnsandboxedCommandsAllowed()
  )
}

// 模块加载时检查是否禁用了后台任务。
const isBackgroundTasksDisabled =
  // eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
  isEnvTruthy(process.env.ZY_CODE_DISABLE_BACKGROUND_TASKS)
const fullInputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe('The PowerShell command to execute'),
    timeout: semanticNumber(z.number().optional()).describe(
      `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`,
    ),
    description: z
      .string()
      .optional()
      .describe('Clear, concise description of what this command does in active voice.'),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(
      `Set to true to run this command in the background. Use Read to read the output later.`,
    ),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe(
      'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
    ),
  }),
)

// 后台任务禁用时，有条件地从 schema 移除 run_in_background。
const inputSchema = lazySchema(() =>
  isBackgroundTasksDisabled
    ? fullInputSchema().omit({
        run_in_background: true,
      })
    : fullInputSchema(),
)
type InputSchema = ReturnType<typeof inputSchema>

// 类型使用 fullInputSchema，以始终包含 run_in_background；即使 schema 省略该字段，
// 代码仍需处理它。
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>
const outputSchema = lazySchema(() =>
  z.object({
    stdout: z.string().describe('The standard output of the command'),
    stderr: z.string().describe('The standard error output of the command'),
    interrupted: z.boolean().describe('Whether the command was interrupted'),
    returnCodeInterpretation: z
      .string()
      .optional()
      .describe('Semantic interpretation for non-error exit codes with special meaning'),
    isImage: z.boolean().optional().describe('Flag to indicate if stdout contains image data'),
    persistedOutputPath: z
      .string()
      .optional()
      .describe('Path to persisted full output when too large for inline'),
    persistedOutputSize: z
      .number()
      .optional()
      .describe('Total output size in bytes when persisted'),
    backgroundTaskId: z
      .string()
      .optional()
      .describe('ID of the background task if command is running in background'),
    backgroundedByUser: z
      .boolean()
      .optional()
      .describe('True if the user manually backgrounded the command with Ctrl+B'),
    assistantAutoBackgrounded: z
      .boolean()
      .optional()
      .describe('True if the command was auto-backgrounded by the assistant-mode blocking budget'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Out = z.infer<OutputSchema>

import type { PowerShellProgress } from '../../types/tools.js'

export type { PowerShellProgress } from '../../types/tools.js'

const COMMON_BACKGROUND_COMMANDS = [
  'npm',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'go',
  'cargo',
  'make',
  'docker',
  'terraform',
  'webpack',
  'vite',
  'jest',
  'pytest',
  'curl',
  'Invoke-WebRequest',
  'build',
  'test',
  'serve',
  'watch',
  'dev',
] as const
function getCommandTypeForLogging(
  command: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0] || ''
  for (const cmd of COMMON_BACKGROUND_COMMANDS) {
    if (firstWord.toLowerCase() === cmd.toLowerCase()) {
      return cmd as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  }
  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'execute Windows PowerShell commands',
  maxResultSizeChars: 30_000,
  strict: true,
  async description({ description }: Partial<PowerShellToolInput>): Promise<string> {
    return description || 'Run PowerShell command'
  },
  async prompt(): Promise<string> {
    return getPrompt()
  },
  isConcurrencySafe(input: PowerShellToolInput): boolean {
    return this.isReadOnly?.(input) ?? false
  },
  isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
    isSearch: boolean
    isRead: boolean
  } {
    if (!input.command) {
      return {
        isSearch: false,
        isRead: false,
      }
    }
    return isSearchOrReadPowerShellCommand(input.command)
  },
  isReadOnly(input: PowerShellToolInput): boolean {
    // Check sync security heuristics before declaring read-only.
    // The full AST parse is async and unavailable here, so we use
    // regex-based detection of subexpressions, splatting, member
    // invocations, and assignments — matching BashTool's pattern of
    // checking security concerns before cmdlet allowlist evaluation.
    if (hasSyncSecurityConcerns(input.command)) {
      return false
    }
    // NOTE: This calls isReadOnlyCommand without the parsed AST. Without the
    // AST, isReadOnlyCommand cannot split pipelines/statements and will return
    // false for anything but the simplest single-token commands. This is a
    // known limitation of the sync Tool.isReadOnly() interface — the real
    // read-only auto-allow happens async in powershellToolHasPermission (step
    // 4.5) where the parsed AST is available.
    return isReadOnlyCommand(input.command)
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(): string {
    return 'PowerShell'
  },
  getToolUseSummary(input: Partial<PowerShellToolInput> | undefined): string | null {
    if (!input?.command) {
      return null
    }
    const { command, description } = input
    if (description) {
      return description
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH)
  },
  getActivityDescription(input: Partial<PowerShellToolInput> | undefined): string {
    if (!input?.command) {
      return tSync('pwshTool.runningCommand')
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH)
    return tSync('pwshTool.running', { desc })
  },
  isEnabled(): boolean {
    return true
  },
  async validateInput(input: PowerShellToolInput): Promise<ValidationResult> {
    // 纵深防御：call() 中也会保护直接调用方。
    if (isWindowsSandboxPolicyViolation()) {
      return {
        result: false,
        message: WINDOWS_SANDBOX_POLICY_REFUSAL,
        errorCode: 11,
      }
    }
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command)
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `Blocked: ${sleepPattern}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. For streaming events (watching logs, polling APIs), use the Monitor tool. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
          errorCode: 10,
        }
      }
    }
    return {
      result: true,
    }
  },
  async checkPermissions(
    input: PowerShellToolInput,
    context: Parameters<Tool['checkPermissions']>[1],
  ): Promise<PermissionResult> {
    return await powershellToolHasPermission(input, context)
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  mapToolResultToToolResultBlock(
    {
      interrupted,
      stdout,
      stderr,
      isImage,
      persistedOutputPath,
      persistedOutputSize,
      backgroundTaskId,
      backgroundedByUser,
      assistantAutoBackgrounded,
    }: Out,
    toolUseID: string,
  ): ToolResultBlock {
    // 对图像数据，格式化为供 ZY 使用的 image content block。
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID)
      if (block) {
        return block
      }
    }
    let processedStdout = stdout
    if (persistedOutputPath) {
      const trimmed = stdout ? stdout.replace(/^(\s*\n)+/, '').trimEnd() : ''
      const preview = generatePreview(trimmed, PREVIEW_SIZE_BYTES)
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore,
      })
    } else if (stdout) {
      processedStdout = stdout.replace(/^(\s*\n)+/, '')
      processedStdout = processedStdout.trimEnd()
    }
    let errorMessage = stderr.trim()
    if (interrupted) {
      if (stderr) {
        errorMessage += EOL
      }
      errorMessage += '<error>Command was aborted before completion</error>'
    }
    let backgroundInfo = ''
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId)
      if (assistantAutoBackgrounded) {
        backgroundInfo = `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${backgroundTaskId}. It is still running — you will be notified when it completes. Output is being written to: ${outputPath}. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`
      } else if (backgroundedByUser) {
        backgroundInfo = `Command was manually backgrounded by user with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`
      } else {
        backgroundInfo = `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}`
      }
    }
    return {
      toolCallId: toolUseID,
      type: 'tool_result' as const,
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      isError: interrupted,
    }
  },
  async call(
    input: PowerShellToolInput,
    toolUseContext: Parameters<Tool['call']>[1],
    _canUseTool?: CanUseToolFn,
    _parentMessage?: AssistantMessage,
    onProgress?: ToolCallProgress<PowerShellProgress>,
  ): Promise<{
    data: Out
  }> {
    // Load-bearing guard: promptShellExecution.ts and processBashCommand.tsx
    // call PowerShellTool.call() directly, bypassing validateInput. This is
    // the check that covers ALL callers. See isWindowsSandboxPolicyViolation
    // comment for the policy rationale.
    if (isWindowsSandboxPolicyViolation()) {
      throw new Error(WINDOWS_SANDBOX_POLICY_REFUSAL)
    }
    const { abortController, setAppState, setToolJSX } = toolUseContext
    const isMainThread = !toolUseContext.agentId
    let progressCounter = 0
    try {
      const commandGenerator = runPowerShellCommand({
        input,
        abortController,
        // 使用始终共享的 task channel，确保异步 agent 的后台 shell task 真正注册，
        // 并可在 agent 退出时终止。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges: !isMainThread,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
      })
      let generatorResult
      do {
        generatorResult = await commandGenerator.next()
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value
          onProgress({
            toolUseID: `ps-progress-${progressCounter++}`,
            data: {
              type: 'powershell_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes ?? 0,
              timeoutMs: progress.timeoutMs ?? 0,
              taskId: progress.taskId,
            },
          })
        }
      } while (!generatorResult.done)
      const result = generatorResult.value

      // Feed git/PR usage metrics (same counters as BashTool). PS invokes
      // git/gh/glab/curl as external binaries with identical syntax, so the
      // shell-agnostic regex detection in trackGitOperations works as-is.
      // Called before the backgroundTaskId early-return so backgrounded
      // commands are counted too (matches BashTool.tsx:912).
      //
      // Pre-flight sentinel guard: the two PS pre-flight paths (pwsh-not-found,
      // exec-spawn-catch) return code: 0 + empty stdout + stderr so call() can
      // surface stderr gracefully instead of throwing ShellError. But
      // gitOperationTracking.ts:48 treats code 0 as success and would
      // regex-match the command, mis-counting a command that never ran.
      // BashTool is safe — its pre-flight goes through createFailedCommand
      // (code: 1) so tracking early-returns. Skip tracking on this sentinel.
      const isPreFlightSentinel =
        result.code === 0 && !result.stdout && result.stderr && !result.backgroundTaskId
      if (!isPreFlightSentinel) {
        trackGitOperations(input.command, result.code, result.stdout)
      }

      // 区分用户主动中断（提交新消息）和其他中断状态。只有用户中断应抑制 ShellError；
      // timeout kill 或带 isError 的 process kill 仍应抛出。与 BashTool 的 isInterrupt 一致。
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt'

      // 只有主线程跟踪或重置 cwd；agent 有各自的 cwd 隔离。
      // 与 BashTool 的 !preventCwdChanges 关卡一致。
      // Runs before the backgroundTaskId early-return: a command may change
      // CWD before being backgrounded (e.g. `Set-Location C:\temp;
      // Start-Sleep 60`), and BashTool has no such early return — its
      // backgrounded results flow through resetCwdIfOutsideProject at :945.
      let stderrForShellReset = ''
      if (isMainThread) {
        const appState = toolUseContext.getAppState()
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('')
        }
      }

      // 转到后台后立即返回 task ID。先剥离 hint，避免因中断转后台的 fullOutput
      // 向 model 泄漏 tag；BashTool 没有提前返回，所有路径都会经过其单一提取点。
      if (result.backgroundTaskId) {
        const bgExtracted = extractZyCodeHints(result.stdout || '', input.command)
        if (isMainThread && bgExtracted.hints.length > 0) {
          for (const hint of bgExtracted.hints) {
            maybeRecordPluginHint(hint)
          }
        }
        return {
          data: {
            stdout: bgExtracted.stripped,
            stderr: [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n'),
            interrupted: false,
            backgroundTaskId: result.backgroundTaskId,
            backgroundedByUser: result.backgroundedByUser,
            assistantAutoBackgrounded: result.assistantAutoBackgrounded,
          },
        }
      }
      const stdoutAccumulator = new EndTruncatingAccumulator()
      const processedStdout = (result.stdout || '').trimEnd()
      stdoutAccumulator.append(processedStdout + EOL)

      // 按语义规则解释退出码。PS 原生 cmdlet（Select-String、Compare-Object、Test-Path）
      // 未匹配时仍退出 0，因此这里始终走默认分支。此逻辑主要处理外部 .exe
      //（grep、rg、findstr、fc、robocopy）；它们的非零值可能表示“未匹配”或“已复制文件”，
      // 而非失败。
      const interpretation = interpretCommandResult(
        input.command,
        result.code,
        processedStdout,
        result.stderr || '',
      )

      // getErrorParts() in toolErrors.ts already prepends 'Exit code N'
      // from error.code when building the ShellError message. Do not
      // duplicate it into stdout here (BashTool's append at :939 is dead
      // code — it throws before stdoutAccumulator.toString() is read).

      let stdout = stripEmptyLines(stdoutAccumulator.toString())

      // ZY Code hints protocol: CLIs/SDKs gated on CLAUDECODE=1 emit a
      // `<zy-code-hint />` tag to stderr (merged into stdout here). Scan,
      // record for useZyCodeHintRecommendation to surface, then strip
      // so the model never sees the tag — a zero-token side channel.
      // Stripping runs unconditionally (subagent output must stay clean too);
      // only the dialog recording is main-thread-only.
      const extracted = extractZyCodeHints(stdout, input.command)
      stdout = extracted.stripped
      if (isMainThread && extracted.hints.length > 0) {
        for (const hint of extracted.hints) {
          maybeRecordPluginHint(hint)
        }
      }

      // preSpawnError means exec() succeeded but the inner shell failed before
      // the command ran (e.g. CWD deleted). createFailedCommand sets code=1,
      // which interpretCommandResult can mistake for grep-no-match / findstr
      // string-not-found. Throw it directly. Matches BashTool.tsx:957.
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError)
      }
      if (interpretation.isError && !isInterrupt) {
        throw new ShellError(stdout, result.stderr || '', result.code, result.interrupted)
      }

      // 大输出：磁盘文件超过 getMaxOutputLength() 字节，stdout 已包含首个分块。
      // 将输出文件复制到 tool-results 目录，使 model 可通过 FileRead 读取；超过 64 MB 时
      // 在复制后截断。与 BashTool.tsx:983-1005 一致。
      //
      // Placed AFTER the preSpawnError/ShellError throws (matches BashTool's
      // ordering, where persistence is post-try/finally): a failing command
      // that also produced >maxOutputLength bytes would otherwise do 3-4 disk
      // syscalls, store to tool-results/, then throw — orphaning the file.
      const MAX_PERSISTED_SIZE = 64 * 1024 * 1024
      let persistedOutputPath: string | undefined
      let persistedOutputSize: number | undefined
      if (result.outputFilePath && result.outputTaskId) {
        try {
          const fileStat = await fsStat(result.outputFilePath)
          persistedOutputSize = fileStat.size
          await ensureToolResultsDir()
          const dest = getToolResultPath(result.outputTaskId, false)
          if (fileStat.size > MAX_PERSISTED_SIZE) {
            await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE)
          }
          try {
            await link(result.outputFilePath, dest)
          } catch {
            await copyFile(result.outputFilePath, dest)
          }
          persistedOutputPath = dest
        } catch {
          // 文件可能已不存在；stdout 预览已足够。
        }
      }

      // Cap image dimensions + size if present (CC-304 — see
      // resizeShellImageOutput). Scope the decoded buffer so it can be
      // reclaimed before we build the output object.
      let isImage = isImageOutput(stdout)
      let compressedStdout = stdout
      if (isImage) {
        const resized = await resizeShellImageOutput(
          stdout,
          result.outputFilePath,
          persistedOutputSize,
        )
        if (resized) {
          compressedStdout = resized
        } else {
          // Parse failed (e.g. multi-line stdout after the data URL). Keep
          // isImage in sync with what we actually send so the UI label stays
          // accurate — mapToolResultToToolResultBlock's defensive
          // fallthrough will send text, not an image block.
          isImage = false
        }
      }
      const finalStderr = [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n')
      logEvent('zy_powershell_tool_command_executed', {
        command_type: getCommandTypeForLogging(input.command),
        stdout_length: compressedStdout.length,
        stderr_length: finalStderr.length,
        exit_code: result.code,
        interrupted: result.interrupted,
      })
      return {
        data: {
          stdout: compressedStdout,
          stderr: finalStderr,
          interrupted: result.interrupted,
          returnCodeInterpretation: interpretation.message,
          isImage,
          persistedOutputPath,
          persistedOutputSize,
        },
      }
    } finally {
      if (setToolJSX) {
        setToolJSX(null)
      }
    }
  },
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr)
  },
} satisfies ToolDef<InputSchema, Out>)
async function* runPowerShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId,
}: {
  input: PowerShellToolInput
  abortController: AbortController
  setAppState: (f: (prev: AppState) => AppState) => void
  setToolJSX?: SetToolJSXFn
  preventCwdChanges?: boolean
  isMainThread?: boolean
  toolUseId?: string
  agentId?: AgentId
}): AsyncGenerator<
  {
    type: 'progress'
    output: string
    fullOutput: string
    elapsedTimeSeconds: number
    totalLines: number
    totalBytes: number
    taskId?: string
    timeoutMs?: number
  },
  ExecResult,
  void
> {
  const { command, description, timeout, run_in_background, dangerouslyDisableSandbox } = input
  const timeoutMs = Math.min(timeout || getDefaultTimeoutMs(), getMaxTimeoutMs())
  let fullOutput = ''
  let lastProgressOutput = ''
  let lastTotalLines = 0
  let lastTotalBytes = 0
  let backgroundShellId: string | undefined
  let interruptBackgroundingStarted = false
  let assistantAutoBackgrounded = false

  // Progress signal: resolved when backgroundShellId is set in the async
  // .then() path, waking the generator's Promise.race immediately instead of
  // waiting for the next setTimeout tick (matches BashTool pattern).
  let resolveProgress: (() => void) | null = null
  function createProgressSignal(): Promise<null> {
    return new Promise<null>((resolve) => {
      resolveProgress = () => resolve(null)
    })
  }
  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command)
  const powershellPath = await getCachedPowerShellPath()
  if (!powershellPath) {
    // Pre-flight failure: pwsh not installed. Return code 0 so call() surfaces
    // this as a graceful stderr message rather than throwing ShellError — the
    // command never ran, so there is no meaningful non-zero exit to report.
    return {
      stdout: '',
      stderr: 'PowerShell is not available on this system.',
      code: 0,
      interrupted: false,
    }
  }
  let shellCommand: Awaited<ReturnType<typeof exec>>
  try {
    shellCommand = await exec(command, abortController.signal, 'powershell', {
      timeout: timeoutMs,
      onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
        lastProgressOutput = lastLines
        fullOutput = allLines
        lastTotalLines = totalLines
        lastTotalBytes = isIncomplete ? totalBytes : 0
      },
      preventCwdChanges,
      // Sandbox works on Linux/macOS/WSL2 — pwsh there is a native binary and
      // SandboxManager.wrapWithSandbox wraps it same as bash (Shell.ts uses
      // /bin/sh for the outer spawn to parse the POSIX-quoted bwrap/sandbox-exec
      // string). On Windows native, sandbox is unsupported; shouldUseSandbox()
      // returns false via isSandboxingEnabled() → isSupportedPlatform() → false.
      // The explicit platform check is redundant-but-obvious.
      shouldUseSandbox:
        getPlatform() === 'windows'
          ? false
          : shouldUseSandbox({
              command,
              dangerouslyDisableSandbox,
            }),
      shouldAutoBackground,
    })
  } catch (e) {
    logError(e)
    // Pre-flight failure: spawn/exec rejected before the command ran. Use
    // code 0 so call() returns stderr gracefully instead of throwing ShellError.
    return {
      stdout: '',
      stderr: `Failed to execute PowerShell command: ${getErrorMessage(e)}`,
      code: 0,
      interrupted: false,
    }
  }
  const resultPromise = shellCommand.result

  // 启动后台 task 并返回其 ID 的 helper。
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask(
      {
        command,
        description: description || command,
        shellCommand,
        toolUseId,
        agentId,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('getAppState not available in runPowerShellCommand context')
        },
        setAppState,
      },
    )
    return handle.taskId
  }

  // 启动后台化并记录日志的 helper。
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // If a foreground task is already registered (via registerForeground in the
    // progress loop), background it in-place instead of re-spawning. Re-spawning
    // would overwrite tasks[taskId], emit a duplicate task_started SDK event,
    // and leak the first cleanup callback.
    if (foregroundTaskId) {
      if (
        !backgroundExistingForegroundTask(
          foregroundTaskId,
          shellCommand,
          description || command,
          setAppState,
          toolUseId,
        )
      ) {
        return
      }
      backgroundShellId = foregroundTaskId
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      })
      backgroundFn?.(foregroundTaskId)
      return
    }

    // 没有已注册的前台 task，启动新的后台 task。注意：spawn 虽为 async，实质上近似同步。
    void spawnBackgroundTask().then((shellId) => {
      backgroundShellId = shellId

      // Wake the generator's Promise.race so it sees backgroundShellId.
      // Without this, the generator waits for the current setTimeout to fire
      // (up to ~1s) before noticing the backgrounding. Matches BashTool.
      const resolve = resolveProgress
      if (resolve) {
        resolveProgress = null
        resolve()
      }
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      })
      if (backgroundFn) {
        backgroundFn(shellId)
      }
    })
  }

  // 启用时设置超时自动后台化。
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout((backgroundFn) => {
      startBackgrounding('zy_powershell_command_timeout_backgrounded', backgroundFn)
    })
  }

  // In assistant mode, the main agent should stay responsive. Auto-background
  // blocking commands after ASSISTANT_BLOCKING_BUDGET_MS so the agent can keep
  // coordinating instead of waiting. The command keeps running — no state loss.
  if (
    feature('KAIROS') &&
    getKairosActive() &&
    isMainThread &&
    !isBackgroundTasksDisabled &&
    run_in_background !== true
  ) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true
        startBackgrounding('zy_powershell_command_assistant_auto_backgrounded')
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref()
  }

  // 处理 ZY 显式要求后台运行。通过 run_in_background 显式请求时，无论命令类型如何
  // 都应遵循；isAutobackgroundingAllowed 只适用于自动后台化。
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask()
    logEvent('zy_powershell_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command),
    })
    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId,
    }
  }

  // 开始轮询输出文件以获取进度。
  TaskOutput.startPolling(shellCommand.taskOutput.taskId)

  // 通过定期检查设置进度 yield。
  const startTime = Date.now()
  let nextProgressTime = startTime + PROGRESS_THRESHOLD_MS
  let foregroundTaskId: string | undefined

  // 进度循环用 try/finally 包装，确保正常完成、超时或中断转后台、Ctrl+B 等所有退出路径
  // 都调用 stopPolling。与 BashTool 模式一致，参见 PR #18887 review thread :560。
  try {
    while (true) {
      const now = Date.now()
      const timeUntilNextProgress = Math.max(0, nextProgressTime - now)
      const progressSignal = createProgressSignal()
      const result = await Promise.race([
        resultPromise,
        new Promise<null>((resolve) =>
          setTimeout((r) => r(null), timeUntilNextProgress, resolve).unref(),
        ),
        progressSignal,
      ])
      if (result !== null) {
        // Race: backgrounding fired (15s timer / onTimeout / Ctrl+B) but the
        // command completed before the next poll tick. #handleExit sets
        // backgroundTaskId but skips outputFilePath (it assumes the background
        // message or <task_notification> will carry the path). Strip
        // backgroundTaskId so the model sees a clean completed command,
        // reconstruct outputFilePath for large outputs, and suppress the
        // redundant <task_notification> from the .then() handler.
        // Check result.backgroundTaskId (not the closure var) to also cover
        // Ctrl+B, which calls shellCommand.background() directly.
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState)
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined,
          }
          // Mirror ShellCommand.#handleExit's large-output branch that was
          // skipped because #backgroundTaskId was set.
          const { taskOutput } = shellCommand
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path
            fixedResult.outputFileSize = taskOutput.outputFileSize
            fixedResult.outputTaskId = taskOutput.taskId
          }
          // Command completed — cleanup stream listeners here. The finally
          // block's guard (!backgroundShellId && status !== 'backgrounded')
          // correctly skips cleanup for *running* backgrounded tasks, but
          // in this race the process is done. Matches BashTool.tsx:1399.
          shellCommand.cleanup()
          return fixedResult
        }
        // 命令已完成。
        return result
      }

      // 检查命令是否因超时或中断转到后台。
      if (backgroundShellId) {
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded,
        }
      }

      // 用户提交了新消息；转到后台，而非终止。
      if (
        abortController.signal.aborted &&
        abortController.signal.reason === 'interrupt' &&
        !interruptBackgroundingStarted
      ) {
        interruptBackgroundingStarted = true
        if (!isBackgroundTasksDisabled) {
          startBackgrounding('zy_powershell_command_interrupt_backgrounded')
          // Reloop so the backgroundShellId check (above) catches the sync
          // foregroundTaskId→background path. Without this, we fall through
          // to the Ctrl+B check below, which matches status==='backgrounded'
          // and incorrectly returns backgroundedByUser:true. (bugs 020/021)
          continue
        }
        shellCommand.kill()
      }

      // 检查此前台 task 是否通过 backgroundAll()（Ctrl+B）转到后台。
      if (foregroundTaskId) {
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true,
          }
        }
      }

      // 到达进度更新时间。
      const elapsed = Date.now() - startTime
      const elapsedSeconds = Math.floor(elapsed / 1000)

      // 超过阈值后显示后台化 UI hint。
      if (
        !isBackgroundTasksDisabled &&
        backgroundShellId === undefined &&
        elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 &&
        setToolJSX
      ) {
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground(
            {
              command,
              description: description || command,
              shellCommand,
              agentId,
            },
            setAppState,
            toolUseId,
          )
        }
        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        })
      }
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout
          ? {
              timeoutMs,
            }
          : undefined),
      }
      nextProgressTime = Date.now() + PROGRESS_INTERVAL_MS
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId)
    // Ensure cleanup runs on every exit path (success, rejection, abort).
    // Skip when backgrounded — LocalShellTask owns cleanup for those.
    // Matches main #21105.
    if (!backgroundShellId && shellCommand.status !== 'backgrounded') {
      if (foregroundTaskId) {
        unregisterForeground(foregroundTaskId, setAppState)
      }
      shellCommand.cleanup()
    }
  }
}

import { isPowerShellToolEnabled } from '../../shell-eval/shared/shellToolUtils.js'
// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(PowerShellTool, () => isPowerShellToolEnabled())
