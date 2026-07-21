import { feature } from 'bun:bundle'
import React, { useCallback, useEffect, useRef } from 'react'
import { setMainLoopModelOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  isWirePermissionResponse,
  type WirePermissionCallbacks,
  type WirePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import { buildWireConnectUrl } from '../bridge/bridgeStatusUtil.js'
import { extractInboundMessageFields } from '../bridge/inboundMessages.js'
import type { ReplWireHandle, WireState } from '../bridge/replBridge.js'
import { setReplWireHandle } from '../bridge/replBridgeHandle.js'
import type { Command } from '../commands/index.js'
import { getSlashCommandToolSkills, isBridgeSafeCommand } from '../commands/index.js'
import { getRemoteSessionUrl } from '../constants/product.js'
import { useNotifications } from '../context/notifications.js'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getLeaderToolUseConfirmQueue } from '../services/swarm/leaderPermissionBridge.js'
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { PermissionMode, WireMessage } from '../types/index.js'
import type { Message } from '../types/message.js'
import type { WireControlResponse } from '../types/wire/control.js'
import { getCwd } from '../services/environment/cwd.js'
import { logForDebugging } from '../services/infra/debug.js'
import { errorMessage } from '../utils/errors.js'
import { enqueue } from '../services/input/messageQueueManager.js'
import { buildSystemInitMessage } from '../services/messages/systemInit.js'
import {
  createSystemMessage,
  createWireStatusMessage,
} from '../services/messages/./constructors.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from '../services/permissions/permissionSetup.js'

/** 失败后多久自动清除 replBridgeEnabled（停止重试）。 */
export const BRIDGE_FAILURE_DISMISS_MS = 10_000

/**
 * initReplBridge 连续失败的最大次数，超过此次数后 hook 将在整个 session
 * 生命周期内停止重试。用于防止在 OAuth 不可恢复的情况下，
 * replBridgeEnabled 被自动禁用后又通过其他路径（settings sync、
 * /remote-control、config tool）重新开启——每次重试都会产生一次
 * 对 POST /v1/environments/bridge 的 401 请求。Datadog 2026-03-08：
 * 最严重的卡死客户端每天产生 2,879 次 401（占该路由所有 401 的 17%）。
 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3

/**
 * Hook，在后台初始化一个始终在线的 bridge 连接，
 * 并将新的 user/assistant 消息写入 bridge session。
 *
 * 如果 bridge 未启用或用户未通过 OAuth 认证，则静默跳过。
 *
 * 监听 AppState.replBridgeEnabled——当关闭时（通过 /config 或 footer），
 * bridge 会被拆除。当重新开启时，它会重新初始化。
 *
 * 来自 zy.ai 的入站消息通过 queuedCommands 注入到 REPL 中。
 */
