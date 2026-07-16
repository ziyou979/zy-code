// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { readFile, stat } from 'node:fs/promises'
import { redownloadUserSettings } from 'src/services/settings-sync/index.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type Tools } from 'src/tool.js'
import { type AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { dequeueAllMatching, enqueue, hasCommandsInQueue } from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import { notifySessionMetadataChanged } from 'src/services/session-state/sessionState.js'
import { logError } from 'src/utils/log.js'
import type { MCPServerConnection, McpSdkServerConfig } from 'src/services/mcp/types.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
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
import { generateSessionTitle } from 'src/utils/sessionTitle.js'
import { buildSideQuestionFallbackParams } from 'src/utils/queryContext.js'
import { runSideQuestion } from 'src/utils/sideQuestion.js'
import { getSettingsWithSources } from 'src/services/settings/settings.js'
import { settingsChangeDetector } from 'src/services/settings/changeDetector.js'
import { getLastCacheSafeParams } from 'src/utils/forkedAgent.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import { setSdkAgentProgressSummariesEnabled } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  doesMessageExistInSession,
  recordAttributionSnapshot,
  saveAiGeneratedTitle,
} from 'src/services/sessionStorage.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import { clearServerCache, reconnectMcpServerImpl } from 'src/services/mcp/client.js'
import {
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import { performMCPOAuthFlow, revokeServerTokens } from 'src/services/mcp/auth.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/services/mcp/utils.js'
import { toInternalMessages } from 'src/services/messages/mappers.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import { statusListeners, type ZyAILimits } from 'src/services/zyAiLimits.js'
import { getDefaultMainLoopModel, getMainLoopModel } from 'src/services/model/model.js'
import { modelSupportsEffort, resolveAppliedEffort } from 'src/utils/effort.js'
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
import { getCommands } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
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
  cronScheduler: import('../../utils/cronScheduler.js').CronScheduler | null
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

  // Handle unexpected permission responses by looking up the unresolved tool
  // call in the transcript and executing it
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async (message) => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // The first message of a session might be the orphaned permission
        // check rather than a user prompt, so kick off the loop.
        kickRun()
      },
    })
  })

  // Track active OAuth flows per server so we can abort a previous flow
  // when a new mcp_authenticate request arrives for the same server.
  const activeOAuthFlows = new Map<string, AbortController>()
  // Track manual callback URL submit functions for active OAuth flows.
  // Used when localhost is not reachable (e.g., browser-based IDEs).
  const oauthCallbackSubmitters = new Map<string, (callbackUrl: string) => void>()
  // Track servers where the manual callback was actually invoked (so the
  // automatic reconnect path knows to skip — the extension will reconnect).
  const oauthManualCallbackUsed = new Set<string>()
  // Track OAuth auth-only promises so mcp_oauth_callback_url can await
  // token exchange completion. Reconnect is handled separately by the
  // extension via handleAuthDone → mcp_reconnect.
  const oauthAuthPromises = new Map<string, Promise<void>>()

  // This is essentially spawning a parallel async task- we have two
  // running in parallel- one reading from stdin and adding to the
  // queue to be processed and another reading from the queue,
  // processing and returning the result of the generation.
  // The process is complete when the input stream completes and
  // the last generation of the queue has complete.
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
      // modelSupportsEffort gate matches zy.ts — applied.effort must
      // mirror what actually goes to the API, not just what's configured.
      const effort = modelSupportsEffort(model)
        ? resolveAppliedEffort(model, currentAppState.effortValue)
        : undefined
      sendControlResponseSuccess(message, {
        ...getSettingsWithSources(),
        applied: {
          model,
          // Numeric effort (ant-only) → null; SDK schema is string-level only.
          effort: typeof effort === 'string' ? effort : null,
        },
      })
    },
    interrupt: (message) => {
      // Track escapes for attribution (ant-only feature)
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
      // handleSetPermissionMode sends the control_response; the
      // notifySessionMetadataChanged that used to follow here is
      // now fired by onChangeAppState (with externalized mode name).
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
      // Handle MCP notifications from SDK servers
      const mcpRequest = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'mcp_message' }
      >
      const sdkClient = mcp.sdkClients.find((client) => client.name === mcpRequest.server_name)
      // Check client exists - dynamically added SDK servers may have
      // placeholder clients with null client until updateSdkMcp() runs
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
      // Connect SDK servers AFTER response to avoid deadlock
      if (sdkServersChanged) {
        void mcp.updateSdkMcp()
      }
    },
    apply_flag_settings: (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'apply_flag_settings' }
      >
      // Snapshot the current model before applying — we need to detect
      // model switches so we can inject breadcrumbs and notify listeners.
      const prevModel = getMainLoopModel()

      // Merge the provided settings into the in-memory flag settings
      const existing = getFlagSettingsInline() ?? {}
      const incoming = req.settings
      // Shallow-merge top-level keys; getSettingsForSource handles the deep
      // merge with file-based flag settings via mergeWith. JSON drops
      // `undefined`, so callers use `null` to clear a key — convert nulls
      // to deletions so SettingsSchema().safeParse() doesn't reject.
      const merged = { ...existing, ...incoming }
      for (const key of Object.keys(merged)) {
        if (merged[key as keyof typeof merged] === null) {
          delete merged[key as keyof typeof merged]
        }
      }
      setFlagSettingsInline(merged)
      // Route through notifyChange so fanOut() resets the settings cache
      // before listeners run (subscriber at :392 calls applySettingsChange).
      settingsChangeDetector.notifyChange('flagSettings')

      // If the incoming settings include a model change, update the override
      // so getMainLoopModel() reflects it (override outranks the cascade).
      if ('model' in incoming) {
        if (incoming.model != null) {
          setMainLoopModelOverride(String(incoming.model))
        } else {
          setMainLoopModelOverride(undefined)
        }
      }

      // If the model changed, inject breadcrumbs + notify metadata listeners.
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
      // Client observed a Read that was later removed from context (e.g.
      // by snip), so transcript-based seeding missed it. Queued into
      // pendingSeeds; applied at the next clone-replace boundary.
      try {
        // expandPath: all other readFileState writers normalize (~, relative,
        // session cwd vs process cwd). FileEditTool looks up by expandPath'd
        // key — a verbatim client path would miss.
        const normalizedPath = expandPath(req.path)
        // Check disk mtime before reading content. If the file changed
        // since the client's observation, readFile would return C_current
        // but we'd store it with the client's M_observed — getChangedFiles
        // then sees disk > cache.timestamp, re-reads, diffs C_current vs
        // C_current = empty, emits no attachment, and the model is never
        // told about the C_observed → C_current change. Skipping the seed
        // makes Edit fail "file not read yet" → forces a fresh Read.
        // Math.floor matches FileReadTool and getFileModificationTime.
        const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
        if (diskMtime <= req.mtime) {
          const raw = await readFile(normalizedPath, 'utf-8')
          // Strip BOM + normalize CRLF→LF to match readFileInRange and
          // readFileSyncWithMetadata. FileEditTool's content-compare
          // fallback (for Windows mtime bumps without content change)
          // compares against LF-normalized disk reads.
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
        // ENOENT etc — skip seeding but still succeed
      }
      sendControlResponseSuccess(message)
    },
    reload_plugins: async (message) => {
      try {
        if (
          feature('DOWNLOAD_USER_SETTINGS') &&
          (isEnvTruthy(process.env.ZY_CODE_REMOTE) || getIsRemoteMode())
        ) {
          // Re-pull user settings so enabledPlugins pushed from the
          // user's local CLI take effect before the cache sweep.
          const applied = await redownloadUserSettings()
          if (applied) {
            settingsChangeDetector.notifyChange('userSettings')
          }
        }

        const r = await refreshActivePlugins(setAppState)

        const sdkAgents = mcp.currentAgents.filter((a) => a.source === 'flagSettings')
        mcp.currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

        // Reload succeeded — gather response data best-effort so a
        // read failure doesn't mask the successful state change.
        // allSettled so one failure doesn't discard the others.
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
        // Pool spread matches mcp_status — all three client sources.
        [...currentAppState.mcp.clients, ...mcp.sdkClients, ...mcp.dynamicMcpState.clients],
        output,
      )
    },
    initialize: async (message) => {
      const req = message.request as Extract<
        WireControlRequest['request'],
        { subtype: 'initialize' }
      >
      // SDK MCP server names from the initialize message
      // Populated by both browser and ProcessTransport sessions
      if (req.sdkMcpServers && req.sdkMcpServers.length > 0) {
        for (const serverName of req.sdkMcpServers) {
          // Create placeholder config for SDK MCP servers
          // The actual server connection is managed by the SDK Query class
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

      // Enable prompt suggestions in AppState when SDK consumer opts in.
      // shouldEnablePromptSuggestion() returns false for non-interactive
      // sessions, but the SDK consumer explicitly requested suggestions.
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

      // If the auto-resume logic pre-enqueued a command, drain it now
      // that initialize has set up systemPrompt, agents, hooks, etc.
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
      // Config-existence gate must cover the SAME sources as the
      // operations below. SDK-injected servers (query({mcpServers:{...}}))
      // and dynamically-added servers were missing here, so
      // toggleMcpServer/reconnect returned "Server not found" even though
      // the disconnect/reconnect would have worked (gh-31339 / CC-314).
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
        // Update appState.mcp with the new client, tools, commands, and resources
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
        // Also update mcp.dynamicMcpState so run() picks up the new tools
        // on the next turn (run() reads mcp.dynamicMcpState, not appState)
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
      // Gate must match the client-lookup spread below (which
      // includes mcp.sdkClients and mcp.dynamicMcpState.clients). Same fix as
      // mcp_reconnect above (gh-31339 / CC-314).
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
        // Disabling: persist + disconnect (matches TUI toggleMcpServer behavior)
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
        // Update appState.mcp to reflect disabled status and remove tools/commands/resources
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
        // Enabling: persist + reconnect
        setMcpServerEnabled(serverName, true)
        const result = await reconnectMcpServerImpl(serverName, config)
        // Update appState.mcp with the new client, tools, commands, and resources
        // This ensures the LLM sees updated tools after enabling the server
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
          // Abort any previous in-flight OAuth flow for this server
          activeOAuthFlows.get(serverName)?.abort()
          const controller = new AbortController()
          activeOAuthFlows.set(serverName, controller)

          // Capture the auth URL from the callback
          let resolveAuthUrl: (url: string) => void
          const authUrlPromise = new Promise<string>((resolve) => {
            resolveAuthUrl = resolve
          })

          // Start the OAuth flow in the background
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

          // Wait for the auth URL (or the flow to complete without needing redirect)
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

          // Store auth-only promise for mcp_oauth_callback_url handler.
          // Don't swallow errors — the callback handler needs to detect
          // auth failures and report them to the caller.
          oauthAuthPromises.set(serverName, oauthPromise)

          // Handle background completion — reconnect after auth.
          // When manual callback is used, skip the reconnect here;
          // the extension's handleAuthDone → mcp_reconnect handles it
          // (which also updates mcp.dynamicMcpState for tool registration).
          const fullFlowPromise = oauthPromise
            .then(async () => {
              // Don't reconnect if the server was disabled during the OAuth flow
              if (isMcpServerDisabled(serverName)) {
                return
              }
              // Skip reconnect if the manual callback path was used —
              // handleAuthDone will do it via mcp_reconnect (which
              // updates mcp.dynamicMcpState for tool registration).
              if (oauthManualCallbackUsed.has(serverName)) {
                return
              }
              // Reconnect the server after successful auth
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
              // Also update mcp.dynamicMcpState so run() picks up the new tools
              // on the next turn (run() reads mcp.dynamicMcpState, not appState)
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
              // Clean up only if this is still the active flow
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
        // Validate the callback URL before submitting. The submit
        // callback in auth.ts silently ignores URLs missing a code
        // param, which would leave the auth promise unresolved and
        // block the control message loop until timeout.
        let hasCodeOrError = false
        try {
          const parsed = new URL(callbackUrl)
          hasCodeOrError = parsed.searchParams.has('code') || parsed.searchParams.has('error')
        } catch {
          // Invalid URL
        }
        if (!hasCodeOrError) {
          sendControlResponseError(
            message,
            'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
          )
        } else {
          oauthManualCallbackUsed.add(serverName)
          submit(callbackUrl)
          // Wait for auth (token exchange) to complete before responding.
          // Reconnect is handled by the extension via handleAuthDone →
          // mcp_reconnect (which updates mcp.dynamicMcpState for tools).
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
      // Fire-and-forget so the compact model call does not block the stdin loop
      // (which would delay processing of subsequent user messages /
      // interrupts for the duration of the API roundtrip).
      const { description, persist } = message.request as { description: string; persist?: boolean }
      // Reuse the live controller only if it has not already been aborted
      // (e.g. by interrupt()); an aborted signal would cause queryCompactModel to
      // immediately throw APIUserAbortError → {title: null}.
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
          // Unreachable in practice — generateSessionTitle wraps its
          // own body and returns null, saveAiGeneratedTitle is wrapped
          // above. Propagate (not swallow) so unexpected failures are
          // visible to the SDK caller (hostComms.ts catches and logs).
          sendControlResponseError(message, errorMessage(e))
        }
      })()
    },
    side_question: (message) => {
      // Same fire-and-forget pattern as generate_session_title above —
      // the forked agent's API roundtrip must not block the stdin loop.
      //
      // The snapshot captured by stopHooks (for querySource === 'sdk')
      // holds the exact systemPrompt/userContext/systemContext/messages
      // sent on the last main-thread turn. Reusing them gives a byte-
      // identical prefix → prompt cache hit.
      //
      // Fallback (resume before first turn completes — no snapshot yet):
      // rebuild from scratch. buildSideQuestionFallbackParams mirrors
      // QueryEngine.ts:ask()'s system prompt assembly (including
      // --system-prompt / --append-system-prompt) so the rebuilt prefix
      // matches in the common case. May still miss the cache for
      // coordinator mode or memory-mechanics extras — acceptable, the
      // alternative is the side question failing entirely.
      const { question } = message.request as { question: string }
      void (async () => {
        try {
          const saved = getLastCacheSafeParams()
          const cacheSafeParams = saved
            ? {
                ...saved,
                // If the last turn was interrupted, the snapshot holds an
                // already-aborted controller; createChildAbortController in
                // createSubagentContext would propagate it and the fork
                // would die before sending a request. The controller is
                // not part of the cache key — swapping in a fresh one is
                // safe. Same guard as generate_session_title above.
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
          // Already connected
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
          // initReplBridge surfaces gate-failure reasons via
          // onStateChange('failed', detail) before returning null.
          // Capture so the control-response error is actionable
          // ("/login", "disabled by your organization's policy", etc.)
          // instead of a generic "initialization failed".
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
                // Forward bridge permission responses into the
                // stdin processing loop so they resolve pending
                // permission requests from the SDK consumer.
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
              // Forward permission requests to the bridge
              structuredIO.setOnControlRequestSent((request) => {
                handle.sendControlRequest(request)
              })
              // Cancel stale bridge permission prompts when the SDK
              // consumer resolves a can_use_tool request first.
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
        // Disable
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
    ...(feature('PROACTIVE') || feature('KAIROS')
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
    // Non-user events are handled inline (no queue). started→completed in
    // the same tick carries no information, so only fire completed.
    // control_response is reported by StructuredIO.processLine (which also
    // sees orphans that never yield here).
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
      // Replay control_response messages when replay mode is enabled
      if (options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    } else if (message.type === 'keep_alive') {
      // Silently ignore keep-alive messages
      continue
    } else if (message.type === 'update_environment_variables') {
      // Handled in structuredIO.ts, but TypeScript needs the type guard
      continue
    } else if (message.type === 'assistant' || message.type === 'system') {
      // History replay from bridge: inject into session.messages as
      // conversation context so the model sees prior turns.
      const internalMsgs = toInternalMessages([message])
      session.appendMessages(...internalMsgs)
      // Echo assistant messages back so CCR displays them
      if (message.type === 'assistant' && options.replayUserMessages) {
        output.enqueue(message)
      }
      continue
    }
    // After handling control, keep-alive, env-var, assistant, and system
    // messages above, only user messages should remain.
    if (message.type !== 'user') {
      continue
    }

    // First prompt message implicitly initializes if not already done.
    initialized = true

    // Check for duplicate user message - skip if already processed
    if (message.uuid) {
      const sessionId = getSessionId() as UUID
      const existsInSession = await doesMessageExistInSession(sessionId, message.uuid as UUID)

      // Check both historical duplicates (from file) and runtime duplicates (this session)
      if (existsInSession || receivedMessageUuids.has(message.uuid as UUID)) {
        logForDebugging(`Skipping duplicate user message: ${message.uuid}`)
        // Send acknowledgment for duplicate message if replay mode is enabled
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
        // Historical dup = transcript already has this turn's output, so it
        // ran but its lifecycle was never closed (interrupted before ack).
        // Runtime dups don't need this — the original enqueue path closes them.
        if (existsInSession) {
          notifyCommandLifecycle(message.uuid, 'completed')
        }
        // Don't enqueue duplicate messages for execution
        continue
      }

      // Track this UUID to prevent runtime duplicates
      trackReceivedMessageUuid(message.uuid as UUID)
    }

    enqueue({
      mode: 'prompt' as const,
      // file_attachments rides the protobuf catchall from the web composer.
      // Same-ref no-op when absent (no 'file_attachments' key).
      value: await resolveAndPrepend(message, message.message.content),
      uuid: message.uuid as UUID,
      priority: message.priority,
    })
    // Increment prompt count for attribution tracking and save snapshot
    // The snapshot persists promptCount so it survives compaction
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
    // If a push-suggestion is in-flight, wait for it to emit before closing
    // the output stream (5 s safety timeout to prevent hanging).
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
