// McpRuntime — headless 模式下 MCP/插件相关的可变状态 + 行为容器。
//
// 收拢 runHeadlessStreaming 闭包中散布的 MCP 状态,并把 7 个 MCP/插件嵌套函数
// 收为方法(Phase 2b)。稳定依赖(structuredIO/getAppState/setAppState/sdkMcpConfigs/
// handleMcpSetServers)构造时注入。控制循环里对 MCP 状态的引用仍直接读 mcp.xxx,
// 留 Phase 3 改路由。
//
// handleMcpSetServers 仍定义在 print.ts(连同 reconcileMcpServers,且在 api-snapshot
// 导出面里),作为依赖注入以避免 print.ts ←→ mcpRuntime.ts 的运行时循环导入。

import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { cwd } from 'node:process'
import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import type { StructuredIO } from 'src/cli/structuredIO.js'
import type { Command } from 'src/commands/index.js'
import { getCommands } from 'src/commands/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isChannelAllowlisted, isChannelsEnabled } from 'src/services/mcp/channelAllowlist.js'
import { setupSdkMcpClients } from 'src/services/mcp/client.js'
import { getAllMcpConfigs } from 'src/services/mcp/config.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/services/mcp/elicitationHandler.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import type {
  MCPServerConnection,
  McpStdioServerConfig,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import { filterToolsByServer } from 'src/services/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/services/mcp/vscodeMcp.js'
import { waitForRemoteManagedSettingsToLoad } from 'src/services/remote-managed-settings/index.js'
import { downloadUserSettings } from 'src/services/settings-sync/index.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { Tools } from 'src/tools/tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { McpServerConfigForProcessTransport, McpServerStatus } from 'src/types/index.js'
import type { WireControlMcpSetServersResponse } from 'src/types/wire/control.js'
import { uniq } from 'src/utils/array.js'
import { logForDebugging } from 'src/utils/debug.js'
import { withDiagnosticsTiming } from 'src/utils/diagLogs.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { executeNotificationHooks } from 'src/services/hooks.js'
import { logError, logMCPDebug } from 'src/utils/log.js'
import { installPluginsForHeadless } from 'src/services/plugins/headlessPluginInstall.js'
import { refreshActivePlugins } from 'src/services/plugins/refresh.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

// ── 类型(从 print.ts 搬出,print.ts re-export 保持导出面不变) ──

export type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}

/** handleMcpSetServers 的类型 —— 纯类型引用 print.ts(运行时不产生循环依赖)。 */
type HandleMcpSetServers = typeof import('src/cli/print.js')['handleMcpSetServers']

// ── 构造依赖 ──

export type McpRuntimeDeps = {
  structuredIO: StructuredIO
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  /** runHeadless 的 sdkMcpConfigs 入参;就地 mutate(delete/Object.assign),持有同一引用。 */
  sdkMcpConfigs: Record<string, McpSdkServerConfig>
  /** 定义在 print.ts,注入以避免循环导入。 */
  handleMcpSetServers: HandleMcpSetServers
  initialCommands: Command[]
  initialAgents: AgentDefinition[]
}

// ── McpRuntime ──

