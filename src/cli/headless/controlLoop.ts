// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { readFile, stat } from 'node:fs/promises'
import { redownloadUserSettings } from 'src/services/settings-sync/index.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import { logForDiagnosticsNoPII } from 'src/services/telemetry/diagLogs.js'
import { type Tools } from 'src/tools/tool.js'
import { type AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import {
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
} from 'src/services/input/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/services/hooks/commandLifecycle.js'
import { notifySessionMetadataChanged } from 'src/services/session-state/sessionState.js'
import { logError } from 'src/services/infra/log.js'
import type { MCPServerConnection, McpSdkServerConfig } from 'src/services/mcp/types.js'
import { createFileStateCacheWithSizeLimit } from 'src/services/file-persistence/fileStateCache.js'
import { expandPath } from 'src/utils/path.js'
import { finalizePendingAsyncHooks } from 'src/services/hooks/asyncHookRegistry.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ModelInfo, WireUserMessageReplay } from 'src/types/index.js'
import type {
  StdoutMessage,
  WireControlRequest,
  WireControlReloadPluginsResponse,
  WireControlSetPermissionModeRequest,
} from 'src/types/wire/control.js'
import { cwd } from 'node:process'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import type { ReplWireHandle } from 'src/bridge/replBridge.js'
import { getRemoteSessionUrl } from 'src/constants/product.js'
import { buildWireConnectUrl } from 'src/bridge/bridgeStatusUtil.js'
import { extractInboundMessageFields } from 'src/bridge/inboundMessages.js'
import { resolveAndPrepend } from 'src/bridge/inboundAttachments.js'
import { createAbortController } from 'src/utils/abortController.js'
import { generateSessionTitle } from 'src/services/session-storage/sessionTitle.js'
import { buildSideQuestionFallbackParams } from 'src/services/query/queryContext.js'
import { runSideQuestion } from 'src/services/assistant/sideQuestion.js'
import { getSettingsWithSources } from 'src/services/settings/settings.js'
import { settingsChangeDetector } from 'src/services/settings/changeDetector.js'
import { getLastCacheSafeParams } from 'src/services/agent/forkedAgent.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import { setSdkAgentProgressSummariesEnabled } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  doesMessageExistInSession,
  recordAttributionSnapshot,
  saveAiGeneratedTitle,
} from 'src/services/sessionStorage.js'
import { incrementPromptCount } from 'src/services/git/commitAttribution.js'
import { clearServerCache, reconnectMcpServerImpl } from 'src/services/mcp/client.js'
import { getMcpConfigByName } from 'src/services/mcp/configLookup.js'
import { isMcpServerDisabled, setMcpServerEnabled } from 'src/services/mcp/serverEnablement.js'
import { performMCPOAuthFlow, revokeServerTokens } from 'src/services/mcp/auth.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/services/mcp/utils.js'
import { toInternalMessages } from 'src/services/messages/mappers.js'
import { collectContextData } from 'src/commands/context/contextNoninteractive.js'
import { statusListeners, type ZyAILimits } from 'src/services/zyAiLimits.js'
import { getDefaultMainLoopModel, getMainLoopModel } from 'src/services/model/model.js'
import { modelSupportsEffort, resolveAppliedEffort } from 'src/services/effort/effort.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { setMainLoopModelOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from 'src/bootstrap/runtime/runtimeContext.js'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { AppState } from 'src/state/AppStateStore.js'
import { getCommands } from '../../commands/index.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { refreshActivePlugins } from '../../services/plugins/refresh.js'
import { loadAllPluginsCacheOnly } from '../../services/plugins/pluginLoader.js'
import type { PluginLoadResult } from '../../services/plugins/types.js'
import { stopTask } from '../../tasks/stopTask.js'
import { errorMessage } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import { createHeadlessSession } from './headlessSession.js'
import { createMcpRuntime } from './mcpRuntime.js'
import { type LoopState } from './turnLoop.js'
import {
  handleInitializeRequest,
  handleRewindFiles,
  handleSetPermissionMode,
  handleChannelEnable,
  handleOrphanedPermissionResponse,
  reregisterChannelHandlerAfterReconnect,
  proactiveModule,
  receivedMessageUuids,
  trackReceivedMessageUuid,
} from '../print.js'
import type { SuggestionState, HeadlessStreamingOptions } from './turnLoop.js'

export interface ControlLoopDeps {
  loopState: LoopState
  bridgeState: { handle: ReplWireHandle | null; lastForwardedIndex: number }
  structuredIO: StructuredIO
  options: HeadlessStreamingOptions
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  output: StructuredIO['outbound']
  session: ReturnType<typeof createHeadlessSession>
  mcp: ReturnType<typeof createMcpRuntime>
  suggestionState: SuggestionState
  pendingSeeds: ReturnType<typeof createFileStateCacheWithSizeLimit>
  buildAllTools: (appState: AppState) => Tools
  modelInfos: ModelInfo[]
  commands: Command[]
  agents: AgentDefinition[]
  mcpClients: MCPServerConnection[]
  injectModelSwitchBreadcrumbs: (modelArg: string, resolvedModel: string) => void
  scheduleProactiveTick: (() => void) | undefined
  cronScheduler: import('../../services/jobs/cronScheduler.js').CronScheduler | null
  unsubscribeSkillChanges: () => void
  unsubscribeAuthStatus: (() => void) | undefined
  rateLimitListener: (limits: ZyAILimits) => void
  kickRun: () => void
}

