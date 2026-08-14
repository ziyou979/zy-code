// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 无环境层的 Remote Control bridge 核心。
 *
 * “无环境层”表示不经过 Environments API，与作为 /worker/* transport 协议的 “CCR v2” 不同；
 * 基于环境的路径 replBridge.ts 也能通过 ZY_CODE_ 使用 CCR v2 transport。本文件关注移除
 * poll/dispatch 层，而不是底层采用哪种 transport 协议。
 *
 * 与基于环境、约 2400 行的 initBridgeCore 不同，此实现不经过 Environments API 工作分发层，
 * 而是直接连接 session-ingress 层：
 *
 *   1. POST /v1/code/sessions              (OAuth, no env_id)  → session.id
 *   2. POST /v1/code/sessions/{id}/bridge  (OAuth)             → {worker_jwt, expires_in, api_base_url, worker_epoch}
 *      每次 /bridge 调用都会递增 epoch；该调用本身就是注册，无需单独调用 /worker/register。
 *   3. createV2ReplTransport(worker_jwt, worker_epoch)         → SSE + CCRClient
 *   4. createTokenRefreshScheduler                             → proactive /bridge re-call (new JWT + new epoch)
 *   5. 401 on SSE → rebuild transport with fresh /bridge credentials (same seq-num)
 *
 * 不包含环境的 register/poll/ack/stop/heartbeat/deregister 生命周期。历史上需要
 * Environments API，是因为 CCR 的 /worker/* 端点要求 session_id+role=worker JWT，且只有
 * 工作分发层能签发。服务端 PR #292605（在 #293280 中重命名）新增 /bridge 端点，可直接完成
 * OAuth→worker_jwt 交换，使 REPL 会话可以不使用环境层。
 *
 * 由 initReplBridge.ts 中的 `zy_bridge_repl_v2` GrowthBook 开关控制。
 * 仅用于 REPL；daemon/print 仍使用环境路径。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { createV2ReplTransport, type ReplWireTransport } from './replBridgeTransport.js'
import { buildCCRv2SdkUrl } from './workSecret.js'
import { toCompatSessionId } from './sessionIdCompat.js'
import { FlushGate } from './flushGate.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import { getEnvLessWireConfig, type EnvLessWireConfig } from './envLessBridgeConfig.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleWireMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import { logWireSkip } from './debugUtils.js'
import { logForDebugging } from '../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../services/telemetry/diagLogs.js'
import { isInProtectedNamespace } from '../services/infra/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ReplWireHandle, WireState } from './replBridge.js'
import type { Message } from '../types/message.js'
import type { WireMessage } from '../types/index.js'
import type { WireControlRequest, WireControlResponse } from '../types/wire/control.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
const ANTHROPIC_VERSION = '2023-06-01'

// ws_connected 的 telemetry 判别值。'initial' 是默认值，绝不会传给只能在初始化后调用的
// rebuildTransport；Exclude<> 在两个签名中显式表达此约束。
type ConnectCause = 'initial' | 'proactive_refresh' | 'auth_401_recovery'

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

export type EnvLessWireParams = {
  baseUrl: string
  orgUUID: string
  title: string
  getAccessToken: () => string | undefined
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * 为 writeMessages() 及初始 flush/drain 路径将内部 Message[] 转为 WireMessage[]。通过注入而非
   * import 提供，因为 mappers.ts 会间接引入 src/commands.ts（完整 command 注册表与 React 树），
   * 使原本不含这些内容的 bundle 膨胀。
   */
  toSDKMessages: (messages: Message[]) => WireMessage[]
  initialHistoryCap: number
  initialMessages?: Message[]
  onInboundMessage?: (msg: WireMessage) => void | Promise<void>
  /**
   * writeMessages() 每看到一条适合生成标题的用户消息便触发，直到 callback 返回 true（完成）。
   * 与 replBridge.ts 的 onUserMessage 一致：调用方推导标题并 PATCH /v1/sessions/{id}，避免自动
   * 启动会话一直使用通用回退标题。调用方负责在第 1 与第 3 条时推导的策略；transport 只负责
   * 持续调用直到收到停止信号。sessionId 是原始 cse_*，updateWireSessionTitle 会在内部重新标记。
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  onPermissionResponse?: (response: WireControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (mode: PermissionMode) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: WireState, detail?: string) => void
  /**
   * 为 true 时不打开 SSE 读取流，只启用 CCRClient 写入路径。该值传递给
   * createV2ReplTransport 与 handleServerControlRequest。
   */
  outboundOnly?: boolean
  /** 用于会话分类的自由格式 tag，例如 ['ccr-mirror']。 */
  tags?: string[]
}

