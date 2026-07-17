/**
 * 根命令的 `.action` 处理器 —— 即交互式 REPL 启动主路径。
 *
 * 这一段约 3300 行的逻辑覆盖：bare 模式 / KAIROS 助手 / 工具栈装配 /
 * MCP 配置加载 / 插件初始化 / 权限解算 / 模型选择 / 会话恢复 / 远程
 * 会话（DIRECT_CONNECT、SSH_REMOTE、teleport）/ Plan 模式 / Coordinator
 * Mode / 队友 swarm / Bridge Mode / 最终 renderAndRun。
 *
 * 与 main.tsx 的耦合点：lazy modules（都走 cli/lazyModules.js）+ pending
 * 状态（cli/argvDispatch.js）。无 run() 局部变量捕获。
 */

import { feature } from 'bun:bundle'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import chalk from 'chalk'
import mapValues from 'lodash-es/mapValues.js'
import { logEvent } from 'src/services/analytics/index.js'
import {
  assistantModule,
  getAssistant,
  getTeammateModeSnapshot,
  getTeammatePromptAddendum,
  getTeammateUtils,
  kairosGate,
} from '../lazyModules.js'
import { extractTeammateOptions, type TeammateOptions } from '../options/teammate.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from '../../services/api/filesApi.js'
import {
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from '../../services/claude-in-chrome/setup.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { setAutoModeFlagCli } from '../../services/permissions/autoModeState.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { checkHasTrustDialogAccepted, getGlobalConfig } from '../../services/config/config.js'
import { seedEarlyInput } from '../../utils/earlyInput.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
} from '../../services/permissions/permissionSetup.js'
import { getPlatform } from '../../services/shell/platform.js'
import { getSessionIngressAuthToken } from '../../services/auth/sessionIngressAuth.js'
import { sessionIdExists } from '../../services/sessionStorage.js'
import type { ValidationError } from '../../services/settings/validation.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { DEFAULT_TASKS_MODE_TASK_LIST_ID } from '../../utils/tasks.js'
import { validateUuid } from '../../utils/uuid.js'
import { isWorktreeModeEnabled } from '../../utils/worktreeModeEnabled.js'
import type { RootActionOptions } from '../assembly/types.js'
// 插件启动检查现在在 REPL.tsx 中以非阻塞方式处理

import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  isClaudeInChromeMCPServer,
} from 'src/services/claude-in-chrome/common.js'
import {
  filterMcpServersByPolicy,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage, getErrnoCode } from 'src/utils/errors.js'