// Phase 5b: 控制消息循环外提自 print.ts runHeadlessStreaming 的 IIFE。
// deps 注入闭包依赖;loopState/bridgeState 共享可变状态;kickRun 处理 run 自递归;
// zyOAuth/OAuth state/initialized/sendControlResponse* 为本循环私有,留函数内部。
export async function runControlLoop(deps: ControlLoopDeps): Promise<void> {
  const {
    loopState,
    bridgeState,
    structuredIO,
    options,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    output,
    session,
    mcp,
    suggestionState,
    pendingSeeds,
    buildAllTools,
    modelInfos,
    commands,
    agents,
    mcpClients,
    injectModelSwitchBreadcrumbs,
    scheduleProactiveTick,
    cronScheduler,
    unsubscribeSkillChanges,
    unsubscribeAuthStatus,
    rateLimitListener,
    kickRun,
  } = deps
  const sendControlResponseSuccess = (
    message: WireControlRequest,
    response?: Record<string, unknown>,
  ) => {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: response,
      },
    })
  }

  const sendControlResponseError = (message: WireControlRequest, errorMessage: string) => {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: errorMessage,
      },
    })
  }

  // 在 transcript 中查找尚未解决的工具调用并执行，以处理意外到达的权限响应
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async (message) => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // 会话首条消息可能是孤立权限检查而非用户 prompt，因此启动循环。
        kickRun()
      },
    })
  })

  // 按 server 跟踪活跃 OAuth 流程，使同一 server 收到新的 mcp_authenticate 请求时可以中止
  // 上一个流程。
  const activeOAuthFlows = new Map<string, AbortController>()
  // 跟踪活跃 OAuth 流程的手动 callback URL 提交函数，用于 localhost 无法访问的场景，
  // 例如基于浏览器的 IDE。
  const oauthCallbackSubmitters = new Map<string, (callbackUrl: string) => void>()
  // 跟踪实际调用过手动 callback 的 server，使自动重连路径知道应跳过；extension 会负责重连。
  const oauthManualCallbackUsed = new Set<string>()
  // 跟踪仅认证的 OAuth promise，使 mcp_oauth_callback_url 能等待 token 交换完成。重连由
  // extension 通过 handleAuthDone → mcp_reconnect 另行处理。
  const oauthAuthPromises = new Map<string, Promise<void>>()

  // 这里实质上启动了并行异步任务：一个从 stdin 读取并加入处理队列，另一个读取队列、执行处理
  // 并返回生成结果。输入流结束且队列最后一次生成完成后，整个流程才结束。
  let initialized = false
  logForDiagnosticsNoPII('info', 'cli_message_loop_started')

  // Phase 3: 控制消息 dispatch map。所有 control_request subtype 均在此分发,
  // 无 subtype 走 else-if(set_proactive 经 feature 条件 spread 也在表内)。
  // handler 为内联闭包,捕获 activeUserSpecifiedModel/options 等闭包状态;
  // message.request 是 subtype 联合,handler 内用 Extract 窄化到具体变体。
  // 返回 'break' 的 handler(如 end_session)令外层 for-await 退出。
  type ControlOutcome = void | 'break'
  const controlHandlers: Partial<
    Record<string, (message: WireControlRequest) => ControlOutcome | Promise<ControlOutcome>>
  > = {
    set_model: (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'set_model' }
      >
      const requestedModel = req.model ?? 'default'
      const model =
        requestedModel === 'default'
          ? (getDefaultMainLoopModel() ?? requestedModel)
          : requestedModel
      loopState.activeUserSpecifiedModel = model
      setMainLoopModelOverride(model)
      notifySessionMetadataChanged({ model })
      injectModelSwitchBreadcrumbs(requestedModel, model)
      sendControlResponseSuccess(message)
    },
    set_max_thinking_tokens: (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'set_max_thinking_tokens' }
      >
      if (req.max_thinking_tokens === null) {
        options.thinkingConfig = undefined
      } else if (req.max_thinking_tokens === 0) {
        options.thinkingConfig = { type: 'disabled' }
      } else {
        options.thinkingConfig = {
          type: 'enabled',
          budgetTokens: req.max_thinking_tokens,
        }
      }
      sendControlResponseSuccess(message)
    },
    get_settings: (message) => {
      const currentAppState = getAppState()
      const model = getMainLoopModel() ?? ''
      // modelSupportsEffort 检查与 zy.ts 一致；applied.effort 必须反映实际发送到 API 的值，
      // 而不只是配置值。
      const effort = modelSupportsEffort(model)
        ? resolveAppliedEffort(model, currentAppState.effortValue)
        : undefined
      sendControlResponseSuccess(message, {
        ...getSettingsWithSources(),
        applied: {
          model,
          // 数值 effort 仅供 ant 使用，因此转为 null；SDK schema 只支持字符串级别。
          effort: typeof effort === 'string' ? effort : null,
        },
      })
    },
    interrupt: (message) => {
      // 跟踪 escape，供归因使用（仅限 ant 功能）
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState((prev) => ({
          ...prev,
          attribution: {
            ...prev.attribution,
            escapeCount: prev.attribution.escapeCount + 1,
          },
        }))
      }
      if (loopState.abortController) {
        // 用户按 ESC（或等价的取消控制信号）— 用 'interrupt' reason。
        loopState.abortController.abort('interrupt')
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      suggestionState.lastEmitted = null
      suggestionState.pendingSuggestion = null
      sendControlResponseSuccess(message)
    },
    set_permission_mode: (message) => {
      const m = message.request as WireControlSetPermissionModeRequest
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: handleSetPermissionMode(
          m as unknown as { mode: import('../../types/permissions.js').InternalPermissionMode },
          message.request_id,
          prev.toolPermissionContext,
          output,
        ),
        isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
      }))
      // handleSetPermissionMode 会发送 control_response；此前紧随其后的
      // notifySessionMetadataChanged 现由 onChangeAppState 触发，并使用外部模式名。
    },
    mcp_status: (message) => {
      sendControlResponseSuccess(message, {
        mcpServers: mcp.buildMcpServerStatuses(),
      })
    },
    get_context_usage: async (message) => {
      try {
        const appState = getAppState()
        const data = await collectContextData({
          messages: session.messages,
          getAppState,
          options: {
            mainLoopModel: getMainLoopModel() ?? '',
            tools: buildAllTools(appState),
            agentDefinitions: appState.agentDefinitions,
            customSystemPrompt: options.systemPrompt,
            appendSystemPrompt: options.appendSystemPrompt,
          },
        })
        sendControlResponseSuccess(message, { ...data })
      } catch (error) {
        sendControlResponseError(message, errorMessage(error))
      }
    },
    mcp_message: (message) => {
      // 处理 SDK server 发来的 MCP 通知
      const mcpRequest = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'mcp_message' }
      >
      const sdkClient = mcp.sdkClients.find((client) => client.name === mcpRequest.server_name)
      // 检查 client 是否存在；动态添加的 SDK server 在 updateSdkMcp() 运行前，可能只有
      // client 为 null 的占位项。
      if (sdkClient && sdkClient.type === 'connected' && sdkClient.client?.transport?.onmessage) {
        sdkClient.client.transport.onmessage(mcpRequest.message as JSONRPCMessage)
      }
      sendControlResponseSuccess(message)
    },
    rewind_files: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'rewind_files' }
      >
      const appState = getAppState()
      const result = await handleRewindFiles(
        req.user_message_id as UUID,
        appState,
        setAppState,
        req.dry_run ?? false,
      )
      if (result.canRewind || req.dry_run) {
        sendControlResponseSuccess(message, result as unknown as Record<string, unknown>)
      } else {
        sendControlResponseError(message, result.error ?? 'Unexpected error')
      }
    },
    cancel_async_message: (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'cancel_async_message' }
      >
      const targetUuid = req.message_uuid
      const removed = dequeueAllMatching((cmd) => cmd.uuid === targetUuid)
      sendControlResponseSuccess(message, {
        cancelled: removed.length > 0,
      })
    },
    end_session: (message) => {
      const req = message.request as { reason?: string }
      logForDebugging(`[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`)
      if (loopState.abortController) {
        // 会话被外部要求结束(SDK end_session 控制消息),
        // 用专门的 reason 区分于其他用户中断路径。
        loopState.abortController.abort('end_session')
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      suggestionState.lastEmitted = null
      suggestionState.pendingSuggestion = null
      sendControlResponseSuccess(message)
      return 'break'
    },
    mcp_set_servers: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'mcp_set_servers' }
      >
      const { response, sdkServersChanged } = await mcp.applyMcpServerChanges(req.servers)
      sendControlResponseSuccess(message, response as unknown as Record<string, unknown>)
      // 响应后再连接 SDK server，避免死锁
      if (sdkServersChanged) {
        void mcp.updateSdkMcp()
      }
    },
    apply_flag_settings: (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'apply_flag_settings' }
      >
      // 应用前创建当前 model 快照，用于检测 model 切换，以注入 breadcrumb 并通知 listener。
      const prevModel = getMainLoopModel()

      // 将传入 settings 合并到内存中的 flag settings
      const existing = getFlagSettingsInline() ?? {}
      const incoming = req.settings
      // 顶层 key 做浅合并；getSettingsForSource 会通过 mergeWith 与文件 flag settings 深度
      // 合并。JSON 会丢弃 `undefined`，调用方因此用 `null` 清除 key；将 null 转为删除操作，
      // 避免 SettingsSchema().safeParse() 拒绝。
      const merged = { ...existing, ...incoming }
      for (const key of Object.keys(merged)) {
        if (merged[key as keyof typeof merged] === null) {
          delete merged[key as keyof typeof merged]
        }
      }
      setFlagSettingsInline(merged)
      // 通过 notifyChange 路由，使 fanOut() 在 listener 运行前重置 settings 缓存；:392 的
      // subscriber 会调用 applySettingsChange。
      settingsChangeDetector.notifyChange('flagSettings')

      // 若传入 settings 包含 model 变化，则更新 override，使 getMainLoopModel() 能反映该变化；
      // override 优先于级联值。
      if ('model' in incoming) {
        if (incoming.model != null) {
          setMainLoopModelOverride(String(incoming.model))
        } else {
          setMainLoopModelOverride(undefined)
        }
      }

      // model 变化时注入 breadcrumb，并通知 metadata listener。
      const newModel = getMainLoopModel() ?? prevModel
      if (newModel !== prevModel) {
        loopState.activeUserSpecifiedModel = newModel
        const modelArg = incoming.model ? String(incoming.model) : 'default'
        notifySessionMetadataChanged({ model: newModel })
        injectModelSwitchBreadcrumbs(modelArg, newModel!)
      }

      sendControlResponseSuccess(message)
    },
    stop_task: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'stop_task' }
      >
      try {
        await stopTask(req.task_id, {
          getAppState,
          setAppState,
        })
        sendControlResponseSuccess(message, {})
      } catch (error) {
        sendControlResponseError(message, errorMessage(error))
      }
    },
    seed_read_state: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'seed_read_state' }
      >
      // client 观察到一次 Read，随后该记录被移出 context（例如被 snip），导致基于 transcript
      // 的种子初始化遗漏。先放入 pendingSeeds，在下个 clone-replace 边界应用。
      try {
        // 使用 expandPath：其他 readFileState 写入方都会规范化 `~`、相对路径以及 session cwd
        // 与 process cwd。FileEditTool 按 expandPath 处理后的 key 查找，原样使用 client 路径会漏掉。
        const normalizedPath = expandPath(req.path)
        // 读取内容前检查磁盘 mtime。若文件在 client 观察后发生变化，readFile 会返回 C_current，
        // 但保存时使用 client 的 M_observed。随后 getChangedFiles 发现 disk > cache.timestamp，
        // 重新读取并比较 C_current 与 C_current，结果为空，不发送附件，模型永远不知道
        // C_observed → C_current 的变化。跳过种子会让 Edit 以 “file not read yet” 失败，从而
        // 强制重新 Read。Math.floor 与 FileReadTool、getFileModificationTime 保持一致。
        const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
        if (diskMtime <= req.mtime) {
          const raw = await readFile(normalizedPath, 'utf-8')
          // 去除 BOM 并将 CRLF 规范为 LF，与 readFileInRange、readFileSyncWithMetadata 一致。
          // FileEditTool 在 Windows mtime 变化但内容未变时使用内容比较回退，该比较也针对
          // LF 规范化后的磁盘读取结果。
          const content = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replaceAll(
            '\r\n',
            '\n',
          )
          pendingSeeds.set(normalizedPath, {
            content,
            timestamp: diskMtime,
            offset: undefined,
            limit: undefined,
          })
        }
      } catch {
        // ENOENT 等错误时跳过种子初始化，但仍视为成功
      }
      sendControlResponseSuccess(message)
    },
    reload_plugins: async (message) => {
      try {
        if (feature('DOWNLOAD_USER_SETTINGS')) {
          if (isEnvTruthy(process.env.ZY_CODE_REMOTE) || getIsRemoteMode()) {
            // 重新拉取用户 settings，使本地 CLI 推送的 enabledPlugins 在清扫缓存前生效。
            const applied = await redownloadUserSettings()
            if (applied) {
              settingsChangeDetector.notifyChange('userSettings')
            }
          }
        }

        const r = await refreshActivePlugins(setAppState)

        const sdkAgents = mcp.currentAgents.filter((a) => a.source === 'flagSettings')
        mcp.currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

        // 重载已成功；尽力收集响应数据，避免读取失败掩盖成功的状态变化。使用 allSettled，
        // 使单项失败不会丢弃其他结果。
        let plugins: WireControlReloadPluginsResponse['plugins'] = []
        const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
          getCommands(cwd()),
          mcp.applyPluginMcpDiff(),
          loadAllPluginsCacheOnly(),
        ])
        if (cmdsR.status === 'fulfilled') {
          mcp.currentCommands = cmdsR.value
        } else {
          logError(cmdsR.reason)
        }
        if (mcpR.status === 'rejected') {
          logError(mcpR.reason)
        }
        if (pluginsR.status === 'fulfilled') {
          const loadResult = pluginsR.value as PluginLoadResult
          plugins = loadResult.enabled.map((p) => ({
            name: p.name,
            path: p.path,
            source: p.source,
          }))
        } else {
          logError(pluginsR.reason)
        }

        sendControlResponseSuccess(message, {
          commands: mcp.currentCommands
            .filter((cmd) => cmd.userInvocable !== false)
            .map((cmd) => ({
              name: getCommandName(cmd),
              description: formatDescriptionWithSource(cmd),
              argumentHint: cmd.argumentHint || '',
            })),
          agents: mcp.currentAgents.map((a) => ({
            name: a.agentType,
            description: a.whenToUse,
            model: a.model === 'inherit' ? undefined : a.model,
          })),
          plugins,
          mcpServers: mcp.buildMcpServerStatuses(),
          error_count: r.error_count,
        } satisfies WireControlReloadPluginsResponse)
      } catch (error) {
        sendControlResponseError(message, errorMessage(error))
      }
    },
    channel_enable: (message) => {
      const currentAppState = getAppState()
      const req = message.request as unknown as { serverName: string }
      handleChannelEnable(
        message.request_id,
        req.serverName,
        // pool 展开方式与 mcp_status 一致，覆盖三个 client 来源。
        [...currentAppState.mcp.clients, ...mcp.sdkClients, ...mcp.dynamicMcpState.clients],
        output,
      )
    },
    initialize: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'initialize' }
      >
      // initialize 消息中的 SDK MCP server 名称；browser 与 ProcessTransport 会话均会填充
      if (req.sdkMcpServers && req.sdkMcpServers.length > 0) {
        for (const serverName of req.sdkMcpServers) {
          // 为 SDK MCP server 创建占位配置；实际 server 连接由 SDK Query 类管理
          sdkMcpConfigs[serverName] = {
            type: 'sdk',
            name: serverName,
          }
        }
      }

      await handleInitializeRequest(
        req,
        message.request_id,
        initialized,
        output,
        commands,
        modelInfos,
        structuredIO,
        !!options.enableAuthStatus,
        options,
        agents,
        getAppState,
      )

      // SDK 消费方选择启用时，在 AppState 中开启 prompt 建议。非交互会话下
      // shouldEnablePromptSuggestion() 返回 false，但 SDK 消费方已显式请求建议。
      if (req.promptSuggestions) {
        setAppState((prev) => {
          if (prev.promptSuggestionEnabled) {
            return prev
          }
          return { ...prev, promptSuggestionEnabled: true }
        })
      }

      if (
        req.agentProgressSummaries &&
        getFeatureValue_CACHED_MAY_BE_STALE('zy_slate_prism', true)
      ) {
        setSdkAgentProgressSummariesEnabled(true)
      }

      initialized = true

      // 若自动恢复逻辑已预先加入 command，此时 initialize 已设置 systemPrompt、agent、hook 等，
      // 可以开始清空队列。
      if (hasCommandsInQueue()) {
        kickRun()
      }
    },
    mcp_reconnect: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'mcp_reconnect' }
      >
      const currentAppState = getAppState()
      const { serverName } = req
      mcp.elicitationRegistered.delete(serverName)
      // 配置存在性检查必须覆盖与下方操作相同的来源。此前遗漏 SDK 注入的 server
      //（query({mcpServers:{...}})）及动态添加的 server，导致即使 disconnect/reconnect
      // 本可正常工作，toggleMcpServer/reconnect 仍返回 “Server not found”（gh-31339 / CC-314）。
      const config =
        getMcpConfigByName(serverName) ??
        mcpClients.find((c) => c.name === serverName)?.config ??
        mcp.sdkClients.find((c) => c.name === serverName)?.config ??
        mcp.dynamicMcpState.clients.find((c) => c.name === serverName)?.config ??
        currentAppState.mcp.clients.find((c) => c.name === serverName)?.config ??
        null
      if (!config) {
        sendControlResponseError(message, `Server not found: ${serverName}`)
      } else {
        const result = await reconnectMcpServerImpl(serverName, config)
        // 用新 client、tool、command 与 resource 更新 appState.mcp
        const prefix = getMcpPrefix(serverName)
        setAppState((prev) => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.map((c) => (c.name === serverName ? result.client : c)),
            tools: [...reject(prev.mcp.tools, (t) => t.name?.startsWith(prefix)), ...result.tools],
            commands: [
              ...reject(prev.mcp.commands, (c) => commandBelongsToServer(c, serverName)),
              ...result.commands,
            ],
            resources:
              result.resources && result.resources.length > 0
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : omit(prev.mcp.resources, serverName),
          },
        }))
        // 同时更新 mcp.dynamicMcpState，使 run() 在下个 turn 获取新 tool；run() 读取的是
        // mcp.dynamicMcpState，而非 appState。
        mcp.dynamicMcpState = {
          ...mcp.dynamicMcpState,
          clients: [
            ...mcp.dynamicMcpState.clients.filter((c) => c.name !== serverName),
            result.client,
          ],
          tools: [
            ...mcp.dynamicMcpState.tools.filter((t) => !t.name?.startsWith(prefix)),
            ...result.tools,
          ],
        }
        if (result.client.type === 'connected') {
          mcp.registerElicitationHandlers([result.client])
          reregisterChannelHandlerAfterReconnect(result.client)
          sendControlResponseSuccess(message)
        } else {
          const errorMessage =
            result.client.type === 'failed'
              ? (result.client.error ?? 'Connection failed')
              : `Server status: ${result.client.type}`
          sendControlResponseError(message, errorMessage)
        }
      }
    },
    mcp_toggle: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'mcp_toggle' }
      >
      const currentAppState = getAppState()
      const { serverName, enabled } = req
      mcp.elicitationRegistered.delete(serverName)
      // 检查必须与下方 client 查找的展开来源一致，其中包括 mcp.sdkClients 与
      // mcp.dynamicMcpState.clients。与上方 mcp_reconnect 的修复相同（gh-31339 / CC-314）。
      const config =
        getMcpConfigByName(serverName) ??
        mcpClients.find((c) => c.name === serverName)?.config ??
        mcp.sdkClients.find((c) => c.name === serverName)?.config ??
        mcp.dynamicMcpState.clients.find((c) => c.name === serverName)?.config ??
        currentAppState.mcp.clients.find((c) => c.name === serverName)?.config ??
        null

      if (!config) {
        sendControlResponseError(message, `Server not found: ${serverName}`)
      } else if (!enabled) {
        // 禁用：持久化并断开，与 TUI toggleMcpServer 行为一致
        setMcpServerEnabled(serverName, false)
        const client = [
          ...mcpClients,
          ...mcp.sdkClients,
          ...mcp.dynamicMcpState.clients,
          ...currentAppState.mcp.clients,
        ].find((c) => c.name === serverName)
        if (client && client.type === 'connected') {
          await clearServerCache(serverName, config)
        }
        // 更新 appState.mcp 以反映禁用状态，并移除 tool、command 与 resource
        const prefix = getMcpPrefix(serverName)
        setAppState((prev) => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.map((c) =>
              c.name === serverName ? { name: serverName, type: 'disabled' as const, config } : c,
            ),
            tools: reject(prev.mcp.tools, (t) => t.name?.startsWith(prefix)),
            commands: reject(prev.mcp.commands, (c) => commandBelongsToServer(c, serverName)),
            resources: omit(prev.mcp.resources, serverName),
          },
        }))
        sendControlResponseSuccess(message)
      } else {
        // 启用：持久化并重连
        setMcpServerEnabled(serverName, true)
        const result = await reconnectMcpServerImpl(serverName, config)
        // 用新 client、tool、command 与 resource 更新 appState.mcp，确保启用 server 后
        // LLM 能看到更新后的 tool。
        const prefix = getMcpPrefix(serverName)
        setAppState((prev) => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.map((c) => (c.name === serverName ? result.client : c)),
            tools: [...reject(prev.mcp.tools, (t) => t.name?.startsWith(prefix)), ...result.tools],
            commands: [
              ...reject(prev.mcp.commands, (c) => commandBelongsToServer(c, serverName)),
              ...result.commands,
            ],
            resources:
              result.resources && result.resources.length > 0
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : omit(prev.mcp.resources, serverName),
          },
        }))
        if (result.client.type === 'connected') {
          mcp.registerElicitationHandlers([result.client])
          reregisterChannelHandlerAfterReconnect(result.client)
          sendControlResponseSuccess(message)
        } else {
          const errorMessage =
            result.client.type === 'failed'
              ? (result.client.error ?? 'Connection failed')
              : `Server status: ${result.client.type}`
          sendControlResponseError(message, errorMessage)
        }
      }
    },
    mcp_authenticate: async (message) => {
      const { serverName } = message.request as { serverName: string }
      const currentAppState = getAppState()
      const config =
        getMcpConfigByName(serverName) ??
        mcpClients.find((c) => c.name === serverName)?.config ??
        currentAppState.mcp.clients.find((c) => c.name === serverName)?.config ??
        null
      if (!config) {
        sendControlResponseError(message, `Server not found: ${serverName}`)
      } else if (config.type !== 'sse' && config.type !== 'http') {
        sendControlResponseError(
          message,
          `Server type "${config.type}" does not support OAuth authentication`,
        )
      } else {
        try {
          // 中止该 server 上一个仍在进行的 OAuth 流程
          activeOAuthFlows.get(serverName)?.abort()
          const controller = new AbortController()
          activeOAuthFlows.set(serverName, controller)

          // 从 callback 捕获认证 URL
          let resolveAuthUrl: (url: string) => void
          const authUrlPromise = new Promise<string>((resolve) => {
            resolveAuthUrl = resolve
          })

          // 在后台启动 OAuth 流程
          const oauthPromise = performMCPOAuthFlow(
            serverName,
            config,
            (url) => resolveAuthUrl!(url),
            controller.signal,
            {
              skipBrowserOpen: true,
              onWaitingForCallback: (submit) => {
                oauthCallbackSubmitters.set(serverName, submit)
              },
            },
          )

          // 等待认证 URL，或等待无需重定向的流程完成
          const authUrl = await Promise.race([
            authUrlPromise,
            oauthPromise.then(() => null as string | null),
          ])

          if (authUrl) {
            sendControlResponseSuccess(message, {
              authUrl,
              requiresUserAction: true,
            })
          } else {
            sendControlResponseSuccess(message, {
              requiresUserAction: false,
            })
          }

          // 为 mcp_oauth_callback_url handler 保存仅认证 promise。不要吞掉错误，callback handler
          // 需要检测认证失败并报告给调用方。
          oauthAuthPromises.set(serverName, oauthPromise)

          // 处理后台完成：认证后重连。使用手动 callback 时在此跳过重连，由 extension 的
          // handleAuthDone → mcp_reconnect 处理；该流程也会更新 mcp.dynamicMcpState 以注册 tool。
          const fullFlowPromise = oauthPromise
            .then(async () => {
              // 若 server 在 OAuth 流程中被禁用，则不重连
              if (isMcpServerDisabled(serverName)) {
                return
              }
              // 使用手动 callback 路径时跳过重连；handleAuthDone 会通过 mcp_reconnect 完成，
              // 同时更新 mcp.dynamicMcpState 以注册 tool。
              if (oauthManualCallbackUsed.has(serverName)) {
                return
              }
              // 认证成功后重连 server
              const result = await reconnectMcpServerImpl(serverName, config)
              const prefix = getMcpPrefix(serverName)
              setAppState((prev) => ({
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients: prev.mcp.clients.map((c) => (c.name === serverName ? result.client : c)),
                  tools: [
                    ...reject(prev.mcp.tools, (t) => t.name?.startsWith(prefix)),
                    ...result.tools,
                  ],
                  commands: [
                    ...reject(prev.mcp.commands, (c) => commandBelongsToServer(c, serverName)),
                    ...result.commands,
                  ],
                  resources:
                    result.resources && result.resources.length > 0
                      ? {
                          ...prev.mcp.resources,
                          [serverName]: result.resources,
                        }
                      : omit(prev.mcp.resources, serverName),
                },
              }))
              // 同时更新 mcp.dynamicMcpState，使 run() 在下个 turn 获取新 tool；run() 读取的是
              // mcp.dynamicMcpState，而非 appState。
              mcp.dynamicMcpState = {
                ...mcp.dynamicMcpState,
                clients: [
                  ...mcp.dynamicMcpState.clients.filter((c) => c.name !== serverName),
                  result.client,
                ],
                tools: [
                  ...mcp.dynamicMcpState.tools.filter((t) => !t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
              }
            })
            .catch((error) => {
              logForDebugging(`MCP OAuth failed for ${serverName}: ${error}`, {
                level: 'error',
              })
            })
            .finally(() => {
              // 仅当这仍是活跃流程时清理
              if (activeOAuthFlows.get(serverName) === controller) {
                activeOAuthFlows.delete(serverName)
                oauthCallbackSubmitters.delete(serverName)
                oauthManualCallbackUsed.delete(serverName)
                oauthAuthPromises.delete(serverName)
              }
            })
          void fullFlowPromise
        } catch (error) {
          sendControlResponseError(message, errorMessage(error))
        }
      }
    },
    mcp_oauth_callback_url: async (message) => {
      const { serverName, callbackUrl } = message.request as {
        serverName: string
        callbackUrl: string
      }
      const submit = oauthCallbackSubmitters.get(serverName)
      if (submit) {
        // 提交前校验 callback URL。auth.ts 中的 submit callback 会静默忽略缺少 code 参数的 URL，
        // 从而使认证 promise 一直未解决，并阻塞控制消息循环直到超时。
        let hasCodeOrError = false
        try {
          const parsed = new URL(callbackUrl)
          hasCodeOrError = parsed.searchParams.has('code') || parsed.searchParams.has('error')
        } catch {
          // URL 无效
        }
        if (!hasCodeOrError) {
          sendControlResponseError(
            message,
            'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
          )
        } else {
          oauthManualCallbackUsed.add(serverName)
          submit(callbackUrl)
          // 响应前等待认证（token 交换）完成。重连由 extension 通过 handleAuthDone →
          // mcp_reconnect 处理，该流程会为 tool 更新 mcp.dynamicMcpState。
          const authPromise = oauthAuthPromises.get(serverName)
          if (authPromise) {
            try {
              await authPromise
              sendControlResponseSuccess(message)
            } catch (error) {
              sendControlResponseError(
                message,
                error instanceof Error ? error.message : 'OAuth authentication failed',
              )
            }
          } else {
            sendControlResponseSuccess(message)
          }
        }
      } else {
        sendControlResponseError(message, `No active OAuth flow for server: ${serverName}`)
      }
    },
    zy_authenticate: async (message) => {
      // 多 Provider OAuth 模式下，headless 控制通道不支持直接 OAuth 登录。
      // 请使用 `zy auth login --provider <provider>` 进行交互式登录。
      sendControlResponseError(
        message,
        'OAuth login via control channel is not supported in multi-provider mode. Please use `zy auth login --provider <provider>` instead.',
      )
    },
    mcp_clear_auth: async (message) => {
      const { serverName } = message.request as { serverName: string }
      const currentAppState = getAppState()
      const config =
        getMcpConfigByName(serverName) ??
        mcpClients.find((c) => c.name === serverName)?.config ??
        currentAppState.mcp.clients.find((c) => c.name === serverName)?.config ??
        null
      if (!config) {
        sendControlResponseError(message, `Server not found: ${serverName}`)
      } else if (config.type !== 'sse' && config.type !== 'http') {
        sendControlResponseError(message, `Cannot clear auth for server type "${config.type}"`)
      } else {
        await revokeServerTokens(serverName, config)
        const result = await reconnectMcpServerImpl(serverName, config)
        const prefix = getMcpPrefix(serverName)
        setAppState((prev) => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.map((c) => (c.name === serverName ? result.client : c)),
            tools: [...reject(prev.mcp.tools, (t) => t.name?.startsWith(prefix)), ...result.tools],
            commands: [
              ...reject(prev.mcp.commands, (c) => commandBelongsToServer(c, serverName)),
              ...result.commands,
            ],
            resources:
              result.resources && result.resources.length > 0
                ? {
                    ...prev.mcp.resources,
                    [serverName]: result.resources,
                  }
                : omit(prev.mcp.resources, serverName),
          },
        }))
        sendControlResponseSuccess(message, {})
      }
    },
    generate_session_title: (message) => {
      // 以 fire-and-forget 方式运行，避免 compact model 调用阻塞 stdin 循环；否则在整个 API
      // 往返期间都会延迟处理后续用户消息与中断。
      const { description, persist } = message.request as { description: string; persist?: boolean }
      // 仅当现有 controller 尚未被 abort（例如被 interrupt() 中止）时才复用；已 abort 的
      // signal 会让 queryCompactModel 立即抛出 APIUserAbortError，最终得到 {title: null}。
      const titleSignal = (
        loopState.abortController && !loopState.abortController.signal.aborted
          ? loopState.abortController
          : createAbortController()
      ).signal
      void (async () => {
        try {
          const title = await generateSessionTitle(description, titleSignal)
          if (title && persist) {
            try {
              saveAiGeneratedTitle(getSessionId() as UUID, title)
            } catch (e) {
              logError(e)
            }
          }
          sendControlResponseSuccess(message, { title })
        } catch (e) {
          // 实际上不可达：generateSessionTitle 会捕获自身函数体错误并返回 null，
          // saveAiGeneratedTitle 在上方也已被包装。此处继续传播而非吞掉，使意外失败对 SDK
          // 调用方可见；hostComms.ts 会捕获并记录。
          sendControlResponseError(message, errorMessage(e))
        }
      })()
    },
    side_question: (message) => {
      // 与上方 generate_session_title 使用相同的 fire-and-forget 模式；fork agent 的 API
      // 往返不能阻塞 stdin 循环。
      //
      // stopHooks 在 querySource === 'sdk' 时捕获的快照，包含上个主线程 turn 实际发送的
      // systemPrompt/userContext/systemContext/messages。复用可获得逐字节一致的前缀，从而命中
      // prompt 缓存。
      //
      // 回退场景（首个 turn 完成前恢复，尚无快照）：从头重建。
      // buildSideQuestionFallbackParams 复刻 QueryEngine.ts:ask() 的 system prompt 组装，
      // 包括 --system-prompt / --append-system-prompt，使常见场景下重建前缀一致。coordinator
      // 模式或额外 memory mechanics 仍可能无法命中缓存，但可以接受，否则 side question 会
      // 完全失败。
      const { question } = message.request as { question: string }
      void (async () => {
        try {
          const saved = getLastCacheSafeParams()
          const cacheSafeParams = saved
            ? {
                ...saved,
                // 若上个 turn 被中断，快照会包含已 abort 的 controller；createSubagentContext 中的
                // createChildAbortController 会传播该状态，使 fork 在发送请求前终止。controller 不属于
                // 缓存 key，替换为新实例是安全的。检查与上方 generate_session_title 相同。
                toolUseContext: {
                  ...saved.toolUseContext,
                  abortController: createAbortController(),
                },
              }
            : await buildSideQuestionFallbackParams({
                tools: buildAllTools(getAppState()),
                commands: mcp.currentCommands,
                mcpClients: [
                  ...getAppState().mcp.clients,
                  ...mcp.sdkClients,
                  ...mcp.dynamicMcpState.clients,
                ],
                messages: session.messages,
                readFileState: loopState.readFileState,
                getAppState,
                setAppState,
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
                thinkingConfig: options.thinkingConfig,
                agents: mcp.currentAgents,
              })
          const result = await runSideQuestion({
            question,
            cacheSafeParams,
          })
          sendControlResponseSuccess(message, { response: result.response })
        } catch (e) {
          sendControlResponseError(message, errorMessage(e))
        }
      })()
    },
    remote_control: async (message) => {
      const req = message.request as unknown as { enabled: boolean }
      if (req.enabled) {
        if (bridgeState.handle) {
          // 已连接
          sendControlResponseSuccess(message, {
            session_url: getRemoteSessionUrl(
              bridgeState.handle.bridgeSessionId,
              bridgeState.handle.sessionIngressUrl,
            ),
            connect_url: buildWireConnectUrl(
              bridgeState.handle.environmentId,
              bridgeState.handle.sessionIngressUrl,
            ),
            environment_id: bridgeState.handle.environmentId,
          })
        } else {
          // initReplBridge 返回 null 前，会通过 onStateChange('failed', detail) 暴露开关失败原因。
          // 捕获该原因，使 control-response 错误包含可操作信息（如 "/login"、组织策略已禁用），
          // 而非泛泛的“初始化失败”。
          let bridgeFailureDetail: string | undefined
          try {
            const { initReplBridge } = await import('src/bridge/initReplBridge.js')
            const handle = await initReplBridge({
              onInboundMessage(msg) {
                const fields = extractInboundMessageFields(msg)
                if (!fields) {
                  return
                }
                const { content, uuid } = fields
                enqueue({
                  value: content,
                  mode: 'prompt' as const,
                  uuid,
                  skipSlashCommands: true,
                })
                kickRun()
              },
              onPermissionResponse(response) {
                // 将 bridge 权限响应转发到 stdin 处理循环，以解决 SDK 消费方待处理的权限请求。
                structuredIO.injectControlResponse(response)
              },
              onInterrupt() {
                loopState.abortController?.abort()
              },
              onSetModel(model) {
                const resolved = model === 'default' ? getDefaultMainLoopModel() : model
                loopState.activeUserSpecifiedModel = resolved
                setMainLoopModelOverride(resolved)
              },
              onSetMaxThinkingTokens(maxTokens) {
                if (maxTokens === null) {
                  options.thinkingConfig = undefined
                } else if (maxTokens === 0) {
                  options.thinkingConfig = { type: 'disabled' }
                } else {
                  options.thinkingConfig = {
                    type: 'enabled',
                    budgetTokens: maxTokens,
                  }
                }
              },
              onStateChange(state, detail) {
                if (state === 'failed') {
                  bridgeFailureDetail = detail
                }
                logForDebugging(
                  `[bridge:sdk] State change: ${state}${detail ? ` — ${detail}` : ''}`,
                )
                output.enqueue({
                  type: 'system' as StdoutMessage['type'],
                  subtype: 'bridge_state' as string,
                  state,
                  detail,
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                } as StdoutMessage)
              },
              initialMessages: session.messages.length > 0 ? session.messages : undefined,
            })
            if (!handle) {
              sendControlResponseError(
                message,
                bridgeFailureDetail ?? 'Remote Control initialization failed',
              )
            } else {
              bridgeState.handle = handle
              bridgeState.lastForwardedIndex = session.messages.length
              // 将权限请求转发到 bridge
              structuredIO.setOnControlRequestSent((request) => {
                handle.sendControlRequest(request)
              })
              // SDK 消费方先解决 can_use_tool 请求时，取消陈旧的 bridge 权限 prompt。
              structuredIO.setOnControlRequestResolved((requestId) => {
                handle.sendControlCancelRequest(requestId)
              })
              sendControlResponseSuccess(message, {
                session_url: getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl),
                connect_url: buildWireConnectUrl(handle.environmentId, handle.sessionIngressUrl),
                environment_id: handle.environmentId,
              })
            }
          } catch (err) {
            sendControlResponseError(message, errorMessage(err))
          }
        }
      } else {
        // 禁用
        if (bridgeState.handle) {
          structuredIO.setOnControlRequestSent(undefined)
          structuredIO.setOnControlRequestResolved(undefined)
          await bridgeState.handle.teardown()
          bridgeState.handle = null
        }
        sendControlResponseSuccess(message)
      }
    },
    // set_proactive 仅在 PROACTIVE/KAIROS feature 开启时注册;feature 关时此 key 不
    // 存在,落到下方「未知 subtype」错误响应,与迁移前的内联 else-if 行为一致。
    ...(feature('PROACTIVE')
      ? {
          set_proactive: (message: WireControlRequest): void => {
            const req = message.request as unknown as { subtype: string; enabled: boolean }
            if (req.enabled) {
              if (!proactiveModule?.isProactiveActive()) {
                proactiveModule!.activateProactive('command')
                scheduleProactiveTick!()
              }
            } else {
              proactiveModule!.deactivateProactive()
            }
            sendControlResponseSuccess(message)
          },
        }
      : {}),
    ...(feature('KAIROS')
      ? {
          set_proactive: (message: WireControlRequest): void => {
            const req = message.request as unknown as { subtype: string; enabled: boolean }
            if (req.enabled) {
              if (!proactiveModule?.isProactiveActive()) {
                proactiveModule!.activateProactive('command')
                scheduleProactiveTick!()
              }
            } else {
              proactiveModule!.deactivateProactive()
            }
            sendControlResponseSuccess(message)
          },
        }
      : {}),
  }

  for await (const message of structuredIO.structuredInput) {
    // 非用户事件内联处理，不进入队列。同一 tick 内从 started→completed 不携带有效信息，因此
    // 只发送 completed。control_response 由 StructuredIO.processLine 报告，它也能看到不会在
    // 此处 yield 的孤立响应。
    const eventId = 'uuid' in message ? message.uuid : undefined
    if (eventId && message.type !== 'user' && message.type !== 'control_response') {
      notifyCommandLifecycle(eventId, 'completed')
    }

    if (message.type === 'control_request') {
      const requestSubtype: string = message.request.subtype
      const controlHandler = controlHandlers[requestSubtype]
      if (controlHandler) {
        const outcome = await controlHandler(message)
        if (outcome === 'break') {
          break // 如 end_session:退出 for-await → 下方 inputClosed 收尾
        }
      } else {
        // 未知 control request subtype——回错误响应,避免调用方苦等不到回复。
        sendControlResponseError(
          message,
          `Unsupported control request subtype: ${(message.request as { subtype: string }).subtype}`,
        )
      }
      continue
    } else if (message.type === 'control_response') {
      // 启用 replay 模式时重放 control_response 消息
      if (options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    } else if (message.type === 'keep_alive') {
      // 静默忽略 keep-alive 消息
      continue
    } else if (message.type === 'update_environment_variables') {
      // 由 structuredIO.ts 处理，但 TypeScript 仍需要类型守卫
      continue
    } else if (message.type === 'assistant' || message.type === 'system') {
      // bridge 的历史重放：注入 session.messages 作为对话 context，使模型看到之前的 turn。
      const internalMsgs = toInternalMessages([message])
      session.appendMessages(...internalMsgs)
      // 回显 assistant 消息，使 CCR 能显示
      if (message.type === 'assistant' && options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    }
    // 上方处理 control、keep-alive、env-var、assistant 与 system 消息后，只应剩余用户消息。
    if (message.type !== 'user') {
      continue
    }

    // 若尚未初始化，首条 prompt 消息会隐式完成初始化。
    initialized = true

    // 检查重复用户消息；已处理则跳过
    if (message.uuid) {
      const sessionId = getSessionId() as UUID
      const existsInSession = await doesMessageExistInSession(sessionId, message.uuid as UUID)

      // 同时检查文件中的历史重复与当前会话的运行时重复
      if (existsInSession || receivedMessageUuids.has(message.uuid as UUID)) {
        logForDebugging(`Skipping duplicate user message: ${message.uuid}`)
        // 启用 replay 模式时对重复消息发送 ack
        if (options.replayUserMessages) {
          logForDebugging(`Sending acknowledgment for duplicate user message: ${message.uuid}`)
          output.enqueue({
            type: 'user',
            message: message.message,
            session_id: sessionId,
            parent_tool_use_id: null,
            uuid: message.uuid,
            timestamp: message.timestamp,
            isReplay: true,
          } as WireUserMessageReplay)
        }
        // 历史重复表示 transcript 已有该 turn 的输出，即执行过但生命周期未关闭（ack 前被中断）。
        // 运行时重复不需要此处理，原始入队路径会负责关闭。
        if (existsInSession) {
          notifyCommandLifecycle(message.uuid, 'completed')
        }
        // 不将重复消息加入执行队列
        continue
      }

      // 跟踪此 UUID，防止运行时重复
      trackReceivedMessageUuid(message.uuid as UUID)
    }

    enqueue({
      mode: 'prompt' as const,
      // file_attachments 通过 Web composer 的 protobuf catchall 传入。缺失时没有
      // 'file_attachments' key，保持同一引用且不操作。
      value: await resolveAndPrepend(message, message.message.content),
      uuid: message.uuid as UUID,
      priority: message.priority,
    })
    // 增加 prompt 计数供归因跟踪，并保存快照；快照持久化 promptCount，使其不受 compaction 影响。
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState((prev) => ({
        ...prev,
        attribution: incrementPromptCount(prev.attribution, (snapshot) => {
          void recordAttributionSnapshot(snapshot).catch((error) => {
            logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
          })
        }),
      }))
    }
    kickRun()
  }
  loopState.inputClosed = true
  cronScheduler?.stop()
  if (!loopState.running) {
    // 若 push suggestion 仍在进行，则关闭输出流前等待其发送；设置 5 秒安全超时以防挂起。
    if (suggestionState.inflightPromise) {
      await Promise.race([suggestionState.inflightPromise, sleep(5000)])
    }
    suggestionState.abortController?.abort()
    suggestionState.abortController = null
    await finalizePendingAsyncHooks()
    unsubscribeSkillChanges()
    unsubscribeAuthStatus?.()
    statusListeners.delete(rateLimitListener)
    output.done()
  }
}