export function useReplBridge(
  messages: Message[],
  setMessages: (action: React.SetStateAction<Message[]>) => void,
  abortControllerRef: React.RefObject<AbortController | null>,
  commands: readonly Command[],
  mainLoopModel: string,
): {
  sendWireResult: () => void
} {
  const handleRef = useRef<ReplWireHandle | null>(null)
  const teardownPromiseRef = useRef<Promise<void> | undefined>(undefined)
  const lastWrittenIndexRef = useRef(0)
  // 记录已作为初始消息刷新的 UUID。在 bridge 重连之间持久化，
  // 因此 Bridge #2+ 仅发送新消息——发送重复的 UUID 会导致服务器关闭 WebSocket。
  const flushedUUIDsRef = useRef(new Set<string>())
  const failureTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 在 effect 重跑之间持久化（与 effect 的局部状态不同）。
  // 仅在成功 init 时重置。达到 MAX_CONSECUTIVE_INIT_FAILURES 后保险丝熔断，
  // 无论 replBridgeEnabled 是否重新切换，整个 session 内不再重试。
  const consecutiveFailuresRef = useRef(0)
  const setAppState = useSetAppState()
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const mainLoopModelRef = useRef(mainLoopModel)
  mainLoopModelRef.current = mainLoopModel
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const store = useAppStateStore()
  const { addNotification } = useNotifications()
  const replBridgeEnabled = feature('BRIDGE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAppState((s) => s.replBridgeEnabled)
    : false
  const replWireConnected = feature('BRIDGE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAppState((state) => state.replWireConnected)
    : false
  const replBridgeOutboundOnly = feature('BRIDGE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAppState((state) => state.replBridgeOutboundOnly)
    : false
  const replWireInitialName = feature('BRIDGE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAppState((state) => state.replWireInitialName)
    : undefined

  // 当启用状态变化时，初始化/拆除 bridge。
  // 传递当前消息作为 initialMessages，以便远程 session
  // 可以从现有对话上下文开始（例如来自 /bridge）。
  useEffect(() => {
    // feature() 检查必须使用正向模式以进行死代码消除——
    // 负向模式（if (!feature(...)) return）不会消除下方的动态 import。
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeEnabled) {
        return
      }
      const outboundOnly = replBridgeOutboundOnly
      function notifyWireFailed(detail?: string): void {
        if (outboundOnly) {
          return
        }
        addNotification({
          key: 'bridge-failed',
          jsx: (
            <>
              <Text color="error">{tSync('notif.remoteControlFailed')}</Text>
              {detail && <Text dimColor> · {detail}</Text>}
            </>
          ),
          priority: 'immediate',
        })
      }
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_INIT_FAILURES) {
        logForDebugging(
          `[bridge:repl] Hook: ${consecutiveFailuresRef.current} consecutive init failures, not retrying this session`,
        )
        // 清除 replBridgeEnabled，使 /remote-control 不会错误地
        // 为从未连接的 bridge 显示 WireDisconnectDialog。
        const fuseHint = 'disabled after repeated failures · restart to retry'
        notifyWireFailed(fuseHint)
        setAppState((prev) => {
          if (prev.replWireError === fuseHint && !prev.replBridgeEnabled) {
            return prev
          }
          return {
            ...prev,
            replWireError: fuseHint,
            replBridgeEnabled: false,
          }
        })
        return
      }
      let cancelled = false
      // 现在捕获 messages.length，以便在 bridge 连接后
      // 不会通过 writeMessages 重新发送初始消息。
      const initialMessageCount = messages.length
      void (async () => {
        try {
          // 在注册新 environment 之前，等待任何正在进行的 teardown 完成。
          // 否则，前一次 teardown 的 deregister HTTP 调用会与
          // 新的 register 调用发生竞争，服务器可能会拆除刚创建的 environment。
          if (teardownPromiseRef.current) {
            logForDebugging(
              '[bridge:repl] Hook: waiting for previous teardown to complete before re-init',
            )
            await teardownPromiseRef.current
            teardownPromiseRef.current = undefined
            logForDebugging(
              '[bridge:repl] Hook: previous teardown complete, proceeding with re-init',
            )
          }
          if (cancelled) {
            return
          }

          // 动态 import，使该模块在 external 构建 中被 tree-shake 掉
          const { initReplBridge } = await import('../bridge/initReplBridge.js')
          const { shouldShowAppUpgradeMessage } = await import('../bridge/envLessBridgeConfig.js')

          // Assistant 模式：永久 bridge session——zy.ai 在 CLI 重启之间
          // 显示一个连续的对话，而不是每次调用创建新 session。
          // initBridgeCore 读取 bridge-pointer.json（#20735 添加的
          // 崩溃恢复文件），并通过 reuseEnvironmentId + api.reconnectSession()
          // 重用其 {environmentId, sessionId}。Teardown 跳过
          // archive/deregister/pointer-clear，因此 session 能在正常退出
          // 而不仅仅是崩溃后存活。非 assistant bridge 在 teardown 时清除
          // pointer（仅用于崩溃恢复）。
          let perpetual = false
          if (feature('KAIROS')) {
            const { isAssistantMode } = (await import('../assistant/index.js')) as unknown as {
              isAssistantMode: () => boolean
            }
            perpetual = isAssistantMode()
          }

          // 当来自 zy.ai 的用户消息到达时，将其注入到 REPL 中。
          // 保留原始 UUID，以便消息转发回 CCR 时与原始消息匹配——避免重复消息。
          //
          // 异步是因为 file_attachments（如果存在）需要在入队 @path 前缀之前
          // 进行网络获取 + 磁盘写入。调用者不会 await——带附件的消息只是
          // 稍晚一些进入队列，这没问题（web 消息不是快速连发的）。
          async function handleInboundMessage(msg: WireMessage): Promise<void> {
            try {
              const fields = extractInboundMessageFields(msg)
              if (!fields) {
                return
              }
              const { uuid } = fields

              // 动态 import，使 bridge 代码不会出现在非 BRIDGE_MODE 构建中。
              const { resolveAndPrepend } = await import('../bridge/inboundAttachments.js')
              let sanitized: string =
                typeof fields.content === 'string' ? fields.content : JSON.stringify(fields.content)
              if (feature('KAIROS_GITHUB_WEBHOOKS')) {
                /* eslint-disable @typescript-eslint/no-require-imports */
                const webhookModule =
                  require('../bridge/webhookSanitizer.js') as typeof import('../bridge/webhookSanitizer.js')
                /* eslint-enable @typescript-eslint/no-require-imports */
                const sanitizedResult = webhookModule.sanitizeInboundWebhookContent(
                  typeof fields.content === 'string'
                    ? fields.content
                    : JSON.stringify(fields.content),
                )
                sanitized =
                  typeof sanitizedResult === 'string'
                    ? sanitizedResult
                    : JSON.stringify(sanitizedResult)
              }
              const resolvedContent = await resolveAndPrepend(msg, sanitized)
              const content =
                typeof resolvedContent === 'string'
                  ? resolvedContent
                  : JSON.stringify(resolvedContent)
              const preview =
                typeof resolvedContent === 'string'
                  ? resolvedContent.slice(0, 80)
                  : Array.isArray(resolvedContent)
                    ? `[${resolvedContent.length} content blocks]`
                    : '[content]'
              logForDebugging(
                `[bridge:repl] Injecting inbound user message: ${preview}${uuid ? ` uuid=${uuid}` : ''}`,
              )
              enqueue({
                value: content,
                mode: 'prompt' as const,
                uuid,
                // skipSlashCommands 保持 true 作为纵深防御——
                // 当 bridgeOrigin 已设置且解析后的命令通过 isBridgeSafeCommand 时，
                // processUserInputBase 会在内部覆盖它。
                // 这使退出词抑制和即时命令块保持完整，适用于任何
                // 直接检查 skipSlashCommands 的代码路径。
                skipSlashCommands: true,
                bridgeOrigin: true,
              })
            } catch (e) {
              logForDebugging(`[bridge:repl] handleInboundMessage failed: ${e}`, {
                level: 'error',
              })
            }
          }

          // 状态变更回调——将 bridge 生命周期事件映射到 AppState。
          function handleStateChange(state: WireState, detail?: string): void {
            if (cancelled) {
              return
            }
            if (outboundOnly) {
              logForDebugging(
                `[bridge:repl] Mirror state=${state}${detail ? ` detail=${detail}` : ''}`,
              )
              // 同步 replWireConnected，使转发 effect 在传输层建立或断开时开始/停止写入。
              if (state === 'failed') {
                setAppState((prev) => {
                  if (!prev.replWireConnected) {
                    return prev
                  }
                  return {
                    ...prev,
                    replWireConnected: false,
                  }
                })
              } else if (state === 'ready' || state === 'connected') {
                setAppState((prev) => {
                  if (prev.replWireConnected) {
                    return prev
                  }
                  return {
                    ...prev,
                    replWireConnected: true,
                  }
                })
              }
              return
            }
            const handle = handleRef.current
            switch (state) {
              case 'ready':
                setAppState((prev) => {
                  const connectUrl =
                    handle && handle.environmentId !== ''
                      ? buildWireConnectUrl(handle.environmentId, handle.sessionIngressUrl)
                      : prev.replWireConnectUrl
                  const sessionUrl = handle
                    ? getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl)
                    : prev.replWireSessionUrl
                  const envId = handle?.environmentId
                  const sessionId = handle?.bridgeSessionId
                  if (
                    prev.replWireConnected &&
                    !prev.replWireSessionActive &&
                    !prev.replWireReconnecting &&
                    prev.replWireConnectUrl === connectUrl &&
                    prev.replWireSessionUrl === sessionUrl &&
                    prev.replWireEnvironmentId === envId &&
                    prev.replWireSessionId === sessionId
                  ) {
                    return prev
                  }
                  return {
                    ...prev,
                    replWireConnected: true,
                    replWireSessionActive: false,
                    replWireReconnecting: false,
                    replWireConnectUrl: connectUrl,
                    replWireSessionUrl: sessionUrl,
                    replWireEnvironmentId: envId,
                    replWireSessionId: sessionId,
                    replWireError: undefined,
                  }
                })
                break
              case 'connected': {
                setAppState((prev) => {
                  if (prev.replWireSessionActive) {
                    return prev
                  }
                  return {
                    ...prev,
                    replWireConnected: true,
                    replWireSessionActive: true,
                    replWireReconnecting: false,
                    replWireError: undefined,
                  }
                })
                // 发送 system/init 使远程客户端（web/iOS/Android）获取 session 元数据。
                // REPL 直接使用 query()——从不经过 QueryEngine 的 WireMessage 层——
                // 因此这是将 system/init 放到 REPL-bridge 线上的唯一路径。
                // Skills 加载是异步的（memoized，REPL 启动后开销小）；
                // fire-and-forget 以免阻塞连接状态转换。
                if (getFeatureValue_CACHED_MAY_BE_STALE('zy_bridge_system_init', false)) {
                  void (async () => {
                    try {
                      const skills = await getSlashCommandToolSkills(getCwd())
                      if (cancelled) {
                        return
                      }
                      const currentState = store.getState()
                      handleRef.current?.writeSdkMessages([
                        buildSystemInitMessage({
                          // tools/mcpClients/plugins 对 REPL-bridge 进行了脱敏：
                          // MCP 前缀的工具名和服务器名会泄露用户已接入的集成；
                          // 插件路径会泄露原始文件系统路径（用户名、项目结构）。
                          // CCR v2 将 SDK 消息持久化到 Spanner——点击"从手机连接"的
                          // 用户可能不希望这些信息出现在 Anthropic 的服务器上。
                          // QueryEngine（SDK）仍然发出完整列表——SDK 消费者期望完整遥测。
                          tools: [],
                          mcpClients: [],
                          model: mainLoopModelRef.current,
                          permissionMode: currentState.toolPermissionContext.mode as PermissionMode,
                          // TODO: 避免此类型转换
                          // 远程客户端只能调用 bridge-safe 命令——
                          // 广告不安全的命令（local-jsx、未允许的 local）
                          // 会让 mobile/web 尝试调用并遇到错误。
                          commands: commandsRef.current.filter(isBridgeSafeCommand),
                          agents: currentState.agentDefinitions.activeAgents,
                          skills,
                          plugins: [],
                        }),
                      ])
                    } catch (err) {
                      logForDebugging(
                        `[bridge:repl] Failed to send system/init: ${errorMessage(err)}`,
                        {
                          level: 'error',
                        },
                      )
                    }
                  })()
                }
                break
              }
              case 'reconnecting':
                setAppState((prevState) => {
                  if (prevState.replWireReconnecting) {
                    return prevState
                  }
                  return {
                    ...prevState,
                    replWireReconnecting: true,
                    replWireSessionActive: false,
                  }
                })
                break
              case 'failed':
                // 清除上一次的失败dismiss计时器
                clearTimeout(failureTimeoutRef.current)
                notifyWireFailed(detail)
                setAppState((prev) => ({
                  ...prev,
                  replWireError: detail,
                  replWireReconnecting: false,
                  replWireSessionActive: false,
                  replWireConnected: false,
                }))
                // 超时后自动禁用，使 hook 停止重试。
                failureTimeoutRef.current = setTimeout(() => {
                  if (cancelled) {
                    return
                  }
                  failureTimeoutRef.current = undefined
                  setAppState((prevState) => {
                    if (!prevState.replWireError) {
                      return prevState
                    }
                    return {
                      ...prevState,
                      replBridgeEnabled: false,
                      replWireError: undefined,
                    }
                  })
                }, BRIDGE_FAILURE_DISMISS_MS)
                break
            }
          }

          // 等待中的 bridge 权限响应 handler 映射，以 request_id 为键。
          // 每个条目是一个等待 CCR 回复的 onResponse handler。
          const pendingPermissionHandlers = new Map<
            string,
            (response: WirePermissionResponse) => void
          >()

          // 将收到的 control_response 消息分发给已注册的 handler
          function handlePermissionResponse(message: WireControlResponse): void {
            const requestId = message.response?.request_id
            if (!requestId) {
              return
            }
            const handler = pendingPermissionHandlers.get(requestId)
            if (!handler) {
              logForDebugging(
                `[bridge:repl] No handler for control_response request_id=${requestId}`,
              )
              return
            }
            pendingPermissionHandlers.delete(requestId)
            // 从 control_response 负载中提取权限决策
            const inner = message.response
            if (
              inner.subtype === 'success' &&
              inner.response &&
              isWirePermissionResponse(inner.response)
            ) {
              handler(inner.response)
            }
          }
          const bridgeHandle = await initReplBridge({
            outboundOnly,
            tags: outboundOnly ? ['ccr-mirror'] : undefined,
            onInboundMessage: handleInboundMessage,
            onPermissionResponse: handlePermissionResponse,
            onInterrupt() {
              abortControllerRef.current?.abort()
            },
            onSetModel(model) {
              const resolved = model === 'default' ? null : (model ?? null)
              setMainLoopModelOverride(resolved)
              setAppState((prevState) => {
                if (prevState.mainLoopModelForSession === resolved) {
                  return prevState
                }
                return {
                  ...prevState,
                  mainLoopModelForSession: resolved,
                }
              })
            },
            onSetMaxThinkingTokens(maxTokens) {
              const enabled = maxTokens !== null
              setAppState((prevState) => {
                if (prevState.thinkingEnabled === enabled) {
                  return prevState
                }
                return {
                  ...prevState,
                  thinkingEnabled: enabled,
                }
              })
            },
            onSetPermissionMode(mode) {
              // 策略守卫必须在 transitionPermissionMode 之前触发——
              // 其内部的 auto-gate 检查是防御性抛出（在抛出之前有
              // setAutoModeActivity(true) 副作用），而不是优雅拒绝。
              // 让该抛出逃逸会：
              // (1) 在 mode 不变的情况下留下 STATE.autoModeActive=true
              //     （违反 src/AGENTS.md 中的三方不变式）
              // (2) 无法发送 control_response → 服务器关闭 WS
              // 这些镜像于 print.ts handleSetPermissionMode；bridge
              // 无法直接导入这些检查（bootstrap-isolation），因此
              // 依赖此判定来发出错误响应。
              if (mode === 'bypassPermissions') {
                if (isBypassPermissionsModeDisabled()) {
                  return {
                    ok: false,
                    error:
                      'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
                  }
                }
                if (!store.getState().toolPermissionContext.isBypassPermissionsModeAvailable) {
                  return {
                    ok: false,
                    error:
                      'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
                  }
                }
              }
              if (true && mode === 'auto' && !isAutoModeGateEnabled()) {
                const reason = getAutoModeUnavailableReason()
                return {
                  ok: false,
                  error: reason
                    ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
                    : 'Cannot set permission mode to auto',
                }
              }
              // 守卫通过——通过集中式 transition 应用，
              // 使 prePlanMode 存储和 auto-mode 状态同步全部触发。
              setAppState((prevState) => {
                const current = prevState.toolPermissionContext.mode
                if (current === mode) {
                  return prevState
                }
                const next = transitionPermissionMode(
                  current,
                  mode,
                  prevState.toolPermissionContext,
                )
                return {
                  ...prevState,
                  toolPermissionContext: {
                    ...next,
                    mode,
                  },
                }
              })
              // 模式已变更，重新检查队列中的权限提示。
              setImmediate(() => {
                getLeaderToolUseConfirmQueue()?.((currentQueue) => {
                  currentQueue.forEach((item) => {
                    void item.recheckPermission()
                  })
                  return currentQueue
                })
              })
              return {
                ok: true,
              }
            },
            onStateChange: handleStateChange,
            initialMessages: messages.length > 0 ? messages : undefined,
            getMessages: () => messagesRef.current,
            previouslyFlushedUUIDs: flushedUUIDsRef.current,
            initialName: replWireInitialName,
            perpetual,
          })
          if (cancelled) {
            // Effect 在 initReplBridge 执行期间被取消。
            // 拆除 handle 以避免泄漏资源（poll loop、
            // WebSocket、已注册的 environment、清理回调）。
            logForDebugging(
              `[bridge:repl] Hook: init cancelled during flight, tearing down${bridgeHandle ? ` env=${bridgeHandle.environmentId}` : ''}`,
            )
            if (bridgeHandle) {
              void bridgeHandle.teardown()
            }
            return
          }
          if (!bridgeHandle) {
            // initReplBridge 返回 null——前置条件失败。对于大多数情况
            // （no_oauth、policy_denied 等），onStateChange('failed')
            // 已带着具体提示触发。GrowthBook-gate-off 的情况是故意静默的——
            // 不是失败，只是尚未推送。
            consecutiveFailuresRef.current++
            logForDebugging(
              `[bridge:repl] Init returned null (precondition or session creation failed); consecutive failures: ${consecutiveFailuresRef.current}`,
            )
            clearTimeout(failureTimeoutRef.current)
            setAppState((prevState) => ({
              ...prevState,
              replWireError: prevState.replWireError ?? 'check debug logs for details',
            }))
            failureTimeoutRef.current = setTimeout(() => {
              if (cancelled) {
                return
              }
              failureTimeoutRef.current = undefined
              setAppState((prevState) => {
                if (!prevState.replWireError) {
                  return prevState
                }
                return {
                  ...prevState,
                  replBridgeEnabled: false,
                  replWireError: undefined,
                }
              })
            }, BRIDGE_FAILURE_DISMISS_MS)
            return
          }
          handleRef.current = bridgeHandle
          setReplWireHandle(bridgeHandle)
          consecutiveFailuresRef.current = 0
          // 在转发 effect 中跳过初始消息——它们已在创建时
          // 作为 session events 加载。
          lastWrittenIndexRef.current = initialMessageCount
          if (outboundOnly) {
            setAppState((prevState) => {
              if (
                prevState.replWireConnected &&
                prevState.replWireSessionId === bridgeHandle.bridgeSessionId
              ) {
                return prevState
              }
              return {
                ...prevState,
                replWireConnected: true,
                replWireSessionId: bridgeHandle.bridgeSessionId,
                replWireSessionUrl: undefined,
                replWireConnectUrl: undefined,
                replWireError: undefined,
              }
            })
            logForDebugging(
              `[bridge:repl] Mirror initialized, session=${bridgeHandle.bridgeSessionId}`,
            )
          } else {
            // 构建 bridge 权限回调，使交互式权限 handler
            // 可以在 bridge 响应和本地用户交互之间进行竞态。
            const permissionCallbacks: WirePermissionCallbacks = {
              sendRequest(
                requestId,
                toolName,
                input,
                toolUseId,
                description,
                permissionSuggestions,
                blockedPath,
              ) {
                bridgeHandle.sendControlRequest({
                  type: 'control_request',
                  request_id: requestId,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: toolName,
                    input,
                    tool_use_id: toolUseId,
                    description,
                    ...(permissionSuggestions
                      ? {
                          permission_suggestions: permissionSuggestions,
                        }
                      : {}),
                    ...(blockedPath
                      ? {
                          blocked_path: blockedPath,
                        }
                      : {}),
                  },
                })
              },
              sendResponse(responseRequestId, response) {
                const payload: Record<string, unknown> = {
                  ...response,
                }
                bridgeHandle.sendControlResponse({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: responseRequestId,
                    response: payload,
                  },
                })
              },
              cancelRequest(cancelRequestId) {
                bridgeHandle.sendControlCancelRequest(cancelRequestId)
              },
              onResponse(responseRequestId, responseHandler) {
                pendingPermissionHandlers.set(responseRequestId, responseHandler)
                return () => {
                  pendingPermissionHandlers.delete(responseRequestId)
                }
              },
            }
            setAppState((prevState) => ({
              ...prevState,
              replWirePermissionCallbacks: permissionCallbacks,
            }))
            const url = getRemoteSessionUrl(
              bridgeHandle.bridgeSessionId,
              bridgeHandle.sessionIngressUrl,
            )
            // environmentId === '' 表示 v2 无 env 路径。buildWireConnectUrl
            // 构建特定于 env 的连接 URL，没有 env 时不存在。
            const hasEnv = bridgeHandle.environmentId !== ''
            const connectUrl = hasEnv
              ? buildWireConnectUrl(bridgeHandle.environmentId, bridgeHandle.sessionIngressUrl)
              : undefined
            setAppState((prevState) => {
              if (prevState.replWireConnected && prevState.replWireSessionUrl === url) {
                return prevState
              }
              return {
                ...prevState,
                replWireConnected: true,
                replWireSessionUrl: url,
                replWireConnectUrl: connectUrl ?? prevState.replWireConnectUrl,
                replWireEnvironmentId: bridgeHandle.environmentId,
                replWireSessionId: bridgeHandle.bridgeSessionId,
                replWireError: undefined,
              }
            })

            // 在转录中显示 bridge 状态及 URL。perpetual（KAIROS
            // assistant 模式）在 initReplBridge.ts 回退到 v1——
            // 为他们跳过仅 v2 的升级提示。使用独立的 try/catch，
            // 使 GrowthBook 的小问题不会影响到外层的 init-failure handler。
            const upgradeNudge = !perpetual
              ? await shouldShowAppUpgradeMessage().catch(() => false)
              : false
            if (cancelled) {
              return
            }
            setMessages((prevMessages) => [
              ...prevMessages,
              createWireStatusMessage(
                url,
                upgradeNudge
                  ? 'Please upgrade to the latest version of the Zy mobile app to see your Remote Control sessions.'
                  : undefined,
              ),
            ])
            logForDebugging(
              `[bridge:repl] Hook initialized, session=${bridgeHandle.bridgeSessionId}`,
            )
          }
        } catch (err) {
          // 绝不让 REPL 崩溃——在 UI 中暴露错误。
          // 先检查 cancelled（与 ~386 行 !handle 路径对称）：
          // 如果 initReplBridge 在快速 toggle-off 期间抛出（进行中的网络错误），
          // 不要将其计入保险丝或向 UI 发送过时的错误。
          // 同时修复了之前在 cancelled 抛出时虚假的 setAppState/setMessages。
          if (cancelled) {
            return
          }
          consecutiveFailuresRef.current++
          const errMsg = errorMessage(err)
          logForDebugging(
            `[bridge:repl] Init failed: ${errMsg}; consecutive failures: ${consecutiveFailuresRef.current}`,
          )
          clearTimeout(failureTimeoutRef.current)
          notifyWireFailed(errMsg)
          setAppState((prevState) => ({
            ...prevState,
            replWireError: errMsg,
          }))
          failureTimeoutRef.current = setTimeout(() => {
            if (cancelled) {
              return
            }
            failureTimeoutRef.current = undefined
            setAppState((prevState) => {
              if (!prevState.replWireError) {
                return prevState
              }
              return {
                ...prevState,
                replBridgeEnabled: false,
                replWireError: undefined,
              }
            })
          }, BRIDGE_FAILURE_DISMISS_MS)
          if (!outboundOnly) {
            setMessages((prevMessages) => [
              ...prevMessages,
              createSystemMessage(`Remote Control failed to connect: ${errMsg}`, 'error'),
            ])
          }
        }
      })()
      return () => {
        cancelled = true
        clearTimeout(failureTimeoutRef.current)
        failureTimeoutRef.current = undefined
        if (handleRef.current) {
          logForDebugging(
            `[bridge:repl] Hook cleanup: starting teardown for env=${handleRef.current.environmentId} session=${handleRef.current.bridgeSessionId}`,
          )
          teardownPromiseRef.current = handleRef.current.teardown()
          handleRef.current = null
          setReplWireHandle(null)
        }
        setAppState((prevState) => {
          if (
            !prevState.replWireConnected &&
            !prevState.replWireSessionActive &&
            !prevState.replWireError
          ) {
            return prevState
          }
          return {
            ...prevState,
            replWireConnected: false,
            replWireSessionActive: false,
            replWireReconnecting: false,
            replWireConnectUrl: undefined,
            replWireSessionUrl: undefined,
            replWireEnvironmentId: undefined,
            replWireSessionId: undefined,
            replWireError: undefined,
            replWirePermissionCallbacks: undefined,
          }
        })
        lastWrittenIndexRef.current = 0
      }
    }
  }, [
    replBridgeEnabled,
    replBridgeOutboundOnly,
    setAppState,
    setMessages,
    addNotification,
    messages,
    store.getState,
    replWireInitialName,
    abortControllerRef.current?.abort,
  ])

  // 新消息出现时写入。
  // 当 replWireConnected 变化时（bridge 完成初始化）也会重跑，
  // 因此 bridge 就绪之前到达的消息也会被写入。
  useEffect(() => {
    // 正向 feature() 守卫——参见第一个 useEffect 注释
    if (feature('BRIDGE_MODE')) {
      if (!replWireConnected) {
        return
      }
      const bridgeHandle = handleRef.current
      if (!bridgeHandle) {
        return
      }

      // 如果消息被压缩（数组缩短），钳位索引。
      // 压缩后 ref 可能超过 messages.length，如果不钳位则不会转发新消息。
      if (lastWrittenIndexRef.current > messages.length) {
        logForDebugging(
          `[bridge:repl] Compaction detected: lastWrittenIndex=${lastWrittenIndexRef.current} > messages.length=${messages.length}, clamping`,
        )
      }
      const startIndex = Math.min(lastWrittenIndexRef.current, messages.length)

      // 收集上次写入以来的新消息
      const newMessages: Message[] = []
      for (let i = startIndex; i < messages.length; i++) {
        const message = messages[i]
        if (
          message &&
          (message.type === 'user' ||
            message.type === 'assistant' ||
            (message.type === 'system' && message.subtype === 'local_command'))
        ) {
          newMessages.push(message)
        }
      }
      lastWrittenIndexRef.current = messages.length
      if (newMessages.length > 0) {
        bridgeHandle.writeMessages(newMessages)
      }
    }
  }, [messages, replWireConnected])
  const sendWireResult = useCallback(() => {
    if (feature('BRIDGE_MODE')) {
      handleRef.current?.sendResult()
    }
  }, [])
  return {
    sendWireResult,
  }
}