import { setAllHookEventsEnabled } from 'src/services/hooks/hookEvents.js'
import { plural } from 'src/utils/stringUtils.js'
import {
  getIsNonInteractiveSession,
  setKairosActive,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { setChromeFlagOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import { setSessionBypassPermissionsMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getTmuxInstallInstructions,
  isTmuxAvailable,
  parsePRReference,
} from '../../services/worktree/worktree.js'
export async function prepareRootAction(prompt: string | undefined, options: RootActionOptions) {
  profileCheckpoint('action_handler_start')

  // --bare = 一键最小模式。设置 SIMPLE 以便所有现有的
  // 门控触发（AGENTS.md、skills、hooks 在 executeHooks 中、agent
  // 目录遍历）。必须在 setup() / 任何门控工作运行之前设置。
  if (options.bare) {
    process.env.ZY_CODE_SIMPLE = '1'
  }

  // 忽略 "code" 作为提示 —— 与没有提示一样处理
  if (prompt === 'code') {
    logEvent('zy_code_prompt_ignored', {})
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.warn(chalk.yellow('Tip: You can launch ZY Code with just `zy`'))
    prompt = undefined
  }

  // 记录任何单字提示的事件
  if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
    logEvent('zy_single_word_prompt', {
      length: prompt.length,
    })
  }

  // 助手模式：当 .zy/settings.json 有 assistant: true 且
  // zy_kairos GrowthBook 门控开启时，强制 brief 开启。权限
  // 模式留给用户 —— 设置 defaultMode 或 --permission-mode
  // 正常应用。REPL 输入的消息默认为 'next'
  // 优先级（messageQueueManager.enqueue），以便它们在工具调用之间
  // 中转中排空。SendUserMessage（BriefTool）通过 brief env
  // 变量启用。SleepTool 保持禁用（它的 isEnabled() 门控在 proactive 上）。
  // kairosEnabled 在这里计算一次并在下方
  // getAssistantSystemPromptAddendum() 调用处重用。
  //
  // 信任门：.zy/settings.json 在不可信的 clone 中是攻击者可控制的。
  // 我们在 showSetupScreens() 显示信任对话框之前运行约 1000 行代码，
  // 到那时我们已经将 .zy/agents/assistant.md 附加到了系统提示。
  // 在目录被明确信任之前拒绝激活。
  let kairosEnabled = false

  let assistantTeamContext:
    | Awaited<ReturnType<typeof getAssistant>['initializeAssistantTeam']>
    | undefined

  const activeAssistantModule = assistantModule
  if (feature('KAIROS') ? options.assistant && activeAssistantModule !== null : false) {
    // --assistant（Agent SDK 守护进程模式）：在
    // isAssistantMode() 在下面运行之前强制锁定。守护进程已经检查过
    // 权限 —— 不要让子进程重新检查 zy_kairos。
    activeAssistantModule!.markAssistantForced()
  }

  if (
    feature('KAIROS')
      ? activeAssistantModule?.isAssistantMode() &&
        // 生成的队友共享领导者的 cwd + settings.json，所以
        // isAssistantMode() 对它们也为 true。--agent-id 被设置
        // 意味着我们是一个生成的队友（extractTeammateOptions 在
        // 约 170 行后运行，所以检查原始 commander 选项）—— 不要
        // 重新初始化团队或覆盖 teammateMode/proactive/brief。
        !options.agentId &&
        kairosGate
      : false
  ) {
    if (!checkHasTrustDialogAccepted()) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(
        chalk.yellow(
          'Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.',
        ),
      )
    } else {
      // 阻塞门检查 —— 缓存的 `true` 立即返回；如果磁盘
      // 缓存为 false/缺失，延迟初始化 GrowthBook 并获取新鲜数据
      //（最多约 5 秒）。--assistant 完全跳过此门（守护进程是
      // 预先授权的）。
      kairosEnabled = getAssistant().isAssistantForced() || (await kairosGate!.isKairosEnabled())
      if (kairosEnabled) {
        options.brief = true
        setKairosActive(true)
        // 预播种一个进程内团队，以便 Agent(name: "foo") 生成
        // 队友时不需要 TeamCreate。必须在 setup() 捕获
        // teammateMode 快照之前运行（initializeAssistantTeam 内部调用
        // setCliTeammateModeOverride）。
        assistantTeamContext = await getAssistant().initializeAssistantTeam()
      }
    }
  }

  const {
    debug = false,
    debugToStderr = false,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions = false,
    tools: baseTools = [],
    allowedTools = [],
    disallowedTools = [],
    mcpConfig = [],
    permissionMode: permissionModeCli,
    addDir = [],
    fallbackModel,
    betas = [],
    ide = false,
    sessionId,
    includeHookEvents,
    includePartialMessages,
  } = options

  if (options.prefill) {
    seedEarlyInput(options.prefill)
  }

  // Promise for file downloads - started early, awaited before REPL renders
  let fileDownloadPromise: Promise<DownloadResult[]> | undefined

  const agentsJson = options.agents

  const agentCli = options.agent

  if (feature('BG_SESSIONS') ? agentCli !== undefined : false) {
    process.env.ZY_CODE_AGENT = agentCli
  }

  // NOTE: LSP manager initialization is intentionally deferred until after
  // the trust dialog is accepted. This prevents plugin LSP servers from
  // executing code in untrusted directories before user consent.

  // 单独提取这些以便需要时可以修改
  let outputFormat = options.outputFormat

  let inputFormat = options.inputFormat

  let verbose = options.verbose ?? getGlobalConfig().verbose

  let print = options.print

  const init = options.init ?? false

  const initOnly = options.initOnly ?? false

  const maintenance = options.maintenance ?? false

  // 提取禁用斜杠命令标志
  const disableSlashCommands = options.disableSlashCommands || false

  // 提取任务模式选项（仅限 ant）
  const tasksOption = isInternalBuild() && options.tasks

  const taskListId = tasksOption
    ? typeof tasksOption === 'string'
      ? tasksOption
      : DEFAULT_TASKS_MODE_TASK_LIST_ID
    : undefined

  if (isInternalBuild() && taskListId) {
    process.env.ZY_CODE_TASK_LIST_ID = taskListId
  }

  // 提取 worktree 选项
  // worktree 可以是 true（不带值的标志）或字符串（自定义名称或 PR 引用）
  const worktreeOption = isWorktreeModeEnabled() ? options.worktree : undefined

  let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined

  const worktreeEnabled = worktreeOption !== undefined

  // 检查 worktree 名称是否是 PR 引用（#N 或 GitHub PR URL）
  let worktreePRNumber: number | undefined

  if (worktreeName) {
    const prNum = parsePRReference(worktreeName)
    if (prNum !== null) {
      worktreePRNumber = prNum
      worktreeName = undefined // slug will be generated in setup()
    }
  }

  // 提取 tmux 选项（需要 --worktree）
  const tmuxEnabled = isWorktreeModeEnabled() && options.tmux === true

  // 验证 tmux 选项
  if (tmuxEnabled) {
    if (!worktreeEnabled) {
      process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'))
      process.exit(1)
    }
    if (getPlatform() === 'windows') {
      process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'))
      process.exit(1)
    }
    if (!(await isTmuxAvailable())) {
      process.stderr.write(
        chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`),
      )
      process.exit(1)
    }
  }

  // 提取队友选项（用于 tmux 生成的代理）
  // 在 if 块外声明，以便稍后可用于系统提示附录
  let storedTeammateOpts: TeammateOptions | undefined

  if (isAgentSwarmsEnabled()) {
    // 提取代理身份选项（用于 tmux 生成的代理）
    // 这些替换了 ZY_CODE_* 环境变量
    const teammateOpts = extractTeammateOptions(options)
    storedTeammateOpts = teammateOpts

    // 如果提供了任何队友身份选项，则必须提供所有三个必需的选项
    const hasAnyTeammateOpt =
      teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName
    const hasAllRequiredTeammateOpts =
      teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName
    if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
      process.stderr.write(
        chalk.red(
          'Error: --agent-id, --agent-name, and --team-name must all be provided together\n',
        ),
      )
      process.exit(1)
    }

    // 如果通过 CLI 提供了队友身份，则设置 dynamicTeamContext
    if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
      getTeammateUtils().setDynamicTeamContext?.({
        agentId: teammateOpts.agentId,
        agentName: teammateOpts.agentName,
        teamName: teammateOpts.teamName,
        color: teammateOpts.agentColor,
        planModeRequired: teammateOpts.planModeRequired ?? false,
        parentSessionId: teammateOpts.parentSessionId,
      })
    }

    // 如果提供了队友模式 CLI 覆盖，则设置
    // 这必须在 setup() 捕获快照之前完成
    if (teammateOpts.teammateMode) {
      getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode)
    }
  }

  // 提取远程 SDK 选项
  const sdkUrl = options.sdkUrl ?? undefined

  // 允许环境变量启用部分消息（用于沙箱网关的 baku）
  const effectiveIncludePartialMessages =
    includePartialMessages || isEnvTruthy(process.env.ZY_CODE_INCLUDE_PARTIAL_MESSAGES)

  // 通过 SDK 选项明确要求时启用所有钩子事件类型
  // 或在 ZY_CODE_REMOTE 模式下运行时（CCR 需要它们）。
  // 否则，只发射 SessionStart 和 Setup 事件。
  if (includeHookEvents || isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
    setAllHookEventsEnabled(true)
  }

  // 当提供 SDK URL 时自动设置输入/输出格式、详细模式和打印模式
  if (sdkUrl) {
    // 如果提供了 SDK URL，自动使用 stream-json 格式，除非明确设置
    if (!inputFormat) {
      inputFormat = 'stream-json'
    }
    if (!outputFormat) {
      outputFormat = 'stream-json'
    }
    // 自动启用详细模式，除非明确禁用或已设置
    if (options.verbose === undefined) {
      verbose = true
    }
    // 自动启用打印模式，除非明确禁用
    if (!options.print) {
      print = true
    }
  }

  // 提取 teleport 选项
  const teleport = options.teleport ?? null

  // 提取 remote 选项（如果没有提供描述可以为 true，或为字符串）
  const remoteOption = options.remote

  const remote = remoteOption === true ? '' : (remoteOption ?? null)

  // 提取 --remote-control / --rc 标志（在交互会话中启用桥接）
  const remoteControlOption = options.remoteControl ?? options.rc

  // 实际的桥接检查延迟到 showSetupScreens() 之后，以便
  // 建立信任且 GrowthBook 有认证头。
  const remoteControl = false

  const remoteControlName =
    typeof remoteControlOption === 'string' && remoteControlOption.length > 0
      ? remoteControlOption
      : undefined

  // 如果提供了会话 ID，则验证它
  if (sessionId) {
    // 检查冲突的标志
    // --session-id 可以与 --continue 或 --resume 一起使用，当同时提供了 --fork-session 时
    //（用于指定叉会话的自定义 ID）
    if ((options.continue || options.resume) && !options.forkSession) {
      process.stderr.write(
        chalk.red(
          'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
        ),
      )
      process.exit(1)
    }

    // 当提供 --sdk-url 时（桥接/远程模式），会话 ID 是
    // 服务器分配的标记 ID（例如 "session_local_01..."）而不是
    // UUID。跳过 UUID 验证和本地存在性检查。
    if (!sdkUrl) {
      const validatedSessionId = validateUuid(sessionId)
      if (!validatedSessionId) {
        process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'))
        process.exit(1)
      }

      // 检查会话 ID 是否已存在
      if (sessionIdExists(validatedSessionId)) {
        process.stderr.write(
          chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`),
        )
        process.exit(1)
      }
    }
  }

  // 如果通过 --file 标志指定了文件资源，则下载它们
  const fileSpecs = options.file

  if (fileSpecs && fileSpecs.length > 0) {
    // 获取会话入口令牌（由 EnvManager 通过 ZY_CODE_SESSION_ACCESS_TOKEN 提供）
    const sessionToken = getSessionIngressAuthToken()
    if (!sessionToken) {
      process.stderr.write(
        chalk.red(
          'Error: Session token required for file downloads. ZY_CODE_SESSION_ACCESS_TOKEN must be set.\n',
        ),
      )
      process.exit(1)
    }

    // 解析会话 ID：优先使用远程会话 ID，回退到内部会话 ID
    const fileSessionId = process.env.ZY_CODE_REMOTE_SESSION_ID || getSessionId()
    const files = parseFileSpecs(fileSpecs)
    if (files.length > 0) {
      // 如果设置了 ZY_CODE_BASE_URL（由 EnvManager 设置），否则使用 OAuth 配置
      // 这确保在所有环境中与会话入口 API 保持一致
      const config: FilesApiConfig = {
        baseUrl: process.env.ZY_CODE_BASE_URL || getOauthConfig().BASE_API_URL,
        oauthToken: sessionToken,
        sessionId: fileSessionId,
      }

      // 开始下载而不阻塞启动 —— 在 REPL 渲染之前等待
      fileDownloadPromise = downloadSessionFiles(files, config)
    }
  }

  // 从状态获取 isNonInteractiveSession（在 init() 之前设置）
  const isNonInteractiveSession = getIsNonInteractiveSession()

  // 验证回退模型与主模型不同
  if (fallbackModel && options.model && fallbackModel === options.model) {
    process.stderr.write(
      chalk.red(
        'Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n',
      ),
    )
    process.exit(1)
  }

  // 处理系统提示选项
  let systemPrompt = options.systemPrompt

  if (options.systemPromptFile) {
    if (options.systemPrompt) {
      process.stderr.write(
        chalk.red(
          'Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n',
        ),
      )
      process.exit(1)
    }
    try {
      const filePath = resolve(options.systemPromptFile)
      systemPrompt = readFileSync(filePath, 'utf8')
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        process.stderr.write(
          chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`),
        )
        process.exit(1)
      }
      process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`))
      process.exit(1)
    }
  }

  // 处理附加系统提示选项
  let appendSystemPrompt = options.appendSystemPrompt

  if (options.appendSystemPromptFile) {
    if (options.appendSystemPrompt) {
      process.stderr.write(
        chalk.red(
          'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n',
        ),
      )
      process.exit(1)
    }
    try {
      const filePath = resolve(options.appendSystemPromptFile)
      appendSystemPrompt = readFileSync(filePath, 'utf8')
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        process.stderr.write(
          chalk.red(
            `Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`,
          ),
        )
        process.exit(1)
      }
      process.stderr.write(
        chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }
  }

  // 为 tmux 队友添加队友特定的系统提示附录
  if (
    isAgentSwarmsEnabled() &&
    storedTeammateOpts?.agentId &&
    storedTeammateOpts?.agentName &&
    storedTeammateOpts?.teamName
  ) {
    const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM
    appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum
  }

  const { mode: permissionMode, notification: permissionModeNotification } =
    initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions,
    })

  // 存储会话绕过权限模式以进行信任对话框检查
  setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions')

  // autoModeFlagCli 是"用户本次会话是否打算使用 auto"的信号。
  // 当以下情况时设置：--enable-auto-mode、--permission-mode auto、解析的
  // 模式是 auto，或设置 defaultMode 是 auto 但门拒绝它
  //（permissionMode 解析为默认，没有明确的 CLI 覆盖）。
  // 由 verifyAutoModeGateAccess 决定是否在
  // auto-unavailable 时通知，以及由 zy_auto_mode_config opt-in carousel 使用。
  if (
    options.enableAutoMode ||
    permissionModeCli === 'auto' ||
    permissionMode === 'auto' ||
    (!permissionModeCli && isDefaultPermissionModeAuto())
  ) {
    setAutoModeFlagCli(true)
  }

  // 如果提供了 MCP 配置文件/字符串，则解析它们
  let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {}

  if (mcpConfig && mcpConfig.length > 0) {
    // 处理 mcpConfig 数组
    const processedConfigs = mcpConfig
      .map((config: string) => config.trim())
      .filter((config: string) => config.length > 0)
    let allConfigs: Record<string, McpServerConfig> = {}
    const allErrors: ValidationError[] = []
    for (const configItem of processedConfigs) {
      let configs: Record<string, McpServerConfig> | null = null
      let errors: ValidationError[] = []

      // 首先尝试解析为 JSON 字符串
      const parsedJson = safeParseJSON(configItem)
      if (parsedJson) {
        const result = parseMcpConfig({
          configObject: parsedJson,
          filePath: 'command line',
          expandVars: true,
          scope: 'dynamic',
        })
        if (result.config) {
          configs = result.config.mcpServers
        } else {
          errors = result.errors
        }
      } else {
        // 尝试作为文件路径
        const configPath = resolve(configItem)
        const result = parseMcpConfigFromFilePath({
          filePath: configPath,
          expandVars: true,
          scope: 'dynamic',
        })
        if (result.config) {
          configs = result.config.mcpServers
        } else {
          errors = result.errors
        }
      }
      if (errors.length > 0) {
        allErrors.push(...errors)
      } else if (configs) {
        // 合并配置，后面的覆盖前面的
        allConfigs = {
          ...allConfigs,
          ...configs,
        }
      }
    }
    if (allErrors.length > 0) {
      const formattedErrors = allErrors
        .map((err) => `${err.path ? `${err.path}: ` : ''}${err.message}`)
        .join('\n')
      logForDebugging(
        `--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`,
        {
          level: 'error',
        },
      )
      process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`)
      process.exit(1)
    }
    if (Object.keys(allConfigs).length > 0) {
      // SDK 主机（Nest/Desktop）拥有自己的服务器命名权，并且可以重用
      // 内置名称 —— 跳过 type:'sdk' 的保留名称检查。
      const nonSdkConfigNames = Object.entries(allConfigs)
        .filter(([, config]) => config.type !== 'sdk')
        .map(([name]) => name)
      let reservedNameError: string | null = null
      if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
        reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`
      } else if (feature('CHICAGO_MCP')) {
        const { isComputerUseMCPServer, COMPUTER_USE_MCP_SERVER_NAME } = await import(
          'src/services/computer-use/common.js'
        )
        if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
          reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`
        }
      }
      if (reservedNameError) {
        // stderr+exit(1) — a throw here becomes a silent unhandled
        // rejection in stream-json mode (void main() in cli.tsx).
        process.stderr.write(`Error: ${reservedNameError}\n`)
        process.exit(1)
      }

      // 向所有配置添加动态范围。type:'sdk' 条目直接传递
      // 不变 —— 它们在下游被提取到 sdkMcpConfigs 中并
      // 传递给 print.ts。Python SDK 依赖此路径（它不在
      // 初始化消息中发送 sdkMcpServers）。在此处丢弃它们会
      // 破坏 Coworker（inc-5122）。策略过滤器下面已经豁免了
      // type:'sdk'，并且没有 SDK 传输时这些条目在 stdin 上是
      // 无效的，所以让它们通过不会有绕过风险。
      const scopedConfigs = mapValues(allConfigs, (config) => ({
        ...config,
        scope: 'dynamic' as const,
      }))

      // 对 --mcp-config 服务器执行托管策略（allowedMcpServers / deniedMcpServers）。
      // 没有这个，CLI 标志会绕过 user/project/local 配置在
      // getZyCodeMcpConfigs 中通过的企业允许列表 —— 调用者将 dynamicMcpConfig
      // 扩展回过滤后的结果之上。在此源处过滤以便所有
      // 下游消费者看到经过策略过滤的集合。
      const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs)
      if (blocked.length > 0) {
        process.stderr.write(
          `Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
        )
      }
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...allowed,
      }
    }
  }

  // 提取 Claude in Chrome 选项并强制 zy.ai 订阅者检查（除非用户是 ant）
  // 存储明确的 CLI 标志以便队友可以继承它
  setChromeFlagOverride(options.chrome)

  const enableClaudeInChrome = shouldEnableClaudeInChrome(options.chrome) && isInternalBuild()

  const autoEnableClaudeInChrome = !enableClaudeInChrome && shouldAutoEnableClaudeInChrome()
  return {
    prompt,
    options,
    kairosEnabled,
    assistantTeamContext,
    debug,
    debugToStderr,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    baseTools,
    allowedTools,
    disallowedTools,
    mcpConfig,
    permissionModeCli,
    addDir,
    fallbackModel,
    betas,
    ide,
    sessionId,
    includeHookEvents,
    includePartialMessages,
    fileDownloadPromise,
    agentsJson,
    agentCli,
    outputFormat,
    inputFormat,
    verbose,
    print,
    init,
    initOnly,
    maintenance,
    disableSlashCommands,
    tasksOption,
    taskListId,
    worktreeOption,
    worktreeName,
    worktreeEnabled,
    worktreePRNumber,
    tmuxEnabled,
    storedTeammateOpts,
    sdkUrl,
    effectiveIncludePartialMessages,
    teleport,
    remoteOption,
    remote,
    remoteControlOption,
    remoteControl,
    remoteControlName,
    fileSpecs,
    isNonInteractiveSession,
    systemPrompt,
    appendSystemPrompt,
    permissionMode,
    permissionModeNotification,
    dynamicMcpConfig,
    enableClaudeInChrome,
    autoEnableClaudeInChrome,
  }
}
