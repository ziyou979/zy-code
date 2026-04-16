// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { randomUUID } from 'crypto'
import {
  createBridgeApiClient,
  BridgeFatalError,
  isExpiredErrorType,
  isSuppressible403,
} from './bridgeApi.js'
import type { BridgeConfig, BridgeApiClient } from './types.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import {
  decodeWorkSecret,
  buildSdkUrl,
  buildCCRv2SdkUrl,
  sameSessionId,
} from './workSecret.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import { HybridTransport } from '../cli/transports/HybridTransport.js'
import {
  type ReplBridgeTransport,
  createV1ReplTransport,
  createV2ReplTransport,
} from './replBridgeTransport.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { validateBridgeId } from './bridgeApi.js'
import {
  describeAxiosError,
  extractHttpStatus,
  logBridgeSkip,
} from './debugUtils.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import { createCapacityWake, type CapacitySignal } from './capacityWake.js'
import { FlushGate } from './flushGate.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import {
  wrapApiForFaultInjection,
  registerBridgeDebugHandle,
  clearBridgeDebugHandle,
  injectBridgeFault,
} from './bridgeDebug.js'

export type ReplBridgeHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}

export type BridgeState = 'ready' | 'connected' | 'reconnecting' | 'failed'

/**
 * Explicit-param input to initBridgeCore. Everything initReplBridge reads
 * from bootstrap state (cwd, session ID, git, OAuth) becomes a field here.
 * A daemon caller (Agent SDK, PR 4) that never runs main.tsx fills these
 * in itself.
 */
export type BridgeCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  /**
   * Opaque string sent as metadata.worker_type. Use BridgeWorkerType for
   * the two CLI-originated values; daemon callers may send any string the
   * backend recognizes (it's just a filter key on the web side).
   */
  workerType: string
  getAccessToken: () => string | undefined
  /**
   * POST /v1/sessions. Injected because `createSession.ts` lazy-loads
   * `auth.ts`/`model.ts`/`oauth/client.ts` and `bun --outfile` inlines
   * dynamic imports — the lazy-load doesn't help, the whole REPL tree ends
   * up in the Agent SDK bundle.
   *
   * REPL wrapper passes `createBridgeSession` from `createSession.ts`.
   * Daemon wrapper passes `createBridgeSessionLean` from `sessionApi.ts`
   * (HTTP-only, orgUUID+model supplied by the daemon caller).
   *
   * Receives `gitRepoUrl`+`branch` so the REPL wrapper can build the git
   * source/outcome for zy.ai's session card. Daemon ignores them.
   */
  createSession: (opts: {
    environmentId: string
    title: string
    gitRepoUrl: string | null
    branch: string
    signal: AbortSignal
  }) => Promise<string | null>
  /**
   * POST /v1/sessions/{id}/archive. Same injection rationale. Best-effort;
   * the callback MUST NOT throw.
   */
  archiveSession: (sessionId: string) => Promise<void>
  /**
   * Invoked on reconnect-after-env-lost to refresh the title. REPL wrapper
   * reads session storage (picks up /rename); daemon returns the static
   * title. Defaults to () => title.
   */
  getCurrentTitle?: () => string
  /**
   * Converts internal Message[] → SDKMessage[] for writeMessages() and the
   * initial-flush/drain paths. REPL wrapper passes the real toSDKMessages
   * from utils/messages/mappers.ts. Daemon callers that only use
   * writeSdkMessages() and pass no initialMessages can omit this — those
   * code paths are unreachable.
   *
   * Injected rather than imported because mappers.ts transitively pulls in
   * src/commands.ts via messages.ts → api.ts → prompts.ts, dragging the
   * entire command registry + React tree into the Agent SDK bundle.
   */
  toSDKMessages?: (messages: Message[]) => SDKMessage[]
  /**
   * OAuth 401 refresh handler passed to createBridgeApiClient. REPL wrapper
   * passes handleOAuth401Error; daemon passes its AuthManager's handler.
   * Injected because utils/auth.ts transitively pulls in the command
   * registry via config.ts → file.ts → permissions/filesystem.ts →
   * sessionStorage.ts → commands.ts.
   */
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * Poll interval config getter for the work-poll heartbeat loop. REPL
   * wrapper passes the GrowthBook-backed getPollIntervalConfig (allows ops
   * to live-tune poll rates fleet-wide). Daemon passes a static config
   * with a 60s heartbeat (5× headroom under the 300s work-lease TTL).
   * Injected because growthbook.ts transitively pulls in the command
   * registry via the same config.ts chain.
   */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * Max initial messages to replay on connect. REPL wrapper reads from the
   * tengu_bridge_initial_history_cap GrowthBook flag. Daemon passes no
   * initialMessages so this is never read. Default 200 matches the flag
   * default.
   */
  initialHistoryCap?: number
  // 与 InitBridgeOptions 相同的 REPL 刷新机制 — daemon 省略这些。
  initialMessages?: Message[]
  previouslyFlushedUUIDs?: Set<string>
  onInboundMessage?: (msg: SDKMessage) => void
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  /**
   * Returns a policy verdict so this module can emit an error control_response
   * without importing the policy checks itself (bootstrap-isolation constraint).
   * The callback must guard `auto` (isAutoModeGateEnabled) and
   * `bypassPermissions` (isBypassPermissionsModeDisabled AND
   * isBypassPermissionsModeAvailable) BEFORE calling transitionPermissionMode —
   * that function's internal auto-gate check is a defensive throw, not a
   * graceful guard, and its side-effect order is setAutoModeActive(true) then
   * throw, which corrupts the 3-way invariant documented in src/CLAUDE.md if
   * the callback lets the throw escape here.
   */
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * Fires on each real user message to flow through writeMessages() until
   * the callback returns true (done). Mirrors remoteBridgeCore.ts's
   * onUserMessage so the REPL bridge can derive a session title from early
   * prompts when none was set at init time (e.g. user runs /remote-control
   * on an empty conversation, then types). Tool-result wrappers, meta
   * messages, and display-tag-only messages are skipped. Receives
   * currentSessionId so the wrapper can PATCH the title without a closure
   * dance to reach the not-yet-returned handle. The caller owns the
   * derive-at-count-1-and-3 policy; the transport just keeps calling until
   * told to stop. Not fired for the writeSdkMessages daemon path (daemon
   * sets its own title at init). Distinct from SessionSpawnOpts's
   * onFirstUserMessage (spawn-bridge, PR #21250), which stays fire-once.
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  /** See InitBridgeOptions.perpetual. */
  perpetual?: boolean
  /**
   * Seeds lastTransportSequenceNum — the SSE event-stream high-water mark
   * that's carried across transport swaps within one process. Daemon callers
   * pass the value they persisted at shutdown so the FIRST SSE connect of a
   * fresh process sends from_sequence_num and the server doesn't replay full
   * history. REPL callers omit (fresh session each run → 0 is correct).
   */
  initialSSESequenceNum?: number
}

/**
 * Superset of ReplBridgeHandle. Adds getSSESequenceNum for daemon callers
 * that persist the SSE seq-num across process restarts and pass it back as
 * initialSSESequenceNum on the next start.
 */
export type BridgeCoreHandle = ReplBridgeHandle & {
  /**
   * Current SSE sequence-number high-water mark. Updates as transports
   * swap. Daemon callers persist this on shutdown and pass it back as
   * initialSSESequenceNum on next start.
   */
  getSSESequenceNum(): number
}

/**
 * Poll error recovery constants. When the work poll starts failing (e.g.
 * server 500s), we use exponential backoff and give up after this timeout.
 * This is deliberately long — the server is the authority on when a session
 * is truly dead. As long as the server accepts our poll, we keep waiting
 * for it to re-dispatch the work item.
 */
const POLL_ERROR_INITIAL_DELAY_MS = 2_000
const POLL_ERROR_MAX_DELAY_MS = 60_000
const POLL_ERROR_GIVE_UP_MS = 15 * 60 * 1000

// 单调递增计数器，用于在日志中区分 init 调用
let initSequence = 0

/**
 * Bootstrap-free core: env registration → session creation → poll loop →
 * ingress WS → teardown. Reads nothing from bootstrap/state or
 * sessionStorage — all context comes from params. Caller (initReplBridge
 * below, or a daemon in PR 4) has already passed entitlement gates and
 * gathered git/auth/title.
 *
 * Returns null on registration or session-creation failure.
 */
