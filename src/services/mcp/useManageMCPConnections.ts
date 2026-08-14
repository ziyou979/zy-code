import { feature } from 'bun:bundle'
import { setChannelPermissionCallbacks } from '../../bootstrap/runtime/runtimeContext.js'
import { basename } from 'node:path'
import { useCallback, useEffect, useRef } from 'react'
import { getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import type { Command } from '../../commands/index.js'
import type { Tool } from '../../tools/tool.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  reconnectMcpServerImpl,
} from './client.js'
import type { MCPServerConnection, ScopedMcpServerConfig, ServerResource } from './types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js'))
      .fetchMcpSkillsForClient
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('../skill-search/localSearch.js') as typeof import('../skill-search/localSearch.js'))
      .clearSkillIndexCache
  : null

import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  dedupZyAIMcpServers,
  filterMcpServersByPolicy,
  getZyCodeMcpConfigs,
} from 'src/services/mcp/configResolution.js'
import { doesEnterpriseMcpConfigExist } from 'src/services/mcp/configLookup.js'
import { isMcpServerDisabled, setMcpServerEnabled } from 'src/services/mcp/serverEnablement.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { PluginError } from 'src/services/plugins/types.js'
import { createDebugLog } from 'src/services/infra/debug.js'

const mcpLog = createDebugLog('mcp')

import { getAllowedChannels } from '../../bootstrap/runtime/runtimeContext.js'
import { useNotifications } from '../../context/notifications.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { errorMessage } from '../../utils/errors.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { logMCPDebug, logMCPError } from '../../services/infra/log.js'
import { enqueue } from '../../services/input/messageQueueManager.js'
import {
  CHANNEL_PERMISSION_METHOD,
  ChannelMessageNotificationSchema,
  ChannelPermissionNotificationSchema,
  findChannelEntry,
  gateChannelServer,
  wrapChannelMessage,
} from './channelNotification.js'
import {
  type ChannelPermissionCallbacks,
  createChannelPermissionCallbacks,
  isChannelPermissionRelayEnabled,
} from './channelPermissions.js'
import { registerElicitationHandler } from './elicitationHandler.js'
import {
  addErrorsToAppState,
  applyPendingMcpUpdates,
  type PendingMcpUpdate,
} from './mcpConnectionReducer.js'
import { getTransportDisplayName } from './transportPresentation.js'
import { excludeStalePluginClients } from './utils.js'
import { clearZyAIMcpConfigsCache, fetchZyAIMcpConfigsIfEligible } from './zyai.js'

// 指数退避重连所用常量
const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

/**
 * 管理 MCP（Model Context Protocol）server 连接和更新的 hook。
 *
 * 此 hook 会：
 * 1. 根据配置初始化 MCP client 连接；
 * 2. 设置连接生命周期事件 handler，并与 app state 同步；
 * 3. 管理 SSE 连接的自动重连；
 * 4. 返回重连函数。
 */