/**
 * 创建会话、获取 worker JWT，并连接 v2 transport。
 *
 * 任一前置步骤失败（创建会话、/bridge、transport 设置失败）时返回 null。调用方
 * initReplBridge 会将其呈现为通用的“初始化失败”状态。
 */
export async function initEnvLessWireCore(
  params: EnvLessWireParams,
): Promise<ReplWireHandle | null> {
  const {
    baseUrl,
    orgUUID,
    title,
    getAccessToken,
    onAuth401,
    toSDKMessages,
    initialHistoryCap,
    initialMessages,
    onInboundMessage,
    onUserMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    outboundOnly,
    tags,
  } = params

  const cfg = await getEnvLessWireConfig()

  // ── 1. 创建会话（POST /v1/code/sessions，不含 env_id）──────────────────
  const accessToken = getAccessToken()
  if (!accessToken) {
    logForDebugging('[remote-bridge] No OAuth token')
    return null
  }

  const createdSessionId = await withRetry(
    () => createCodeSession(baseUrl, accessToken, title, cfg.http_timeout_ms, tags),
    'createCodeSession',
    cfg,
  )
  if (!createdSessionId) {
    onStateChange?.('failed', 'Session creation failed — see debug log')
    logWireSkip('v2_session_create_failed', undefined, true)
    return null
  }
  const sessionId: string = createdSessionId
  logForDebugging(`[remote-bridge] Created session ${sessionId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_v2_session_created')

  // ── 2. 获取 bridge 凭据（POST /bridge → worker_jwt、expires_in、api_base_url）──
  const credentials = await withRetry(
    () => fetchRemoteCredentials(sessionId, baseUrl, accessToken, cfg.http_timeout_ms),
    'fetchRemoteCredentials',
    cfg,
  )
  if (!credentials) {
    onStateChange?.('failed', 'Remote credentials fetch failed — see debug log')
    logWireSkip('v2_remote_creds_failed', undefined, true)
    void archiveSession(sessionId, baseUrl, accessToken, orgUUID, cfg.http_timeout_ms)
    return null
  }
  logForDebugging(
    `[remote-bridge] Fetched bridge credentials (expires_in=${credentials.expires_in}s)`,
  )

  // ── 3. 构建 v2 transport（SSETransport + CCRClient）────────────────────
  const sessionUrl = buildCCRv2SdkUrl(credentials.api_base_url, sessionId)
  logForDebugging(`[remote-bridge] v2 session URL: ${sessionUrl}`)

  let transport: ReplWireTransport
  try {
    transport = await createV2ReplTransport({
      sessionUrl,
      ingressToken: credentials.worker_jwt,
      sessionId,
      epoch: credentials.worker_epoch,
      heartbeatIntervalMs: cfg.heartbeat_interval_ms,
      heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
      // 各实例独立的闭包，避免将 worker JWT 放入 process.env.ZY_CODE_SESSION_ACCESS_TOKEN。
      // mcp/client.ts 会无条件读取该环境变量，否则可能把 JWT 发给用户配置的 ws/http MCP server。
      // 构造时固定值是正确的，因为刷新时会完整重建 transport（见下方 rebuildTransport）。
      getAuthToken: () => credentials.worker_jwt,
      outboundOnly,
    })
  } catch (err) {
    logForDebugging(`[remote-bridge] v2 transport setup failed: ${errorMessage(err)}`, {
      level: 'error',
    })
    onStateChange?.('failed', `Transport setup failed: ${errorMessage(err)}`)
    logWireSkip('v2_transport_setup_failed', undefined, true)
    void archiveSession(sessionId, baseUrl, accessToken, orgUUID, cfg.http_timeout_ms)
    return null
  }
  logForDebugging(`[remote-bridge] v2 transport created (epoch=${credentials.worker_epoch})`)
  onStateChange?.('ready')

  // ── 4. 状态 ─────────────────────────────────────────────────────────────

  // 回显去重：POST 的消息会从读取流返回。以初始消息 UUID 作为种子，从而识别服务端对已 flush
  // 历史的回显。两个集合都覆盖初始 UUID：recentPostedUUIDs 是容量 2000 的环形缓冲区，实时写入
  // 足够多后可能淘汰它们；initialMessageUUIDs 是无界回退。形成纵深防御，与 replBridge.ts 一致。
  const recentPostedUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
      recentPostedUUIDs.add(msg.uuid)
    }
  }

  // 对重新投递的入站 prompt 做防御性去重，覆盖 seq-num 协商边界情况及 transport 更换后的
  // 服务端历史重放。
  const recentInboundUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)

  // FlushGate：历史 flush POST 进行期间将实时写入排队，使服务端按 [history..., live...] 顺序接收。
  const flushGate = new FlushGate<Message>()

  let initialFlushDone = false
  let tornDown = false
  let authRecoveryInFlight = false
  // onUserMessage 的 latch；callback 返回 true（策略表示“完成推导”）时置为 true。sessionId 是
  // const，不存在重建会话路径；rebuildTransport 只替换同一会话的 JWT/epoch，因此无需重置。
  let userMessageCallbackDone = !onUserMessage

  // telemetry：onConnect 为何触发？rebuildTransport 在 wireTransportCallbacks 前设置，
  // onConnect 异步读取。authRecoveryInFlight 会串行化重建调用方，而每次新的
  // initEnvLessWireCore() 调用都会获得默认值为 'initial' 的新闭包，因此不存在竞争。
  let connectCause: ConnectCause = 'initial'

  // transport.connect() 后等待 onConnect 的截止时间。onConnect（已连接）与 onClose（收到关闭，
  // 并非静默）都会清除。若二者在 cfg.connect_timeout_ms 前均未触发，则发送 onConnectTimeout；
  // 这是 `started →（静默）` 空档的唯一信号。
  let connectDeadline: ReturnType<typeof setTimeout> | undefined
  function onConnectTimeout(cause: ConnectCause): void {
    if (tornDown) {
      return
    }
    logEvent('zy_bridge_repl_connect_timeout', {
      v2: true,
      elapsed_ms: cfg.connect_timeout_ms,
      cause: cause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // ── 5. JWT 刷新调度器 ───────────────────────────────────────────────────
  // 根据 response.expires_in 在过期前 5 分钟安排 callback。触发时使用 OAuth 重新请求 /bridge，
  // 再用新凭据重建 transport。每次 /bridge 调用都会在服务端递增 epoch，因此只替换 JWT 会让
  // 旧 CCRClient 继续用陈旧 epoch 发送心跳，并在 20 秒内收到 409。JWT 是 opaque 数据，不要解码。
  const refresh = createTokenRefreshScheduler({
    refreshBufferMs: cfg.token_refresh_buffer_ms,
    getAccessToken: async () => {
      // 调用 /bridge 前无条件刷新 OAuth。getAccessToken() 会把过期 token 作为非 null 字符串返回，
      // 因为它不检查 expiresAt，所以 truthy 不代表有效。将陈旧 token 传给 onAuth401，使
      // handleOAuth401Error 的 keychain 比较能检测并行刷新。
      const stale = getAccessToken()
      if (onAuth401) {
        await onAuth401(stale ?? '')
      }
      return getAccessToken() ?? stale
    },
    onRefresh: (sid, oauthToken) => {
      void (async () => {
        // 笔记本唤醒时，逾期的主动刷新定时器与 SSE 401 会近乎同时触发。在请求 /bridge 前先占用
        // flag，使另一条路径完全跳过，避免 epoch 递增两次；若两边都请求，第一次重建会拿到陈旧
        // epoch 并收到 409。
        if (authRecoveryInFlight || tornDown) {
          logForDebugging('[remote-bridge] Recovery already in flight, skipping proactive refresh')
          return
        }
        authRecoveryInFlight = true
        try {
          const fresh = await withRetry(
            () => fetchRemoteCredentials(sid, baseUrl, oauthToken, cfg.http_timeout_ms),
            'fetchRemoteCredentials (proactive)',
            cfg,
          )
          if (!fresh || tornDown) {
            return
          }
          await rebuildTransport(fresh, 'proactive_refresh')
          logForDebugging('[remote-bridge] Transport rebuilt (proactive refresh)')
        } catch (err) {
          logForDebugging(
            `[remote-bridge] Proactive refresh rebuild failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'bridge_repl_v2_proactive_refresh_failed')
          if (!tornDown) {
            onStateChange?.('failed', `Refresh failed: ${errorMessage(err)}`)
          }
        } finally {
          authRecoveryInFlight = false
        }
      })()
    },
    label: 'remote',
  })
  refresh.scheduleFromExpiresIn(sessionId, credentials.expires_in)

  // ── 6. Wire callback（提取后 transport 重建时可重新绑定）────────────────
  function wireTransportCallbacks(): void {
    transport.setOnConnect(() => {
      clearTimeout(connectDeadline)
      logForDebugging('[remote-bridge] v2 transport connected')
      logForDiagnosticsNoPII('info', 'bridge_repl_v2_transport_connected')
      logEvent('zy_bridge_repl_ws_connected', {
        v2: true,
        cause: connectCause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
        initialFlushDone = true
        // 捕获当前 transport；若 flush 中途发生 401 或 teardown，陈旧的 .finally() 不能清空 gate
        // 或发出已连接信号。防护模式与 replBridge.ts:1119 相同。
        const flushTransport = transport
        void flushHistory(initialMessages)
          .catch((e) => logForDebugging(`[remote-bridge] flushHistory failed: ${e}`))
          .finally(() => {
            // authRecoveryInFlight 用于处理 v1 与 v2 的不对称：v1 会在 setOnClose 中同步清空
            // transport（replBridge.ts:1175），因此 transport !== flushTransport 会立即成立。v2 不会
            // 清空，transport 要到 rebuildTransport:346、经过 3 个 await 后才重新赋值。
            // authRecoveryInFlight 在进入 rebuildTransport 时同步设置。
            if (transport !== flushTransport || tornDown || authRecoveryInFlight) {
              return
            }
            drainFlushGate()
            onStateChange?.('connected')
          })
      } else if (!flushGate.active) {
        onStateChange?.('connected')
      }
    })

    transport.setOnData((data: string) => {
      handleIngressMessage(
        data,
        recentPostedUUIDs,
        recentInboundUUIDs,
        onInboundMessage,
        // 远程 client 已响应权限 prompt，turn 将继续。缺少此更新时，服务端会一直停留在
        // requires_action，直到下一条用户消息或 turn 结束结果。
        onPermissionResponse
          ? (res) => {
              transport.reportState('running')
              onPermissionResponse(res)
            }
          : undefined,
        (req) =>
          handleServerControlRequest(req, {
            transport,
            sessionId,
            onInterrupt,
            onSetModel,
            onSetMaxThinkingTokens,
            onSetPermissionMode,
            outboundOnly,
          }),
      )
    })

    transport.setOnClose((code?: number) => {
      clearTimeout(connectDeadline)
      if (tornDown) {
        return
      }
      logForDebugging(`[remote-bridge] v2 transport closed (code=${code})`)
      logEvent('zy_bridge_repl_ws_closed', { code, v2: true })
      // onClose 只在终态失败时触发：401（JWT 无效）、4090（CCR epoch 不匹配）、4091（CCR 初始化
      // 失败），或 SSE 的 10 分钟重连预算耗尽。瞬时断开由 SSETransport 内部透明处理。401 可通过
      // 获取新 JWT 并重建 transport 恢复；其他关闭码均无法恢复。
      if (code === 401 && !authRecoveryInFlight) {
        void recoverFromAuthFailure()
        return
      }
      onStateChange?.('failed', `Transport closed (code ${code})`)
    })
  }

  // ── 7. Transport 重建（主动刷新与 401 恢复共用）──────────────────────────
  // 每次 /bridge 调用都会在服务端递增 epoch。两条刷新路径都必须用新 epoch 重建 transport；
  // 只替换 JWT 会让旧 CCRClient 继续用陈旧 epoch 发送心跳并收到 409。SSE 从旧 transport 的
  // seq-num 高水位恢复，因此服务端无需重放。调用方必须在调用前同步设置
  // authRecoveryInFlight = true（任何 await 之前），并在 finally 中清除。本函数不管理该 flag；
  // 若移到这里，已来不及阻止两次 /bridge 请求，而每次请求都会递增 epoch。
  async function rebuildTransport(
    fresh: RemoteCredentials,
    cause: Exclude<ConnectCause, 'initial'>,
  ): Promise<void> {
    connectCause = cause
    // 重建期间将写入排队；/bridge 返回后旧 transport 的 epoch 已陈旧，下一次写入或心跳会收到
    // 409。若无此 gate，writeMessages 会先把 UUID 加入 recentPostedUUIDs，随后 writeBatch 因
    // uploader 在 409 后关闭而静默不操作，导致消息永久静默丢失。
    flushGate.start()
    try {
      const seq = transport.getLastSequenceNum()
      transport.close()
      transport = await createV2ReplTransport({
        sessionUrl: buildCCRv2SdkUrl(fresh.api_base_url, sessionId),
        ingressToken: fresh.worker_jwt,
        sessionId,
        epoch: fresh.worker_epoch,
        heartbeatIntervalMs: cfg.heartbeat_interval_ms,
        heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
        initialSequenceNum: seq,
        getAuthToken: () => fresh.worker_jwt,
        outboundOnly,
      })
      if (tornDown) {
        // 异步 createV2ReplTransport 期间触发了 teardown。不要再绑定、连接或调度，否则会在
        // cancelAll() 后重新启动定时器，并向已拆除的 bridge 触发 onInboundMessage。
        transport.close()
        return
      }
      wireTransportCallbacks()
      transport.connect()
      connectDeadline = setTimeout(onConnectTimeout, cfg.connect_timeout_ms, connectCause)
      refresh.scheduleFromExpiresIn(sessionId, fresh.expires_in)
      // 将排队写入清空到新 uploader。此操作在 ccr.initialize() 完成前运行，因为
      // transport.connect() 是 fire-and-forget，但 uploader 会排在初始 PUT /worker 后串行执行。
      // 若初始化以 4091 失败，事件会丢弃；不过只有各实例的 recentPostedUUIDs 被填充，因此重新
      // 启用 bridge 时会再次 flush。
      drainFlushGate()
    } finally {
      // 失败路径也要结束 gate；成功时 drainFlushGate 已结束。排队消息会被丢弃，因为 transport
      // 仍不可用。
      flushGate.drop()
    }
  }

  // ── 8. 401 恢复（OAuth 刷新与重建）─────────────────────────────────────
  async function recoverFromAuthFailure(): Promise<void> {
    // setOnClose 已检查 `!authRecoveryInFlight`，但该检查与此处赋值相对于 onRefresh 必须是
    // 原子操作；在任何 await 前同步占用。笔记本唤醒会近乎同时触发两条路径。
    if (authRecoveryInFlight) {
      return
    }
    authRecoveryInFlight = true
    onStateChange?.('reconnecting', 'JWT expired — refreshing')
    logForDebugging('[remote-bridge] 401 on SSE — attempting JWT refresh')
    try {
      // 无条件尝试刷新 OAuth；getAccessToken() 会把过期 token 作为非 null 字符串返回，因此
      // !oauthToken 无法发现过期。传入陈旧 token，使 handleOAuth401Error 的 keychain 比较能
      // 检测其他 tab 是否已刷新。
      const stale = getAccessToken()
      if (onAuth401) {
        await onAuth401(stale ?? '')
      }
      const oauthToken = getAccessToken() ?? stale
      if (!oauthToken || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed: no OAuth token')
        }
        return
      }

      const fresh = await withRetry(
        () => fetchRemoteCredentials(sessionId, baseUrl, oauthToken, cfg.http_timeout_ms),
        'fetchRemoteCredentials (recovery)',
        cfg,
      )
      if (!fresh || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed after 401')
        }
        return
      }
      // 若 401 中断初始 flush，writeBatch 可能在已关闭 uploader 上静默不操作；SSE wrapper 会在
      // 本地 setOnClose callback 前调用 ccr.close()。重置后，新 onConnect 会再次 flush。v1 在
      // replBridge.ts:1027 将 initialFlushDone 放在各 transport 闭包中，会自然重置；v2 则位于外层。
      initialFlushDone = false
      await rebuildTransport(fresh, 'auth_401_recovery')
      logForDebugging('[remote-bridge] Transport rebuilt after 401')
    } catch (err) {
      logForDebugging(`[remote-bridge] 401 recovery failed: ${errorMessage(err)}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'bridge_repl_v2_jwt_refresh_failed')
      if (!tornDown) {
        onStateChange?.('failed', `JWT refresh failed: ${errorMessage(err)}`)
      }
    } finally {
      authRecoveryInFlight = false
    }
  }

  wireTransportCallbacks()

  // 在 connect 前启动 flushGate，使握手期间的 writeMessages() 排队，而不与历史 POST 竞争。
  if (initialMessages && initialMessages.length > 0) {
    flushGate.start()
  }
  transport.connect()
  connectDeadline = setTimeout(onConnectTimeout, cfg.connect_timeout_ms, connectCause)

  // ── 8. 历史 flush 与 drain helper ──────────────────────────────────────
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) {
      return
    }
    for (const msg of msgs) {
      recentPostedUUIDs.add(msg.uuid)
    }
    const events = toSDKMessages(msgs).map((m) => ({
      ...m,
      session_id: sessionId,
    }))
    if (msgs.some((m) => m.type === 'user')) {
      transport.reportState('running')
    }
    logForDebugging(`[remote-bridge] Drained ${msgs.length} queued message(s) after flush`)
    void transport.writeBatch(events)
  }

  async function flushHistory(msgs: Message[]): Promise<void> {
    // v2 始终创建新的服务端会话（上方无条件调用 createCodeSession），不复用会话，也不存在重复
    // POST 风险。与 v1 不同，此处不按 previouslyFlushedUUIDs 过滤；该集合通过 useRef 跨 REPL
    // 启用/禁用周期保留，否则重新启用时会错误抑制历史。
    const eligible = msgs.filter(isEligibleWireMessage)
    const capped =
      initialHistoryCap > 0 && eligible.length > initialHistoryCap
        ? eligible.slice(-initialHistoryCap)
        : eligible
    if (capped.length < eligible.length) {
      logForDebugging(
        `[remote-bridge] Capped initial flush: ${eligible.length} -> ${capped.length} (cap=${initialHistoryCap})`,
      )
    }
    const events = toSDKMessages(capped).map((m) => ({
      ...m,
      session_id: sessionId,
    }))
    if (events.length === 0) {
      return
    }
    // turn 中途初始化：若查询运行期间启用 Remote Control，最后一条符合条件的消息是用户 prompt
    // 或 tool_result，二者类型均为 'user'。缺少此处理时，init PUT 的 'idle' 会一直保留到下条
    // user 类型消息经 writeMessages 转发；纯文本 turn 中永远不会发生，因为初始化后只流式发送
    // assistant chunk。检查限额前的 eligible，而非 capped；即使真实尾部消息是 assistant，限额
    // 也可能截断到用户消息。
    if (eligible.at(-1)?.type === 'user') {
      transport.reportState('running')
    }
    logForDebugging(`[remote-bridge] Flushing ${events.length} history events`)
    await transport.writeBatch(events)
  }

  // ── 9. Teardown ─────────────────────────────────────────────────────────
  // SIGINT/SIGTERM/⁠/exit 时，gracefulShutdown 会让 runCleanupFunctions() 与 2 秒上限竞争，
  // 随后 forceExit 终止进程。预算如下：
  //   - archive：teardown_archive_timeout_ms（默认 1500，上限 2000）
  //   - result 写入：fire-and-forget，归档延迟为 drain 留出时间
  //   - 401 重试：仅当首次归档收到 401，与归档共享预算
  async function teardown(): Promise<void> {
    if (tornDown) {
      return
    }
    tornDown = true
    refresh.cancelAll()
    clearTimeout(connectDeadline)
    flushGate.drop()

    // 归档前发送 result 消息。transport.write() 只等待入队；SerialBatchEventUploader 缓冲后即
    // 完成，drain 异步进行。在 close() 前归档，可借助通常约 100 至 500ms 的归档耗时，为 uploader
    // drain 循环提供 POST result 的窗口，无需显式 sleep。close() 会设置 closed=true，在下次
    // while 检查时中断 drain，因此先关闭再归档会丢失 result。
    transport.reportState('idle')
    void transport.write(makeResultMessage(sessionId))

    let token = getAccessToken()
    let status = await archiveSession(
      sessionId,
      baseUrl,
      token,
      orgUUID,
      cfg.teardown_archive_timeout_ms,
    )

    // token 通常是新鲜的，因为刷新调度器会在过期前 5 分钟运行；但笔记本错过刷新窗口后唤醒，
    // getAccessToken() 仍会返回陈旧字符串。收到 401 时重试一次：onAuth401（即
    // handleOAuth401Error）会清除 keychain 缓存并强制刷新。正常路径不主动刷新，因为
    // handleOAuth401Error 即使 token 有效也会强制刷新，99% 的情况下会浪费预算。try/catch 与
    // recoverFromAuthFailure 一致：keychain 读取可能抛错（例如 macOS 唤醒后仍锁定），若此处
    // 未捕获，会跳过 transport.close 与 telemetry。
    if (status === 401 && onAuth401) {
      try {
        await onAuth401(token ?? '')
        token = getAccessToken()
        status = await archiveSession(
          sessionId,
          baseUrl,
          token,
          orgUUID,
          cfg.teardown_archive_timeout_ms,
        )
      } catch (err) {
        logForDebugging(`[remote-bridge] Teardown 401 retry threw: ${errorMessage(err)}`, {
          level: 'error',
        })
      }
    }

    transport.close()

    const archiveStatus: ArchiveTelemetryStatus =
      status === 'no_token'
        ? 'skipped_no_token'
        : status === 'timeout' || status === 'error'
          ? 'network_error'
          : status >= 500
            ? 'server_5xx'
            : status >= 400
              ? 'server_4xx'
              : 'ok'

    logForDebugging(`[remote-bridge] Torn down (archive=${status})`)
    logForDiagnosticsNoPII('info', 'bridge_repl_v2_teardown')
    logEvent(
      feature('CCR_MIRROR') && outboundOnly ? 'zy_ccr_mirror_teardown' : 'zy_bridge_repl_teardown',
      {
        v2: true,
        archive_status: archiveStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        archive_ok: typeof status === 'number' && status < 400,
        archive_http_status: typeof status === 'number' ? status : undefined,
        archive_timeout: status === 'timeout',
        archive_no_token: status === 'no_token',
      },
    )
  }
  const unregister = registerCleanup(teardown)

  if (feature('CCR_MIRROR') && outboundOnly) {
    logEvent('zy_ccr_mirror_started', {
      v2: true,
      expires_in_s: credentials.expires_in,
    })
  } else {
    logEvent('zy_bridge_repl_started', {
      has_initial_messages: !!(initialMessages && initialMessages.length > 0),
      v2: true,
      expires_in_s: credentials.expires_in,
      inProtectedNamespace: isInProtectedNamespace(),
    })
  }

  // ── 10. Handle ─────────────────────────────────────────────────────────
  return {
    bridgeSessionId: sessionId,
    environmentId: '',
    sessionIngressUrl: credentials.api_base_url,
    writeMessages(messages) {
      const filtered = messages.filter(
        (m) =>
          isEligibleWireMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) {
        return
      }

      // 触发 onUserMessage 以推导标题。在 flushGate 检查前扫描，因为即使 prompt 排队，也适合
      // 生成标题。每条适合生成标题的消息都会调用，直到 callback 返回 true；策略由调用方负责，
      // 例如第 1 与第 3 条时推导，显式标题则跳过。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, sessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      if (flushGate.enqueue(...filtered)) {
        logForDebugging(`[remote-bridge] Queued ${filtered.length} message(s) during flush`)
        return
      }

      for (const msg of filtered) {
        recentPostedUUIDs.add(msg.uuid)
      }
      const events = toSDKMessages(filtered).map((m) => ({
        ...m,
        session_id: sessionId,
      }))
      // v2 服务端不会像 v1 的 session-ingress session_status_updater.go 那样从事件推导
      // worker_status。此处主动推送，使 CCR Web 会话列表显示 Running 而非一直停在 Idle。批次中
      // 存在用户消息表示 turn 开始。CCRClient.reportState 会去重连续的同状态推送。
      if (filtered.some((m) => m.type === 'user')) {
        transport.reportState('running')
      }
      logForDebugging(`[remote-bridge] Sending ${filtered.length} message(s)`)
      void transport.writeBatch(events)
    },
    writeSdkMessages(messages: WireMessage[]) {
      const filtered = messages.filter((m) => !m.uuid || !recentPostedUUIDs.has(m.uuid))
      if (filtered.length === 0) {
        return
      }
      for (const msg of filtered) {
        if (msg.uuid) {
          recentPostedUUIDs.add(msg.uuid)
        }
      }
      const events = filtered.map((m) => ({ ...m, session_id: sessionId }))
      void transport.writeBatch(events)
    },
    sendControlRequest(request: WireControlRequest) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_request during 401 recovery: ${request.request_id}`,
        )
        return
      }
      const event = { ...request, session_id: sessionId }
      if (request.request.subtype === 'can_use_tool') {
        transport.reportState('requires_action')
      }
      void transport.write(event)
      logForDebugging(`[remote-bridge] Sent control_request request_id=${request.request_id}`)
    },
    sendControlResponse(response: WireControlResponse) {
      if (authRecoveryInFlight) {
        logForDebugging('[remote-bridge] Dropping control_response during 401 recovery')
        return
      }
      const event = { ...response, session_id: sessionId }
      transport.reportState('running')
      void transport.write(event)
      logForDebugging('[remote-bridge] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_cancel_request during 401 recovery: ${requestId}`,
        )
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: sessionId,
      }
      // hook/classifier/channel/recheck 已在本地解决权限；这些路径中 interactiveHandler 只调用
      // cancelRequest，不调用 sendResponse，因此缺少此更新会让服务端停留在 requires_action。
      transport.reportState('running')
      void transport.write(event)
      logForDebugging(`[remote-bridge] Sent control_cancel_request request_id=${requestId}`)
    },
    sendResult() {
      if (authRecoveryInFlight) {
        logForDebugging('[remote-bridge] Dropping result during 401 recovery')
        return
      }
      transport.reportState('idle')
      void transport.write(makeResultMessage(sessionId))
      logForDebugging(`[remote-bridge] Sent result`)
    },
    async teardown() {
      unregister()
      await teardown()
    },
  }
}