export class McpRuntime {
  /** SDK MCP clients;updateSdkMcp/applyMcpServerChanges 会重新赋值。 */
  sdkClients: MCPServerConnection[] = []
  /** SDK MCP tools;同上。 */
  sdkTools: Tools = []
  /** 追踪哪些 MCP client 已注册 elicitation handler。 */
  readonly elicitationRegistered = new Set<string>()
  /** 动态(控制消息/插件)添加的 MCP 服务器状态。 */
  dynamicMcpState: DynamicMcpState = { clients: [], tools: [], configs: {} }
  /** 序列化并发 applyMcpServerChanges 调用的 promise 链。 */
  mcpChangesPromise: Promise<{
    response: WireControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> = Promise.resolve({
    response: { added: [], removed: [], errors: {} },
    sdkServersChanged: false,
  })
  /** 后台插件安装 promise;null 表示未启动。 */
  pluginInstallPromise: Promise<void> | null = null
  /** 热更新后的命令列表(初始 = runHeadless 入参 commands)。 */
  currentCommands: Command[]
  /** 热更新后的 agents 列表(初始 = runHeadless 入参 agents)。 */
  currentAgents: AgentDefinition[]

  // 注入依赖
  protected readonly structuredIO: StructuredIO
  protected readonly output: StructuredIO['outbound']
  protected readonly getAppState: () => AppState
  protected readonly setAppState: (f: (prev: AppState) => AppState) => void
  protected readonly sdkMcpConfigs: Record<string, McpSdkServerConfig>
  protected readonly handleMcpSetServers: HandleMcpSetServers

  constructor(deps: McpRuntimeDeps) {
    this.structuredIO = deps.structuredIO
    this.output = deps.structuredIO.outbound
    this.getAppState = deps.getAppState
    this.setAppState = deps.setAppState
    this.sdkMcpConfigs = deps.sdkMcpConfigs
    this.handleMcpSetServers = deps.handleMcpSetServers
    this.currentCommands = deps.initialCommands
    this.currentAgents = deps.initialAgents
  }

  /**
   * Register elicitation request/completion handlers on connected MCP clients
   * that haven't been registered yet. SDK MCP servers are excluded because they
   * route through WireControlClientTransport. Hooks run first (matching REPL
   * behavior); if no hook responds, the request is forwarded to the SDK
   * consumer via the control protocol.
   */
  registerElicitationHandlers(clients: MCPServerConnection[]): void {
    for (const connection of clients) {
      if (connection.type !== 'connected' || this.elicitationRegistered.has(connection.name)) {
        continue
      }
      // Skip SDK MCP servers — elicitation flows through WireControlClientTransport
      if (connection.config.type === 'sdk') {
        continue
      }
      const serverName = connection.name

      // Wrapped in try/catch because setRequestHandler throws if the client wasn't
      // created with elicitation capability declared (e.g., SDK-created clients).
      try {
        connection.client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
          logMCPDebug(
            serverName,
            `Elicitation request received in print mode: ${jsonStringify(request)}`,
          )

          const mode = request.params.mode === 'url' ? 'url' : 'form'

          logEvent('zy_mcp_elicitation_shown', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })

          // Run elicitation hooks first — they can provide a response programmatically
          const hookResponse = await runElicitationHooks(serverName, request.params, extra.signal)
          if (hookResponse) {
            logMCPDebug(serverName, `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`)
            logEvent('zy_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return hookResponse
          }

          // Delegate to SDK consumer via control protocol
          const url = 'url' in request.params ? (request.params.url as string) : undefined
          const requestedSchema =
            'requestedSchema' in request.params
              ? (request.params.requestedSchema as Record<string, unknown> | undefined)
              : undefined

          const elicitationId =
            'elicitationId' in request.params
              ? (request.params.elicitationId as string | undefined)
              : undefined

          const rawResult = await this.structuredIO.handleElicitation(
            serverName,
            request.params.message,
            requestedSchema,
            extra.signal,
            mode,
            url,
            elicitationId,
          )

          const result = await runElicitationResultHooks(
            serverName,
            rawResult,
            extra.signal,
            mode,
            elicitationId,
          )

          logEvent('zy_mcp_elicitation_response', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            action: result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return result
        })

        // Surface completion notifications to SDK consumers (URL mode)
        connection.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          (notification) => {
            const { elicitationId } = notification.params
            logMCPDebug(serverName, `Elicitation completion notification: ${elicitationId}`)
            void executeNotificationHooks({
              message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
              notificationType: 'elicitation_complete',
            })
            this.output.enqueue({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        )

        this.elicitationRegistered.add(serverName)
      } catch {
        // setRequestHandler throws if the client wasn't created with
        // elicitation capability — skip silently
      }
    }
  }

  async updateSdkMcp(): Promise<void> {
    // Check if SDK MCP servers need to be updated (new servers added or removed)
    const currentServerNames = new Set(Object.keys(this.sdkMcpConfigs))
    const connectedServerNames = new Set(this.sdkClients.map((c) => c.name))

    // Check if there are any differences (additions or removals)
    const hasNewServers = Array.from(currentServerNames).some(
      (name) => !connectedServerNames.has(name),
    )
    const hasRemovedServers = Array.from(connectedServerNames).some(
      (name) => !currentServerNames.has(name),
    )
    // Check if any SDK clients are pending and need to be upgraded
    const hasPendingSdkClients = this.sdkClients.some((c) => c.type === 'pending')
    // Check if any SDK clients failed their handshake and need to be retried.
    // Without this, a client that lands in 'failed' (e.g. handshake timeout on
    // a WS reconnect race) stays failed forever — its name satisfies the
    // connectedServerNames diff but it contributes zero tools.
    const hasFailedSdkClients = this.sdkClients.some((c) => c.type === 'failed')

    const haveServersChanged =
      hasNewServers || hasRemovedServers || hasPendingSdkClients || hasFailedSdkClients

    if (haveServersChanged) {
      // Clean up removed servers
      for (const client of this.sdkClients) {
        if (!currentServerNames.has(client.name)) {
          if (client.type === 'connected') {
            await client.cleanup()
          }
        }
      }

      // Re-initialize all SDK MCP servers with current config
      const sdkSetup = await setupSdkMcpClients(this.sdkMcpConfigs, (serverName, message) =>
        this.structuredIO.sendMcpMessage(serverName, message),
      )
      this.sdkClients = sdkSetup.clients
      this.sdkTools = sdkSetup.tools

      // Store SDK MCP tools in appState so subagents can access them via
      // assembleToolPool. Only tools are stored here — SDK clients are already
      // merged separately in the query loop (allMcpClients) and mcp_status handler.
      // Use both old (connectedServerNames) and new (currentServerNames) to remove
      // stale SDK tools when servers are added or removed.
      const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
      this.setAppState((prev) => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              (t) => !allSdkNames.some((name) => t.name.startsWith(getMcpPrefix(name))),
            ),
            ...this.sdkTools,
          ],
        },
      }))

      // Set up the special internal VSCode MCP server if necessary.
      setupVscodeSdkMcp(this.sdkClients)
    }
  }

  applyMcpServerChanges(servers: Record<string, McpServerConfigForProcessTransport>): Promise<{
    response: WireControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> {
    // Serialize calls to prevent race conditions between concurrent callers
    // (background plugin install and mcp_set_servers control messages)
    const doWork = async (): Promise<{
      response: WireControlMcpSetServersResponse
      sdkServersChanged: boolean
    }> => {
      const oldSdkClientNames = new Set(this.sdkClients.map((c) => c.name))

      const result = await this.handleMcpSetServers(
        servers,
        { configs: this.sdkMcpConfigs, clients: this.sdkClients, tools: this.sdkTools },
        this.dynamicMcpState,
        this.setAppState,
      )

      // Update SDK state (need to mutate sdkMcpConfigs since it's shared)
      for (const key of Object.keys(this.sdkMcpConfigs)) {
        delete this.sdkMcpConfigs[key]
      }
      Object.assign(this.sdkMcpConfigs, result.newWireState.configs)
      this.sdkClients = result.newWireState.clients
      this.sdkTools = result.newWireState.tools
      this.dynamicMcpState = result.newDynamicState

      // Keep appState.mcp.tools in sync so subagents can see SDK MCP tools.
      // Use both old and new SDK client names to remove stale tools.
      if (result.sdkServersChanged) {
        const newSdkClientNames = new Set(this.sdkClients.map((c) => c.name))
        const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
        this.setAppState((prev) => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: [
              ...prev.mcp.tools.filter(
                (t) => !allSdkNames.some((name) => t.name.startsWith(getMcpPrefix(name))),
              ),
              ...this.sdkTools,
            ],
          },
        }))
      }

      return {
        response: result.response,
        sdkServersChanged: result.sdkServersChanged,
      }
    }

    this.mcpChangesPromise = this.mcpChangesPromise.then(doWork, doWork)
    return this.mcpChangesPromise
  }

  // Build McpServerStatus[] for control responses. Shared by mcp_status and
  // reload_plugins handlers. Reads this.sdkClients, this.dynamicMcpState.
  buildMcpServerStatuses(): McpServerStatus[] {
    const currentAppState = this.getAppState()
    const currentMcpClients = currentAppState.mcp.clients
    const allMcpTools = uniqBy(
      [...currentAppState.mcp.tools, ...this.dynamicMcpState.tools],
      'name',
    )
    const existingNames = new Set([
      ...currentMcpClients.map((c) => c.name),
      ...this.sdkClients.map((c) => c.name),
    ])
    return [
      ...currentMcpClients,
      ...this.sdkClients,
      ...this.dynamicMcpState.clients.filter((c) => !existingNames.has(c.name)),
    ].map((connection) => {
      let config
      if (connection.config.type === 'sse' || connection.config.type === 'http') {
        config = {
          type: connection.config.type,
          url: connection.config.url,
          headers: connection.config.headers,
          oauth: connection.config.oauth,
        }
      } else if (connection.config.type === 'zyai-proxy') {
        config = {
          type: 'zyai-proxy' as const,
          url: connection.config.url,
          id: connection.config.id,
        }
      } else if (connection.config.type === 'stdio' || connection.config.type === undefined) {
        const stdioConfig = connection.config as ScopedMcpServerConfig & McpStdioServerConfig
        config = {
          type: 'stdio' as const,
          command: stdioConfig.command,
          args: stdioConfig.args,
        }
      }
      const serverTools =
        connection.type === 'connected'
          ? filterToolsByServer(allMcpTools, connection.name).map((tool) => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined
      // Capabilities passthrough with allowlist pre-filter. The IDE reads
      // experimental['zy/channel'] to decide whether to show the
      // Enable-channel prompt — only echo it if channel_enable would
      // actually pass the allowlist. Not a security boundary (the
      // handler re-runs the full gate); just avoids dead buttons.
      let capabilities: { experimental?: Record<string, unknown> } | undefined
      if (
        (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
        connection.type === 'connected' &&
        connection.capabilities.experimental
      ) {
        const exp = { ...connection.capabilities.experimental }
        if (
          exp['zy/channel'] &&
          (!isChannelsEnabled() || !isChannelAllowlisted(connection.config.pluginSource))
        ) {
          delete exp['zy/channel']
        }
        if (Object.keys(exp).length > 0) {
          capabilities = { experimental: exp }
        }
      }
      return {
        name: connection.name,
        status: connection.type,
        serverInfo: connection.type === 'connected' ? connection.serverInfo : undefined,
        error: connection.type === 'failed' ? connection.error : undefined,
        config,
        scope: connection.config.scope,
        tools: serverTools,
        capabilities,
      }
    })
  }

  async installPluginsAndApplyMcpInBackground(): Promise<void> {
    try {
      // Join point for user settings (fired at runHeadless entry) and managed
      // settings (fired in main.tsx preAction). downloadUserSettings() caches
      // its promise so this awaits the same in-flight request.
      await Promise.all([
        feature('DOWNLOAD_USER_SETTINGS') &&
        (isEnvTruthy(process.env.ZY_CODE_REMOTE) || getIsRemoteMode())
          ? withDiagnosticsTiming('headless_user_settings_download', () => downloadUserSettings())
          : Promise.resolve(),
        withDiagnosticsTiming('headless_managed_settings_wait', () =>
          waitForRemoteManagedSettingsToLoad(),
        ),
      ])

      const pluginsInstalled = await installPluginsForHeadless()

      if (pluginsInstalled) {
        await this.applyPluginMcpDiff()
      }
    } catch (error) {
      logError(error)
    }
  }

  // Clear all plugin-related caches, reload commands/agents/hooks.
  // Called after ZY_CODE_SYNC_PLUGIN_INSTALL completes (before first query)
  // and after non-sync background install finishes.
  async refreshPluginState(): Promise<void> {
    // refreshActivePlugins handles the full cache sweep (clearAllCaches),
    // reloads all plugin component loaders, writes AppState.plugins +
    // AppState.agentDefinitions, registers hooks, and bumps mcp.pluginReconnectKey.
    const { agentDefinitions: freshAgentDefs } = await refreshActivePlugins(this.setAppState)

    // Headless-specific: currentCommands/currentAgents are local mutable refs
    // captured by the query loop (REPL uses AppState instead). getCommands is
    // fresh because refreshActivePlugins cleared its cache.
    this.currentCommands = await getCommands(cwd())

    // Preserve SDK-provided agents (--agents CLI flag or SDK initialize
    // control_request) — both inject via parseAgentsFromJson with
    // source='flagSettings'. loadMarkdownFilesForSubdir never assigns this
    // source, so it cleanly discriminates "injected, not disk-loadable".
    const sdkAgents = this.currentAgents.filter((a) => a.source === 'flagSettings')
    this.currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
  }

  // Re-diff MCP configs after plugin state changes. Filters to
  // process-transport-supported types and carries SDK-mode servers through
  // so applyMcpServerChanges' diff doesn't close their transports.
  async applyPluginMcpDiff(): Promise<void> {
    const { servers: newConfigs } = await getAllMcpConfigs()
    const supportedConfigs: Record<string, McpServerConfigForProcessTransport> = {}
    for (const [name, config] of Object.entries(newConfigs)) {
      const type = config.type
      if (
        type === undefined ||
        type === 'stdio' ||
        type === 'sse' ||
        type === 'http' ||
        type === 'sdk'
      ) {
        supportedConfigs[name] = config as McpServerConfigForProcessTransport
      }
    }
    for (const [name, config] of Object.entries(this.sdkMcpConfigs)) {
      if ((config as Record<string, unknown>).type === 'sdk' && !(name in supportedConfigs)) {
        supportedConfigs[name] = config as McpServerConfigForProcessTransport
      }
    }
    const { response, sdkServersChanged } = await this.applyMcpServerChanges(supportedConfigs)
    if (sdkServersChanged) {
      void this.updateSdkMcp()
    }
    logForDebugging(
      `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
    )
  }
}

export function createMcpRuntime(deps: McpRuntimeDeps): McpRuntime {
  return new McpRuntime(deps)
}
