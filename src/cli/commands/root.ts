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
import uniqBy from 'lodash-es/uniqBy.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  setAdditionalDirectoriesForAgentsMd,
  setIsRemoteMode,
  setMainLoopModelOverride,
  setMainThreadAgentType,
} from '../../bootstrap/state.js'
import { maybeActivateBrief } from '../../cli/activate/brief.js'
import { maybeActivateProactive } from '../../cli/activate/proactive.js'
import { pendingAssistantChat, pendingConnect, pendingSSH } from '../../cli/argvDispatch.js'
import { getInputPrompt } from '../../cli/bootstrap/inputPrompt.js'
import { logManagedSettings } from '../../cli/bootstrap/managedSettings.js'
import {
  logSessionTelemetry,
  logStartupTelemetry,
  logTenguInit,
} from '../../cli/bootstrap/telemetry.js'
import {
  assistantModule,
  coordinatorModeModule,
  getAssistant,
  getTeammateModeSnapshot,
  getTeammatePromptAddendum,
  getTeammateUtils,
  kairosGate,
} from '../../cli/lazyModules.js'
import { extractTeammateOptions, type TeammateOptions } from '../../cli/options/teammate.js'
import { filterCommandsForRemoteMode, getCommands } from '../../commands.js'
import { getOauthConfig } from '../../constants/oauth.js'
import type { StatsStore } from '../../context/stats.js'
import { getSystemContext, getUserContext } from '../../context.js'
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
  launchInvalidSettingsDialog,
  launchSnapshotUpdateDialog,
} from '../../dialogLaunchers.js'
import { addToHistory } from '../../history.js'
import type { Root } from '../../ink.js'
import {
  exitWithError,
  exitWithMessage,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from '../../interactiveHelpers.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import {
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
  refreshGrowthBookAfterAuthChange,
} from '../../services/analytics/growthbook.js'
import { fetchBootstrapData } from '../../services/api/bootstrap.js'
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from '../../services/api/filesApi.js'
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from '../../services/claude-in-chrome/prompt.js'
import {
  setupClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from '../../services/claude-in-chrome/setup.js'
import { prefetchAllMcpResources } from '../../services/mcp/client.js'
import type {
  McpSdkServerConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import {
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getUserSpecifiedModelSetting,
  type ModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../services/model/model.js'
import { ensureModelStringsInitialized } from '../../services/model/modelStrings.js'
import { setAutoModeFlagCli } from '../../services/permissions/autoModeState.js'
import { refreshPolicyLimits } from '../../services/policy-limits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remote-managed-settings/index.js'
import { computeInitialTeamContext } from '../../services/swarm/reconnection.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from '../../services/zyAiLimits.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import type { ToolInputJSONSchema } from '../../Tool.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
  isCustomAgent,
  parseAgentsFromJson,
} from '../../tools/AgentTool/loadAgentsDir.js'
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { getTools, loadExternalTools } from '../../tools.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { count, uniq } from '../../utils/array.js'
import { installAsciicastRecorder } from '../../utils/asciicast.js'
import { validateForceLoginOrg } from '../../utils/auth.js'
import { assertMinVersion } from '../../utils/autoUpdater.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../../utils/config.js'
import { loadConversationForResume } from '../../utils/conversationRecovery.js'
import { seedEarlyInput } from '../../utils/earlyInput.js'
import { resolveInitialEffortSetting } from '../../utils/effort.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { refreshExampleCommands } from '../../utils/exampleCommands.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { createSystemMessage, createUserMessage } from '../../utils/messages.js'
import {
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from '../../utils/permissions/permissionSetup.js'
import { getPlatform } from '../../utils/platform.js'
import { cleanupOrphanedPluginVersionsInBackground } from '../../utils/plugins/cacheUtils.js'
import { initializeVersionedPlugins } from '../../utils/plugins/installedPluginsManager.js'
import { getGlobExclusionsForPluginCache } from '../../utils/plugins/orphanedPluginFilter.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { processSessionStartHooks, processSetupHooks } from '../../utils/sessionStart.js'
import { cacheSessionTitle, saveAgentSetting, sessionIdExists } from '../../utils/sessionStorage.js'
import { getInitialSettings, getSettingsWithErrors } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { DEFAULT_TASKS_MODE_TASK_LIST_ID } from '../../utils/tasks.js'
import { validateUuid } from '../../utils/uuid.js'
import { isWorktreeModeEnabled } from '../../utils/worktreeModeEnabled.js'
import {
  dispatchResumeMode,
  launchRemoteSessionRepl,
  launchResumedSessionRepl,
  runAssistantChatMode,
  runDirectConnectMode,
  runHeadlessMode,
  runInteractiveMode,
  runSshMode,
} from '../assembly/index.js'
import type { RootActionOptions } from '../assembly/types.js'

// 插件启动检查现在在 REPL.tsx 中以非阻塞方式处理

import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  isClaudeInChromeMCPServer,
} from 'src/services/claude-in-chrome/common.js'
import { logPermissionContextForAnts } from 'src/services/internalLogging.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getZyCodeMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js'
import { fetchZyAIMcpConfigsIfEligible } from 'src/services/mcp/zyai.js'
import { logContextMetrics } from 'src/utils/api.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionName,
} from 'src/utils/concurrentSessions.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage, getErrnoCode, isENOENT, toError } from 'src/utils/errors.js'
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js'
import { writeToStderr } from 'src/utils/process.js'
import { processResumedConversation } from 'src/utils/sessionRestore.js'
import { plural } from 'src/utils/stringUtils.js'
import {
  type ChannelEntry,
  getInitialMainLoopModel,
  getIsNonInteractiveSession,
  getSessionId,
  getUserMsgOptIn,
  setAllowedChannels,
  setChromeFlagOverride,
  setInitialMainLoopModel,
  setKairosActive,
  setOriginalCwd,
  setSessionBypassPermissionsMode,
  setUserMsgOptIn,
  switchSession,
} from '../../bootstrap/state.js'

// TeleportRepoMismatchDialog、TeleportResumeWrapper 在调用处动态导入
import { createRemoteSessionConfig } from '../../remote/RemoteSessionManager.js'
// teleportWithProgress 在调用处动态导入
import { initializeLspServerManager } from '../../services/lsp/manager.js'
import { shouldEnablePromptSuggestion } from '../../services/prompt-suggestion/promptSuggestion.js'
import { prepareApiRequest } from '../../services/teleport/api.js'
import { type AppState, IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { asSessionId } from '../../types/ids.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from '../../utils/thinking.js'
import { resetUserCache } from '../../utils/user.js'
import {
  getTmuxInstallInstructions,
  isTmuxAvailable,
  parsePRReference,
} from '../../utils/worktree.js'

export async function rootAction(
  prompt: string | undefined,
  options: RootActionOptions,
): Promise<void> {
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
  if (feature('KAIROS') && options.assistant && assistantModule) {
    // --assistant（Agent SDK 守护进程模式）：在
    // isAssistantMode() 在下面运行之前强制锁定。守护进程已经检查过
    // 权限 —— 不要让子进程重新检查 zy_kairos。
    assistantModule.markAssistantForced()
  }
  if (
    feature('KAIROS') &&
    assistantModule?.isAssistantMode() &&
    // 生成的队友共享领导者的 cwd + settings.json，所以
    // isAssistantMode() 对它们也为 true。--agent-id 被设置
    // 意味着我们是一个生成的队友（extractTeammateOptions 在
    // 约 170 行后运行，所以检查原始 commander 选项）—— 不要
    // 重新初始化团队或覆盖 teammateMode/proactive/brief。
    !options.agentId &&
    kairosGate
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
      kairosEnabled =
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        getAssistant().isAssistantForced() || (await (kairosGate as any).isKairosEnabled())
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
  if (feature('BG_SESSIONS') && agentCli) {
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
  let remoteControl = false
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
  if (enableClaudeInChrome) {
    const platform = getPlatform()
    try {
      logEvent('zy_Zy_in_chrome_setup', {
        platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const {
        mcpConfig: chromeMcpConfig,
        allowedTools: chromeMcpTools,
        systemPrompt: chromeSystemPrompt,
      } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }
      allowedTools.push(...chromeMcpTools)
      if (chromeSystemPrompt) {
        appendSystemPrompt = appendSystemPrompt
          ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}`
          : chromeSystemPrompt
      }
    } catch (error) {
      logEvent('zy_Zy_in_chrome_setup_failed', {
        platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logForDebugging(`[Claude in Chrome] Error: ${error}`)
      logError(error)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Failed to run with ZY in Chrome.`)
      process.exit(1)
    }
  } else if (autoEnableClaudeInChrome) {
    try {
      const { mcpConfig: chromeMcpConfig } = setupClaudeInChrome()
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...chromeMcpConfig,
      }
      const hint =
        feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun
          ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
          : CLAUDE_IN_CHROME_SKILL_HINT
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint
    } catch (error) {
      // 静默跳过自动启用的任何错误
      logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`)
    }
  }

  // 提取严格的 MCP 配置标志
  const strictMcpConfig = options.strictMcpConfig || false

  // 检查是否存在企业 MCP 配置。当存在时，只允许包含特殊服务器类型（sdk）的动态 MCP
  // 配置
  if (doesEnterpriseMcpConfigExist()) {
    if (strictMcpConfig) {
      process.stderr.write(
        chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'),
      )
      process.exit(1)
    }

    // 对于 --mcp-config，如果所有服务器都是内部类型（sdk）则允许
    if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
      process.stderr.write(
        chalk.red(
          'You cannot dynamically configure MCP servers when an enterprise MCP config is present',
        ),
      )
      process.exit(1)
    }
  }

  // chicago MCP: guarded Computer Use (app allowlist + frontmost gate +
  // SCContentFilter screenshots). Ant-only, GrowthBook-gated — failures
  // are silent (this is dogfooding). Platform + interactive checks inline
  // so non-macOS / print-mode ants skip the heavy @ant/computer-use-mcp
  // import entirely. gates.js is light (type-only package import).
  //
  // Placed AFTER the enterprise-MCP-config check: that check rejects any
  // dynamicMcpConfig entry with `type !== 'sdk'`, and our config is
  // `type: 'stdio'`. An enterprise-config ant with the GB gate on would
  // otherwise process.exit(1). Chrome has the same latent issue but has
  // shipped without incident; chicago places itself correctly.
  if (feature('CHICAGO_MCP') && getPlatform() === 'macos' && !getIsNonInteractiveSession()) {
    try {
      const { getChicagoEnabled } = await import('src/services/computer-use/gates.js')
      if (getChicagoEnabled()) {
        const { setupComputerUseMCP } = await import('src/services/computer-use/setup.js')
        const { mcpConfig, allowedTools: cuTools } = setupComputerUseMCP()
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...mcpConfig,
        }
        allowedTools.push(...cuTools)
      }
    } catch (error) {
      logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`)
    }
  }

  // 存储额外目录用于 AGENTS.md 加载（由 env var 控制）
  setAdditionalDirectoriesForAgentsMd(addDir)

  // 来自 --channels 标志的通道服务器允许列表 —— 服务器 whose
  // 入站推送通知应注册此会话。选项
  // 在 feature() 块内添加，所以 TS 不知道它
  // 在选项类型上 —— 与 main.tsx:1824 处的 --assistant 相同模式。
  // devChannels 延迟：showSetupScreens 显示确认对话框
  // 并且只在接受时附加到 allowedChannels。
  let devChannels: ChannelEntry[] | undefined
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    // Parse plugin:name@marketplace / server:Y tags into typed entries.
    // Tag 决定下游信任模型：plugin-kind 命中市场
    // 验证 + GrowthBook 允许列表，server-kind 总是失败
    // 允许列表（schema 仅适用于插件），除非设置了 dev 标志。
    // 未标记或没有 marketpalce 的插件条目是硬错误 ——
    // 在门中静默不匹配看起来像通道
    // "开启" 但什么都不触发。
    const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
      const entries: ChannelEntry[] = []
      const bad: string[] = []
      for (const c of raw) {
        if (c.startsWith('plugin:')) {
          const rest = c.slice(7)
          const at = rest.indexOf('@')
          if (at <= 0 || at === rest.length - 1) {
            bad.push(c)
          } else {
            entries.push({
              kind: 'plugin',
              name: rest.slice(0, at),
              marketplace: rest.slice(at + 1),
            })
          }
        } else if (c.startsWith('server:') && c.length > 7) {
          entries.push({
            kind: 'server',
            name: c.slice(7),
          })
        } else {
          bad.push(c)
        }
      }
      if (bad.length > 0) {
        process.stderr.write(
          chalk.red(
            `${flag} entries must be tagged: ${bad.join(', ')}\n` +
              `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` +
              `  server:<name>                — manually configured MCP server\n`,
          ),
        )
        process.exit(1)
      }
      return entries
    }
    const rawChannels = options.channels
    const rawDev = options.dangerouslyLoadDevelopmentChannels
    // 始终解析 + 设置。ChannelsNotice 读取 getAllowedChannels() 并
    // 在启动屏幕中渲染适当的分支（disabled/noAuth/policyBlocked/
    // listening）。gateChannelServer() 强制执行。
    // --channels 在交互和打印/SDK 模式中都有效；dev-channels
    // 保持仅限交互模式（需要确认对话框）。
    let channelEntries: ChannelEntry[] = []
    if (rawChannels && rawChannels.length > 0) {
      channelEntries = parseChannelEntries(rawChannels, '--channels')
      setAllowedChannels(channelEntries)
    }
    if (!isNonInteractiveSession) {
      if (rawDev && rawDev.length > 0) {
        devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels')
      }
    }
    // 标志使用遥测。记录插件标识符（与
    // zy_plugin_installed 相同层级 —— 公共注册表式名称）；server-kind
    // 不记录（MCP 服务器名称层级，仅在其他地方选择加入）。
    // 每个服务器的门结果进入 zy_mcp_channel_gate 一旦
    // 服务器连接。dev 条目经过确认对话框后
    // —— dev_plugins 捕获输入的内容，而不是接受的内容。
    if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
      const joinPluginIds = (entries: ChannelEntry[]) => {
        const ids = entries.flatMap((e) =>
          e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : [],
        )
        return ids.length > 0
          ? (ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
          : undefined
      }
      logEvent('zy_mcp_channel_flags', {
        channels_count: channelEntries.length,
        dev_count: devChannels?.length ?? 0,
        plugins: joinPluginIds(channelEntries),
        dev_plugins: joinPluginIds(devChannels ?? []),
      })
    }
  }

  // SDK 通过 --tools 选择启用 SendUserMessage。所有会话都需要
  // 明确选择；在 --tools 中列出它表示意图。运行在
  // initializeToolPermissionContext 之前，以便 getToolsForDefaultPreset() 在计算基础工具不允许过滤器时
  // 看到该工具已启用。
  // 条件导入避免将工具名称字符串泄漏到
  // 外部构建中。
  if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } =
      require('../../tools/BriefTool/prompt.js') as typeof import('../../tools/BriefTool/prompt.js')
    const { isBriefEntitled } =
      require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const parsed = parseToolListFromCLI(baseTools)
    if (
      (parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) &&
      isBriefEntitled()
    ) {
      setUserMsgOptIn(true)
    }
  }

  // 此 await 替换了启动路径中已有的阻塞 existsSync/statSync 调用。
  // 挂钟时间不变；我们只是在 fs I/O 期间让出事件循环
  // 而不是阻塞它。参见 #19661。
  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: allowedTools,
    disallowedToolsCli: disallowedTools,
    baseToolsCli: baseTools,
    permissionMode,
    allowDangerouslySkipPermissions,
    addDirs: addDir,
  })
  let toolPermissionContext = initResult.toolPermissionContext
  const { warnings, dangerousPermissions, overlyBroadBashPermissions } = initResult

  // 为 ant 用户处理过于宽泛的 shell 允许规则（Bash(*)、PowerShell(*)）
  if (isInternalBuild() && overlyBroadBashPermissions.length > 0) {
    for (const permission of overlyBroadBashPermissions) {
      logForDebugging(
        `Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`,
      )
    }
    toolPermissionContext = removeDangerousPermissions(
      toolPermissionContext,
      overlyBroadBashPermissions,
    )
  }
  if (dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext)
  }

  // 打印初始化中的任何警告
  warnings.forEach((warning) => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(warning)
  })
  void assertMinVersion()

  // zy.ai 配置获取：仅 -p 模式（交互使用 useManageMCPConnections
  // 两阶段加载）。在这里启动以便与 setup() 重叠；在
  // runHeadless 之前等待，以便单次 -p 看到连接器。在
  // 企业/严格 MCP 下跳过以保留策略边界。
  const zyaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> =
    isNonInteractiveSession &&
    !strictMcpConfig &&
    !doesEnterpriseMcpConfigExist() &&
    // --bare / SIMPLE：跳过 zy.ai 代理服务器（datadog、Gmail、
    // Slack、BigQuery、PubMed —— 每个连接 6-14 秒）。需要 MCP 的脚本化调用
    // 显式传递 --mcp-config。
    !isBareMode()
      ? fetchZyAIMcpConfigsIfEligible().then((configs) => {
          const { allowed, blocked } = filterMcpServersByPolicy(configs)
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: zy.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            )
          }
          return allowed
        })
      : Promise.resolve({})

  // 早期启动 MCP 配置加载（安全 —— 仅读取文件，不执行）。
  // 交互和 -p 都使用 getZyCodeMcpConfigs（仅本地文件读取）。
  // 本地 promise 稍后等待（在 prefetchAllMcpResources 之前）以便
  // 与 setup()、命令加载和信任对话框重叠配置 I/O。
  logForDebugging('[STARTUP] Loading MCP configs...')
  const mcpConfigStart = Date.now()
  let mcpConfigResolvedMs: number | undefined
  // --bare 跳过自动发现的 MCP（.mcp.json、用户设置、插件）——
  // 只有显式的 --mcp-config 有效。dynamicMcpConfig 在下游
  // 扩展到 allMcpConfigs 上，所以它在此跳过后仍然存在。
  const mcpConfigPromise = (
    strictMcpConfig || isBareMode()
      ? Promise.resolve({
          servers: {} as Record<string, ScopedMcpServerConfig>,
        })
      : getZyCodeMcpConfigs(dynamicMcpConfig)
  ).then((result) => {
    mcpConfigResolvedMs = Date.now() - mcpConfigStart
    return result
  })

  // NOTE: We do NOT call prefetchAllMcpResources here - that's deferred until after trust dialog

  if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: Invalid input format "${inputFormat}".`)
    process.exit(1)
  }
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(`Error: --input-format=stream-json requires output-format=stream-json.`)
    process.exit(1)
  }

  // 验证 sdkUrl 仅与适当的格式一起使用（格式在上面自动设置）
  if (sdkUrl) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 replayUserMessages 仅与 stream-json 格式一起使用
  if (options.replayUserMessages) {
    if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 includePartialMessages 仅与打印模式和 stream-json 输出一起使用
  if (effectiveIncludePartialMessages) {
    if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
      writeToStderr(
        `Error: --include-partial-messages requires --print and --output-format=stream-json.`,
      )
      process.exit(1)
    }
  }

  // 验证 --no-session-persistence 仅与打印模式一起使用
  if (options.sessionPersistence === false && !isNonInteractiveSession) {
    writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`)
    process.exit(1)
  }
  const effectivePrompt = prompt || ''
  let inputPrompt = await getInputPrompt(
    effectivePrompt,
    (inputFormat ?? 'text') as 'text' | 'stream-json',
  )

  profileCheckpoint('action_after_input_prompt')

  // 在 getTools() 之前激活主动模式，以便 SleepTool.isEnabled()
  //（返回 isProactiveActive()）通过并包含 Sleep。
  // 稍后 REPL 路径的 maybeActivateProactive() 调用是幂等的。
  maybeActivateProactive(options)
  await loadExternalTools()
  let tools = getTools(toolPermissionContext)

  // 为无头路径应用协调器模式工具过滤
  //（镜像 useMergedTools.ts 对 REPL/交互路径的过滤）
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.ZY_CODE_COORDINATOR_MODE)) {
    const { applyCoordinatorToolFilter } = await import('../../utils/toolPool.js')
    tools = applyCoordinatorToolFilter(tools)
  }
  profileCheckpoint('action_tools_loaded')
  let jsonSchema: ToolInputJSONSchema | undefined
  if (
    isSyntheticOutputToolEnabled({
      isNonInteractiveSession,
    }) &&
    options.jsonSchema
  ) {
    jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema
  }
  if (jsonSchema) {
    const syntheticOutputResult = createSyntheticOutputTool(jsonSchema)
    if ('tool' in syntheticOutputResult) {
      // 在 getTools() 过滤之后将 SyntheticOutputTool 添加到工具数组。
      // 此工具从正常过滤中排除（参见 tools.ts），因为它是
      // 结构化输出的实现细节，不是用户控制的工具。
      tools = [...tools, syntheticOutputResult.tool]
      logEvent('zy_structured_output_enabled', {
        schema_property_count: Object.keys((jsonSchema.properties as Record<string, unknown>) || {})
          .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_required_fields: Boolean(
          jsonSchema.required,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    } else {
      logEvent('zy_structured_output_failure', {
        error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // 重要：setup() 必须在任何其他依赖 cwd 或 worktree 设置的代码之前调用

  profileCheckpoint('action_before_setup')
  logForDebugging('[STARTUP] Running setup()...')
  const setupStart = Date.now()
  const { setup } = await import('../../setup.js')
  const messagingSocketPath = feature('UDS_INBOX') ? options.messagingSocketPath : undefined
  // 并行化 setup() 与命令+代理加载。setup() 的约 28ms 主要是
  // startUdsMessaging（socket 绑定，约 20ms）—— 不是磁盘绑定的，所以它
  // 不与 getCommands 的文件读取竞争。在 !worktreeEnabled 门控，
  // 因为 --worktree 使 setup() 执行 process.chdir()（setup.ts:203），
  // 而命令/代理需要 post-chdir 的 cwd。
  const preSetupCwd = getCwd()
  // 在启动 getCommands() 之前注册捆绑的技能/插件 —— 它们是
  // 纯内存数组推送（<1ms，零 I/O），getBundledSkills()
  // 同步读取。之前在 setup() 中运行，在约 20ms 的
  // await 点之后，所以并行的 getCommands() 缓存了一个空列表。
  if (process.env.ZY_CODE_ENTRYPOINT !== 'local-agent') {
    initBuiltinPlugins()
    initBundledSkills()
  }
  const setupPromise = setup(
    preSetupCwd,
    permissionMode,
    allowDangerouslySkipPermissions,
    worktreeEnabled,
    worktreeName,
    tmuxEnabled,
    sessionId ? validateUuid(sessionId) : undefined,
    worktreePRNumber,
    messagingSocketPath,
  )
  const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)
  const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd)
  // 如果这些在下方约 28ms setupPromise await 期间拒绝，
  // 在 Promise.all 连接它们之前抑制瞬态 unhandledRejection。
  commandsPromise?.catch(() => {})
  agentDefsPromise?.catch(() => {})
  await setupPromise
  logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`)

  profileCheckpoint('action_after_setup')

  // 仅在显式请求 socket 时才将用户消息重放到 stream-json。
  // 自动生成的 socket 是被动的 —— 它让工具在想要时注入，
  // 但默认开启会为从未使用它的 SDK 消费者重塑 stream-json。
  // 注入并希望在流中看到这些注入的调用者
  // 显式传递 --messaging-socket-path（或 --replay-user-messages）。
  let effectiveReplayUserMessages = !!options.replayUserMessages
  if (feature('UDS_INBOX')) {
    if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
      effectiveReplayUserMessages = !!options.messagingSocketPath
    }
  }
  if (getIsNonInteractiveSession()) {
    // 现在应用完全合并的设置 env（包括项目范围的
    // .zy/settings.json PATH/GIT_DIR/GIT_WORK_TREE）以便 gitExe() 和
    // 下方的 git 生成看到它。信任在 -p 模式中是隐式的；
    // managedEnv.ts:96-97 的文档字符串说这应用了"潜在的
    // 危险环境变量如 LD_PRELOAD、PATH"来自所有
    // 来源。下方 isNonInteractiveSession 块中的后续调用
    // 是幂等的（Object.assign，configureGlobalAgents 弹出先前的
    // 拦截器）并选择插件贡献的 env 在插件
    // 初始化之后。项目设置已经在此加载：
    // init() 中的 applySafeConfigEnvironmentVariables 调用了
    // managedEnv.ts:86 的 getInitialSettings，它合并了所有启用的
    // 源，包括 projectSettings/localSettings。
    applyConfigEnvironmentVariables()

    // 现在生成 git status/log/branch 子进程，以便子进程执行与
    // 下方的 getCommands await 和 startDeferredPrefetches 重叠。在
    // setup() 之后，以便 cwd 是最终的（setup.ts:254 对于 --worktree 可能
    // process.chdir(worktreePath)），并在上面的 applyConfigEnvironmentVariables
    // 之后以便应用所有来源的 PATH/GIT_DIR/GIT_WORK_TREE（受信任 + 项目）。
    // getSystemContext 是缓存的；startDeferredPrefetches 中的
    // prefetchSystemContextIfSafe 调用变成缓存命中。await getIsGit()
    // 的微任务在 getCommands Promise.all await 下方排空。
    // 信任在 -p 模式中是隐式的（与 prefetchSystemContextIfSafe 相同的门控）。
    void getSystemContext()
    // 现在也启动 getUserContext —— 它的首次 await（getMemoryFiles
    // 中的 fs.readFile）自然让出，所以 AGENTS.md 目录遍历
    // 在 context Promise.all 连接之前约 280ms 的重叠窗口中运行。
    // startDeferredPrefetches 中的 void getUserContext() 变成缓存命中。
    void getUserContext()
    // 现在启动 ensureModelStringsInitialized —— 对于 Bedrock 这会触发
    // 100-200ms 的配置获取，之前在 print.ts:739 串行等待。
    // updateBedrockModelStrings 是 sequential() 包装的，所以
    // await 连接进行中的获取。非 Bedrock 是同步
    // 提前返回（零成本）。
    void ensureModelStringsInitialized()
  }

  // 应用 --name：仅缓存，以便在
  // 会话 ID 最终通过 --continue/--resume 确定之前不创建孤立文件。
  // materializeSessionFile 在首次用户消息时持久化它；
  // REPL 的 useTerminalTitle 通过 getCurrentSessionTitle 读取它。
  const sessionNameArg = options.name?.trim()
  if (sessionNameArg) {
    cacheSessionTitle(sessionNameArg)
  }

  // Ant 模型别名（capybara-fast 等）通过
  // zy_ant_model_override GrowthBook 标志解析。_CACHED_MAY_BE_STALE
  // 同步读取磁盘；磁盘由 fire-and-forget 写入填充。在
  // 冷缓存上，parseUserSpecifiedModel 返回未解析的别名，
  // API 404，并且 -p 在异步写入落地之前退出 —— 新鲜 pod 上崩溃循环。
  // 在此等待 init 填充 _CACHED_MAY_BE_STALE 现在首先检查的内存负载映射。
  // 门控以便温暖路径保持非阻塞：
  //  - 通过 --model 或 ZY_CODE_MODEL 显式指定模型（两者都馈入别名解析）
  //  - 没有 env 覆盖（它在磁盘之前在 _CACHED_MAY_BE_STALE 之前短路）
  //  - 标志在磁盘上不存在（== null 也捕获 pre-#22279 中毒的 null）
  const explicitModel = options.model || process.env.ZY_CODE_MODEL
  if (
    isInternalBuild() &&
    explicitModel &&
    explicitModel !== 'default' &&
    !hasGrowthBookEnvOverride('zy_ant_model_override') &&
    getGlobalConfig().cachedGrowthBookFeatures?.zy_ant_model_override == null
  ) {
    await initializeGrowthBook()
  }

  // 用 null 关键字特殊处理默认模型
  // NOTE: Model resolution happens after setup() to ensure trust is established before AWS auth
  const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model
  const userSpecifiedFallbackModel =
    fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel

  // 重用 preSetupCwd，除非 setup() chdir'd（worktreeEnabled）。
  // 在常见路径中节省一个 getCwd() 系统调用。
  const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd
  logForDebugging('[STARTUP] Loading commands and agents...')
  const commandsStart = Date.now()
  // 连接在 setup() 之前启动的 promises（或者如果
  // worktreeEnabled 门控了早期启动则重新开始）。两者都按 cwd 缓存。
  const [commands, agentDefinitionsResult] = await Promise.all([
    commandsPromise ?? getCommands(currentCwd),
    agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
  ])
  logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`)

  profileCheckpoint('action_commands_loaded')

  // 如果通过 --agents 标志提供了 CLI 代理，则解析它们
  let cliAgents: typeof agentDefinitionsResult.activeAgents = []
  if (agentsJson) {
    try {
      const parsedAgents = safeParseJSON(agentsJson)
      if (parsedAgents) {
        cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings')
      }
    } catch (error) {
      logError(error)
    }
  }

  // 将 CLI 代理与现有的合并
  const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents]
  const agentDefinitions = {
    ...agentDefinitionsResult,
    allAgents,
    activeAgents: getActiveAgentsFromList(allAgents),
  }

  // 从 CLI 标志或设置查找主线程代理
  const agentSetting = agentCli ?? getInitialSettings().agent
  let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined
  if (agentSetting) {
    mainThreadAgentDefinition = agentDefinitions.activeAgents.find(
      (agent) => agent.agentType === agentSetting,
    )
    if (!mainThreadAgentDefinition) {
      logForDebugging(
        `Warning: agent "${agentSetting}" not found. ` +
          `Available agents: ${agentDefinitions.activeAgents.map((a) => a.agentType).join(', ')}. ` +
          `Using default behavior.`,
      )
    }
  }

  // 将主线程代理类型存储在引导状态中，以便钩子可以访问它
  setMainThreadAgentType(mainThreadAgentDefinition?.agentType)

  // 记录代理标志使用情况 —— 仅为内置代理记录代理名称，以避免泄露自定义代理名称
  if (mainThreadAgentDefinition) {
    logEvent('zy_agent_flag', {
      agentType: isBuiltInAgent(mainThreadAgentDefinition)
        ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
      ...(agentCli && {
        source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }

  // 将代理设置持久化到会话转录中，以便恢复视图显示和恢复
  if (mainThreadAgentDefinition?.agentType) {
    saveAgentSetting(mainThreadAgentDefinition.agentType)
  }

  // 为非交互会话应用代理的系统提示
  //（交互模式使用 buildEffectiveSystemPrompt）
  if (
    isNonInteractiveSession &&
    mainThreadAgentDefinition &&
    !systemPrompt &&
    !isBuiltInAgent(mainThreadAgentDefinition)
  ) {
    const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt()
    if (agentSystemPrompt) {
      systemPrompt = agentSystemPrompt
    }
  }

  // initialPrompt 放在前面以便其斜杠命令（如果有）被处理；
  // 用户提供的文本变成尾部上下文。
  // 仅在 inputPrompt 是字符串时连接。当它是
  // AsyncIterable（SDK stream-json 模式）时，模板插值会
  // 调用 .toString() 产生 "[object Object]"。AsyncIterable 情况
  // 在 print.ts 中通过 structuredIO.prependUserMessage() 处理。
  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof inputPrompt === 'string') {
      inputPrompt = inputPrompt
        ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}`
        : mainThreadAgentDefinition.initialPrompt
    } else if (!inputPrompt) {
      inputPrompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  // 早期计算有效模型，以便钩子可以与 MCP 并行运行
  // 如果用户没有指定模型但代理有一个，使用代理的模型
  let effectiveModel = userSpecifiedModel
  if (
    !effectiveModel &&
    mainThreadAgentDefinition?.model &&
    mainThreadAgentDefinition.model !== 'inherit'
  ) {
    effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model)
  }
  setMainLoopModelOverride(effectiveModel)

  // 为钩子计算解析的模型（使用启动时用户指定的模型）
  setInitialMainLoopModel(getUserSpecifiedModelSetting() || null)
  const initialMainLoopModel = getInitialMainLoopModel()
  const resolvedInitialModelInput = initialMainLoopModel ?? getDefaultMainLoopModel()
  const resolvedInitialModel = resolvedInitialModelInput
    ? parseUserSpecifiedModel(resolvedInitialModelInput)
    : ''
  // 对于带有 --agent-type 的 tmux 队友，附加自定义代理的提示
  if (
    isAgentSwarmsEnabled() &&
    storedTeammateOpts?.agentId &&
    storedTeammateOpts?.agentName &&
    storedTeammateOpts?.teamName &&
    storedTeammateOpts?.agentType
  ) {
    // 查找自定义代理定义
    const customAgent = agentDefinitions.activeAgents.find(
      (a) => a.agentType === storedTeammateOpts.agentType,
    )
    if (customAgent) {
      // 获取提示 —— 需要处理内置和自定义代理
      let customPrompt: string | undefined
      if (customAgent.source === 'built-in') {
        // 内置代理有接受 toolUseContext 的 getSystemPrompt
        // 我们在这里无法访问完整的 toolUseContext，所以暂时跳过
        logForDebugging(
          `[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`,
        )
      } else {
        // 自定义代理有不接受参数的 getSystemPrompt
        customPrompt = customAgent.getSystemPrompt()
      }

      // 为 tmux 队友记录代理内存加载事件
      if (customAgent.memory) {
        logEvent('zy_agent_memory_loaded', {
          ...(isInternalBuild() && {
            agent_type:
              customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          }),
          scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }
      if (customPrompt) {
        const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`
        appendSystemPrompt = appendSystemPrompt
          ? `${appendSystemPrompt}\n\n${customInstructions}`
          : customInstructions
      }
    } else {
      logForDebugging(
        `[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`,
      )
    }
  }
  maybeActivateBrief(options)
  // defaultView: 'chat' 是持久化的选择加入 —— 检查授权并设置
  // userMsgOptIn 以便工具 + 提示部分激活。仅限交互：
  // defaultView 是显示偏好；SDK 会话没有显示，并且
  // 助手安装程序将 defaultView:'chat' 写入 settings.local.json
  // 否则会泄漏到同一目录中的 --print 会话。
  // 在 maybeActivateBrief() 之后立即运行，以便所有启动选择加入路径触发
  // 在任何 isBriefEnabled() 读取之前（主动提示的
  // briefVisibility）。GB 关闭开关后的持久化 'chat' 会
  // 透传（授权失败）。
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    !getIsNonInteractiveSession() &&
    !getUserMsgOptIn() &&
    getInitialSettings().defaultView === 'chat'
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isBriefEntitled } =
      require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isBriefEntitled()) {
      setUserMsgOptIn(true)
    }
  }
  // 协调器模式有自己的系统提示并过滤掉 Sleep，所以
  // 通用主动提示会告诉它调用它无法访问的工具
  // 并与委托指令冲突。
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    (options.proactive || isEnvTruthy(process.env.ZY_CODE_PROACTIVE)) &&
    !coordinatorModeModule?.isCoordinatorMode()
  ) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const briefVisibility =
      feature('KAIROS') || feature('KAIROS_BRIEF')
        ? (
            require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
          ).isBriefEnabled()
          ? 'Call SendUserMessage at checkpoints to mark where things stand.'
          : 'The user will see any text you output.'
        : 'The user will see any text you output.'
    /* eslint-enable @typescript-eslint/no-require-imports */
    const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${proactivePrompt}`
      : proactivePrompt
  }
  if (feature('KAIROS') && kairosEnabled && assistantModule) {
    const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum()
    appendSystemPrompt = appendSystemPrompt
      ? `${appendSystemPrompt}\n\n${assistantAddendum}`
      : assistantAddendum
  }

  // Ink 根仅在交互会话中需要 —— Ink 构造函数中的
  // patchConsole 会在无头模式下吞掉控制台输出。
  let root!: Root
  let getFpsMetrics!: () => FpsMetrics | undefined
  let stats!: StatsStore

  // 在命令加载后显示设置屏幕
  if (!isNonInteractiveSession) {
    const ctx = getRenderContext(false)
    getFpsMetrics = ctx.getFpsMetrics
    stats = ctx.stats
    // 在 Ink 挂载之前安装 asciicast 录制器（仅限 ant，通过 ZY_CODE_TERMINAL_RECORDING=1 选择加入）
    if (isInternalBuild()) {
      installAsciicastRecorder()
    }

    const { createRoot } = await import('../../ink.js')
    root = await createRoot(ctx.renderOptions)

    // 现在记录启动时间，在任何阻塞对话框渲染之前。从
    // REPL 首次渲染（旧位置）记录包括了用户坐在
    // 信任/OAuth/入门/恢复选择器上的时间 —— p99 约 70s
    // 由对话框等待时间主导，而不是代码路径启动时间。
    logEvent('zy_timer', {
      event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      durationMs: Math.round(process.uptime() * 1000),
    })
    logForDebugging('[STARTUP] Running showSetupScreens()...')

    const setupScreensStart = Date.now()
    const onboardingShown = await showSetupScreens(
      root,
      permissionMode,
      allowDangerouslySkipPermissions,
      commands,
      enableClaudeInChrome,
      devChannels,
    )

    logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`)

    // 现在信任已建立且 GrowthBook 有认证头，
    // 解析 --remote-control / --rc 授权门。
    if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
      const { getWireDisabledReason } = await import('../../bridge/bridgeEnabled.js')
      const disabledReason = await getWireDisabledReason()
      remoteControl = disabledReason === null
      if (disabledReason) {
        process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`))
      }
    }

    // 检查待处理的代理内存快照更新（仅限 --agent 模式，仅限 ant）
    if (
      feature('AGENT_MEMORY_SNAPSHOT') &&
      mainThreadAgentDefinition &&
      isCustomAgent(mainThreadAgentDefinition) &&
      mainThreadAgentDefinition.memory &&
      mainThreadAgentDefinition.pendingSnapshotUpdate
    ) {
      const agentDef = mainThreadAgentDefinition
      const choice = await launchSnapshotUpdateDialog(root, {
        agentType: agentDef.agentType,
        scope: agentDef.memory!,
        snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
      })
      if (choice === 'merge') {
        const {
          // @ts-expect-error
          buildMergePrompt,
        } = await import('../../components/agents/SnapshotUpdateDialog.js')
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        const mergePrompt = (buildMergePrompt as any)(agentDef.agentType, agentDef.memory!)
        inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt
      }
      agentDef.pendingSnapshotUpdate = undefined
    }

    // 如果刚刚完成了入门培训，则跳过执行 /login
    if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
      prompt = ''
    }
    if (onboardingShown) {
      // 现在刷新认证依赖的服务，因为用户在入门培训期间已登录
      // 与 src/commands/login.tsx 中的登录后逻辑保持一致
      void refreshRemoteManagedSettings()
      void refreshPolicyLimits()
      // 在 GrowthBook 刷新之前清除用户数据缓存，以便它获取新鲜凭证
      resetUserCache()
      // 登录后刷新 GrowthBook 以获取更新的功能标志（例如用于 zy.ai MCP）
      refreshGrowthBookAfterAuthChange()
      // 清除任何过时的受信任设备令牌，然后注册远程控制。
      // 两者都在内部通过 zy_sessions_elevated_auth_enforcement 自门控
      // —— enrollTrustedDevice() 通过 checkGate_CACHED_OR_BLOCKING（等待
      // 上方的 GrowthBook 重新初始化），clearTrustedDeviceToken() 通过
      // 同步缓存检查（可接受，因为清除是幂等的）。
      void import('../../bridge/trustedDevice.js').then((m) => {
        m.clearTrustedDeviceToken()
        return m.enrollTrustedDevice()
      })
      // Onboarding 写入了 settings.json（包括 models 和 mainLoopModel），
      // 需要刷新 settings 缓存并重新解析模型。
      resetSettingsCache()
      const postOnboardingModel = getDefaultMainLoopModelSetting()
      setInitialMainLoopModel(postOnboardingModel as ModelSetting)
    }

    // 验证活动令牌的 org 是否匹配 forceLoginOrgUUID（如果在托管设置中设置）。
    // 在入门培训之后运行，以便托管设置和登录状态完全加载。
    const orgValidation = await validateForceLoginOrg()
    if (!orgValidation.valid) {
      // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
      await exitWithError(root, (orgValidation as any).message)
    }
  }

  // 如果启动了 gracefulShutdown（例如用户拒绝了信任对话框），
  // process.exitCode 将被设置。跳过所有可能触发代码执行的后续操作
  // 在进程退出之前（例如插件 LSP、hook 或后台 API 预热）。
  if (process.exitCode !== undefined) {
    logForDebugging('Graceful shutdown initiated, skipping further initialization')
    return
  }

  // 在建立信任后初始化 LSP 管理器（或在非交互模式中
  // 信任是隐式的）。这防止插件 LSP 服务器在用户同意之前
  // 在不可信的目录中执行代码。
  // 必须在设置内联插件之后（如果有）以便 --plugin-dir LSP 服务器被包含。
  initializeLspServerManager()

  // 在建立信任后显示设置验证错误
  // MCP 配置错误不会阻止设置加载，所以排除它们
  if (!isNonInteractiveSession) {
    const { errors } = getSettingsWithErrors()
    const nonMcpErrors = errors.filter((e) => !e.mcpErrorMetadata)
    if (nonMcpErrors.length > 0) {
      await launchInvalidSettingsDialog(root, {
        settingsErrors: nonMcpErrors,
        onExit: () => gracefulShutdownSync(1),
      })
    }
  }

  // 在建立信任后检查配额状态、passes 资格和引导数据。
  // 这些会进行 API 调用，因此放在启动流程后段。
  // --bare / SIMPLE：跳过 —— 这些是 REPL 首次响应性的缓存预热
  //（配额、passes、引导数据）。
  const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('zy_cicada_nap_ms', 0)
  const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0
  const skipStartupPrefetches =
    isBareMode() || (bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs)
  if (!skipStartupPrefetches) {
    const lastPrefetchedInfo =
      lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : ''
    logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`)
    checkQuotaStatus().catch((error) => logError(error))

    // 从服务器获取引导数据并更新所有缓存值。
    void fetchBootstrapData()

    // TODO: Consolidate other prefetches into a single bootstrap request.
    if (bgRefreshThrottleMs > 0) {
      saveGlobalConfig((current) => ({
        ...current,
        startupPrefetchedAt: Date.now(),
      }))
    }
  } else {
    logForDebugging(
      `Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`,
    )
  }
  if (!isNonInteractiveSession) {
    void refreshExampleCommands() // 预取示例命令（运行 git log，无 API 调用）
  }

  // 解析 MCP 配置（早期启动，与 setup/信任对话框工作重叠）
  const { servers: existingMcpConfigs } = await mcpConfigPromise
  logForDebugging(
    `[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`,
  )
  // CLI 标志（--mcp-config）应覆盖基于文件的配置，与设置优先级匹配
  const allMcpConfigs = {
    ...existingMcpConfigs,
    ...dynamicMcpConfig,
  }

  // 将 SDK 配置与普通 MCP 配置分开
  const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {}
  const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(allMcpConfigs)) {
    const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig
    if (typedConfig.type === 'sdk') {
      sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig
    } else {
      regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig
    }
  }

  profileCheckpoint('action_mcp_configs_loaded')

  // 在信任对话框之后预取 MCP 资源（这是执行发生的地方）。
  // 仅限交互模式：打印模式延迟连接直到 headlessStore 存在
  // 并按服务器推送（下方），所以 ToolSearch 的 pending-client 处理有效
  // 且一个慢速服务器不会阻塞批次。
  const localMcpPromise = isNonInteractiveSession
    ? Promise.resolve({
        clients: [],
        tools: [],
        commands: [],
      })
    : prefetchAllMcpResources(regularMcpConfigs)
  const zyaiMcpPromise = isNonInteractiveSession
    ? Promise.resolve({
        clients: [],
        tools: [],
        commands: [],
      })
    : zyaiConfigPromise.then((configs) =>
        Object.keys(configs).length > 0
          ? prefetchAllMcpResources(configs)
          : {
              clients: [],
              tools: [],
              commands: [],
            },
      )
  // 按名称去重合并：每个 prefetchAllMcpResources 调用独立
  // 添加帮助工具（ListMcpResourcesTool、ReadMcpResourceTool）通过
  // 本地去重标志，所以合并两个调用可能产生重复。print.ts
  // 已经对最终工具池进行 uniqBy 处理，但在此去重保持 appState 干净。
  const mcpPromise = Promise.all([localMcpPromise, zyaiMcpPromise]).then(([local, zyai]) => ({
    clients: [...local.clients, ...zyai.clients],
    tools: uniqBy([...local.tools, ...zyai.tools], 'name'),
    commands: uniqBy([...local.commands, ...zyai.commands], 'name'),
  }))

  // 早期启动钩子以便它们与 MCP 连接并行运行。
  // 跳过 initOnly/init/maintenance（单独处理）、非交互
  //（通过 setupTrigger 处理）和 resume/continue（conversationRecovery.ts
  // 改为触发 'resume' —— 没有这个守卫，钩子在 /resume 上触发两次
  // 且第二个 systemMessage 覆盖第一个。gh-30825）
  const hooksPromise =
    initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume
      ? null
      : processSessionStartHooks('startup', {
          agentType: mainThreadAgentDefinition?.agentType,
          model: resolvedInitialModel,
        })

  // MCP 从不阻塞 REPL 渲染或第 1 轮 TTFT。useManageMCPConnections
  // 在服务器连接时异步填充 appState.mcp（connectToServer 是
  // 缓存的 —— 上方的预取调用和钩子汇聚到相同的
  // 连接）。getToolUseContext 通过 computeTools() 新鲜读取 store.getState()，
  // 所以第 1 轮看到查询时已连接的任何内容。
  // 慢速服务器为第 2+ 轮填充。匹配交互无提示
  // 行为。打印模式：按服务器推送到 headlessStore（下方）。
  const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = []
  // 抑制瞬态 unhandledRejection —— 预取预热
  // 缓存的 connectToServer 缓存，但在交互模式下没有人等待它。
  mcpPromise.catch(() => {})
  const mcpClients: Awaited<typeof mcpPromise>['clients'] = []
  const mcpTools: Awaited<typeof mcpPromise>['tools'] = []
  const mcpCommands: Awaited<typeof mcpPromise>['commands'] = []
  let thinkingEnabled = shouldEnableThinkingByDefault(effectiveModel)
  let thinkingConfig: ThinkingConfig = thinkingEnabled
    ? {
        type: 'adaptive',
      }
    : {
        type: 'disabled',
      }
  if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
    thinkingEnabled = true
    thinkingConfig = {
      type: 'adaptive',
    }
  } else if (options.thinking === 'disabled') {
    thinkingEnabled = false
    thinkingConfig = {
      type: 'disabled',
    }
  } else {
    const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
      : options.maxThinkingTokens
    if (maxThinkingTokens !== undefined) {
      if (maxThinkingTokens > 0) {
        thinkingEnabled = true
        thinkingConfig = {
          type: 'enabled',
          budgetTokens: maxThinkingTokens,
        }
      } else if (maxThinkingTokens === 0) {
        thinkingEnabled = false
        thinkingConfig = {
          type: 'disabled',
        }
      }
    }
  }
  logForDiagnosticsNoPII('info', 'started', {
    version: MACRO.VERSION,
    is_native_binary: isInBundledMode(),
  })
  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'exited')
  })
  void logTenguInit({
    hasInitialPrompt: Boolean(prompt),
    hasStdin: Boolean(inputPrompt),
    verbose,
    debug,
    debugToStderr,
    print: !!print,
    outputFormat: outputFormat ?? 'text',
    inputFormat: inputFormat ?? 'text',
    numAllowedTools: allowedTools.length,
    numDisallowedTools: disallowedTools.length,
    mcpClientCount: Object.keys(allMcpConfigs).length,
    worktreeEnabled,
    skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
    githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
    dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
    permissionMode,
    modeIsBypass: permissionMode === 'bypassPermissions',
    allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
    systemPromptFlag: systemPrompt ? (options.systemPromptFile ? 'file' : 'flag') : undefined,
    appendSystemPromptFlag: appendSystemPrompt
      ? options.appendSystemPromptFile
        ? 'file'
        : 'flag'
      : undefined,
    thinkingConfig,
    assistantActivationPath:
      feature('KAIROS') && kairosEnabled
        ? assistantModule?.getAssistantActivationPath()
        : undefined,
    isCoordinator: feature('COORDINATOR_MODE')
      ? (coordinatorModeModule?.isCoordinatorMode() ?? false)
      : false,
  })

  // 初始化时记录一次上下文指标
  void logContextMetrics(regularMcpConfigs, toolPermissionContext)
  void logPermissionContextForAnts(null, 'initialization')
  logManagedSettings()

  // 注册 PID 文件用于并发会话检测（~/.zy/sessions/）
  // 并触发多 clauding 遥测。放在这里（不是 init.ts）以便只有
  // REPL 路径注册 —— 不是 `zy doctor` 等子命令。链式：
  // count 必须在 register 的写入完成后运行，否则它会错过我们自己的文件。
  void registerSession().then((registered) => {
    if (!registered) {
      return
    }
    if (sessionNameArg) {
      void updateSessionName(sessionNameArg)
    }
    void countConcurrentSessions().then((count) => {
      if (count >= 2) {
        logEvent('zy_concurrent_sessions', {
          num_sessions: count,
        })
      }
    })
  })

  // 初始化版本化插件系统（如果需要触发 V1→V2 迁移）。
  // 然后运行孤儿 GC，再预热 Grep/Glob 排除缓存。
  // 顺序很重要：预热扫描磁盘查找 .orphaned_at 标记，
  // 所以它必须看到 GC 的 Pass 1（从重新安装的版本中移除标记）
  // 和 Pass 2（标记未标记的孤儿）已应用。
  // 预热还在自动更新之前落地（在 REPL 中首次提交时触发）
  // 不会在我们下面孤立此会话的活跃版本。
  // --bare / SIMPLE：跳过插件版本同步 + 孤儿清理。这些是
  // 脚本化调用不需要的安装/升级簿记 ——
  // 下次交互会话将协调。此处的 await 之前
  // 阻塞了 -p 在市场往返上。
  if (isBareMode()) {
    // skip — no-op
  } else if (isNonInteractiveSession) {
    // 在无头模式下，等待以确保插件同步在 CLI 退出之前完成
    await initializeVersionedPlugins()
    profileCheckpoint('action_after_plugins_init')
    void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache())
  } else {
    // 在交互模式下，触发后不等待 —— 这纯粹是
    // 不影响当前会话运行时行为的簿记
    void initializeVersionedPlugins().then(async () => {
      profileCheckpoint('action_after_plugins_init')
      await cleanupOrphanedPluginVersionsInBackground()
      void getGlobExclusionsForPluginCache()
    })
  }
  const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null
  if (initOnly) {
    applyConfigEnvironmentVariables()
    await processSetupHooks('init', {
      forceSyncExecution: true,
    })
    await processSessionStartHooks('startup', {
      forceSyncExecution: true,
    })
    gracefulShutdownSync(0)
    return
  }

  // --print 模式
  if (isNonInteractiveSession) {
    await runHeadlessMode({
      inputPrompt,
      options,
      outputFormat,
      verbose,
      jsonSchema,
      tools,
      toolPermissionContext,
      allowDangerouslySkipPermissions,
      allowedTools,
      effectiveModel,
      userSpecifiedFallbackModel,
      thinkingConfig,
      systemPrompt,
      appendSystemPrompt,
      commands,
      disableSlashCommands,
      agentActiveAgents: agentDefinitions.activeAgents,
      agentCli,
      mcpClients,
      mcpCommands,
      mcpTools,
      regularMcpConfigs,
      sdkMcpConfigs,
      zyaiConfigPromise,
      betas,
      sdkUrl,
      teleport,
      effectiveReplayUserMessages,
      effectiveIncludePartialMessages,
      setupTrigger,
      kairosEnabled,
    })
    return
  }

  // 启动时记录模型配置
  logEvent('zy_startup_manual_model_config', {
    cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    env_var: process.env
      .ZY_CODE_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    settings_file: getInitialSettings()
      ?.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // 构建初始通知队列
  const initialNotifications: Array<{
    key: string
    text: string
    color?: 'warning'
    priority: 'high'
  }> = []
  if (permissionModeNotification) {
    initialNotifications.push({
      key: 'permission-mode-notification',
      text: permissionModeNotification,
      priority: 'high',
    })
  }
  if (overlyBroadBashPermissions.length > 0) {
    const displayList = uniq(overlyBroadBashPermissions.map((p) => p.ruleDisplay))
    const displays = displayList.join(', ')
    const sources = uniq(overlyBroadBashPermissions.map((p) => p.sourceDisplay)).join(', ')
    const n = displayList.length
    initialNotifications.push({
      key: 'overly-broad-bash-notification',
      text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
      color: 'warning',
      priority: 'high',
    })
  }
  const effectiveToolPermissionContext = {
    ...toolPermissionContext,
    mode:
      isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired()
        ? ('plan' as const)
        : toolPermissionContext.mode,
  }
  // 所有启动选择加入路径（--tools、--brief、defaultView）已在上方触发；
  // initialIsBriefOnly 仅读取结果状态。
  const initialIsBriefOnly =
    feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false
  const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled
  let ccrMirrorEnabled = false
  if (feature('CCR_MIRROR') && !fullRemoteControl) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isCcrMirrorEnabled } =
      require('../../bridge/bridgeEnabled.js') as typeof import('../../bridge/bridgeEnabled.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    ccrMirrorEnabled = isCcrMirrorEnabled()
  }
  const initialState: AppState = {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: verbose ?? getGlobalConfig().verbose ?? false,
    mainLoopModel: initialMainLoopModel,
    mainLoopModelForSession: null,
    isBriefOnly: initialIsBriefOnly,
    expandedView: getGlobalConfig().showSpinnerTree
      ? 'teammates'
      : getGlobalConfig().showExpandedTodos
        ? 'tasks'
        : 'none',
    showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    toolPermissionContext: effectiveToolPermissionContext,
    agent: mainThreadAgentDefinition?.agentType,
    agentDefinitions,
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    kairosEnabled,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
    replWireExplicit: remoteControl,
    replBridgeOutboundOnly: ccrMirrorEnabled,
    replWireConnected: false,
    replWireSessionActive: false,
    replWireReconnecting: false,
    replWireConnectUrl: undefined,
    replWireSessionUrl: undefined,
    replWireEnvironmentId: undefined,
    replWireSessionId: undefined,
    replWireError: undefined,
    replWireInitialName: remoteControlName,
    showRemoteCallout: false,
    notifications: {
      current: null,
      queue: initialNotifications,
    },
    elicitation: {
      queue: [],
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    thinkingEnabled,
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    authVersion: 0,
    initialMessage: inputPrompt
      ? {
          message: createUserMessage({
            content: [{ type: 'text' as const, text: String(inputPrompt) }],
          }),
        }
      : null,
    effortValue: resolveInitialEffortSetting(options.effort),
    activeOverlays: new Set<string>(),
    // 同步计算 teamContext 以避免渲染期间的 useEffect setState。
    // KAIROS：assistantTeamContext 优先 —— 在
    // KAIROS 块中更早设置，以便 Agent(name: "foo") 可以生成进程内队友
    // 而不需要 TeamCreate。computeInitialTeamContext() 用于 tmux 生成的
    // 队友读取自己的身份，而不是助手模式领导者。
    teamContext: (feature('KAIROS')
      ? (assistantTeamContext ?? computeInitialTeamContext?.())
      : computeInitialTeamContext?.()) as AppState['teamContext'],
  }

  // 将 CLI 初始提示添加到历史记录
  if (inputPrompt) {
    addToHistory(String(inputPrompt))
  }
  const initialTools = mcpTools

  // 同步递增 numStartups，仅延迟遥测。
  saveGlobalConfig((current) => ({
    ...current,
    numStartups: (current.numStartups ?? 0) + 1,
  }))
  setImmediate(() => {
    void logStartupTelemetry()
    logSessionTelemetry()
  })

  // 设置每轮会话环境数据上传器（仅限 ant 构建）。
  // 在 Anthropic 拥有的仓库中工作时为所有 ant 用户默认启用。
  // 在每轮捕获 git/文件系统状态（不是转录），以便
  // 可以在任何用户消息索引处重新创建环境。门控：
  //   - 构建时：此导入在外部构建中是存根。
  //   - 运行时：上传者检查 github.com/anthropics/* 远程 + gcloud 认证。
  //   - 安全：ZY_CODE_DISABLE_SESSION_DATA_UPLOAD=1 绕过（测试设置此）。
  // 导入是动态 + 异步的，以避免增加启动延迟。
  const sessionUploaderPromise = isInternalBuild()
    ? import('../../utils/sessionDataUploader.js')
    : null

  // 将会话上传器解析延迟到 onTurnComplete 回调，以避免
  // 在 main.tsx 中添加新的顶级 await（性能关键路径）。
  // sessionDataUploader.ts 中的每轮认证逻辑优雅地处理未认证
  // 状态（每轮重新检查，所以会话中间的认证恢复有效）。
  const uploaderReady = sessionUploaderPromise
    ? // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
      sessionUploaderPromise.then((mod: any) => mod.createSessionTurnUploader()).catch(() => null)
    : null
  const sessionConfig = {
    debug: debug || debugToStderr,
    commands: [...commands, ...mcpCommands],
    initialTools,
    mcpClients,
    autoConnectIdeFlag: ide,
    mainThreadAgentDefinition,
    disableSlashCommands,
    dynamicMcpConfig,
    strictMcpConfig,
    systemPrompt,
    appendSystemPrompt,
    taskListId,
    thinkingConfig,
    ...(uploaderReady && {
      onTurnComplete: (messages: MessageType[]) => {
        void uploaderReady.then((uploader) => uploader?.(messages))
      },
    }),
  }

  // 用于 processResumedConversation 调用的共享上下文
  const resumeContext = {
    modeApi: coordinatorModeModule,
    mainThreadAgentDefinition,
    agentDefinitions,
    currentCwd,
    cliAgents,
    initialState,
  }
  if (options.continue) {
    // 直接继续最近的对话
    let resumeSucceeded = false
    try {
      const resumeStart = performance.now()

      // 在恢复之前清除过时的缓存，以确保新鲜的文件/技能发现
      const { clearSessionCaches } = await import('../../commands/clear/caches.js')
      clearSessionCaches()
      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* sourceFile */,
      )
      if (!result) {
        logEvent('zy_continue', {
          success: false,
        })
        return await exitWithError(root, 'No conversation found to continue')
      }
      const loaded = await processResumedConversation(
        result,
        {
          forkSession: !!options.forkSession,
          includeAttribution: true,
          transcriptPath: result.fullPath,
        },
        resumeContext,
      )
      if (loaded.restoredAgentDef) {
        mainThreadAgentDefinition = loaded.restoredAgentDef
      }
      maybeActivateProactive(options)
      maybeActivateBrief(options)
      logEvent('zy_continue', {
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart),
      })
      resumeSucceeded = true
      await launchResumedSessionRepl({
        root,
        appProps: { getFpsMetrics, stats, initialState: loaded.initialState },
        renderAndRun,
        sessionConfig,
        resumed: loaded,
        fallbackAgentDefinition: mainThreadAgentDefinition,
      })
    } catch (error) {
      if (!resumeSucceeded) {
        logEvent('zy_continue', {
          success: false,
        })
      }
      logError(error)
      process.exit(1)
    }
  } else if (feature('DIRECT_CONNECT') && pendingConnect?.url) {
    // `zy connect <url>` —— 完整交互式 TUI 连接到远程服务器
    await runDirectConnectMode({
      root,
      appProps: { getFpsMetrics, stats, initialState },
      renderAndRun,
      pendingConnect: { ...pendingConnect, url: pendingConnect.url! },
      config: {
        debug: debug || debugToStderr,
        commands,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        thinkingConfig,
      },
    })
    return
  } else if (feature('SSH_REMOTE') && pendingSSH?.host) {
    // `zy ssh <host> [dir]` —— 探测远程，如果需要则部署二进制文件，
    // 生成带有 unix-socket -R 转发到本地认证代理的 ssh，将
    // SSHSession 交给 REPL。工具在远程运行，UI 在本地渲染。
    await runSshMode({
      root,
      appProps: { getFpsMetrics, stats, initialState },
      renderAndRun,
      pendingSSH: { ...pendingSSH, host: pendingSSH.host! },
      localVersion: MACRO.VERSION,
      config: {
        debug: debug || debugToStderr,
        commands,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        thinkingConfig,
      },
    })
    return
  } else if (
    feature('KAIROS') &&
    pendingAssistantChat &&
    (pendingAssistantChat.sessionId || pendingAssistantChat.discover)
  ) {
    await runAssistantChatMode({
      root,
      renderAndRun,
      getFpsMetrics,
      stats,
      initialState,
      pendingAssistantChat,
      commands,
      debug,
      debugToStderr,
      ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      thinkingConfig,
    })
    return
  } else if (options.resume || options.fromPr || teleport || remote !== null) {
    await dispatchResumeMode({
      root,
      renderAndRun,
      getFpsMetrics,
      stats,
      initialState,
      options,
      sessionConfig,
      resumeContext,
      mainThreadAgentDefinition,
      teleport,
      remote,
      commands,
      debug,
      debugToStderr,
      ide,
      disableSlashCommands,
      thinkingConfig,
      fileDownloadPromise,
    })
  } else {
    await runInteractiveMode({
      root,
      appProps: { getFpsMetrics, stats, initialState },
      renderAndRun,
      sessionConfig,
      options,
      hookMessages,
      hooksPromise,
    })
  }
}
