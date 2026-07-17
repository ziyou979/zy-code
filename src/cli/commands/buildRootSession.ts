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
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { maybeActivateBrief } from '../activate/brief.js'
import { maybeActivateProactive } from '../activate/proactive.js'
import { pendingAssistantChat, pendingConnect, pendingSSH } from '../argvDispatch.js'
import { logSessionTelemetry, logStartupTelemetry } from '../bootstrap/telemetry.js'
import { coordinatorModeModule, getTeammateUtils } from '../lazyModules.js'
import { addToHistory } from '../../services/session-storage/history.js'
import { exitWithError, renderAndRun } from '../../cli/InteractiveHelpers.js'
import { computeInitialTeamContext } from '../../services/swarm/reconnection.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { uniq } from '../../utils/array.js'
import {
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../../services/config/config.js'
import { loadConversationForResume } from '../../utils/conversationRecovery.js'
import { resolveInitialEffortSetting } from '../../utils/effort.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { applyConfigEnvironmentVariables } from '../../services/environment/managedEnv.js'
import { createUserMessage } from '../../services/messages/./constructors.js'
import { processSessionStartHooks, processSetupHooks } from '../../services/session-storage/sessionStart.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import {
  dispatchResumeMode,
  launchResumedSessionRepl,
  runAssistantChatMode,
  runDirectConnectMode,
  runHeadlessMode,
  runInteractiveMode,
  runSshMode,
} from '../assembly/index.js'
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { processResumedConversation } from 'src/utils/sessionRestore.js'
import { plural } from 'src/utils/stringUtils.js'
import { getUserMsgOptIn } from 'src/bootstrap/runtime/runtimeContext.js'
import { shouldEnablePromptSuggestion } from '../../services/prompt-suggestion/availability.js'
import type { AppState } from '../../state/AppStateStore.js'
import { IDLE_SPECULATION_STATE } from '../../state/speculationState.js'
import { loadRootResources } from './loadRootResources.js'
export async function buildRootSession(context: Awaited<ReturnType<typeof loadRootResources>>) {
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
  } = context

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

  if (feature('CCR_MIRROR') ? !fullRemoteControl : false) {
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
  } else if (feature('DIRECT_CONNECT') ? pendingConnect?.url !== undefined : false) {
    // `zy connect <url>` —— 完整交互式 TUI 连接到远程服务器
    await runDirectConnectMode({
      root,
      appProps: { getFpsMetrics, stats, initialState },
      renderAndRun,
      pendingConnect: { ...pendingConnect!, url: pendingConnect!.url! },
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
  } else if (feature('SSH_REMOTE') ? pendingSSH?.host !== undefined : false) {
    // `zy ssh <host> [dir]` —— 探测远程，如果需要则部署二进制文件，
    // 生成带有 unix-socket -R 转发到本地认证代理的 ssh，将
    // SSHSession 交给 REPL。工具在远程运行，UI 在本地渲染。
    await runSshMode({
      root,
      appProps: { getFpsMetrics, stats, initialState },
      renderAndRun,
      pendingSSH: { ...pendingSSH!, host: pendingSSH!.host! },
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
    feature('KAIROS')
      ? Boolean(
          pendingAssistantChat && (pendingAssistantChat.sessionId || pendingAssistantChat.discover),
        )
      : false
  ) {
    await runAssistantChatMode({
      root,
      renderAndRun,
      getFpsMetrics,
      stats,
      initialState,
      pendingAssistantChat: pendingAssistantChat!,
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