export async function initBridgeCore(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle | null> {
  const {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken,
    createSession,
    archiveSession,
    getCurrentTitle = () => title,
    toSDKMessages = () => {
      throw new Error(
        'BridgeCoreParams.toSDKMessages not provided. Pass it if you use writeMessages() or initialMessages — daemon callers that only use writeSdkMessages() never hit this path.',
      )
    },
    onAuth401,
    getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
    initialHistoryCap = 200,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    onUserMessage,
    perpetual,
    initialSSESequenceNum = 0,
  } = params

  const seq = ++initSequence

  // bridgePointer 导入提升：perpetual 模式在 register 之前读取它；
  // 非 perpetual 在 session create 之后写入它；两者都在 teardown 时使用 clear。
  const { writeBridgePointer, clearBridgePointer, readBridgePointer } =
    await import('./bridgePointer.js')

  // Perpetual 模式：读取崩溃恢复指针并将其视为先前
  // 状态。指针在 session create 后无条件写入
  // （所有会话的崩溃恢复）；perpetual 模式只是跳过
  // teardown clear，所以它也能在干净退出后存活。只重用 'repl'
  // 指针 — 崩溃的独立 bridge（`zy remote-control`）
  // 写入 source:'standalone' 和不同的 workerType。
  const rawPrior = perpetual ? await readBridgePointer(dir) : null
  const prior = rawPrior?.source === 'repl' ? rawPrior : null

  logForDebugging(
    `[bridge:repl] initBridgeCore #${seq} starting (initialMessages=${initialMessages?.length ?? 0}${prior ? ` perpetual prior=env:${prior.environmentId}` : ''})`,
  )

  // 5. 注册 bridge 环境
  const rawApi = createBridgeApiClient({
    baseUrl,
    getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401,
    getTrustedDeviceToken,
  })
  // 仅 Ant：拦截以便 /bridge-kick 可以注入 poll/register/heartbeat
  // 故障。在外部构建中零成本（rawApi 直接传递不变）。
  const api =
    process.env.USER_TYPE === 'zy-super' ? wrapApiForFaultInjection(rawApi) : rawApi

  const bridgeConfig: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: 1,
    spawnMode: 'single-session',
    verbose: false,
    sandbox: false,
    bridgeId: randomUUID(),
    workerType,
    environmentId: randomUUID(),
    reuseEnvironmentId: prior?.environmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
  }

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(bridgeConfig)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logBridgeSkip(
      'registration_failed',
      `[bridge:repl] Environment registration failed: ${errorMessage(err)}`,
    )
    // 陈旧指针可能是原因（过期/删除的环境）— 清除它以便
    // 下次启动不会重试相同的死 ID。
    if (prior) {
      await clearBridgePointer(dir)
    }
    onStateChange?.('failed', errorMessage(err))
    return null
  }

  logForDebugging(`[bridge:repl] Environment registered: ${environmentId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_env_registered')
  logEvent('tengu_bridge_repl_env_registered', {})

  /**
   * Reconnect-in-place: if the just-registered environmentId matches what
   * was requested, call reconnectSession to force-stop stale workers and
   * re-queue the session. Used at init (perpetual mode — env is alive but
   * idle after clean teardown) and in doReconnect() Strategy 1 (env lost
   * then resurrected). Returns true on success; caller falls back to
   * fresh session creation on false.
   */
  async function tryReconnectInPlace(
    requestedEnvId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (environmentId !== requestedEnvId) {
      logForDebugging(
        `[bridge:repl] Env mismatch (requested ${requestedEnvId}, got ${environmentId}) — cannot reconnect in place`,
      )
      return false
    }
    // 指针存储 createBridgeSession 返回的内容（session_*，
    // compat/convert.go:41）。/bridge/reconnect 是 environments 层
    // 端点 — 一旦服务器的 ccr_v2_compat_enabled 门控开启，它会
    // 通过 infra 标签（cse_*）查找会话，并对 session_* 伪装返回
    // "Session not found"。我们在 poll 前不知道门控状态，
    // 所以两者都试；如果 ID 已经是 cse_*，重新标记是无操作
    // （doReconnect Strategy 1 路径 — currentSessionId 永远不会变异
    // 为 cse_*，但为未来检查做准备）。
    const infraId = toInfraSessionId(sessionId)
    const candidates =
      infraId === sessionId ? [sessionId] : [sessionId, infraId]
    for (const id of candidates) {
      try {
        await api.reconnectSession(environmentId, id)
        logForDebugging(
          `[bridge:repl] Reconnected session ${id} in place on env ${environmentId}`,
        )
        return true
      } catch (err) {
        logForDebugging(
          `[bridge:repl] reconnectSession(${id}) failed: ${errorMessage(err)}`,
        )
      }
    }
    logForDebugging(
      '[bridge:repl] reconnectSession exhausted — falling through to fresh session',
    )
    return false
  }

  // Perpetual 初始化：环境存活但干净 teardown 后没有排队工作。
  // reconnectSession 重新排队它。doReconnect() 有相同的
  // 调用但只在 poll 404 时触发（环境死亡）；
  // 这里环境存活但空闲。
  const reusedPriorSession = prior
    ? await tryReconnectInPlace(prior.environmentId, prior.sessionId)
    : false
  if (prior && !reusedPriorSession) {
    await clearBridgePointer(dir)
  }

  // 6. 在 bridge 上创建会话。初始消息不包含为
  // 会话创建事件，因为它们使用 STREAM_ONLY 持久化且
  // 在 CCR UI 订阅之前发布，所以会丢失。相反，
  // 初始消息在 ingress WebSocket 连接后通过它刷新。

  // 可变会话 ID — 在连接丢失后重新创建环境+会话对时更新。
  let currentSessionId: string


  if (reusedPriorSession && prior) {
    currentSessionId = prior.sessionId
    logForDebugging(
      `[bridge:repl] Perpetual session reused: ${currentSessionId}`,
    )
    // 服务器已经有之前 CLI 运行的所有 initialMessages。标记
    // 它们为已刷新，以便初始刷新过滤器排除它们
    // （previouslyFlushedUUIDs 在每次 CLI 启动时是新的 Set）。
    // 重复的 UUID 会导致服务器杀死 WebSocket。
    if (initialMessages && previouslyFlushedUUIDs) {
      for (const msg of initialMessages) {
        previouslyFlushedUUIDs.add(msg.uuid)
      }
    }
  } else {
    const createdSessionId = await createSession({
      environmentId,
      title,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!createdSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed, deregistering environment',
      )
      logEvent('tengu_bridge_repl_session_failed', {})
      await api.deregisterEnvironment(environmentId).catch(() => {})
      onStateChange?.('failed', 'Session creation failed')
      return null
    }

    currentSessionId = createdSessionId
    logForDebugging(`[bridge:repl] Session created: ${currentSessionId}`)
  }

  // 崩溃恢复指针：现在写入，以便此后任何时刻的 kill -9
  // 留下可恢复的轨迹。在 teardown 中清除（非 perpetual）
  // 或保持不变（perpetual 模式 — 指针在干净退出后也存活）。
  // 从相同目录运行 `zy remote-control --continue` 会检测到
  // 它并提供恢复选项。
  await writeBridgePointer(dir, {
    sessionId: currentSessionId,
    environmentId,
    source: 'repl',
  })
  logForDiagnosticsNoPII('info', 'bridge_repl_session_created')
  logEvent('tengu_bridge_repl_started', {
    has_initial_messages: !!(initialMessages && initialMessages.length > 0),
    inProtectedNamespace: isInProtectedNamespace(),
  })

  // 初始消息的 UUID。用于 writeMessages 中的去重，以避免
  // 重新发送已在 WebSocket 打开时刷新的消息。
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
    }
  }

  // 已通过 ingress WebSocket 发送到服务器的消息的
  // 有界环形 UUID 缓冲区。有两个用途：
  //  1. 回显过滤 — 忽略我们在 WS 上弹回的自己消息。
  //  2. writeMessages 中的次要去重 — 捕获钩子基于索引的
  //     跟踪不够充分的竞态条件。
  //
  // 用 initialMessageUUIDs 播种，以便当服务器通过 ingress
  // WebSocket 回显初始对话上下文时，这些消息被识别为
  // 回显而不会重新注入 REPL。
  //
  // 容量 2000 远高于任何现实的回显窗口（回显
  // 在几毫秒内到达）和压缩后可能重新遇到的任何消息。
  // 钩子的 lastWrittenIndexRef 是主要去重；这是安全网。
  const recentPostedUUIDs = new BoundedUUIDSet(2000)
  for (const uuid of initialMessageUUIDs) {
    recentPostedUUIDs.add(uuid)
  }

  // 已转发到 REPL 的入站提示 UUID 的有界集合。
  // 当服务器重新传递提示时的防御性去重（seq-num
  // 协商失败、服务器边缘情况、传输交换竞态）。
  // 下面的 seq-num 携带是主要修复；这是安全网。
  const recentInboundUUIDs = new BoundedUUIDSet(2000)

  // 7. 启动工作项轮询循环 — 这就是让会话
  // 在 zy.ai 上"活跃"的原因。当用户在那里输入时，后端
  // 会向我们的环境分发工作项。我们轮询它，获取 ingress token，
  // 并连接 ingress WebSocket。
  //
  // 轮询循环持续运行：当工作到达时它连接 ingress
  // WebSocket，如果 WebSocket 意外断开（code != 1000），它会
  // 恢复轮询以获取新的 ingress token 并重新连接。
  const pollController = new AbortController()
  // 适配 HybridTransport（v1：WS 读取 + POST 写入
  // Session-Ingress）或 SSETransport+CCRClient（v2：SSE 读取 + POST
  // 写入 CCR /worker/*）。v1/v2 选择在 onWorkReceived 中决定：
  // 由 secret.use_code_sessions 服务器驱动，CLAUDE_BRIDGE_USE_CCR_V2
  // 作为 ant-dev 覆盖。
  let transport: ReplBridgeTransport | null = null
  // 每次 onWorkReceived 时递增。在 createV2ReplTransport 的 .then()
  // 闭包中捕获以检测陈旧决议：如果两个调用在 transport 为
  // null 时竞态，两者都调用 registerWorker()（递增服务器 epoch），
  // 第二个解析的是正确的 — 但 transport !== null 检查搞反了
  // （先解析的安装，第二个丢弃）。生成计数器
  // 独立于 transport 状态捕获它。
  let v2Generation = 0
  // 跨传输交换携带的 SSE 序列号高水位标记。
  // 没有这个，每个新的 SSETransport 从 0 开始，在首次连接时
  // 不发送 from_sequence_num / Last-Event-ID，服务器会
  // 重播整个会话事件历史 — 每次发送的每个提示都
  // 作为新的入站消息重新传递。
  //
  // 仅在我们实际重新连接了先前会话时才播种。如果
  // `reusedPriorSession` 为 false，我们落入 `createSession()` —
  // 调用者持久化的 seq-num 属于死会话，应用到
  // 从 1 开始的新流会静默丢弃事件。与 doReconnect
  // Strategy 2 相同的危险；相同的修复。
  let lastTransportSequenceNum = reusedPriorSession ? initialSSESequenceNum : 0
  // 跟踪当前工作 ID，以便 teardown 可以调用 stopWork
  let currentWorkId: string | null = null
  // 当前工作项的会话 ingress JWT — 用于心跳认证。
  let currentIngressToken: string | null = null
  // 当传输丢失时提前唤醒容量睡眠的信号，
  // 以便轮询循环立即切换回快速轮询新工作。
  const capacityWake = createCapacityWake(pollController.signal)
  const wakePollLoop = capacityWake.wake
  const capacitySignal = capacityWake.signal
  // 在初始刷新期间门控消息写入，以防止排序
  // 竞态，新消息与历史交错到达服务器。
  const flushGate = new FlushGate<Message>()

  // onUserMessage 的锁存器 — 当回调返回 true 时翻转为 true
  // （策略说"完成派生"）。如果没有回调，完全跳过扫描
  // （daemon 路径 — 不需要标题派生）。
  let userMessageCallbackDone = !onUserMessage

  // 环境重新创建的共享计数器，由
  // onEnvironmentLost 和异常关闭处理程序共同使用。
  const MAX_ENVIRONMENT_RECREATIONS = 3
  let environmentRecreations = 0
  let reconnectPromise: Promise<boolean> | null = null

  /**
   * Recover from onEnvironmentLost (poll returned 404 — env was reaped
   * server-side). Tries two strategies in order:
   *
   *   1. Reconnect-in-place: idempotent re-register with reuseEnvironmentId
   *      → if the backend returns the same env ID, call reconnectSession()
   *      to re-queue the existing session. currentSessionId stays the same;
   *      the URL on the user's phone stays valid; previouslyFlushedUUIDs is
   *      preserved so history isn't re-sent.
   *
   *   2. Fresh session fallback: if the backend returns a different env ID
   *      (original TTL-expired, e.g. laptop slept >4h) or reconnectSession()
   *      throws, archive the old session and create a new one on the
   *      now-registered env. Old behavior before #20460 primitives landed.
   *
   * Uses a promise-based reentrancy guard so concurrent callers share the
   * same reconnection attempt.
   */
  async function reconnectEnvironmentWithSession(): Promise<boolean> {
    if (reconnectPromise) {
      return reconnectPromise
    }
    reconnectPromise = doReconnect()
    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function doReconnect(): Promise<boolean> {
    environmentRecreations++
    // Invalidate any in-flight v2 handshake — the environment is being
    // recreated, so a stale transport arriving post-reconnect would be
    // pointed at a dead session.
    v2Generation++
    logForDebugging(
      `[bridge:repl] Reconnecting after env lost (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
    )

    if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
      logForDebugging(
        `[bridge:repl] Environment reconnect limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
      )
      return false
    }

    // Close the stale transport. Capture seq BEFORE close — if Strategy 1
    // (tryReconnectInPlace) succeeds we keep the SAME session, and the
    // next transport must resume where this one left off, not replay from
    // the last transport-swap checkpoint.
    if (transport) {
      const seq = transport.getLastSequenceNum()
      if (seq > lastTransportSequenceNum) {
        lastTransportSequenceNum = seq
      }
      transport.close()
      transport = null
    }
    // Transport is gone — wake the poll loop out of its at-capacity
    // heartbeat sleep so it can fast-poll for re-dispatched work.
    wakePollLoop()
    // Reset flush gate so writeMessages() hits the !transport guard
    // instead of silently queuing into a dead buffer.
    flushGate.drop()

    // Release the current work item (force=false — we may want the session
    // back). Best-effort: the env is probably gone, so this likely 404s.
    if (currentWorkId) {
      const workIdBeingCleared = currentWorkId
      await api
        .stopWork(environmentId, workIdBeingCleared, false)
        .catch(() => {})
      // When doReconnect runs concurrently with the poll loop (ws_closed
      // handler case — void-called, unlike the awaited onEnvironmentLost
      // path), onWorkReceived can fire during the stopWork await and set
      // a fresh currentWorkId. If it did, the poll loop has already
      // recovered on its own — defer to it rather than proceeding to
      // archiveSession, which would destroy the session its new
      // transport is connected to.
      if (currentWorkId !== workIdBeingCleared) {
        logForDebugging(
          '[bridge:repl] Poll loop recovered during stopWork await — deferring to it',
        )
        environmentRecreations = 0
        return true
      }
      currentWorkId = null
      currentIngressToken = null
    }

    // Bail out if teardown started while we were awaiting
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted by teardown')
      return false
    }

    // Strategy 1: idempotent re-register with the server-issued env ID.
    // If the backend resurrects the same env (fresh secret), we can
    // reconnect the existing session. If it hands back a different ID, the
    // original env is truly gone and we fall through to a fresh session.
    const requestedEnvId = environmentId
    bridgeConfig.reuseEnvironmentId = requestedEnvId
    try {
      const reg = await api.registerBridgeEnvironment(bridgeConfig)
      environmentId = reg.environment_id
      environmentSecret = reg.environment_secret
    } catch (err) {
      bridgeConfig.reuseEnvironmentId = undefined
      logForDebugging(
        `[bridge:repl] Environment re-registration failed: ${errorMessage(err)}`,
      )
      return false
    }
    // Clear before any await — a stale value would poison the next fresh
    // registration if doReconnect runs again.
    bridgeConfig.reuseEnvironmentId = undefined

    logForDebugging(
      `[bridge:repl] Re-registered: requested=${requestedEnvId} got=${environmentId}`,
    )

    // Bail out if teardown started while we were registering
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after env registration, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // Same race as above, narrower window: poll loop may have set up a
    // transport during the registerBridgeEnvironment await. Bail before
    // tryReconnectInPlace/archiveSession kill it server-side.
    if (transport !== null) {
      logForDebugging(
        '[bridge:repl] Poll loop recovered during registerBridgeEnvironment await — deferring to it',
      )
      environmentRecreations = 0
      return true
    }

    // Strategy 1: same helper as perpetual init. currentSessionId stays
    // the same on success; URL on mobile/web stays valid;
    // previouslyFlushedUUIDs preserved (no re-flush).
    if (await tryReconnectInPlace(requestedEnvId, currentSessionId)) {
      logEvent('tengu_bridge_repl_reconnected_in_place', {})
      environmentRecreations = 0
      return true
    }
    // Env differs → TTL-expired/reaped; or reconnect failed.
    // Don't deregister — we have a fresh secret for this env either way.
    if (environmentId !== requestedEnvId) {
      logEvent('tengu_bridge_repl_env_expired_fresh_session', {})
    }

    // Strategy 2: fresh session on the now-registered environment.
    // Archive the old session first — it's orphaned (bound to a dead env,
    // or reconnectSession rejected it). Don't deregister the env — we just
    // got a fresh secret for it and are about to use it.
    await archiveSession(currentSessionId)

    // Bail out if teardown started while we were archiving
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after archive, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // Re-read the current title in case the user renamed the session.
    // REPL wrapper reads session storage; daemon wrapper returns the
    // original title (nothing to refresh).
    const currentTitle = getCurrentTitle()

    // Create a new session on the now-registered environment
    const newSessionId = await createSession({
      environmentId,
      title: currentTitle,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!newSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed during reconnection',
      )
      return false
    }

    // Bail out if teardown started during session creation (up to 15s)
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after session creation, cleaning up',
      )
      await archiveSession(newSessionId)
      return false
    }

    currentSessionId = newSessionId
    // Re-publish to the PID file so peer dedup (peerRegistry.ts) picks up the
    // new ID — setReplBridgeHandle only fires at init/teardown, not reconnect.
    void updateSessionBridgeId(toCompatSessionId(newSessionId)).catch(() => {})
    // Reset per-session transport state IMMEDIATELY after the session swap,
    // before any await. If this runs after `await writeBridgePointer` below,
    // there's a window where handle.bridgeSessionId already returns session B
    // but getSSESequenceNum() still returns session A's seq — a daemon
    // persistState() in that window writes {bridgeSessionId: B, seq: OLD_A},
    // which PASSES the session-ID validation check and defeats it entirely.
    //
    // The SSE seq-num is scoped to the session's event stream — carrying it
    // over leaves the transport's lastSequenceNum stuck high (seq only
    // advances when received > last), and its next internal reconnect would
    // send from_sequence_num=OLD_SEQ against a stream starting at 1 → all
    // events in the gap silently dropped. Inbound UUID dedup is also
    // session-scoped.
    lastTransportSequenceNum = 0
    recentInboundUUIDs.clear()
    // Title derivation is session-scoped too: if the user typed during the
    // createSession await above, the callback fired against the OLD archived
    // session ID (PATCH lost) and the new session got `currentTitle` captured
    // BEFORE they typed. Reset so the next prompt can re-derive. Self-
    // correcting: if the caller's policy is already done (explicit title or
    // count ≥ 3), it returns true on the first post-reset call and re-latches.
    userMessageCallbackDone = !onUserMessage
    logForDebugging(`[bridge:repl] Re-created session: ${currentSessionId}`)

    // Rewrite the crash-recovery pointer with the new IDs so a crash after
    // this point resumes the right session. (The reconnect-in-place path
    // above doesn't touch the pointer — same session, same env.)
    await writeBridgePointer(dir, {
      sessionId: currentSessionId,
      environmentId,
      source: 'repl',
    })

    // Clear flushed UUIDs so initial messages are re-sent to the new session.
    // UUIDs are scoped per-session on the server, so re-flushing is safe.
    previouslyFlushedUUIDs?.clear()


    // Reset the counter so independent reconnections hours apart don't
    // exhaust the limit — it guards against rapid consecutive failures,
    // not lifetime total.
    environmentRecreations = 0

    return true
  }

  // Helper: get the current OAuth access token for session ingress auth.
  // Unlike the JWT path, OAuth tokens are refreshed by the standard OAuth
  // flow — no proactive scheduler needed.
  function getOAuthToken(): string | undefined {
    return getAccessToken()
  }

  // Drain any messages that were queued during the initial flush.
  // Called after writeBatch completes (or fails) so queued messages
  // are sent in order after the historical messages.
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) return
    if (!transport) {
      logForDebugging(
        `[bridge:repl] Cannot drain ${msgs.length} pending message(s): no transport`,
      )
      return
    }
    for (const msg of msgs) {
      recentPostedUUIDs.add(msg.uuid)
    }
    const sdkMessages = toSDKMessages(msgs)
    const events = sdkMessages.map(sdkMsg => ({
      ...sdkMsg,
      session_id: currentSessionId,
    }))
    logForDebugging(
      `[bridge:repl] Drained ${msgs.length} pending message(s) after flush`,
    )
    void transport.writeBatch(events)
  }

  // Teardown reference — set after definition below. All callers are async
  // callbacks that run after assignment, so the reference is always valid.
  let doTeardownImpl: (() => Promise<void>) | null = null
  function triggerTeardown(): void {
    void doTeardownImpl?.()
  }

  /**
   * Body of the transport's setOnClose callback, hoisted to initBridgeCore
   * scope so /bridge-kick can fire it directly. setOnClose wraps this with
   * a stale-transport guard; debugFireClose calls it bare.
   *
   * With autoReconnect:true, this only fires on: clean close (1000),
   * permanent server rejection (4001/1002/4003), or 10-min budget
   * exhaustion. Transient drops are retried internally by the transport.
   */
  function handleTransportPermanentClose(closeCode: number | undefined): void {
    logForDebugging(
      `[bridge:repl] Transport permanently closed: code=${closeCode}`,
    )
    logEvent('tengu_bridge_repl_ws_closed', {
      code: closeCode,
    })
    // Capture SSE seq high-water mark before nulling. When called from
    // setOnClose the guard guarantees transport !== null; when fired from
    // /bridge-kick it may already be null (e.g. fired twice) — skip.
    if (transport) {
      const closedSeq = transport.getLastSequenceNum()
      if (closedSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = closedSeq
      }
      transport = null
    }
    // Transport is gone — wake the poll loop out of its at-capacity
    // heartbeat sleep so it's fast-polling by the time the reconnect
    // below completes and the server re-queues work.
    wakePollLoop()
    // Reset flush state so writeMessages() hits the !transport guard
    // (with a warning log) instead of silently queuing into a buffer
    // that will never be drained. Unlike onWorkReceived (which
    // preserves pending messages for the new transport), onClose is
    // a permanent close — no new transport will drain these.
    const dropped = flushGate.drop()
    if (dropped > 0) {
      logForDebugging(
        `[bridge:repl] Dropping ${dropped} pending message(s) on transport close (code=${closeCode})`,
        { level: 'warn' },
      )
    }

    if (closeCode === 1000) {
      // Clean close — session ended normally. Tear down the bridge.
      onStateChange?.('failed', 'session ended')
      pollController.abort()
      triggerTeardown()
      return
    }

    // Transport reconnect budget exhausted or permanent server
    // rejection. By this point the env has usually been reaped
    // server-side (BQ 2026-03-12: ~98% of ws_closed never recover
    // via poll alone). stopWork(force=false) can't re-dispatch work
    // from an archived env; reconnectEnvironmentWithSession can
    // re-activate it via POST /bridge/reconnect, or fall through
    // to a fresh session if the env is truly gone. The poll loop
    // (already woken above) picks up the re-queued work once
    // doReconnect completes.
    onStateChange?.(
      'reconnecting',
      `Remote Control connection lost (code ${closeCode})`,
    )
    logForDebugging(
      `[bridge:repl] Transport reconnect budget exhausted (code=${closeCode}), attempting env reconnect`,
    )
    void reconnectEnvironmentWithSession().then(success => {
      if (success) return
      // doReconnect has four abort-check return-false sites for
      // teardown-in-progress. Don't pollute the BQ failure signal
      // or double-teardown when the user just quit.
      if (pollController.signal.aborted) return
      // doReconnect returns false (never throws) on genuine failure.
      // The dangerous case: registerBridgeEnvironment succeeded (so
      // environmentId now points at a fresh valid env) but
      // createSession failed — poll loop would poll a sessionless
      // env getting null work with no errors, never hitting any
      // give-up path. Tear down explicitly.
      logForDebugging(
        '[bridge:repl] reconnectEnvironmentWithSession resolved false — tearing down',
      )
      logEvent('tengu_bridge_repl_reconnect_failed', {
        close_code: closeCode,
      })
      onStateChange?.('failed', 'reconnection failed')
      triggerTeardown()
    })
  }

  // Ant-only: SIGUSR2 → force doReconnect() for manual testing. Skips the
  // ~30s poll wait — fire-and-observe in the debug log immediately.
  // Windows has no USR signals; `process.on` would throw there.
  let sigusr2Handler: (() => void) | undefined
  if (process.env.USER_TYPE === 'zy-super' && process.platform !== 'win32') {
    sigusr2Handler = () => {
      logForDebugging(
        '[bridge:repl] SIGUSR2 received — forcing doReconnect() for testing',
      )
      void reconnectEnvironmentWithSession()
    }
    process.on('SIGUSR2', sigusr2Handler)
  }

  // Ant-only: /bridge-kick fault injection. handleTransportPermanentClose
  // is defined below and assigned into this slot so the slash command can
  // invoke it directly — the real setOnClose callback is buried inside
  // wireTransport which is itself inside onWorkReceived.
  let debugFireClose: ((code: number) => void) | null = null
  if (process.env.USER_TYPE === 'zy-super') {
    registerBridgeDebugHandle({
      fireClose: code => {
        if (!debugFireClose) {
          logForDebugging('[bridge:debug] fireClose: no transport wired yet')
          return
        }
        logForDebugging(`[bridge:debug] fireClose(${code}) — injecting`)
        debugFireClose(code)
      },
      forceReconnect: () => {
        logForDebugging('[bridge:debug] forceReconnect — injecting')
        void reconnectEnvironmentWithSession()
      },
      injectFault: injectBridgeFault,
      wakePollLoop,
      describe: () =>
        `env=${environmentId} session=${currentSessionId} transport=${transport?.getStateLabel() ?? 'null'} workId=${currentWorkId ?? 'null'}`,
    })
  }

  const pollOpts = {
    api,
    getCredentials: () => ({ environmentId, environmentSecret }),
    signal: pollController.signal,
    getPollIntervalConfig,
    onStateChange,
    getWsState: () => transport?.getStateLabel() ?? 'null',
    // REPL bridge is single-session: having any transport == at capacity.
    // No need to check isConnectedStatus() — even while the transport is
    // auto-reconnecting internally (up to 10 min), poll is heartbeat-only.
    isAtCapacity: () => transport !== null,
    capacitySignal,
    onFatalError: triggerTeardown,
    getHeartbeatInfo: () => {
      if (!currentWorkId || !currentIngressToken) {
        return null
      }
      return {
        environmentId,
        workId: currentWorkId,
        sessionToken: currentIngressToken,
      }
    },
    // Work-item JWT expired (or work gone). The transport is useless —
    // SSE reconnects and CCR writes use the same stale token. Without
    // this callback the poll loop would do a 10-min at-capacity backoff,
    // during which the work lease (300s TTL) expires and the server stops
    // forwarding prompts → ~25-min dead window observed in daemon logs.
    // Kill the transport + work state so isAtCapacity()=false; the loop
    // fast-polls and picks up the server's re-dispatched work in seconds.
    onHeartbeatFatal: (err: BridgeFatalError) => {
      logForDebugging(
        `[bridge:repl] heartbeatWork fatal (status=${err.status}) — tearing down work item for fast re-dispatch`,
      )
      if (transport) {
        const seq = transport.getLastSequenceNum()
        if (seq > lastTransportSequenceNum) {
          lastTransportSequenceNum = seq
        }
        transport.close()
        transport = null
      }
      flushGate.drop()
      // force=false → server re-queues. Likely already expired, but
      // idempotent and makes re-dispatch immediate if not.
      if (currentWorkId) {
        void api
          .stopWork(environmentId, currentWorkId, false)
          .catch((e: unknown) => {
            logForDebugging(
              `[bridge:repl] stopWork after heartbeat fatal: ${errorMessage(e)}`,
            )
          })
      }
      currentWorkId = null
      currentIngressToken = null
      wakePollLoop()
      onStateChange?.(
        'reconnecting',
        'Work item lease expired, fetching fresh token',
      )
    },
    async onEnvironmentLost() {
      const success = await reconnectEnvironmentWithSession()
      if (!success) {
        return null
      }
      return { environmentId, environmentSecret }
    },
    onWorkReceived: (
      workSessionId: string,
      ingressToken: string,
      workId: string,
      serverUseCcrV2: boolean,
    ) => {
      // When new work arrives while a transport is already open, the
      // server has decided to re-dispatch (e.g. token rotation, server
      // restart). Close the existing transport and reconnect — discarding
      // the work causes a stuck 'reconnecting' state if the old WS dies
      // shortly after (the server won't re-dispatch a work item it
      // already delivered).
      // ingressToken (JWT) is stored for heartbeat auth (both v1 and v2).
      // Transport auth diverges — see the v1/v2 split below.
      if (transport?.isConnectedStatus()) {
        logForDebugging(
          `[bridge:repl] Work received while transport connected, replacing with fresh token (workId=${workId})`,
        )
      }

      logForDebugging(
        `[bridge:repl] Work received: workId=${workId} workSessionId=${workSessionId} currentSessionId=${currentSessionId} match=${sameSessionId(workSessionId, currentSessionId)}`,
      )

      // Refresh the crash-recovery pointer's mtime. Staleness checks file
      // mtime (not embedded timestamp) so this re-write bumps the clock —
      // a 5h+ session that crashes still has a fresh pointer. Fires once
      // per work dispatch (infrequent — bounded by user message rate).
      void writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })

      // Reject foreign session IDs — the server shouldn't assign sessions
      // from other environments. Since we create env+session as a pair,
      // a mismatch indicates an unexpected server-side reassignment.
      //
      // Compare by underlying UUID, not by tagged-ID prefix. When CCR
      // v2's compat layer serves the session, createBridgeSession gets
      // session_* from the v1-facing API (compat/convert.go:41) but the
      // infrastructure layer delivers cse_* in the work queue
      // (container_manager.go:129). Same UUID, different tag.
      if (!sameSessionId(workSessionId, currentSessionId)) {
        logForDebugging(
          `[bridge:repl] Rejecting foreign session: expected=${currentSessionId} got=${workSessionId}`,
        )
        return
      }

      currentWorkId = workId
      currentIngressToken = ingressToken

      // Server decides per-session (secret.use_code_sessions from the work
      // secret, threaded through runWorkPollLoop). The env var is an ant-dev
      // override for forcing v2 before the server flag is on for your user —
      // requires ccr_v2_compat_enabled server-side or registerWorker 404s.
      //
      // Kept separate from ZY_CODE_ (the child-SDK transport
      // selector set by sessionRunner/environment-manager) to avoid the
      // inheritance hazard in spawn mode where the parent's orchestrator
      // var would leak into a v1 child.
      const useCcrV2 =
        serverUseCcrV2 || isEnvTruthy(process.env.CLAUDE_BRIDGE_USE_CCR_V2)

      // Auth is the one place v1 and v2 diverge hard:
      //
      // - v1 (Session-Ingress): accepts OAuth OR JWT. We prefer OAuth
      //   because the standard OAuth refresh flow handles expiry — no
      //   separate JWT refresh scheduler needed.
      //
      // - v2 (CCR /worker/*): REQUIRES the JWT. register_worker.go:32
      //   validates the session_id claim, which OAuth tokens don't carry.
      //   The JWT from the work secret has both that claim and the worker
      //   role (environment_auth.py:856). JWT refresh: when it expires the
      //   server re-dispatches work with a fresh one, and onWorkReceived
      //   fires again. createV2ReplTransport stores it via
      //   updateSessionIngressAuthToken() before touching the network.
      let v1OauthToken: string | undefined
      if (!useCcrV2) {
        v1OauthToken = getOAuthToken()
        if (!v1OauthToken) {
          logForDebugging(
            '[bridge:repl] No OAuth token available for session ingress, skipping work',
          )
          return
        }
        updateSessionIngressAuthToken(v1OauthToken)
      }
      logEvent('tengu_bridge_repl_work_received', {})

      // Close the previous transport. Nullify BEFORE calling close() so
      // the close callback doesn't treat the programmatic close as
      // "session ended normally" and trigger a full teardown.
      if (transport) {
        const oldTransport = transport
        transport = null
        // Capture the SSE sequence high-water mark so the next transport
        // resumes the stream instead of replaying from seq 0. Use max() —
        // a transport that died early (never received any frames) would
        // otherwise reset a non-zero mark back to 0.
        const oldSeq = oldTransport.getLastSequenceNum()
        if (oldSeq > lastTransportSequenceNum) {
          lastTransportSequenceNum = oldSeq
        }
        oldTransport.close()
      }
      // Reset flush state — the old flush (if any) is no longer relevant.
      // Preserve pending messages so they're drained after the new
      // transport's flush completes (the hook has already advanced its
      // lastWrittenIndex and won't re-send them).
      flushGate.deactivate()

      // Closure adapter over the shared handleServerControlRequest —
      // captures transport/currentSessionId so the transport.setOnData
      // callback below doesn't need to thread them through.
      const onServerControlRequest = (request: SDKControlRequest): void =>
        handleServerControlRequest(request, {
          transport,
          sessionId: currentSessionId,
          onInterrupt,
          onSetModel,
          onSetMaxThinkingTokens,
          onSetPermissionMode,
        })

      let initialFlushDone = false

      // Wire callbacks onto a freshly constructed transport and connect.
      // Extracted so the (sync) v1 and (async) v2 construction paths can
      // share the identical callback + flush machinery.
      const wireTransport = (newTransport: ReplBridgeTransport): void => {
        transport = newTransport

        newTransport.setOnConnect(() => {
          // Guard: if transport was replaced by a newer onWorkReceived call
          // while the WS was connecting, ignore this stale callback.
          if (transport !== newTransport) return

          logForDebugging('[bridge:repl] Ingress transport connected')
          logEvent('tengu_bridge_repl_ws_connected', {})

          // Update the env var with the latest OAuth token so POST writes
          // (which read via getSessionIngressAuthToken()) use a fresh token.
          // v2 skips this — createV2ReplTransport already stored the JWT,
          // and overwriting it with OAuth would break subsequent /worker/*
          // requests (session_id claim check).
          if (!useCcrV2) {
            const freshToken = getOAuthToken()
            if (freshToken) {
              updateSessionIngressAuthToken(freshToken)
            }
          }

          // Reset teardownStarted so future teardowns are not blocked.
          teardownStarted = false

          // Flush initial messages only on first connect, not on every
          // WS reconnection. Re-flushing would cause duplicate messages.
          // IMPORTANT: onStateChange('connected') is deferred until the
          // flush completes. This prevents writeMessages() from sending
          // new messages that could arrive at the server interleaved with
          // the historical messages, and delays the web UI from showing
          // the session as active until history is persisted.
          if (
            !initialFlushDone &&
            initialMessages &&
            initialMessages.length > 0
          ) {
            initialFlushDone = true

            // Cap the initial flush to the most recent N messages. The full
            // history is UI-only (model doesn't see it) and large replays cause
            // slow session-ingress persistence (each event is a threadstore write)
            // plus elevated Firestore pressure. A 0 or negative cap disables it.
            const historyCap = initialHistoryCap
            const eligibleMessages = initialMessages.filter(
              m =>
                isEligibleBridgeMessage(m) &&
                !previouslyFlushedUUIDs?.has(m.uuid),
            )
            const cappedMessages =
              historyCap > 0 && eligibleMessages.length > historyCap
                ? eligibleMessages.slice(-historyCap)
                : eligibleMessages
            if (cappedMessages.length < eligibleMessages.length) {
              logForDebugging(
                `[bridge:repl] Capped initial flush: ${eligibleMessages.length} -> ${cappedMessages.length} (cap=${historyCap})`,
              )
              logEvent('tengu_bridge_repl_history_capped', {
                eligible_count: eligibleMessages.length,
                capped_count: cappedMessages.length,
              })
            }
            const sdkMessages = toSDKMessages(cappedMessages)
            if (sdkMessages.length > 0) {
              logForDebugging(
                `[bridge:repl] Flushing ${sdkMessages.length} initial message(s) via transport`,
              )
              const events = sdkMessages.map(sdkMsg => ({
                ...sdkMsg,
                session_id: currentSessionId,
              }))
              const dropsBefore = newTransport.droppedBatchCount
              void newTransport
                .writeBatch(events)
                .then(() => {
                  // If any batch was dropped during this flush (SI down for
                  // maxConsecutiveFailures attempts), flush() still resolved
                  // normally but the events were NOT delivered. Don't mark
                  // UUIDs as flushed — keep them eligible for re-send on the
                  // next onWorkReceived (JWT refresh re-dispatch, line ~1144).
                  if (newTransport.droppedBatchCount > dropsBefore) {
                    logForDebugging(
                      `[bridge:repl] Initial flush dropped ${newTransport.droppedBatchCount - dropsBefore} batch(es) — not marking ${sdkMessages.length} UUID(s) as flushed`,
                    )
                    return
                  }
                  if (previouslyFlushedUUIDs) {
                    for (const sdkMsg of sdkMessages) {
                      if (sdkMsg.uuid) {
                        previouslyFlushedUUIDs.add(sdkMsg.uuid)
                      }
                    }
                  }
                })
                .catch(e =>
                  logForDebugging(`[bridge:repl] Initial flush failed: ${e}`),
                )
                .finally(() => {
                  // Guard: if transport was replaced during the flush,
                  // don't signal connected or drain — the new transport
                  // owns the lifecycle now.
                  if (transport !== newTransport) return
                  drainFlushGate()
                  onStateChange?.('connected')
                })
            } else {
              // All initial messages were already flushed (filtered by
              // previouslyFlushedUUIDs). No flush POST needed — clear
              // the flag and signal connected immediately. This is the
              // first connect for this transport (inside !initialFlushDone),
              // so no flush POST is in-flight — the flag was set before
              // connect() and must be cleared here.
              drainFlushGate()
              onStateChange?.('connected')
            }
          } else if (!flushGate.active) {
            // No initial messages or already flushed on first connect.
            // WS auto-reconnect path — only signal connected if no flush
            // POST is in-flight. If one is, .finally() owns the lifecycle.
            onStateChange?.('connected')
          }
        })

        newTransport.setOnData(data => {
          handleIngressMessage(
            data,
            recentPostedUUIDs,
            recentInboundUUIDs,
            onInboundMessage,
            onPermissionResponse,
            onServerControlRequest,
          )
        })

        // Body lives at initBridgeCore scope so /bridge-kick can call it
        // directly via debugFireClose. All referenced closures (transport,
        // wakePollLoop, flushGate, reconnectEnvironmentWithSession, etc.)
        // are already at that scope. The only lexical dependency on
        // wireTransport was `newTransport.getLastSequenceNum()` — but after
        // the guard below passes we know transport === newTransport.
        debugFireClose = handleTransportPermanentClose
        newTransport.setOnClose(closeCode => {
          // Guard: if transport was replaced, ignore stale close.
          if (transport !== newTransport) return
          handleTransportPermanentClose(closeCode)
        })

        // Start the flush gate before connect() to cover the WS handshake
        // window. Between transport assignment and setOnConnect firing,
        // writeMessages() could send messages via HTTP POST before the
        // initial flush starts. Starting the gate here ensures those
        // calls are queued. If there are no initial messages, the gate
        // stays inactive.
        if (
          !initialFlushDone &&
          initialMessages &&
          initialMessages.length > 0
        ) {
          flushGate.start()
        }

        newTransport.connect()
      } // end wireTransport

      // Bump unconditionally — ANY new transport (v1 or v2) invalidates an
      // in-flight v2 handshake. Also bumped in doReconnect().
      v2Generation++

      if (useCcrV2) {
        // workSessionId is the cse_* form (infrastructure-layer ID from the
        // work queue), which is what /v1/code/sessions/{id}/worker/* wants.
        // The session_* form (currentSessionId) is NOT usable here —
        // handler/convert.go:30 validates TagCodeSession.
        const sessionUrl = buildCCRv2SdkUrl(baseUrl, workSessionId)
        const thisGen = v2Generation
        logForDebugging(
          `[bridge:repl] CCR v2: sessionUrl=${sessionUrl} session=${workSessionId} gen=${thisGen}`,
        )
        void createV2ReplTransport({
          sessionUrl,
          ingressToken,
          sessionId: workSessionId,
          initialSequenceNum: lastTransportSequenceNum,
        }).then(
          t => {
            // Teardown started while registerWorker was in flight. Teardown
            // saw transport === null and skipped close(); installing now
            // would leak CCRClient heartbeat timers and reset
            // teardownStarted via wireTransport's side effects.
            if (pollController.signal.aborted) {
              t.close()
              return
            }
            // onWorkReceived may have fired again while registerWorker()
            // was in flight (server re-dispatch with a fresh JWT). The
            // transport !== null check alone gets the race wrong when BOTH
            // attempts saw transport === null — it keeps the first resolver
            // (stale epoch) and discards the second (correct epoch). The
            // generation check catches it regardless of transport state.
            if (thisGen !== v2Generation) {
              logForDebugging(
                `[bridge:repl] CCR v2: discarding stale handshake gen=${thisGen} current=${v2Generation}`,
              )
              t.close()
              return
            }
            wireTransport(t)
          },
          (err: unknown) => {
            logForDebugging(
              `[bridge:repl] CCR v2: createV2ReplTransport failed: ${errorMessage(err)}`,
              { level: 'error' },
            )
            logEvent('tengu_bridge_repl_ccr_v2_init_failed', {})
            // If a newer attempt is in flight or already succeeded, don't
            // touch its work item — our failure is irrelevant.
            if (thisGen !== v2Generation) return
            // Release the work item so the server re-dispatches immediately
            // instead of waiting for its own timeout. currentWorkId was set
            // above; without this, the session looks stuck to the user.
            if (currentWorkId) {
              void api
                .stopWork(environmentId, currentWorkId, false)
                .catch((e: unknown) => {
                  logForDebugging(
                    `[bridge:repl] stopWork after v2 init failure: ${errorMessage(e)}`,
                  )
                })
              currentWorkId = null
              currentIngressToken = null
            }
            wakePollLoop()
          },
        )
      } else {
        // v1: HybridTransport (WS reads + POST writes to Session-Ingress).
        // autoReconnect is true (default) — when the WS dies, the transport
        // reconnects automatically with exponential backoff. POST writes
        // continue during reconnection (they use getSessionIngressAuthToken()
        // independently of WS state). The poll loop remains as a secondary
        // fallback if the reconnect budget is exhausted (10 min).
        //
        // Auth: uses OAuth tokens directly instead of the JWT from the work
        // secret. refreshHeaders picks up the latest OAuth token on each
        // WS reconnect attempt.
        const wsUrl = buildSdkUrl(sessionIngressUrl, workSessionId)
        logForDebugging(`[bridge:repl] Ingress URL: ${wsUrl}`)
        logForDebugging(
          `[bridge:repl] Creating HybridTransport: session=${workSessionId}`,
        )
        // v1OauthToken was validated non-null above (we'd have returned early).
        const oauthToken = v1OauthToken ?? ''
        wireTransport(
          createV1ReplTransport(
            new HybridTransport(
              new URL(wsUrl),
              {
                Authorization: `Bearer ${oauthToken}`,
                'anthropic-version': '2023-06-01',
              },
              workSessionId,
              () => ({
                Authorization: `Bearer ${getOAuthToken() ?? oauthToken}`,
                'anthropic-version': '2023-06-01',
              }),
              // Cap retries so a persistently-failing session-ingress can't
              // pin the uploader drain loop for the lifetime of the bridge.
              // 50 attempts ≈ 20 min (15s POST timeout + 8s backoff + jitter
              // per cycle at steady state). Bridge-only — direct API keeps indefinite.
              {
                maxConsecutiveFailures: 50,
                isBridge: true,
                onBatchDropped: () => {
                  onStateChange?.(
                    'reconnecting',
                    'Lost sync with Remote Control — events could not be delivered',
                  )
                  // SI has been down ~20 min. Wake the poll loop so that when
                  // SI recovers, next poll → onWorkReceived → fresh transport
                  // → initial flush succeeds → onStateChange('connected') at
                  // ~line 1420. Without this, state stays 'reconnecting' even
                  // after SI recovers — daemon.ts:437 denies all permissions,
                  // useReplBridge.ts:311 keeps replBridgeSessionActive=false.
                  // If the env was archived during the outage, poll 404 →
                  // onEnvironmentLost recovery path handles it.
                  wakePollLoop()
                },
              },
            ),
          ),
        )
      }
    },
  }
  void startWorkPollLoop(pollOpts)

  // Perpetual mode: hourly mtime refresh of the crash-recovery pointer.
  // The onWorkReceived refresh only fires per user prompt — a
  // daemon idle for >4h would have a stale pointer, and the next restart
  // would clear it (readBridgePointer TTL check) → fresh session. The
  // standalone bridge (bridgeMain.ts) has an identical hourly timer.
  const pointerRefreshTimer = perpetual
    ? setInterval(() => {
        // doReconnect() reassigns currentSessionId/environmentId non-
        // atomically (env at ~:634, session at ~:719, awaits in between).
        // If this timer fires in that window, its fire-and-forget write can
        // race with (and overwrite) doReconnect's own pointer write at ~:740,
        // leaving the pointer at the now-archived old session. doReconnect
        // writes the pointer itself, so skipping here is free.
        if (reconnectPromise) return
        void writeBridgePointer(dir, {
          sessionId: currentSessionId,
          environmentId,
          source: 'repl',
        })
      }, 60 * 60_000)
    : null
  pointerRefreshTimer?.unref?.()

  // Push a silent keep_alive frame on a fixed interval so upstream proxies
  // and the session-ingress layer don't GC an otherwise-idle remote control
  // session. The keep_alive type is filtered before reaching any client UI
  // (Query.ts drops it; web/iOS/Android never see it in their message loop).
  // Interval comes from GrowthBook (tengu_bridge_poll_interval_config
  // session_keepalive_interval_v2_ms, default 120s); 0 = disabled.
  const keepAliveIntervalMs =
    getPollIntervalConfig().session_keepalive_interval_v2_ms
  const keepAliveTimer =
    keepAliveIntervalMs > 0
      ? setInterval(() => {
          if (!transport) return
          logForDebugging('[bridge:repl] keep_alive sent')
          void transport.write({ type: 'keep_alive' }).catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] keep_alive write failed: ${errorMessage(err)}`,
            )
          })
        }, keepAliveIntervalMs)
      : null
  keepAliveTimer?.unref?.()

  // Shared teardown sequence used by both cleanup registration and
  // the explicit teardown() method on the returned handle.
  let teardownStarted = false
  doTeardownImpl = async (): Promise<void> => {
    if (teardownStarted) {
      logForDebugging(
        `[bridge:repl] Teardown already in progress, skipping duplicate call env=${environmentId} session=${currentSessionId}`,
      )
      return
    }
    teardownStarted = true
    const teardownStart = Date.now()
    logForDebugging(
      `[bridge:repl] Teardown starting: env=${environmentId} session=${currentSessionId} workId=${currentWorkId ?? 'none'} transportState=${transport?.getStateLabel() ?? 'null'}`,
    )

    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer)
    }
    if (sigusr2Handler) {
      process.off('SIGUSR2', sigusr2Handler)
    }
    if (process.env.USER_TYPE === 'zy-super') {
      clearBridgeDebugHandle()
      debugFireClose = null
    }
    pollController.abort()
    logForDebugging('[bridge:repl] Teardown: poll loop aborted')

    // Capture the live transport's seq BEFORE close() — close() is sync
    // (just aborts the SSE fetch) and does NOT invoke onClose, so the
    // setOnClose capture path never runs for explicit teardown.
    // Without this, getSSESequenceNum() after teardown returns the stale
    // lastTransportSequenceNum (captured at the last transport swap), and
    // daemon callers persisting that value lose all events since then.
    if (transport) {
      const finalSeq = transport.getLastSequenceNum()
      if (finalSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = finalSeq
      }
    }

    if (perpetual) {
      // Perpetual teardown is LOCAL-ONLY — do not send result, do not call
      // stopWork, do not close the transport. All of those signal the
      // server (and any mobile/attach subscribers) that the session is
      // ending. Instead: stop polling, let the socket die with the
      // process; the backend times the work-item lease back to pending on
      // its own (TTL 300s). Next daemon start reads the pointer and
      // reconnectSession re-queues work.
      transport = null
      flushGate.drop()
      // Refresh the pointer mtime so that sessions lasting longer than
      // BRIDGE_POINTER_TTL_MS (4h) don't appear stale on next start.
      await writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })
      logForDebugging(
        `[bridge:repl] Teardown (perpetual): leaving env=${environmentId} session=${currentSessionId} alive on server, duration=${Date.now() - teardownStart}ms`,
      )
      return
    }

    // Fire the result message, then archive, THEN close. transport.write()
    // only enqueues (SerialBatchEventUploader resolves on buffer-add); the
    // stopWork/archive latency (~200-500ms) is the drain window for the
    // result POST. Closing BEFORE archive meant relying on HybridTransport's
    // void-ed 3s grace period, which nothing awaits — forceExit can kill the
    // socket mid-POST. Same reorder as remoteBridgeCore.ts teardown (#22803).
    const teardownTransport = transport
    transport = null
    flushGate.drop()
    if (teardownTransport) {
      void teardownTransport.write(makeResultMessage(currentSessionId))
    }

    const stopWorkP = currentWorkId
      ? api
          .stopWork(environmentId, currentWorkId, true)
          .then(() => {
            logForDebugging('[bridge:repl] Teardown: stopWork completed')
          })
          .catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] Teardown stopWork failed: ${errorMessage(err)}`,
            )
          })
      : Promise.resolve()

    // Run stopWork and archiveSession in parallel. gracefulShutdown.ts:407
    // races runCleanupFunctions() against 2s (NOT the 5s outer failsafe),
    // so archive is capped at 1.5s at the injection site to stay under budget.
    // archiveSession is contractually no-throw; the injected implementations
    // log their own success/failure internally.
    await Promise.all([stopWorkP, archiveSession(currentSessionId)])

    teardownTransport?.close()
    logForDebugging('[bridge:repl] Teardown: transport closed')

    await api.deregisterEnvironment(environmentId).catch((err: unknown) => {
      logForDebugging(
        `[bridge:repl] Teardown deregister failed: ${errorMessage(err)}`,
      )
    })

    // Clear the crash-recovery pointer — explicit disconnect or clean REPL
    // exit means the user is done with this session. Crash/kill-9 never
    // reaches this line, leaving the pointer for next-launch recovery.
    await clearBridgePointer(dir)

    logForDebugging(
      `[bridge:repl] Teardown complete: env=${environmentId} duration=${Date.now() - teardownStart}ms`,
    )
  }

  // 8. Register cleanup for graceful shutdown
  const unregister = registerCleanup(() => doTeardownImpl?.())

  logForDebugging(
    `[bridge:repl] Ready: env=${environmentId} session=${currentSessionId}`,
  )
  onStateChange?.('ready')

  return {
    get bridgeSessionId() {
      return currentSessionId
    },
    get environmentId() {
      return environmentId
    },
    getSSESequenceNum() {
      // lastTransportSequenceNum only updates when a transport is CLOSED
      // (captured at swap/onClose). During normal operation the CURRENT
      // transport's live seq isn't reflected there. Merge both so callers
      // (e.g. daemon persistState()) get the actual high-water mark.
      const live = transport?.getLastSequenceNum() ?? 0
      return Math.max(lastTransportSequenceNum, live)
    },
    sessionIngressUrl,
    writeMessages(messages) {
      // Filter to user/assistant messages that haven't already been sent.
      // Two layers of dedup:
      //  - initialMessageUUIDs: messages sent as session creation events
      //  - recentPostedUUIDs: messages recently sent via POST
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return

      // Fire onUserMessage for title derivation. Scan before the flushGate
      // check — prompts are title-worthy even if they queue behind the
      // initial history flush. Keeps calling on every title-worthy message
      // until the callback returns true; the caller owns the policy.
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, currentSessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      // Queue messages while the initial flush is in progress to prevent
      // them from arriving at the server interleaved with history.
      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[bridge:repl] Queued ${filtered.length} message(s) during initial flush`,
        )
        return
      }

      if (!transport) {
        const types = filtered.map(m => m.type).join(',')
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} message(s) [${types}] for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }

      // Track in the bounded ring buffer for echo filtering and dedup.
      for (const msg of filtered) {
        recentPostedUUIDs.add(msg.uuid)
      }

      logForDebugging(
        `[bridge:repl] Sending ${filtered.length} message(s) via transport`,
      )

      // Convert to SDK format and send via HTTP POST (HybridTransport).
      // The web UI receives them via the subscribe WebSocket.
      const sdkMessages = toSDKMessages(filtered)
      const events = sdkMessages.map(sdkMsg => ({
        ...sdkMsg,
        session_id: currentSessionId,
      }))
      void transport.writeBatch(events)
    },
    writeSdkMessages(messages) {
      // Daemon path: query() already yields SDKMessage, skip conversion.
      // Still run echo dedup (server bounces writes back on the WS).
      // No initialMessageUUIDs filter — daemon has no initial messages.
      // No flushGate — daemon never starts it (no initial flush).
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return
      if (!transport) {
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} SDK message(s) for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid)
      }
      const events = filtered.map(m => ({ ...m, session_id: currentSessionId }))
      void transport.writeBatch(events)
    },
    sendControlRequest(request: SDKControlRequest) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_request',
        )
        return
      }
      const event = { ...request, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging(
        `[bridge:repl] Sent control_request request_id=${request.request_id}`,
      )
    },
    sendControlResponse(response: SDKControlResponse) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_response',
        )
        return
      }
      const event = { ...response, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging('[bridge:repl] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_cancel_request',
        )
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: currentSessionId,
      }
      void transport.write(event)
      logForDebugging(
        `[bridge:repl] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    sendResult() {
      if (!transport) {
        logForDebugging(
          `[bridge:repl] sendResult: skipping, transport not configured session=${currentSessionId}`,
        )
        return
      }
      void transport.write(makeResultMessage(currentSessionId))
      logForDebugging(
        `[bridge:repl] Sent result for session=${currentSessionId}`,
      )
    },
    async teardown() {
      unregister()
      await doTeardownImpl?.()
      logForDebugging('[bridge:repl] Torn down')
      logEvent('tengu_bridge_repl_teardown', {})
    },
  }
}

/**
 * Persistent poll loop for work items. Runs in the background for the
 * lifetime of the bridge connection.
 *
 * When a work item arrives, acknowledges it and calls onWorkReceived
 * with the session ID and ingress token (which connects the ingress
 * WebSocket). Then continues polling — the server will dispatch a new
 * work item if the ingress WebSocket drops, allowing automatic
 * reconnection without tearing down the bridge.
 */
async function startWorkPollLoop({
  api,
  getCredentials,
  signal,
  onStateChange,
  onWorkReceived,
  onEnvironmentLost,
  getWsState,
  isAtCapacity,
  capacitySignal,
  onFatalError,
  getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
  getHeartbeatInfo,
  onHeartbeatFatal,
}: {
  api: BridgeApiClient
  getCredentials: () => { environmentId: string; environmentSecret: string }
  signal: AbortSignal
  onStateChange?: (state: BridgeState, detail?: string) => void
  onWorkReceived: (
    sessionId: string,
    ingressToken: string,
    workId: string,
    useCodeSessions: boolean,
  ) => void
  /** Called when the environment has been deleted. Returns new credentials or null. */
  onEnvironmentLost?: () => Promise<{
    environmentId: string
    environmentSecret: string
  } | null>
  /** Returns the current WebSocket readyState label for diagnostic logging. */
  getWsState?: () => string
  /**
   * Returns true when the caller cannot accept new work (transport already
   * connected). When true, the loop polls at the configured at-capacity
   * interval as a heartbeat only. Server-side BRIDGE_LAST_POLL_TTL is
   * 4 hours — anything shorter than that is sufficient for liveness.
   */
  isAtCapacity?: () => boolean
  /**
   * Produces a signal that aborts when capacity frees up (transport lost),
   * merged with the loop signal. Used to interrupt the at-capacity sleep
   * so recovery polling starts immediately.
   */
  capacitySignal?: () => CapacitySignal
  /** Called on unrecoverable errors (e.g. server-side expiry) to trigger full teardown. */
  onFatalError?: () => void
  /** Poll interval config getter — defaults to DEFAULT_POLL_CONFIG. */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * Returns the current work ID and session ingress token for heartbeat.
   * When null, heartbeat is not possible (no active work item).
   */
  getHeartbeatInfo?: () => {
    environmentId: string
    workId: string
    sessionToken: string
  } | null
  /**
   * Called when heartbeatWork throws BridgeFatalError (401/403/404/410 —
   * JWT expired or work item gone). Caller should tear down the transport
   * + work state so isAtCapacity() flips to false and the loop fast-polls
   * for the server's re-dispatched work item. When provided, the loop
   * SKIPS the at-capacity backoff sleep (which would otherwise cause a
   * ~10-minute dead window before recovery). When omitted, falls back to
   * the backoff sleep to avoid a tight poll+heartbeat loop.
   */
  onHeartbeatFatal?: (err: BridgeFatalError) => void
}): Promise<void> {
  const MAX_ENVIRONMENT_RECREATIONS = 3

  logForDebugging(
    `[bridge:repl] Starting work poll loop for env=${getCredentials().environmentId}`,
  )

  let consecutiveErrors = 0
  let firstErrorTime: number | null = null
  let lastPollErrorTime: number | null = null
  let environmentRecreations = 0
  // Set when the at-capacity sleep overruns its deadline by a large margin
  // (process suspension). Consumed at the top of the next iteration to
  // force one fast-poll cycle — isAtCapacity() is `transport !== null`,
  // which stays true while the transport auto-reconnects, so the poll
  // loop would otherwise go straight back to a 10-minute sleep on a
  // transport that may be pointed at a dead socket.
  let suspensionDetected = false

  while (!signal.aborted) {
    // Capture credentials outside try so the catch block can detect
    // whether a concurrent reconnection replaced the environment.
    const { environmentId: envId, environmentSecret: envSecret } =
      getCredentials()
    const pollConfig = getPollIntervalConfig()
    try {
      const work = await api.pollForWork(
        envId,
        envSecret,
        signal,
        pollConfig.reclaim_older_than_ms,
      )

      // A successful poll proves the env is genuinely healthy — reset the
      // env-loss counter so events hours apart each start fresh. Outside
      // the state-change guard below because onEnvLost's success path
      // already emits 'ready'; emitting again here would be a duplicate.
      // (onEnvLost returning creds does NOT reset this — that would break
      // oscillation protection when the new env immediately dies.)
      environmentRecreations = 0

      // Reset error tracking on successful poll
      if (consecutiveErrors > 0) {
        logForDebugging(
          `[bridge:repl] Poll recovered after ${consecutiveErrors} consecutive error(s)`,
        )
        consecutiveErrors = 0
        firstErrorTime = null
        lastPollErrorTime = null
        onStateChange?.('ready')
      }

      if (!work) {
        // Read-and-clear: after a detected suspension, skip the at-capacity
        // branch exactly once. The pollForWork above already refreshed the
        // server's BRIDGE_LAST_POLL_TTL; this fast cycle gives any
        // re-dispatched work item a chance to land before we go back under.
        const skipAtCapacityOnce = suspensionDetected
        suspensionDetected = false
        if (isAtCapacity?.() && capacitySignal && !skipAtCapacityOnce) {
          const atCapMs = pollConfig.poll_interval_ms_at_capacity
          // Heartbeat loops WITHOUT polling. When at-capacity polling is also
          // enabled (atCapMs > 0), the loop tracks a deadline and breaks out
          // to poll at that interval — heartbeat and poll compose instead of
          // one suppressing the other. Breaks out when:
          //   - Poll deadline reached (atCapMs > 0 only)
          //   - Auth fails (JWT expired → poll refreshes tokens)
          //   - Capacity wake fires (transport lost → poll for new work)
          //   - Heartbeat config disabled (GrowthBook update)
          //   - Loop aborted (shutdown)
          if (
            pollConfig.non_exclusive_heartbeat_interval_ms > 0 &&
            getHeartbeatInfo
          ) {
            logEvent('tengu_bridge_heartbeat_mode_entered', {
              heartbeat_interval_ms:
                pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // Deadline computed once at entry — GB updates to atCapMs don't
            // shift an in-flight deadline (next entry picks up the new value).
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let needsBackoff = false
            let hbCycles = 0
            while (
              !signal.aborted &&
              isAtCapacity() &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) break

              const info = getHeartbeatInfo()
              if (!info) break

              // Capture capacity signal BEFORE the async heartbeat call so
              // a transport loss during the HTTP request is caught by the
              // subsequent sleep.
              const cap = capacitySignal()

              try {
                await api.heartbeatWork(
                  info.environmentId,
                  info.workId,
                  info.sessionToken,
                )
              } catch (err) {
                logForDebugging(
                  `[bridge:repl:heartbeat] Failed: ${errorMessage(err)}`,
                )
                if (err instanceof BridgeFatalError) {
                  cap.cleanup()
                  logEvent('tengu_bridge_heartbeat_error', {
                    status:
                      err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    error_type: (err.status === 401 || err.status === 403
                      ? 'auth_failed'
                      : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                  // JWT expired (401/403) or work item gone (404/410).
                  // Either way the current transport is dead — SSE
                  // reconnects and CCR writes will fail on the same
                  // stale token. If the caller gave us a recovery hook,
                  // tear down work state and skip backoff: isAtCapacity()
                  // flips to false, next outer-loop iteration fast-polls
                  // for the server's re-dispatched work item. Without
                  // the hook, backoff to avoid tight poll+heartbeat loop.
                  if (onHeartbeatFatal) {
                    onHeartbeatFatal(err)
                    logForDebugging(
                      `[bridge:repl:heartbeat] Fatal (status=${err.status}), work state cleared — fast-polling for re-dispatch`,
                    )
                  } else {
                    needsBackoff = true
                  }
                  break
                }
              }

              hbCycles++
              await sleep(
                hbConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }

            const exitReason = needsBackoff
              ? 'error'
              : signal.aborted
                ? 'shutdown'
                : !isAtCapacity()
                  ? 'capacity_changed'
                  : pollDeadline !== null && Date.now() >= pollDeadline
                    ? 'poll_due'
                    : 'config_disabled'
            logEvent('tengu_bridge_heartbeat_mode_exited', {
              reason:
                exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
            })

            // On auth_failed or fatal, backoff before polling to avoid a
            // tight poll+heartbeat loop. Fall through to the shared sleep
            // below — it's the same capacitySignal-wrapped sleep the legacy
            // path uses, and both need the suspension-overrun check.
            if (!needsBackoff) {
              if (exitReason === 'poll_due') {
                // bridgeApi throttles empty-poll logs (EMPTY_POLL_LOG_INTERVAL=100)
                // so the once-per-10min poll_due poll is invisible at counter=2.
                // Log it here so verification runs see both endpoints in the debug log.
                logForDebugging(
                  `[bridge:repl] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
                )
              }
              continue
            }
          }
          // At-capacity sleep — reached by both the legacy path (heartbeat
          // disabled) and the heartbeat-backoff path (needsBackoff=true).
          // Merged so the suspension detector covers both; previously the
          // backoff path had no overrun check and could go straight back
          // under for 10 min after a laptop wake. Use atCapMs when enabled,
          // else the heartbeat interval as a floor (guaranteed > 0 on the
          // backoff path) so heartbeat-only configs don't tight-loop.
          const sleepMs =
            atCapMs > 0
              ? atCapMs
              : pollConfig.non_exclusive_heartbeat_interval_ms
          if (sleepMs > 0) {
            const cap = capacitySignal()
            const sleepStart = Date.now()
            await sleep(sleepMs, cap.signal)
            cap.cleanup()
            // Process-suspension detector. A setTimeout overshooting its
            // deadline by 60s means the process was suspended (laptop lid,
            // SIGSTOP, VM pause) — even a pathological GC pause is seconds,
            // not minutes. Early aborts (wakePollLoop → cap.signal) produce
            // overrun < 0 and fall through. Note: this only catches sleeps
            // that outlast their deadline; WebSocketTransport's ping
            // interval (10s granularity) is the primary detector for shorter
            // suspensions. This is the backstop for when that detector isn't
            // running (transport mid-reconnect, interval stopped).
            const overrun = Date.now() - sleepStart - sleepMs
            if (overrun > 60_000) {
              logForDebugging(
                `[bridge:repl] At-capacity sleep overran by ${Math.round(overrun / 1000)}s — process suspension detected, forcing one fast-poll cycle`,
              )
              logEvent('tengu_bridge_repl_suspension_detected', {
                overrun_ms: overrun,
              })
              suspensionDetected = true
            }
          }
        } else {
          await sleep(pollConfig.poll_interval_ms_not_at_capacity, signal)
        }
        continue
      }

      // Decode before type dispatch — need the JWT for the explicit ack.
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Failed to decode work secret: ${errorMessage(err)}`,
        )
        logEvent('tengu_bridge_repl_work_secret_failed', {})
        // Can't ack (needs the JWT we failed to decode). stopWork uses OAuth.
        // Prevents XAUTOCLAIM re-delivering this poisoned item every cycle.
        await api.stopWork(envId, work.id, false).catch(() => {})
        continue
      }

      // Explicitly acknowledge to prevent redelivery. Non-fatal on failure:
      // server re-delivers, and the onWorkReceived callback handles dedup.
      logForDebugging(`[bridge:repl] Acknowledging workId=${work.id}`)
      try {
        await api.acknowledgeWork(envId, work.id, secret.session_ingress_token)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
        )
      }

      if (work.data.type === 'healthcheck') {
        logForDebugging('[bridge:repl] Healthcheck received')
        continue
      }

      if (work.data.type === 'session') {
        const workSessionId = work.data.id
        try {
          validateBridgeId(workSessionId, 'session_id')
        } catch {
          logForDebugging(
            `[bridge:repl] Invalid session_id in work: ${workSessionId}`,
          )
          continue
        }

        onWorkReceived(
          workSessionId,
          secret.session_ingress_token,
          work.id,
          secret.use_code_sessions === true,
        )
        logForDebugging('[bridge:repl] Work accepted, continuing poll loop')
      }
    } catch (err) {
      if (signal.aborted) break

      // Detect permanent "environment deleted" error — no amount of
      // retrying will recover. Re-register a new environment instead.
      // Checked BEFORE the generic BridgeFatalError bail. pollForWork uses
      // validateStatus: s => s < 500, so 404 is always wrapped into a
      // BridgeFatalError by handleErrorStatus() — never an axios-shaped
      // error. The poll endpoint's only path param is the env ID; 404
      // unambiguously means env-gone (no-work is a 200 with null body).
      // The server sends error.type='not_found_error' (standard Anthropic
      // API shape), not a bridge-specific string — but status===404 is
      // the real signal and survives body-shape changes.
      if (
        err instanceof BridgeFatalError &&
        err.status === 404 &&
        onEnvironmentLost
      ) {
        // If credentials have already been refreshed by a concurrent
        // reconnection (e.g. WS close handler), the stale poll's error
        // is expected — skip onEnvironmentLost and retry with fresh creds.
        const currentEnvId = getCredentials().environmentId
        if (envId !== currentEnvId) {
          logForDebugging(
            `[bridge:repl] Stale poll error for old env=${envId}, current env=${currentEnvId} — skipping onEnvironmentLost`,
          )
          consecutiveErrors = 0
          firstErrorTime = null
          continue
        }

        environmentRecreations++
        logForDebugging(
          `[bridge:repl] Environment deleted, attempting re-registration (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
        )
        logEvent('tengu_bridge_repl_env_lost', {
          attempt: environmentRecreations,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

        if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
          logForDebugging(
            `[bridge:repl] Environment re-registration limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
          )
          onStateChange?.(
            'failed',
            'Environment deleted and re-registration limit reached',
          )
          onFatalError?.()
          break
        }

        onStateChange?.('reconnecting', 'environment lost, recreating session')
        const newCreds = await onEnvironmentLost()
        // doReconnect() makes several sequential network calls (1-5s).
        // If the user triggered teardown during that window, its internal
        // abort checks return false — but we need to re-check here to
        // avoid emitting a spurious 'failed' + onFatalError() during
        // graceful shutdown.
        if (signal.aborted) break
        if (newCreds) {
          // Credentials are updated in the outer scope via
          // reconnectEnvironmentWithSession — getCredentials() will
          // return the fresh values on the next poll iteration.
          // Do NOT reset environmentRecreations here — onEnvLost returning
          // creds only proves we tried to fix it, not that the env is
          // healthy. A successful poll (above) is the reset point; if the
          // new env immediately dies again we still want the limit to fire.
          consecutiveErrors = 0
          firstErrorTime = null
          onStateChange?.('ready')
          logForDebugging(
            `[bridge:repl] Re-registered environment: ${newCreds.environmentId}`,
          )
          continue
        }

        onStateChange?.(
          'failed',
          'Environment deleted and re-registration failed',
        )
        onFatalError?.()
        break
      }

      // Fatal errors (401/403/404/410) — no point retrying
      if (err instanceof BridgeFatalError) {
        const isExpiry = isExpiredErrorType(err.errorType)
        const isSuppressible = isSuppressible403(err)
        logForDebugging(
          `[bridge:repl] Fatal poll error: ${err.message} (status=${err.status}, type=${err.errorType ?? 'unknown'})${isSuppressible ? ' (suppressed)' : ''}`,
        )
        logEvent('tengu_bridge_repl_fatal_error', {
          status: err.status,
          error_type:
            err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiry ? 'info' : 'error',
          'bridge_repl_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        // Cosmetic 403 errors (e.g., external_poll_sessions scope,
        // environments:manage permission) — suppress user-visible error
        // but always trigger teardown so cleanup runs.
        if (!isSuppressible) {
          onStateChange?.(
            'failed',
            isExpiry
              ? 'session expired · /remote-control to reconnect'
              : err.message,
          )
        }
        // Always trigger teardown — matches bridgeMain.ts where fatalExit=true
        // is unconditional and post-loop cleanup always runs.
        onFatalError?.()
        break
      }

      const now = Date.now()

      // Detect system sleep/wake: if the gap since the last poll error
      // greatly exceeds the max backoff delay, the machine likely slept.
      // Reset error tracking so we retry with a fresh budget instead of
      // immediately giving up.
      if (
        lastPollErrorTime !== null &&
        now - lastPollErrorTime > POLL_ERROR_MAX_DELAY_MS * 2
      ) {
        logForDebugging(
          `[bridge:repl] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting poll error budget`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_sleep_detected', {
          gapMs: now - lastPollErrorTime,
        })
        consecutiveErrors = 0
        firstErrorTime = null
      }
      lastPollErrorTime = now

      consecutiveErrors++
      if (firstErrorTime === null) {
        firstErrorTime = now
      }
      const elapsed = now - firstErrorTime
      const httpStatus = extractHttpStatus(err)
      const errMsg = describeAxiosError(err)
      const wsLabel = getWsState?.() ?? 'unknown'

      logForDebugging(
        `[bridge:repl] Poll error (attempt ${consecutiveErrors}, elapsed ${Math.round(elapsed / 1000)}s, ws=${wsLabel}): ${errMsg}`,
      )
      logEvent('tengu_bridge_repl_poll_error', {
        status: httpStatus,
        consecutiveErrors,
        elapsedMs: elapsed,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

      // Only transition to 'reconnecting' on the first error — stay
      // there until a successful poll (avoid flickering the UI state).
      if (consecutiveErrors === 1) {
        onStateChange?.('reconnecting', errMsg)
      }

      // Give up after continuous failures
      if (elapsed >= POLL_ERROR_GIVE_UP_MS) {
        logForDebugging(
          `[bridge:repl] Poll failures exceeded ${POLL_ERROR_GIVE_UP_MS / 1000}s (${consecutiveErrors} errors), giving up`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_give_up')
        logEvent('tengu_bridge_repl_poll_give_up', {
          consecutiveErrors,
          elapsedMs: elapsed,
          lastStatus: httpStatus,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        onStateChange?.('failed', 'connection to server lost')
        break
      }

      // Exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s (cap)
      const backoff = Math.min(
        POLL_ERROR_INITIAL_DELAY_MS * 2 ** (consecutiveErrors - 1),
        POLL_ERROR_MAX_DELAY_MS,
      )
      // The poll_due heartbeat-loop exit leaves a healthy lease exposed to
      // this backoff path. Heartbeat before each sleep so /poll outages
      // (the VerifyEnvironmentSecretAuth DB path heartbeat was introduced to
      // avoid) don't kill the 300s lease TTL.
      if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
        const info = getHeartbeatInfo?.()
        if (info) {
          try {
            await api.heartbeatWork(
              info.environmentId,
              info.workId,
              info.sessionToken,
            )
          } catch {
            // Best-effort — if heartbeat also fails the lease dies, same as
            // pre-poll_due behavior (where the only heartbeat-loop exits were
            // ones where the lease was already dying).
          }
        }
      }
      await sleep(backoff, signal)
    }
  }

  logForDebugging(
    `[bridge:repl] Work poll loop ended (aborted=${signal.aborted}) env=${getCredentials().environmentId}`,
  )
}

// Exported for testing only
export {
  startWorkPollLoop as _startWorkPollLoopForTesting,
  POLL_ERROR_INITIAL_DELAY_MS as _POLL_ERROR_INITIAL_DELAY_MS_ForTesting,
  POLL_ERROR_MAX_DELAY_MS as _POLL_ERROR_MAX_DELAY_MS_ForTesting,
  POLL_ERROR_GIVE_UP_MS as _POLL_ERROR_GIVE_UP_MS_ForTesting,
}