// ─── Session API（v2 /code/sessions，无环境层）──────────────────────────────

/** 以指数退避和随机抖动重试异步初始化调用。 */
async function withRetry<T>(
  fn: () => Promise<T | null>,
  label: string,
  cfg: EnvLessWireConfig,
): Promise<T | null> {
  const max = cfg.init_retry_max_attempts
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await fn()
    if (result !== null) {
      return result
    }
    if (attempt < max) {
      const base = cfg.init_retry_base_delay_ms * 2 ** (attempt - 1)
      const jitter = base * cfg.init_retry_jitter_fraction * (2 * Math.random() - 1)
      const delay = Math.min(base + jitter, cfg.init_retry_max_delay_ms)
      logForDebugging(
        `[remote-bridge] ${label} failed (attempt ${attempt}/${max}), retrying in ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  return null
}

// 已移到 codeSessionApi.ts，使 SDK /bridge 子路径可以打包这些函数，而无需引入本文件庞大的
// CLI 依赖树（analytics、transport）。
export {
  createCodeSession,
  type RemoteCredentials,
} from './codeSessionApi.js'
import {
  createCodeSession,
  fetchRemoteCredentials as fetchRemoteCredentialsRaw,
  type RemoteCredentials,
} from './codeSessionApi.js'
import { getWireBaseUrlOverride } from './bridgeConfig.js'
// CLI 侧 wrapper：应用 CLAUDE_BRIDGE_BASE_URL 开发覆盖项并注入 trusted-device token。二者都会
// 读取环境或 GrowthBook，而面向 SDK 的 codeSessionApi.ts 导出必须避免这些读取。
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<RemoteCredentials | null> {
  const creds = await fetchRemoteCredentialsRaw(
    sessionId,
    baseUrl,
    accessToken,
    timeoutMs,
    getTrustedDeviceToken(),
  )
  if (!creds) {
    return null
  }
  return getWireBaseUrlOverride() ? { ...creds, api_base_url: baseUrl } : creds
}

type ArchiveStatus = number | 'timeout' | 'error' | 'no_token'

// 供 BQ `GROUP BY archive_status` 使用的单一分类值。_teardown 上的布尔值早于此字段，与其重复；
// archive_timeout 除外，它区分 ECONNABORTED 与其他网络错误。此处二者都映射为
// 'network_error'，因为 1.5 秒窗口中的主要原因是超时。
type ArchiveTelemetryStatus =
  | 'ok'
  | 'skipped_no_token'
  | 'network_error'
  | 'server_4xx'
  | 'server_5xx'

async function archiveSession(
  sessionId: string,
  baseUrl: string,
  accessToken: string | undefined,
  orgUUID: string,
  timeoutMs: number,
): Promise<ArchiveStatus> {
  if (!accessToken) {
    return 'no_token'
  }
  // 归档接口位于兼容层（/v1/sessions/*，不是 /v1/code/sessions）。compat.parseSessionID 只接受
  // TagSession（session_*），因此需重新标记 cse_*。必须携带 anthropic-beta 与
  // x-organization-uuid，否则兼容 gateway 会在到达 handler 前返回 404。
  //
  // 与 bridgeMain.ts 不同：后者在 sessionCompatIds 中缓存 compatId，以便会话中途切换开关时
  // 保持内存中的 titledSessions/logger key 一致；这里的 compatId 只是服务端 URL 路径片段，
  // 不涉及内存状态。每次重新计算可匹配服务端当前校验规则：若开关关闭，服务端已更新为接受
  // cse_*，此处也会正确发送。
  const compatId = toCompatSessionId(sessionId)
  try {
    const response = await axios.post(
      `${baseUrl}/v1/sessions/${compatId}/archive`,
      {},
      {
        headers: {
          ...oauthHeaders(accessToken),
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'x-organization-uuid': orgUUID,
        },
        timeout: timeoutMs,
        validateStatus: () => true,
      },
    )
    logForDebugging(`[remote-bridge] Archive ${compatId} status=${response.status}`)
    return response.status
  } catch (err) {
    const msg = errorMessage(err)
    logForDebugging(`[remote-bridge] Archive failed: ${msg}`)
    return axios.isAxiosError(err) && err.code === 'ECONNABORTED' ? 'timeout' : 'error'
  }
}