export function useManageMCPConnections(
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined,
  isStrictMcpConfig = false,
) {
  const store = useAppStateStore()
  const _authVersion = useAppState((s) => s.authVersion)
  // /reload-plugins（refreshActivePlugins）会递增此值，以读取新启用的 plugin MCP server。
  // getZyCodeMcpConfigs() 调用已由 refreshActivePlugins 清除缓存的 loadAllPlugins()，因此
  // 下方 effect 重新运行时能看到最新 plugin 数据。
  const _pluginReconnectKey = useAppState((s) => s.mcp.pluginReconnectKey)
  const setAppState = useSetAppState()

  // 跟踪活跃重连尝试，以便取消
  const reconnectTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  // 按 skip kind 对 --channels 阻止警告去重，使用户看到“运行 /login”（auth skip）并登录后，
  // 若又触发 policy gate，仍能收到第二条 toast。
  const channelWarnedKindsRef = useRef<
    Set<'disabled' | 'auth' | 'policy' | 'marketplace' | 'allowlist'>
  >(new Set())
  // Channel 权限回调只构造一次，ref 稳定。回调通过 runtimeContext 暴露给权限流程；
  // pending Map 仍位于闭包中，避免把函数或请求状态塞进可序列化的 AppState。
  const channelPermCallbacksRef = useRef<ChannelPermissionCallbacks | null>(null)
  if (feature('KAIROS')) {
    if (channelPermCallbacksRef.current === null) {
      channelPermCallbacksRef.current = createChannelPermissionCallbacks()
    }
  } else if (feature('KAIROS_CHANNELS')) {
    if (channelPermCallbacksRef.current === null) {
      channelPermCallbacksRef.current = createChannelPermissionCallbacks()
    }
  }
  // 向 runtimeContext 发布稳定回调，卸载时清除，避免跨会话残留。
  useEffect(() => {
    const publishCallbacks = (): (() => void) | undefined => {
      const callbacks = channelPermCallbacksRef.current
      if (!callbacks || !isChannelPermissionRelayEnabled()) {
        return undefined
      }
      setChannelPermissionCallbacks(callbacks)
      return () => setChannelPermissionCallbacks(undefined)
    }

    if (feature('KAIROS')) {
      // GrowthBook runtime gate 与 channels 分离，使 channels 可独立发布。挂载时检查；会话中途变化
      // 需重启。关闭时，runtimeContext 中没有回调 → interactiveHandler 不发送 →
      // intercept 没有 pending 项 → "yes tbxkq" 作为普通 chat 流入 Zy。一个开关即可完全禁用。
      return publishCallbacks()
    }
    if (feature('KAIROS_CHANNELS')) {
      // GrowthBook runtime gate 与 channels 分离，使 channels 可独立发布。挂载时检查；会话中途变化
      // 需重启。关闭时，runtimeContext 中没有回调 → interactiveHandler 不发送 →
      // intercept 没有 pending 项 → "yes tbxkq" 作为普通 chat 流入 Zy。一个开关即可完全禁用。
      return publishCallbacks()
    }
  }, [])
  const { addNotification } = useNotifications()

  // 批量更新 MCP 状态：将各 server 更新入队，并通过 setTimeout 在一次 setAppState 中刷新。
  // 使用时间窗口而非 queueMicrotask，确保网络 IO 导致连接回调分时到达时仍能合并更新。
  const MCP_BATCH_FLUSH_MS = 16
  const pendingUpdatesRef = useRef<PendingMcpUpdate[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingUpdates = useCallback(() => {
    flushTimerRef.current = null
    const updates = pendingUpdatesRef.current
    if (updates.length === 0) {
      return
    }
    pendingUpdatesRef.current = []

    setAppState((prevState) => applyPendingMcpUpdates(prevState, updates))
  }, [setAppState])

  // 更新 server 状态、tools、commands 和 resources。tools、commands 或 resources 为
  // undefined 时保留现有值；type 为 disabled 或 failed 时自动清除它们。通过 setTimeout
  // 批量合并 MCP_BATCH_FLUSH_MS 时间窗内到达的更新。
  const updateServer = useCallback(
    (update: PendingMcpUpdate) => {
      pendingUpdatesRef.current.push(update)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flushPendingUpdates, MCP_BATCH_FLUSH_MS)
      }
    },
    [flushPendingUpdates],
  )

  const onConnectionAttempt = useCallback(
    ({
      client,
      tools,
      commands,
      resources,
    }: {
      client: MCPServerConnection
      tools: Tool[]
      commands: Command[]
      resources?: ServerResource[]
    }) => {
      updateServer({ ...client, tools, commands, resources })

      // 根据 client 状态处理副作用
      switch (client.type) {
        case 'connected': {
          // 用真实 handler 覆盖 connectToServer 注册的默认 elicitation handler；真实 handler
          // 会将 elicitation 加入 AppState 供 UI 使用。在此处每次连接注册一次，而不是放入
          // [mcpClients] effect，可避免每次状态变化都为全部已连接 server 重复运行。
          registerElicitationHandler(client.client, client.name, setAppState)

          client.client.onclose = () => {
            const configType = client.config.type ?? 'stdio'

            clearServerCache(client.name, client.config).catch(() => {
              mcpLog(`Failed to invalidate the server cache: ${client.name}`)
            })

            // TODO：理想情况下应以 appState 为事实来源，判断断连是否由禁用导致；但此时 appState
            // 已滞后，而获取 appState 实时引用也不够稳妥，因此暂时检查磁盘状态，后续可考虑重构。
            if (isMcpServerDisabled(client.name)) {
              logMCPDebug(client.name, `Server is disabled, skipping automatic reconnection`)
              return
            }

            // 为远程 transport 处理自动重连；stdio（本地进程）和 sdk（内部）不支持重连，跳过
            if (configType !== 'stdio' && configType !== 'sdk') {
              const transportType = getTransportDisplayName(configType)
              logMCPDebug(
                client.name,
                `${transportType} transport closed/disconnected, attempting automatic reconnection`,
              )

              // 取消此 server 现有的重连尝试
              const existingTimer = reconnectTimersRef.current.get(client.name)
              if (existingTimer) {
                clearTimeout(existingTimer)
                reconnectTimersRef.current.delete(client.name)
              }

              // 使用指数退避尝试重连
              const reconnectWithBackoff = async () => {
                for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
                  // 检查等待期间 server 是否已禁用
                  if (isMcpServerDisabled(client.name)) {
                    logMCPDebug(client.name, `Server disabled during reconnection, stopping retry`)
                    reconnectTimersRef.current.delete(client.name)
                    return
                  }

                  updateServer({
                    ...client,
                    type: 'pending',
                    reconnectAttempt: attempt,
                    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
                  })

                  const reconnectStartTime = Date.now()
                  try {
                    const result = await reconnectMcpServerImpl(client.name, client.config)
                    const elapsed = Date.now() - reconnectStartTime

                    if (result.client.type === 'connected') {
                      logMCPDebug(
                        client.name,
                        `${transportType} reconnection successful after ${elapsed}ms (attempt ${attempt})`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }

                    logMCPDebug(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} completed with status: ${result.client.type}`,
                    )

                    // 最后一次尝试时使用结果更新状态
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }
                  } catch (error) {
                    const elapsed = Date.now() - reconnectStartTime
                    logMCPError(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} failed after ${elapsed}ms: ${error}`,
                    )

                    // 最后一次尝试时标记为 failed
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      updateServer({ ...client, type: 'failed' })
                      return
                    }
                  }

                  // 按指数退避安排下一次重试
                  const backoffMs = Math.min(
                    INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
                    MAX_BACKOFF_MS,
                  )
                  logMCPDebug(
                    client.name,
                    `Scheduling reconnection attempt ${attempt + 1} in ${backoffMs}ms`,
                  )

                  await new Promise<void>((resolve) => {
                    // eslint-disable-next-line no-restricted-syntax -- timer stored in ref for cancellation; sleep() doesn't expose the handle
                    const timer = setTimeout(resolve, backoffMs)
                    reconnectTimersRef.current.set(client.name, timer)
                  })
                }
              }

              void reconnectWithBackoff()
            } else {
              updateServer({ ...client, type: 'failed' })
            }
          }

          // Channel push：notifications/zy/channel → enqueue()。gate 决定是否注册 handler；
          // 无论是否注册，连接都保持运行，由 allowedMcpServers 控制。
          if (feature('KAIROS')) {
            const gate = gateChannelServer(
              client.name,
              client.capabilities,
              client.config.pluginSource,
            )
            const entry = findChannelEntry(client.name, getAllowedChannels())
            // Plugin telemetry 标识符：所有 plugin-kind 条目记录 name@marketplace，与不受 gate
            // 限制、会记录任意 plugin_id+marketplace_name 的 zy_plugin_installed 同级。
            // server-kind 名称属于 MCP-server-name 层级，其他位置需 opt-in 才记录（参见
            // metadata.ts 的 isAnalyticsToolDetailsLoggingEnabled），此处不记录；其余由
            // is_dev/entry_kind 分段。
            const pluginId =
              entry?.kind === 'plugin'
                ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                : undefined
            // 跳过 capability-miss，因为所有非 channel MCP server 都会触发
            if (gate.action === 'register' || gate.kind !== 'capability') {
              logEvent('zy_mcp_channel_gate', {
                registered: gate.action === 'register',
                skip_kind:
                  gate.action === 'skip'
                    ? (gate.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                    : undefined,
                entry_kind:
                  entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                is_dev: entry?.dev ?? false,
                plugin: pluginId,
              })
            }
            switch (gate.action) {
              case 'register':
                logMCPDebug(client.name, 'Channel notifications registered')
                client.client.setNotificationHandler(
                  ChannelMessageNotificationSchema(),
                  async (notification) => {
                    const { content, meta } = notification.params
                    logMCPDebug(client.name, `notifications/zy/channel: ${content.slice(0, 80)}`)
                    logEvent('zy_mcp_channel_message', {
                      content_length: content.length,
                      meta_key_count: Object.keys(meta ?? {}).length,
                      entry_kind:
                        entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      is_dev: entry?.dev ?? false,
                      plugin: pluginId,
                    })
                    enqueue({
                      mode: 'prompt',
                      value: wrapChannelMessage(client.name, content, meta),
                      priority: 'next',
                      isMeta: true,
                      origin: {
                        kind: 'channel',
                        channel: client.name,
                        server: client.name,
                      },
                      skipSlashCommands: true,
                    })
                  },
                )
                if (client.capabilities?.experimental?.['zy/channel/permission'] !== undefined) {
                  client.client.setNotificationHandler(
                    ChannelPermissionNotificationSchema(),
                    async (notification) => {
                      const { request_id, behavior } = notification.params
                      const resolved =
                        channelPermCallbacksRef.current?.resolve(
                          request_id,
                          behavior,
                          client.name,
                        ) ?? false
                      logMCPDebug(
                        client.name,
                        `notifications/zy/channel/permission: ${request_id} → ${behavior} (${resolved ? 'matched pending' : 'no pending entry — stale or unknown ID'})`,
                      )
                    },
                  )
                }
                break
              case 'skip':
                client.client.removeNotificationHandler('notifications/zy/channel')
                client.client.removeNotificationHandler(CHANNEL_PERMISSION_METHOD)
                logMCPDebug(client.name, `Channel notifications skipped: ${gate.reason}`)
                if (
                  gate.kind !== 'capability' &&
                  gate.kind !== 'session' &&
                  !channelWarnedKindsRef.current.has(gate.kind) &&
                  (gate.kind === 'marketplace' || gate.kind === 'allowlist' || entry !== undefined)
                ) {
                  channelWarnedKindsRef.current.add(gate.kind)
                  const text =
                    gate.kind === 'disabled'
                      ? 'Channels are not currently available'
                      : gate.kind === 'auth'
                        ? 'Channels require zy.ai authentication · run /login'
                        : gate.kind === 'policy'
                          ? 'Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings'
                          : gate.reason
                  addNotification({
                    key: `channels-blocked-${gate.kind}`,
                    priority: 'high',
                    text,
                    color: 'warning',
                    timeoutMs: 12000,
                  })
                }
                break
            }
          } else if (feature('KAIROS_CHANNELS')) {
            const gate = gateChannelServer(
              client.name,
              client.capabilities,
              client.config.pluginSource,
            )
            const entry = findChannelEntry(client.name, getAllowedChannels())
            // Plugin telemetry 标识符：所有 plugin-kind 条目记录 name@marketplace，与不受 gate
            // 限制、会记录任意 plugin_id+marketplace_name 的 zy_plugin_installed 同级。
            // server-kind 名称属于 MCP-server-name 层级，其他位置需 opt-in 才记录（参见
            // metadata.ts 的 isAnalyticsToolDetailsLoggingEnabled），此处不记录；其余由
            // is_dev/entry_kind 分段。
            const pluginId =
              entry?.kind === 'plugin'
                ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                : undefined
            // 跳过 capability-miss，因为所有非 channel MCP server 都会触发
            if (gate.action === 'register' || gate.kind !== 'capability') {
              logEvent('zy_mcp_channel_gate', {
                registered: gate.action === 'register',
                skip_kind:
                  gate.action === 'skip'
                    ? (gate.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                    : undefined,
                entry_kind:
                  entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                is_dev: entry?.dev ?? false,
                plugin: pluginId,
              })
            }
            switch (gate.action) {
              case 'register':
                logMCPDebug(client.name, 'Channel notifications registered')
                client.client.setNotificationHandler(
                  ChannelMessageNotificationSchema(),
                  async (notification) => {
                    const { content, meta } = notification.params
                    logMCPDebug(client.name, `notifications/zy/channel: ${content.slice(0, 80)}`)
                    logEvent('zy_mcp_channel_message', {
                      content_length: content.length,
                      meta_key_count: Object.keys(meta ?? {}).length,
                      entry_kind:
                        entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      is_dev: entry?.dev ?? false,
                      plugin: pluginId,
                    })
                    enqueue({
                      mode: 'prompt',
                      value: wrapChannelMessage(client.name, content, meta),
                      priority: 'next',
                      isMeta: true,
                      origin: {
                        kind: 'channel',
                        channel: client.name,
                        server: client.name,
                      },
                      skipSlashCommands: true,
                    })
                  },
                )
                // Permission-reply handler 使用独立事件和 capability。仅当 server 声明
                // zy/channel/permission 时注册，与 interactiveHandler.ts 发送路径使用相同 opt-in
                // 检查。server 解析用户回复并发出 {request_id, behavior}；本端不使用正则，因此普通
                // channel 文本不会意外匹配。
                if (client.capabilities?.experimental?.['zy/channel/permission'] !== undefined) {
                  client.client.setNotificationHandler(
                    ChannelPermissionNotificationSchema(),
                    async (notification) => {
                      const { request_id, behavior } = notification.params
                      const resolved =
                        channelPermCallbacksRef.current?.resolve(
                          request_id,
                          behavior,
                          client.name,
                        ) ?? false
                      logMCPDebug(
                        client.name,
                        `notifications/zy/channel/permission: ${request_id} → ${behavior} (${resolved ? 'matched pending' : 'no pending entry — stale or unknown ID'})`,
                      )
                    },
                  )
                }
                break
              case 'skip':
                // 幂等 teardown 确保 register→skip 的重新判定（例如 /logout 后 effect 重跑）会实际
                // 移除活跃 handler。否则会话中途降级将是单向的：gate 要求 skip，但旧 handler 仍持续
                // 入队。Map.delete 在从未注册时也安全。
                client.client.removeNotificationHandler('notifications/zy/channel')
                client.client.removeNotificationHandler(CHANNEL_PERMISSION_METHOD)
                logMCPDebug(client.name, `Channel notifications skipped: ${gate.reason}`)
                // channel server 被阻止时，每种 kind 显示一次 toast。这是唯一的用户可见信号，因为上方
                // logMCPDebug 需要 --debug。capability/session skip 属于预期噪声，仅记 debug。
                // marketplace/allowlist 在 session 之后运行；若走到这些 kind，说明是用户主动请求。
                if (
                  gate.kind !== 'capability' &&
                  gate.kind !== 'session' &&
                  !channelWarnedKindsRef.current.has(gate.kind) &&
                  (gate.kind === 'marketplace' || gate.kind === 'allowlist' || entry !== undefined)
                ) {
                  channelWarnedKindsRef.current.add(gate.kind)
                  // disabled/auth/policy 使用更短且可执行的自定义 toast 文案；marketplace/allowlist 直接
                  // 复用 gate reason，因为其中已指出不匹配项。
                  const text =
                    gate.kind === 'disabled'
                      ? 'Channels are not currently available'
                      : gate.kind === 'auth'
                        ? 'Channels require zy.ai authentication · run /login'
                        : gate.kind === 'policy'
                          ? 'Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings'
                          : gate.reason
                  addNotification({
                    key: `channels-blocked-${gate.kind}`,
                    priority: 'high',
                    text,
                    color: 'warning',
                    timeoutMs: 12000,
                  })
                }
                break
            }
          }

          // 注册 list_changed 通知 handler，使 server 可在 tools、prompts 或 resources 变化时通知
          if (client.capabilities?.tools?.listChanged) {
            client.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
              logMCPDebug(client.name, `Received tools/list_changed notification, refreshing tools`)
              try {
                // 失效前获取缓存 promise，以记录此前数量
                const previousToolsPromise = fetchToolsForClient.cache.get(client.name)
                fetchToolsForClient.cache.delete(client.name)
                const newTools = await fetchToolsForClient(client)
                const newCount = newTools.length
                if (previousToolsPromise) {
                  previousToolsPromise.then(
                    (previousTools: Tool[]) => {
                      logEvent('zy_mcp_list_changed', {
                        type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        previousCount: previousTools.length,
                        newCount,
                      })
                    },
                    () => {
                      logEvent('zy_mcp_list_changed', {
                        type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        newCount,
                      })
                    },
                  )
                } else {
                  logEvent('zy_mcp_list_changed', {
                    type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    newCount,
                  })
                }
                updateServer({ ...client, tools: newTools })
              } catch (error) {
                logMCPError(
                  client.name,
                  `Failed to refresh tools after list_changed notification: ${errorMessage(error)}`,
                )
              }
            })
          }

          if (client.capabilities?.prompts?.listChanged) {
            client.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
              logMCPDebug(
                client.name,
                `Received prompts/list_changed notification, refreshing prompts`,
              )
              logEvent('zy_mcp_list_changed', {
                type: 'prompts' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              try {
                // skill 来自 resources 而非 prompts，因此此处不使其缓存失效；
                // fetchMcpSkillsForClient 返回缓存结果。
                fetchCommandsForClient.cache.delete(client.name)
                const [mcpPrompts, mcpSkills] = await Promise.all([
                  fetchCommandsForClient(client),
                  feature('MCP_SKILLS') ? fetchMcpSkillsForClient!(client) : Promise.resolve([]),
                ])
                updateServer({
                  ...client,
                  commands: [...mcpPrompts, ...mcpSkills] as Command[],
                })
                // MCP skill 变化后使 skill-search 索引失效，下次发现时使用新集合重建
                clearSkillIndexCache?.()
              } catch (error) {
                logMCPError(
                  client.name,
                  `Failed to refresh prompts after list_changed notification: ${errorMessage(error)}`,
                )
              }
            })
          }

          if (client.capabilities?.resources?.listChanged) {
            client.client.setNotificationHandler(
              ResourceListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received resources/list_changed notification, refreshing resources`,
                )
                logEvent('zy_mcp_list_changed', {
                  type: 'resources' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                try {
                  fetchResourcesForClient.cache.delete(client.name)
                  if (feature('MCP_SKILLS')) {
                    // skill 从 resources 中发现，因此一并刷新。prompts 缓存也需失效：此处会写 commands，
                    // 否则并发 prompts/list_changed 的新结果可能被本地旧缓存覆盖。
                    fetchMcpSkillsForClient!.cache.delete(client.name)
                    fetchCommandsForClient.cache.delete(client.name)
                    const [newResources, mcpPrompts, mcpSkills] = await Promise.all([
                      fetchResourcesForClient(client),
                      fetchCommandsForClient(client),
                      fetchMcpSkillsForClient!(client),
                    ])
                    updateServer({
                      ...client,
                      resources: newResources,
                      commands: [...mcpPrompts, ...mcpSkills] as Command[],
                    })
                    // MCP skill 变化后使 skill-search 索引失效，下次发现时使用新集合重建
                    clearSkillIndexCache?.()
                  } else {
                    const newResources = await fetchResourcesForClient(client)
                    updateServer({ ...client, resources: newResources })
                  }
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh resources after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }
          break
        }

        case 'needs-auth':
        case 'failed':
        case 'pending':
        case 'disabled':
          break
      }
    },
    [updateServer, setAppState, addNotification],
  )

  // appState 中不存在的所有 server 初始化为 pending。session 变化（/clear）及
  // /reload-plugins（pluginReconnectKey）时重跑。plugin 重载时还会断开配置中已不存在的
  // stale plugin MCP server（scope 为 dynamic），防止已禁用 plugin 留下幽灵 tool。此处跳过
  // zy.ai 去重以免等待网络；下方 connect useEffect 会紧接着运行，并在连接前去重。
  const _sessionId = getSessionId()
  useEffect(() => {
    async function initializeServersAsPending() {
      const { servers: existingConfigs, errors: mcpErrors } = isStrictMcpConfig
        ? { servers: {}, errors: [] }
        : await getZyCodeMcpConfigs(dynamicMcpConfig)
      const configs = { ...existingConfigs, ...dynamicMcpConfig }

      // 将 MCP 错误加入 plugin 错误供 UI 展示，并去重
      addErrorsToAppState(setAppState, mcpErrors)

      setAppState((prevState) => {
        // 断开 stale MCP server：包括从配置移除的 plugin server，或配置哈希因编辑 .mcp.json
        // 而变化的 server。其名称已从 mcpWithoutStale.clients 移除，所以下方会重新以 pending
        // 状态加入。
        const { stale, ...mcpWithoutStale } = excludeStalePluginClients(prevState.mcp, configs)
        // 以 fire-and-forget 清理 stale 连接，因为 state updater 必须同步。调用 cleanup 前需消除
        // 三类风险：
        // 1. 待执行的重连定时器会使用旧配置；
        // 2. L254 设置的 onclose 会用闭包中的旧配置启动 reconnectWithBackoff。它只检查
        //    isMcpServerDisabled，而配置变化的 server 并未禁用，会与新连接竞态，最终由最后一次
        //    updateServer 胜出；
        // 3. clearServerCache 内部调用已记忆化的 connectToServer。对从未连接的 server
        //    （disabled/pending/failed），空缓存会触发真实连接及 spawn/OAuth，随后立即被终止。
        //    只有已连接 server 才需清理。
        for (const s of stale) {
          const timer = reconnectTimersRef.current.get(s.name)
          if (timer) {
            clearTimeout(timer)
            reconnectTimersRef.current.delete(s.name)
          }
          if (s.type === 'connected') {
            s.client.onclose = undefined
            void clearServerCache(s.name, s.config).catch(() => {})
          }
        }

        const existingServerNames = new Set(mcpWithoutStale.clients.map((c) => c.name))
        const newClients = Object.entries(configs)
          .filter(([name]) => !existingServerNames.has(name))
          .map(([name, config]) => ({
            name,
            type: isMcpServerDisabled(name) ? ('disabled' as const) : ('pending' as const),
            config,
          }))

        if (newClients.length === 0 && stale.length === 0) {
          return prevState
        }

        return {
          ...prevState,
          mcp: {
            ...prevState.mcp,
            ...mcpWithoutStale,
            clients: [...mcpWithoutStale.clients, ...newClients],
          },
        }
      })
    }

    void initializeServersAsPending().catch((error) => {
      logMCPError(
        'useManageMCPConnections',
        `Failed to initialize servers as pending: ${errorMessage(error)}`,
      )
    })
  }, [isStrictMcpConfig, dynamicMcpConfig, setAppState])

  // 加载 MCP 配置并连接 server。分两阶段：先加载较快的 ZY Code 配置，再加载可能较慢的
  // zy.ai 配置。
  useEffect(() => {
    let cancelled = false

    async function loadAndConnectMcpConfigs() {
      // 清除 zy.ai MCP 缓存，以当前 auth 状态获取最新配置；authVersion 在 login/logout 后变化
      // 时尤其重要。立即启动请求，使其与 getZyCodeMcpConfigs 内的 loadAllPlugins() 并行，只在
      // 去重阶段等待。下方 Phase 2 等待同一 promise，不会发起第二次网络调用。
      let zyaiPromise: Promise<Record<string, ScopedMcpServerConfig>>
      if (isStrictMcpConfig || doesEnterpriseMcpConfigExist()) {
        zyaiPromise = Promise.resolve({})
      } else {
        clearZyAIMcpConfigsCache()
        zyaiPromise = fetchZyAIMcpConfigsIfEligible()
      }

      // Phase 1：加载 ZY Code 配置。此处抑制与 --mcp-config 条目或 zy.ai connector 重复的
      // plugin MCP server，避免它们在 Phase 2 与 connector 同时连接。
      const { servers: ZyCodeConfigs, errors: mcpErrors } = isStrictMcpConfig
        ? { servers: {}, errors: [] }
        : await getZyCodeMcpConfigs(dynamicMcpConfig)
      if (cancelled) {
        return
      }

      // 将 MCP 错误加入 plugin 错误供 UI 展示，并去重
      addErrorsToAppState(setAppState, mcpErrors)

      const configs = { ...ZyCodeConfigs, ...dynamicMcpConfig }

      // 开始连接 ZY Code server，不等待完成，与 Phase 2 并发；过滤已禁用 server，避免无用连接
      const enabledConfigs = Object.fromEntries(
        Object.entries(configs).filter(([name]) => !isMcpServerDisabled(name)),
      )
      getMcpToolsCommandsAndResources(onConnectionAttempt, enabledConfigs).catch((error) => {
        logMCPError(
          'useManageMcpConnections',
          `Failed to get MCP resources: ${errorMessage(error)}`,
        )
      })

      // Phase 2：等待上方已启动且记忆化的 zy.ai 配置请求，不会重复获取
      let zyaiConfigs: Record<string, ScopedMcpServerConfig> = {}
      if (!isStrictMcpConfig) {
        zyaiConfigs = filterMcpServersByPolicy(await zyaiPromise).allowed
        if (cancelled) {
          return
        }

        // 抑制与已启用手动 server 重复的 zy.ai connector。二者 key 不会冲突（如 `slack` 与
        // `zy.ai Slack`），下方 merge 无法发现，因此需按 URL signature 基于内容去重。
        if (Object.keys(zyaiConfigs).length > 0) {
          const { servers: dedupedZyAI } = dedupZyAIMcpServers(zyaiConfigs, configs)
          zyaiConfigs = dedupedZyAI
        }

        if (Object.keys(zyaiConfigs).length > 0) {
          // 立即将 zy.ai server 加为 pending，使其显示在 UI 中
          setAppState((prevState) => {
            const existingServerNames = new Set(prevState.mcp.clients.map((c) => c.name))
            const newClients = Object.entries(zyaiConfigs)
              .filter(([name]) => !existingServerNames.has(name))
              .map(([name, config]) => ({
                name,
                type: isMcpServerDisabled(name) ? ('disabled' as const) : ('pending' as const),
                config,
              }))
            if (newClients.length === 0) {
              return prevState
            }
            return {
              ...prevState,
              mcp: {
                ...prevState.mcp,
                clients: [...prevState.mcp.clients, ...newClients],
              },
            }
          })

          // 开始连接，仅处理已启用 server
          const enabledZyaiConfigs = Object.fromEntries(
            Object.entries(zyaiConfigs).filter(([name]) => !isMcpServerDisabled(name)),
          )
          getMcpToolsCommandsAndResources(onConnectionAttempt, enabledZyaiConfigs).catch(
            (error) => {
              logMCPError(
                'useManageMcpConnections',
                `Failed to get zy.ai MCP resources: ${errorMessage(error)}`,
              )
            },
          )
        }
      }

      // 两个阶段完成后记录 server 数量
      const allConfigs = { ...configs, ...zyaiConfigs }
      const counts = {
        enterprise: 0,
        global: 0,
        project: 0,
        user: 0,
        plugin: 0,
        zyai: 0,
      }
      // 仅限 Ant：收集 stdio 命令 basename，与 RSS/FPS metrics 关联。rust-analyzer 等 stdio
      // server 可能资源消耗较大，需要识别哪些与会话性能不佳相关。
      const stdioCommands: string[] = []
      for (const [name, serverConfig] of Object.entries(allConfigs)) {
        if (serverConfig.scope === 'enterprise') {
          counts.enterprise++
        } else if (serverConfig.scope === 'user') {
          counts.global++
        } else if (serverConfig.scope === 'project') {
          counts.project++
        } else if (serverConfig.scope === 'local') {
          counts.user++
        } else if (serverConfig.scope === 'dynamic') {
          counts.plugin++
        } else if (serverConfig.scope === 'zyai') {
          counts.zyai++
        }

        if (
          isInternalBuild() &&
          !isMcpServerDisabled(name) &&
          (serverConfig.type === undefined || serverConfig.type === 'stdio') &&
          'command' in serverConfig
        ) {
          stdioCommands.push(basename(serverConfig.command))
        }
      }
      logEvent('zy_mcp_servers', {
        ...counts,
        ...(isInternalBuild() && stdioCommands.length > 0
          ? {
              stdio_commands: stdioCommands
                .sort()
                .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }
          : {}),
      })
    }

    void loadAndConnectMcpConfigs()

    return () => {
      cancelled = true
    }
  }, [isStrictMcpConfig, dynamicMcpConfig, onConnectionAttempt, setAppState])

  // 卸载时清理所有定时器
  useEffect(() => {
    const timers = reconnectTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      // 卸载前刷新所有待处理的 MCP 批量更新
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
        flushPendingUpdates()
      }
    }
  }, [flushPendingUpdates])

  // 暴露 reconnectMcpServer 供组件使用。通过 store.getState() 读取 mcp.clients，使回调在
  // client 状态切换时保持稳定，无需每次连接都重新创建。
  const reconnectMcpServer = useCallback(
    async (serverName: string) => {
      const client = store.getState().mcp.clients.find((c) => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      // 取消待处理的自动重连尝试
      const existingTimer = reconnectTimersRef.current.get(serverName)
      if (existingTimer) {
        clearTimeout(existingTimer)
        reconnectTimersRef.current.delete(serverName)
      }

      const result = await reconnectMcpServerImpl(serverName, client.config)

      onConnectionAttempt(result)

      // 不抛出异常；重连失败时交由 UI 处理 client 类型。详细日志由
      // reconnectMcpServerImpl 通过 --debug 输出。
      return result
    },
    [store, onConnectionAttempt],
  )

  // 暴露切换 server 启用/禁用状态的函数
  const toggleMcpServer = useCallback(
    async (serverName: string): Promise<void> => {
      const client = store.getState().mcp.clients.find((c) => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      const isCurrentlyDisabled = client.type === 'disabled'

      if (!isCurrentlyDisabled) {
        // 取消待处理的自动重连尝试
        const existingTimer = reconnectTimersRef.current.get(serverName)
        if (existingTimer) {
          clearTimeout(existingTimer)
          reconnectTimersRef.current.delete(serverName)
        }

        // 清除缓存前先将 disabled 状态持久化到磁盘，因为 onclose handler 会检查磁盘状态
        setMcpServerEnabled(serverName, false)

        // 禁用时，若当前已连接则断开并清理
        if (client.type === 'connected') {
          await clearServerCache(serverName, client.config)
        }

        // 更新为 disabled 状态，并自动清除 tools/commands/resources
        updateServer({
          name: serverName,
          type: 'disabled',
          config: client.config,
        })
      } else {
        // 启用时先将 enabled 状态持久化到磁盘
        setMcpServerEnabled(serverName, true)

        // 标记为 pending 并重新连接
        updateServer({
          name: serverName,
          type: 'pending',
          config: client.config,
        })

        // 重新连接 server
        const result = await reconnectMcpServerImpl(serverName, client.config)

        onConnectionAttempt(result)
      }
    },
    [store, updateServer, onConnectionAttempt],
  )

  return { reconnectMcpServer, toggleMcpServer }
}
