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
import chalk from 'chalk'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { setMainLoopModelOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import { setMainThreadAgentType } from 'src/bootstrap/runtime/runtimeContext.js'
import { maybeActivateBrief } from '../activate/brief.js'
import { logManagedSettings } from '../bootstrap/managedSettings.js'
import { logTenguInit } from '../bootstrap/telemetry.js'
import { assistantModule, coordinatorModeModule } from '../lazyModules.js'
import type { StatsStore } from '../../context/stats.js'
import { launchInvalidSettingsDialog, launchSnapshotUpdateDialog } from '../../cli/DialogLaunchers.js'
import type { Root } from '../../ink/index.js'
import { exitWithError, getRenderContext, showSetupScreens } from '../../cli/InteractiveHelpers.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { fetchBootstrapData } from '../../services/api/bootstrap.js'
import {
  getDefaultMainLoopModel,
  getDefaultMainLoopModelSetting,
  getUserSpecifiedModelSetting,
  type ModelSetting,
  parseUserSpecifiedModel,
} from '../../services/model/model.js'
import { refreshPolicyLimits } from '../../services/policy-limits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remote-managed-settings/index.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from '../../services/zyAiLimits.js'
import { isBuiltInAgent, isCustomAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { installAsciicastRecorder } from '../../services/shell/asciicast.js'
import { validateForceLoginOrg } from '../../services/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { refreshExampleCommands } from '../../services/hints/exampleCommands.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { logError } from '../../utils/log.js'
import { cleanupOrphanedPluginVersionsInBackground } from '../../services/plugins/cacheUtils.js'
import { initializeVersionedPlugins } from '../../services/plugins/installedPluginsManager.js'
import { getGlobExclusionsForPluginCache } from '../../services/plugins/orphanedPluginFilter.js'
import { processSessionStartHooks } from '../../services/session-storage/sessionStart.js'
import { saveAgentSetting } from '../../services/sessionStorage.js'
import { getInitialSettings, getSettingsWithErrors } from '../../services/settings/settings.js'
import { resetSettingsCache } from '../../services/settings/settingsCache.js'
import { profileCheckpoint } from '../../services/telemetry/startupProfiler.js'
import { logPermissionContextForAnts } from 'src/services/internalLogging.js'
import { logContextMetrics } from 'src/utils/api.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import {
  countConcurrentSessions,
  registerSession,
  updateSessionName,
} from 'src/services/session/concurrentSessions.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import {
  getInitialMainLoopModel,
  setInitialMainLoopModel,
} from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getIsNonInteractiveSession,
  getUserMsgOptIn,
  setUserMsgOptIn,
} from 'src/bootstrap/runtime/runtimeContext.js'
// teleportWithProgress 在调用处动态导入
import { initializeLspServerManager } from '../../services/lsp/manager.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { resetUserCache } from '../../services/auth/user.js'
import {
  appendProactiveModePrompt,
  createMcpPrefetchPromises,
  maybeEnableBriefOptInFromDefaultView,
  resolveThinkingState,
  splitMcpConfigs,
} from './sessionBootConfig.js'
import { RootActionCompleted } from './rootActionPipeline.js'
import { initializeRootRuntime } from './initializeRootRuntime.js'
export async function loadRootResources(
  context: Awaited<ReturnType<typeof initializeRootRuntime>>,
) {
  let {
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
    strictMcpConfig,
    devChannels,
    initResult,
    toolPermissionContext,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions,
    zyaiConfigPromise,
    mcpConfigStart,
    mcpConfigResolvedMs,
    mcpConfigPromise,
    effectivePrompt,
    inputPrompt,
    tools,
    jsonSchema,
    setupStart,
    setup,
    messagingSocketPath,
    preSetupCwd,
    setupPromise,
    commandsPromise,
    agentDefsPromise,
    effectiveReplayUserMessages,
    sessionNameArg,
    explicitModel,
    userSpecifiedModel,
    userSpecifiedFallbackModel,
    currentCwd,
    commandsStart,
    commands,
    agentDefinitionsResult,
    cliAgents,
    allAgents,
    agentDefinitions,
    agentSetting,
    mainThreadAgentDefinition,
  } = context

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
  if (feature('KAIROS')) {
    maybeEnableBriefOptInFromDefaultView()
  } else if (feature('KAIROS_BRIEF')) {
    maybeEnableBriefOptInFromDefaultView()
  }

  // 协调器模式有自己的系统提示并过滤掉 Sleep，所以
  // 通用主动提示会告诉它调用它无法访问的工具
  // 并与委托指令冲突。
  const proactiveRequested = options.proactive || isEnvTruthy(process.env.ZY_CODE_PROACTIVE)
  if (feature('PROACTIVE')) {
    appendSystemPrompt = appendProactiveModePrompt(
      appendSystemPrompt,
      proactiveRequested,
      coordinatorModeModule?.isCoordinatorMode() ?? false,
    )
  } else if (feature('KAIROS')) {
    appendSystemPrompt = appendProactiveModePrompt(
      appendSystemPrompt,
      proactiveRequested,
      coordinatorModeModule?.isCoordinatorMode() ?? false,
    )
  }

  const activeAssistantModule = assistantModule
  if (feature('KAIROS') ? kairosEnabled && activeAssistantModule !== null : false) {
    const assistantAddendum = activeAssistantModule!.getAssistantSystemPromptAddendum()
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

    const { createRoot } = await import('../../ink/index.js')
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
    if (feature('BRIDGE_MODE') ? remoteControlOption !== undefined : false) {
      const { getWireDisabledReason } = await import('../../bridge/bridgeEnabled.js')
      const disabledReason = await getWireDisabledReason()
      remoteControl = disabledReason === null
      if (disabledReason) {
        process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`))
      }
    }

    // 检查待处理的代理内存快照更新（仅限 --agent 模式，仅限 ant）
    if (
      feature('AGENT_MEMORY_SNAPSHOT')
        ? Boolean(
            mainThreadAgentDefinition &&
              isCustomAgent(mainThreadAgentDefinition) &&
              mainThreadAgentDefinition.memory &&
              mainThreadAgentDefinition.pendingSnapshotUpdate,
          )
        : false
    ) {
      const agentDef = mainThreadAgentDefinition!
      const choice = await launchSnapshotUpdateDialog(root, {
        agentType: agentDef.agentType,
        scope: agentDef.memory!,
        snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
      })
      if (choice === 'merge') {
        const snapshotUpdateDialogModule = (await import(
          '../../components/agents/SnapshotUpdateDialog.js'
        )) as {
          buildMergePrompt?: (agentType: string, scope: unknown) => string
        }
        const mergePrompt = snapshotUpdateDialogModule.buildMergePrompt?.(
          agentDef.agentType,
          agentDef.memory!,
        )
        if (mergePrompt) {
          inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt
        }
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
      await exitWithError(root, orgValidation.message)
    }
  }

  // 如果启动了 gracefulShutdown（例如用户拒绝了信任对话框），
  // process.exitCode 将被设置。跳过所有可能触发代码执行的后续操作
  // 在进程退出之前（例如插件 LSP、hook 或后台 API 预热）。
  if (process.exitCode !== undefined) {
    logForDebugging('Graceful shutdown initiated, skipping further initialization')
    throw new RootActionCompleted()
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

  const { sdkMcpConfigs, regularMcpConfigs } = splitMcpConfigs(allMcpConfigs)

  profileCheckpoint('action_mcp_configs_loaded')

  // 在信任对话框之后预取 MCP 资源（这是执行发生的地方）。
  // 仅限交互模式：打印模式延迟连接直到 headlessStore 存在，
  // 并按服务器推送，所以一个慢速服务器不会阻塞整批启动。
  const { localMcpPromise, zyaiMcpPromise, mcpPromise } = createMcpPrefetchPromises(
    isNonInteractiveSession,
    regularMcpConfigs,
    zyaiConfigPromise,
  )

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

  const { thinkingEnabled, thinkingConfig } = resolveThinkingState(
    effectiveModel,
    options.thinking,
    options.maxThinkingTokens,
  )

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
    assistantActivationPath: feature('KAIROS')
      ? kairosEnabled
        ? assistantModule?.getAssistantActivationPath()
        : undefined
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

  const setupTrigger: 'init' | 'maintenance' | null =
    initOnly || init ? 'init' : maintenance ? 'maintenance' : null
  return {
    ...context,
    effectiveModel,
    initialMainLoopModel,
    resolvedInitialModelInput,
    resolvedInitialModel,
    root,
    getFpsMetrics,
    stats,
    bgRefreshThrottleMs,
    lastPrefetched,
    skipStartupPrefetches,
    existingMcpConfigs,
    allMcpConfigs,
    sdkMcpConfigs,
    regularMcpConfigs,
    localMcpPromise,
    zyaiMcpPromise,
    mcpPromise,
    hooksPromise,
    hookMessages,
    mcpClients,
    mcpTools,
    mcpCommands,
    thinkingEnabled,
    thinkingConfig,
    setupTrigger,
  }
}
