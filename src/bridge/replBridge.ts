// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { randomUUID } from 'node:crypto'
import {
  createWireApiClient,
  WireFatalError,
  isExpiredErrorType,
  isSuppressible403,
} from './bridgeApi.js'
import type { WireConfig, WireApiClient } from './types.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isInternalBuild } from '../utils/envUtils.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleWireMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import { decodeWorkSecret, buildSdkUrl, buildCCRv2SdkUrl, sameSessionId } from './workSecret.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { updateSessionWireId } from '../services/session/concurrentSessions.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import { HybridTransport } from '../cli/transports/hybridTransport.js'
import {
  type ReplWireTransport,
  createV1ReplTransport,
  createV2ReplTransport,
} from './replBridgeTransport.js'
import { updateSessionIngressAuthToken } from '../services/auth/sessionIngressAuth.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { validateWireId } from './bridgeApi.js'
import { describeAxiosError, extractHttpStatus, logWireSkip } from './debugUtils.js'
import type { Message } from '../types/message.js'
import type { WireMessage } from '../types/index.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
import type { WireControlRequest, WireControlResponse } from '../types/wire/control.js'
import { createCapacityWake, type CapacitySignal } from './capacityWake.js'
import { FlushGate } from './flushGate.js'
import { DEFAULT_POLL_CONFIG, type PollIntervalConfig } from './pollConfigDefaults.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import {
  wrapApiForFaultInjection,
  registerWireDebugHandle,
  clearWireDebugHandle,
  injectWireFault,
} from './bridgeDebug.js'
export type ReplWireHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: WireMessage[]): void
  sendControlRequest(request: WireControlRequest): void
  sendControlResponse(response: WireControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}

export type WireState = 'ready' | 'connected' | 'reconnecting' | 'failed'

/**
 * Explicit-param input to initBridgeCore. Everything initReplBridge reads
 * from bootstrap state (cwd, session ID, git, OAuth) becomes a field here.
 * A daemon caller (Agent SDK, PR 4) that never runs main.tsx fills these
 * in itself.
 */
export type WireCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  /**
   * Opaque string sent as metadata.worker_type. Use WireWorkerType for
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
   * REPL wrapper passes `createWireSession` from `createSession.ts`.
   * Daemon wrapper passes `createWireSessionLean` from `sessionApi.ts`
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
   * Converts internal Message[] → WireMessage[] for writeMessages() and the
   * initial-flush/drain paths. REPL wrapper passes the real toSDKMessages
   * from services/messages/mappers.ts. Daemon callers that only use
   * writeSdkMessages() and pass no initialMessages can omit this — those
   * code paths are unreachable.
   *
   * Injected rather than imported because mappers.ts transitively pulls in
   * src/commands.ts via messages.ts → api.ts → prompts.ts, dragging the
   * entire command registry + React tree into the Agent SDK bundle.
   */
  toSDKMessages?: (messages: Message[]) => WireMessage[]
  /**
   * OAuth 401 refresh handler passed to createWireApiClient. REPL wrapper
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
   * zy_bridge_initial_history_cap GrowthBook flag. Daemon passes no
   * initialMessages so this is never read. Default 200 matches the flag
   * default.
   */
  initialHistoryCap?: number
  // 与 InitWireOptions 相同的 REPL 刷新机制 — daemon 省略这些。
  initialMessages?: Message[]
  previouslyFlushedUUIDs?: Set<string>
  onInboundMessage?: (msg: WireMessage) => void
  onPermissionResponse?: (response: WireControlResponse) => void
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
   * throw, which corrupts the 3-way invariant documented in src/AGENTS.md if
   * the callback lets the throw escape here.
   */
  onSetPermissionMode?: (mode: PermissionMode) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: WireState, detail?: string) => void
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
  /** See InitWireOptions.perpetual. */
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
 * Superset of ReplWireHandle. Adds getSSESequenceNum for daemon callers
 * that persist the SSE seq-num across process restarts and pass it back as
 * initialSSESequenceNum on the next start.
 */
export type WireCoreHandle = ReplWireHandle & {
  /**
   * Current SSE sequence-number high-water mark. Updates as transports
   * swap. Daemon callers persist this on shutdown and pass it back as
   * initialSSESequenceNum on next start.
   */
  getSSESequenceNum(): number
}

/**
 * 轮询错误恢复常量。当工作轮询开始失败（如服务器 500 错误）时，
 * 我们使用指数退避并在超时后放弃。这个超时时间设置得较长——
 * 服务器才是判断会话是否真正终止的权威。只要服务器还接受我们的轮询，
 * 我们就继续等待它重新分发工作项。
 */
const POLL_ERROR_INITIAL_DELAY_MS = 2_000
const POLL_ERROR_MAX_DELAY_MS = 60_000
const POLL_ERROR_GIVE_UP_MS = 15 * 60 * 1000

// 单调递增计数器，用于在日志中区分 init 调用
let initSequence = 0

/**
 * 无引导的核心：环境注册 → 会话创建 → 轮询循环 → ingress WS → 清理。
 * 不从 bootstrap/state 或 sessionStorage 读取任何内容——所有上下文来自参数。
 * 调用者（下方的 initReplBridge 或 PR 4 中的 daemon）已经通过权限门控
 * 并收集了 git/auth/title 信息。
 *
 * 注册或会话创建失败时返回 null。
 */
export async function initBridgeCore(params: WireCoreParams): Promise<WireCoreHandle | null> {
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
        'WireCoreParams.toSDKMessages not provided. Pass it if you use writeMessages() or initialMessages — daemon callers that only use writeSdkMessages() never hit this path.',
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
  const { writeWirePointer, clearWirePointer, readWirePointer } = await import('./bridgePointer.js')

  // Perpetual 模式：读取崩溃恢复指针并将其视为先前
  // 状态。指针在 session create 后无条件写入
  // （所有会话的崩溃恢复）；perpetual 模式只是跳过
  // teardown clear，所以它也能在干净退出后存活。只重用 'repl'
  // 指针 — 崩溃的独立 bridge（`zy remote-control`）
  // 写入 source:'standalone' 和不同的 workerType。
  const rawPrior = perpetual ? await readWirePointer(dir) : null
  const prior = rawPrior?.source === 'repl' ? rawPrior : null

  logForDebugging(
    `[bridge:repl] initBridgeCore #${seq} starting (initialMessages=${initialMessages?.length ?? 0}${prior ? ` perpetual prior=env:${prior.environmentId}` : ''})`,
  )

  // 5. 注册 bridge 环境
  const rawApi = createWireApiClient({
    baseUrl,
    getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401,
    getTrustedDeviceToken,
  })
  // 仅 Ant：拦截以便 /bridge-kick 可以注入 poll/register/heartbeat
  // 故障。在外部构建中零成本（rawApi 直接传递不变）。
  const api = isInternalBuild() ? wrapApiForFaultInjection(rawApi) : rawApi

  const bridgeConfig: WireConfig = {
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
    const reg = await api.registerWireEnvironment(bridgeConfig)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logWireSkip(
      'registration_failed',
      `[bridge:repl] Environment registration failed: ${errorMessage(err)}`,
    )
    // 陈旧指针可能是原因（过期/删除的环境）— 清除它以便
    // 下次启动不会重试相同的死 ID。
    if (prior) {
      await clearWirePointer(dir)
    }
    onStateChange?.('failed', errorMessage(err))
    return null
  }

  logForDebugging(`[bridge:repl] Environment registered: ${environmentId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_env_registered')
  logEvent('zy_bridge_repl_env_registered', {})

  /**
   * 原地重连：如果刚注册的环境 ID 与请求的一致，调用 reconnectSession
   * 强制停止旧的工作器并将会话重新入队。用于初始化时（永久模式——
   * 环境存活但在清理后空闲）以及 doReconnect() 策略 1（环境丢失后恢复）。
   * 成功返回 true；失败时调用者回退到创建新会话。
   */
  async function tryReconnectInPlace(requestedEnvId: string, sessionId: string): Promise<boolean> {
    if (environmentId !== requestedEnvId) {
      logForDebugging(
        `[bridge:repl] Env mismatch (requested ${requestedEnvId}, got ${environmentId}) — cannot reconnect in place`,
      )
      return false
    }
    // 指针存储 createWireSession 返回的内容（session_*，
    // compat/convert.go:41）。/bridge/reconnect 是 environments 层
    // 端点 — 一旦服务器的 ccr_v2_compat_enabled 门控开启，它会
    // 通过 infra 标签（cse_*）查找会话，并对 session_* 伪装返回
    // "Session not found"。我们在 poll 前不知道门控状态，
    // 所以两者都试；如果 ID 已经是 cse_*，重新标记是无操作
    // （doReconnect Strategy 1 路径 — currentSessionId 永远不会变异
    // 为 cse_*，但为未来检查做准备）。
    const infraId = toInfraSessionId(sessionId)
    const candidates = infraId === sessionId ? [sessionId] : [sessionId, infraId]
    for (const id of candidates) {
      try {
        await api.reconnectSession(environmentId, id)
        logForDebugging(`[bridge:repl] Reconnected session ${id} in place on env ${environmentId}`)
        return true
      } catch (err) {
        logForDebugging(`[bridge:repl] reconnectSession(${id}) failed: ${errorMessage(err)}`)
      }
    }
    logForDebugging('[bridge:repl] reconnectSession exhausted — falling through to fresh session')
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
    await clearWirePointer(dir)
  }

  // 6. 在 bridge 上创建会话。初始消息不包含为
  // 会话创建事件，因为它们使用 STREAM_ONLY 持久化且
  // 在 CCR UI 订阅之前发布，所以会丢失。相反，
  // 初始消息在 ingress WebSocket 连接后通过它刷新。

  // 可变会话 ID — 在连接丢失后重新创建环境+会话对时更新。
  let currentSessionId: string

  if (reusedPriorSession && prior) {
    currentSessionId = prior.sessionId
    logForDebugging(`[bridge:repl] Perpetual session reused: ${currentSessionId}`)
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
      logForDebugging('[bridge:repl] Session creation failed, deregistering environment')
      logEvent('zy_bridge_repl_session_failed', {})
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
  await writeWirePointer(dir, {
    sessionId: currentSessionId,
    environmentId,
    source: 'repl',
  })
  logForDiagnosticsNoPII('info', 'bridge_repl_session_created')
  logEvent('zy_bridge_repl_started', {
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
  // 由 secret.use_code_sessions 服务器驱动，ZY_BRIDGE_USE_CCR
  // 作为 ant-dev 覆盖。
  let transport: ReplWireTransport | null = null
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
   * 从 onEnvironmentLost 恢复（轮询返回 404——环境在服务器端被回收）。
   * 按顺序尝试两种策略：
   *
   *   1. 原地重连：使用 reuseEnvironmentId 幂等重新注册
   *      → 如果后端返回相同的环境 ID，调用 reconnectSession()
   *      将现有会话重新入队。currentSessionId 保持不变；
   *      用户手机上的 URL 保持有效；previouslyFlushedUUIDs
   *      被保留，因此不会重新发送历史记录。
   *
   *   2. 新会话回退：如果后端返回不同的环境 ID
   *      （原始 TTL 过期，例如笔记本睡眠超过 4 小时）或 reconnectSession()
   *      抛出异常，归档旧会话并在已注册的环境上创建新会话。
   *      这是 #20460 原语落地之前的旧行为。
   *
   * 使用基于 Promise 的可重入守卫，使并发调用者共享同一次重连尝试。
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
    // 使任何进行中的 v2 握手失效——环境正在被重新创建，
    // 因此重连后到达的旧传输将指向一个已死会话。
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

    // 在 close 之前捕获序列号——如果策略 1（tryReconnectInPlace）成功，
    // 我们保留同一个会话，下一个传输必须从当前传输停止的位置继续，
    // 而不是从上次传输交换的检查点重放。
    if (transport) {
      const seq = transport.getLastSequenceNum()
      if (seq > lastTransportSequenceNum) {
        lastTransportSequenceNum = seq
      }
      transport.close()
      transport = null
    }
    // 传输已移除——唤醒轮询循环退出容量心跳睡眠，
    // 以便快速轮询重新分发的工作。
    wakePollLoop()
    // 重置刷新门，使 writeMessages() 命中 !transport 守卫，
    // 而不是静默排队到一个已死的缓冲区中。
    flushGate.drop()

    // 释放当前工作项（force=false——我们可能想要回会话）。
    // 尽力而为：环境可能已经不在了，所以这很可能返回 404。
    if (currentWorkId) {
      const workIdBeingCleared = currentWorkId
      await api.stopWork(environmentId, workIdBeingCleared, false).catch(() => {})
      // 当 doReconnect 与轮询循环并发运行时（ws_closed 处理程序场景——
      // void 调用，不同于等待的 onEnvironmentLost 路径），onWorkReceived
      // 可以在 stopWork 等待期间触发并设置新的 currentWorkId。如果发生了，
      // 轮询循环已经自行恢复—— defer 给它而不是继续执行 archiveSession，
      // 那会销毁它的新传输所连接的会话。
      if (currentWorkId !== workIdBeingCleared) {
        logForDebugging('[bridge:repl] Poll loop recovered during stopWork await — deferring to it')
        environmentRecreations = 0
        return true
      }
      currentWorkId = null
      currentIngressToken = null
    }

    // 如果在我们等待时清理已经开始，则退出
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted by teardown')
      return false
    }

    // 策略 1：使用服务器下发的环境 ID 进行幂等重新注册。
    // 如果后端恢复同一个环境（新密钥），我们可以重连现有会话。
    // 如果返回不同的 ID，原始环境确实已经消失，我们回退到创建新会话。
    const requestedEnvId = environmentId
    bridgeConfig.reuseEnvironmentId = requestedEnvId
    try {
      const reg = await api.registerWireEnvironment(bridgeConfig)
      environmentId = reg.environment_id
      environmentSecret = reg.environment_secret
    } catch (err) {
      bridgeConfig.reuseEnvironmentId = undefined
      logForDebugging(`[bridge:repl] Environment re-registration failed: ${errorMessage(err)}`)
      return false
    }
    // 在任何 await 之前清除——如果 doReconnect 再次运行，旧值会污染下一次新注册。
    bridgeConfig.reuseEnvironmentId = undefined

    logForDebugging(`[bridge:repl] Re-registered: requested=${requestedEnvId} got=${environmentId}`)

    // 如果在我们注册时清理已经开始，则退出
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted after env registration, cleaning up')
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 与上面相同的竞态，窗口更窄：轮询循环可能在 registerWireEnvironment
    // 等待期间设置了传输。在 tryReconnectInPlace/archiveSession 在服务器端
    // 销毁它之前退出。
    if (transport !== null) {
      logForDebugging(
        '[bridge:repl] Poll loop recovered during registerWireEnvironment await — deferring to it',
      )
      environmentRecreations = 0
      return true
    }

    // 策略 1：与永久初始化相同的辅助函数。成功时 currentSessionId 保持不变；
    // 移动设备/web 上的 URL 保持有效；previouslyFlushedUUIDs 被保留（不重新刷新）。
    if (await tryReconnectInPlace(requestedEnvId, currentSessionId)) {
      logEvent('zy_bridge_repl_reconnected_in_place', {})
      environmentRecreations = 0
      return true
    }
    // Env differs → TTL-expired/reaped; or reconnect failed.
    // Don't deregister — we have a fresh secret for this env either way.
    if (environmentId !== requestedEnvId) {
      logEvent('zy_bridge_repl_env_expired_fresh_session', {})
    }

    // 策略 2：在已注册的环境上创建新会话。
    // 先归档旧会话——它已经是孤儿了（绑定到已死的环境，或被 reconnectSession 拒绝）。
    // 不要注销环境——我们刚为它获取了新密钥并且即将使用它。
    await archiveSession(currentSessionId)

    // 如果在我们归档时清理已经开始，则退出
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted after archive, cleaning up')
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 重新读取当前标题，以防用户重命名了会话。
    // REPL 包装器读取会话存储；daemon 包装器返回原始标题（无需刷新）。
    const currentTitle = getCurrentTitle()

    // 在已注册的环境上创建新会话
    const newSessionId = await createSession({
      environmentId,
      title: currentTitle,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!newSessionId) {
      logForDebugging('[bridge:repl] Session creation failed during reconnection')
      return false
    }

    // 如果在会话创建期间（最长 15 秒）清理已经开始，则退出
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted after session creation, cleaning up')
      await archiveSession(newSessionId)
      return false
    }

    currentSessionId = newSessionId
    // 重新发布到 PID 文件，以便 peer dedup（peerRegistry.ts）获取新 ID——
    // setReplWireHandle 仅在 init/teardown 时触发，不在 reconnect 时触发。
    void updateSessionWireId(toCompatSessionId(newSessionId)).catch(() => {})
    // 在会话交换后立即重置每个传输的状态，在任何 await 之前。
    // 如果这在下面的 `await writeWirePointer` 之后运行，会有一个窗口
    // 期间 handle.bridgeSessionId 已经返回会话 B 但 getSSESequenceNum()
    // 仍然返回会话 A 的序列号——daemon 在该窗口中的 persistState() 会写入
    // {bridgeSessionId: B, seq: OLD_A}，这会通过会话 ID 验证检查并完全破坏它。
    //
    // SSE 序列号与会话的事件流绑定——将其携带过来会使传输的 lastSequenceNum
    // 卡在高位（只有 received > last 时序列号才会前进），其下次内部重连会
    // 针对从 1 开始的流发送 from_sequence_num=OLD_SEQ → 间隔中的所有事件被静默丢弃。
    // 入站 UUID 去重也是会话范围的。
    lastTransportSequenceNum = 0
    recentInboundUUIDs.clear()
    // 标题派生也是会话范围的：如果用户在上面的 createSession 等待期间输入了内容，
    // 回调会针对旧的已归档会话 ID 触发（PATCH 丢失），新会话获取的是他们输入之前
    // 捕获的 `currentTitle`。重置以便下一个提示可以重新派生。自我修正：如果调用者的策略
    // 已经完成（明确标题或计数 ≥ 3），它会在重置后的第一次调用时返回 true 并重新锁定。
    userMessageCallbackDone = !onUserMessage
    logForDebugging(`[bridge:repl] Re-created session: ${currentSessionId}`)

    // 用新 ID 重写崩溃恢复指针，以便此点之后的崩溃能恢复正确的会话。
    // （上面的原地重连路径不会触碰指针——同一个会话，同一个环境。）
    await writeWirePointer(dir, {
      sessionId: currentSessionId,
      environmentId,
      source: 'repl',
    })

    // 清除已刷新的 UUID，以便初始消息重新发送到新会话。
    // UUID 在服务器上按会话作用域，因此重新刷新是安全的。
    previouslyFlushedUUIDs?.clear()

    // 重置计数器，使间隔数小时的独立重连不会耗尽限制——
    // 它防范的是快速连续失败，而不是生命周期总数。
    environmentRecreations = 0

    return true
  }

  // 辅助函数：获取当前 OAuth access token 用于会话 ingress 认证。
  // 与 JWT 路径不同，OAuth token 由标准 OAuth 流程刷新——不需要主动调度器。
  function getOAuthToken(): string | undefined {
    return getAccessToken()
  }

  // Drain any messages that were queued during the initial flush.
  // Called after writeBatch completes (or fails) so queued messages
  // are sent in order after the historical messages.
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) {
      return
    }
    if (!transport) {
      logForDebugging(`[bridge:repl] Cannot drain ${msgs.length} pending message(s): no transport`)
      return
    }
    for (const msg of msgs) {
      recentPostedUUIDs.add(msg.uuid)
    }
    const sdkMessages = toSDKMessages(msgs)
    const events = sdkMessages.map((sdkMsg) => ({
      ...sdkMsg,
      session_id: currentSessionId,
    }))
    logForDebugging(`[bridge:repl] Drained ${msgs.length} pending message(s) after flush`)
    void transport.writeBatch(events)
  }

  // 清理引用——在下方定义之后设置。所有调用者都是异步回调，
  // 在赋值之后运行，因此引用始终有效。
  let doTeardownImpl: (() => Promise<void>) | null = null
  function triggerTeardown(): void {
    void doTeardownImpl?.()
  }

  /**
   * 传输的 setOnClose 回调的主体，提升到 initBridgeCore 作用域，
   * 以便 /bridge-kick 可以直接触发它。setOnClose 用旧传输守卫包裹它；
   * debugFireClose 直接调用它。
   *
   * 当 autoReconnect:true 时，仅在以下情况触发：正常关闭（1000）、
   * 服务器永久拒绝（4001/1002/4003）或 10 分钟预算耗尽。
   * 瞬态断开由传输内部重试。
   */
  function handleTransportPermanentClose(closeCode: number | undefined): void {
    logForDebugging(`[bridge:repl] Transport permanently closed: code=${closeCode}`)
    logEvent('zy_bridge_repl_ws_closed', {
      code: closeCode,
    })
    // 在置空之前捕获 SSE 序列号高水位标记。当从 setOnClose 调用时，
    // 守卫保证 transport !== null；当从 /bridge-kick 触发时可能已经为 null
    //（例如触发了两次）——跳过。
    if (transport) {
      const closedSeq = transport.getLastSequenceNum()
      if (closedSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = closedSeq
      }
      transport = null
    }
    // 传输已移除——唤醒轮询循环退出容量心跳睡眠，
    // 以便在下方重连完成且服务器重新入队工作时已经在快速轮询。
    wakePollLoop()
    // 重置刷新状态，使 writeMessages() 命中 !transport 守卫（带有警告日志），
    // 而不是静默排队到一个永远不会被排空的缓冲区。与 onWorkReceived 不同
    //（后者为新传输保留待处理消息），onClose 是永久关闭——不会有新传输来排空这些。
    const dropped = flushGate.drop()
    if (dropped > 0) {
      logForDebugging(
        `[bridge:repl] Dropping ${dropped} pending message(s) on transport close (code=${closeCode})`,
        { level: 'warn' },
      )
    }

    if (closeCode === 1000) {
      // 正常关闭——会话正常结束。清理 bridge。
      onStateChange?.('failed', 'session ended')
      pollController.abort()
      triggerTeardown()
      return
    }

    // 传输重连预算耗尽或服务器永久拒绝。到此时环境通常已经在
    // 服务器端被回收（BQ 2026-03-12：约 98% 的 ws_closed 仅靠轮询无法恢复）。
    // stopWork(force=false) 无法从已归档的环境重新分发工作；
    // reconnectEnvironmentWithSession 可以通过 POST /bridge/reconnect 重新激活它，
    // 或者如果环境确实消失则回退到新会话。轮询循环（已在上方唤醒）
    // 会在 doReconnect 完成后接收重新入队的工作。
    onStateChange?.('reconnecting', `Remote Control connection lost (code ${closeCode})`)
    logForDebugging(
      `[bridge:repl] Transport reconnect budget exhausted (code=${closeCode}), attempting env reconnect`,
    )
    void reconnectEnvironmentWithSession().then((success) => {
      if (success) {
        return
      }
      // doReconnect 有四个中止检查返回 false 的站点用于进行中的清理。
      // 当用户只是退出时，不要污染 BQ 失败信号或双重清理。
      if (pollController.signal.aborted) {
        return
      }
      // doReconnect returns false (never throws) on genuine failure.
      // The dangerous case: registerWireEnvironment succeeded (so
      // environmentId now points at a fresh valid env) but
      // createSession failed — poll loop would poll a sessionless
      // env getting null work with no errors, never hitting any
      // give-up path. Tear down explicitly.
      logForDebugging('[bridge:repl] reconnectEnvironmentWithSession resolved false — tearing down')
      logEvent('zy_bridge_repl_reconnect_failed', {
        close_code: closeCode,
      })
      onStateChange?.('failed', 'reconnection failed')
      triggerTeardown()
    })
  }

  // 仅 Ant：SIGUSR2 → 强制 doReconnect() 用于手动测试。跳过约 30 秒的
  // 轮询等待——立即在调试日志中触发并观察。
  // Windows 没有 USR 信号；`process.on` 在那里会抛出异常。
  let sigusr2Handler: (() => void) | undefined
  if (isInternalBuild() && process.platform !== 'win32') {
    sigusr2Handler = () => {
      logForDebugging('[bridge:repl] SIGUSR2 received — forcing doReconnect() for testing')
      void reconnectEnvironmentWithSession()
    }
    process.on('SIGUSR2', sigusr2Handler)
  }

  // 仅 Ant：/bridge-kick 故障注入。handleTransportPermanentClose 在下方定义
  // 并赋值到这个槽位，以便斜杠命令可以直接调用它——真正的 setOnClose 回调
  // 埋在 wireTransport 里面，而它本身又在 onWorkReceived 里面。
  let debugFireClose: ((code: number) => void) | null = null
  if (isInternalBuild()) {
    registerWireDebugHandle({
      fireClose: (code) => {
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
      injectFault: injectWireFault,
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
    // REPL bridge 是单会话的：有任何传输 = 达到容量。
    // 无需检查 isConnectedStatus()——即使传输在内部自动重连期间
    //（最长 10 分钟），轮询也仅用于心跳。
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
    // 工作项 JWT 过期（或工作项消失）。传输已无用——
    // SSE 重连和 CCR 写入使用相同的旧 token。没有这个回调的话，
    // 轮询循环会执行 10 分钟的容量退避，在此期间工作租约（300 秒 TTL）
    // 过期且服务器停止转发提示→daemon 日志中观察到约 25 分钟的死窗口。
    // 销毁传输 + 工作状态使 isAtCapacity()=false；循环快速轮询并在
    // 几秒内接收服务器重新分发的工作项。
    onHeartbeatFatal: (err: WireFatalError) => {
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
      // force=false → 服务器重新入队。可能已经过期，但幂等且如果未过期则使重新分发立即生效。
      if (currentWorkId) {
        void api.stopWork(environmentId, currentWorkId, false).catch((e: unknown) => {
          logForDebugging(`[bridge:repl] stopWork after heartbeat fatal: ${errorMessage(e)}`)
        })
      }
      currentWorkId = null
      currentIngressToken = null
      wakePollLoop()
      onStateChange?.('reconnecting', 'Work item lease expired, fetching fresh token')
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
      // 当传输已打开时有新工作到达，服务器已决定重新分发
      //（例如 token 轮换、服务器重启）。关闭现有传输并重新连接——
      // 如果旧 WS 在之后不久死亡，丢弃工作会导致卡在 'reconnecting' 状态
      //（服务器不会重新分发它已经交付的工作项）。
      // ingressToken（JWT）存储用于心跳认证（v1 和 v2 都使用）。
      // 传输认证不同——见下方的 v1/v2 分支。
      if (transport?.isConnectedStatus()) {
        logForDebugging(
          `[bridge:repl] Work received while transport connected, replacing with fresh token (workId=${workId})`,
        )
      }

      logForDebugging(
        `[bridge:repl] Work received: workId=${workId} workSessionId=${workSessionId} currentSessionId=${currentSessionId} match=${sameSessionId(workSessionId, currentSessionId)}`,
      )

      // 刷新崩溃恢复指针的 mtime。陈旧性检查文件 mtime（而非嵌入的时间戳），
      // 因此这次重写会推进时钟——超过 5 小时的会话崩溃后仍然有新鲜的指针。
      // 每次工作调度触发一次（不频繁——受用户消息速率限制）。
      void writeWirePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })

      // 拒绝外部会话 ID——服务器不应该从其他环境分配会话。
      // 因为我们成对创建 env+session，不匹配表明意外的服务器端重新分配。
      //
      // 通过底层 UUID 比较，而非标记 ID 前缀。当 CCR v2 的兼容层提供会话时，
      // createWireSession 从面向 v1 的 API 获取 session_*（compat/convert.go:41），
      // 但基础设施层在工作队列中交付 cse_*（container_manager.go:129）。
      // 相同的 UUID，不同的标记。
      if (!sameSessionId(workSessionId, currentSessionId)) {
        logForDebugging(
          `[bridge:repl] Rejecting foreign session: expected=${currentSessionId} got=${workSessionId}`,
        )
        return
      }

      currentWorkId = workId
      currentIngressToken = ingressToken

      // 服务器按会话决定（来自工作密钥的 secret.use_code_sessions，
      // 通过 runWorkPollLoop 传递）。环境变量是 ant-dev 覆盖，用于在服务器标志
      // 对你的用户开启之前强制使用 v2——需要服务器端的 ccr_v2_compat_enabled，
      // 否则 registerWorker 会 404。
      //
      // 与 ZY_CODE_（子级 SDK 传输选择器，由 sessionRunner/environment-manager
      // 设置）分开，以避免在 spawn 模式中父级的 orchestrator 变量泄漏到 v1 子级的继承风险。
      const useCcrV2 = serverUseCcrV2 || isEnvTruthy(process.env.ZY_BRIDGE_USE_CCR)

      // 认证是 v1 和 v2 唯一真正分歧的地方：
      //
      // - v1（Session-Ingress）：接受 OAuth 或 JWT。我们偏好 OAuth，
      //   因为标准 OAuth 刷新流程处理过期——不需要单独的 JWT 刷新调度器。
      //
      // - v2（CCR /worker/*）：必须使用 JWT。register_worker.go:32
      //   验证 session_id 声明，OAuth token 不携带该声明。
      //   工作密钥中的 JWT 同时具有该声明和 worker 角色（environment_auth.py:856）。
      //   JWT 刷新：当它过期时，服务器用新的 JWT 重新分发工作，onWorkReceived 再次触发。
      //   createV2ReplTransport 通过网络操作前通过 updateSessionIngressAuthToken() 存储它。
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
      logEvent('zy_bridge_repl_work_received', {})

      // 关闭之前的传输。在调用 close() 之前置空，以便关闭回调不会将程序化关闭
      // 视为"会话正常结束"并触发完整清理。
      if (transport) {
        const oldTransport = transport
        transport = null
        // 捕获 SSE 序列高水位标记，以便下一个传输恢复流而不是从 seq 0 重放。
        // 使用 max()——过早死亡的传输（从未收到任何帧）否则会将非零标记重置为 0。
        const oldSeq = oldTransport.getLastSequenceNum()
        if (oldSeq > lastTransportSequenceNum) {
          lastTransportSequenceNum = oldSeq
        }
        oldTransport.close()
      }
      // 重置刷新状态——旧的刷新（如果有）不再相关。
      // 保留待处理消息，以便它们在新传输刷新完成后被排空
      //（钩子已经推进了 lastWrittenIndex，不会重新发送它们）。
      flushGate.deactivate()

      // 共享 handleServerControlRequest 的闭包适配器——
      // 捕获 transport/currentSessionId，使下方的 transport.setOnData
      // 回调不需要将它们传递进来。
      const onServerControlRequest = (request: WireControlRequest): void =>
        handleServerControlRequest(request, {
          transport,
          sessionId: currentSessionId,
          onInterrupt,
          onSetModel,
          onSetMaxThinkingTokens,
          onSetPermissionMode,
        })

      let initialFlushDone = false

      // 将回调绑定到新建的传输并连接。
      // 提取出来使（同步的）v1 和（异步的）v2 构建路径可以共享相同的回调 + 刷新机制。
      const wireTransport = (newTransport: ReplWireTransport): void => {
        transport = newTransport

        newTransport.setOnConnect(() => {
          // 守卫：如果传输在 WS 连接期间被更新的 onWorkReceived 调用替换，
          // 忽略这个旧回调。
          if (transport !== newTransport) {
            return
          }

          logForDebugging('[bridge:repl] Ingress transport connected')
          logEvent('zy_bridge_repl_ws_connected', {})

          // 用最新的 OAuth token 更新环境变量，使 POST 写入
          //（通过 getSessionIngressAuthToken() 读取）使用新 token。
          // v2 跳过这个——createV2ReplTransport 已经存储了 JWT，
          // 用 OAuth 覆盖它会破坏后续的 /worker/* 请求（session_id 声明检查）。
          if (!useCcrV2) {
            const freshToken = getOAuthToken()
            if (freshToken) {
              updateSessionIngressAuthToken(freshToken)
            }
          }

          // 重置 teardownStarted 以便未来的清理不会被阻塞。
          teardownStarted = false

          // 仅在首次连接时刷新初始消息，而不是每次 WS 重连都刷新。
          // 重新刷新会导致重复消息。
          // 重要：onStateChange('connected') 被推迟到刷新完成。
          // 这防止 writeMessages() 发送可能在历史消息之间交错到达服务器的新消息，
          // 并延迟 web UI 在历史记录持久化之前显示会话为活动状态。
          if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
            initialFlushDone = true

            // 将初始刷新限制为最近的 N 条消息。完整历史记录仅供 UI 使用
            //（模型看不到它），大量重放会导致会话 ingress 持久化缓慢
            //（每个事件都是一次 threadstore 写入）以及增加 Firestore 压力。
            // 0 或负数限制会禁用它。
            const historyCap = initialHistoryCap
            const eligibleMessages = initialMessages.filter(
              (m) => isEligibleWireMessage(m) && !previouslyFlushedUUIDs?.has(m.uuid),
            )
            const cappedMessages =
              historyCap > 0 && eligibleMessages.length > historyCap
                ? eligibleMessages.slice(-historyCap)
                : eligibleMessages
            if (cappedMessages.length < eligibleMessages.length) {
              logForDebugging(
                `[bridge:repl] Capped initial flush: ${eligibleMessages.length} -> ${cappedMessages.length} (cap=${historyCap})`,
              )
              logEvent('zy_bridge_repl_history_capped', {
                eligible_count: eligibleMessages.length,
                capped_count: cappedMessages.length,
              })
            }
            const sdkMessages = toSDKMessages(cappedMessages)
            if (sdkMessages.length > 0) {
              logForDebugging(
                `[bridge:repl] Flushing ${sdkMessages.length} initial message(s) via transport`,
              )
              const events = sdkMessages.map((sdkMsg) => ({
                ...sdkMsg,
                session_id: currentSessionId,
              }))
              const dropsBefore = newTransport.droppedBatchCount
              void newTransport
                .writeBatch(events)
                .then(() => {
                  // 如果在此次刷新期间有任何批次被丢弃（SI 宕机达到 maxConsecutiveFailures 次数），
                  // flush() 仍然正常解析但事件并未交付。不要将 UUID 标记为已刷新——
                  // 保留它们在下一次 onWorkReceived 时重新发送的资格（JWT 刷新重新分发）。
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
                .catch((e) => logForDebugging(`[bridge:repl] Initial flush failed: ${e}`))
                .finally(() => {
                  // 守卫：如果传输在刷新期间被替换，不要发送 connected 信号或排空——
                  // 新传输现在拥有生命周期。
                  if (transport !== newTransport) {
                    return
                  }
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
            // 没有初始消息或首次连接时已刷新。
            // WS 自动重连路径——仅在没有刷新 POST 进行中时才发送 connected 信号。
            // 如果有，.finally() 拥有生命周期。
            onStateChange?.('connected')
          }
        })

        newTransport.setOnData((data) => {
          handleIngressMessage(
            data,
            recentPostedUUIDs,
            recentInboundUUIDs,
            onInboundMessage,
            onPermissionResponse,
            onServerControlRequest,
          )
        })

        // 主体位于 initBridgeCore 作用域，以便 /bridge-kick 可以通过 debugFireClose 直接调用它。
        // 所有引用的闭包（transport、wakePollLoop、flushGate、reconnectEnvironmentWithSession 等）
        // 已经在该作用域中。对 wireTransport 的唯一词法依赖是 `newTransport.getLastSequenceNum()`——
        // 但在下方守卫通过后我们知道 transport === newTransport。
        debugFireClose = handleTransportPermanentClose
        newTransport.setOnClose((closeCode) => {
          // 守卫：如果传输被替换，忽略旧关闭。
          if (transport !== newTransport) {
            return
          }
          handleTransportPermanentClose(closeCode)
        })

        // 在 connect() 之前启动刷新门以覆盖 WS 握手窗口。
        // 在传输赋值和 setOnConnect 触发之间，writeMessages() 可能在
        // 初始刷新开始之前通过 HTTP POST 发送消息。在这里启动门确保
        // 这些调用被排队。如果没有初始消息，门保持不活跃。
        if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
          flushGate.start()
        }

        newTransport.connect()
      } // end wireTransport

      // 无条件递增——任何新传输（v1 或 v2）都会使进行中的 v2 握手失效。
      // 在 doReconnect() 中也递增。
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
          (t) => {
            // registerWorker 正在进行时触发了清理。清理看到 transport === null 并跳过了 close()；
            // 现在安装会泄漏 CCRClient 心跳定时器并通过 wireTransport 的副作用重置 teardownStarted。
            if (pollController.signal.aborted) {
              t.close()
              return
            }
            // onWorkReceived 可能在 registerWorker() 进行时再次触发（服务器用新 JWT 重新分发）。
            // 当两次尝试都看到 transport === null 时，仅靠 transport !== null 检查会出错——
            // 它保留第一个解析器（旧 epoch）并丢弃第二个（正确 epoch）。
            // 生成检查无论传输状态如何都能捕获它。
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
            logEvent('zy_bridge_repl_ccr_v2_init_failed', {})
            // 如果有更新的尝试正在进行或已成功的，不要触碰它的工作项——我们的失败无关紧要。
            if (thisGen !== v2Generation) {
              return
            }
            // 释放工作项使服务器立即重新分发，而不是等待自己的超时。
            // currentWorkId 已在上方设置；没有这个的话，会话对用户来说像是卡住了。
            if (currentWorkId) {
              void api.stopWork(environmentId, currentWorkId, false).catch((e: unknown) => {
                logForDebugging(`[bridge:repl] stopWork after v2 init failure: ${errorMessage(e)}`)
              })
              currentWorkId = null
              currentIngressToken = null
            }
            wakePollLoop()
          },
        )
      } else {
        // v1：HybridTransport（WS 读取 + POST 写入 Session-Ingress）。
        // autoReconnect 为 true（默认）——当 WS 断开时，传输以指数退避自动重连。
        // POST 写入在重连期间继续（它们使用 getSessionIngressAuthToken()，独立于 WS 状态）。
        // 如果重连预算耗尽（10 分钟），轮询循环作为次要回退保留。
        //
        // 认证：直接使用 OAuth token 而不是工作密钥中的 JWT。
        // refreshHeaders 在每次 WS 重连尝试时获取最新的 OAuth token。
        const wsUrl = buildSdkUrl(sessionIngressUrl, workSessionId)
        logForDebugging(`[bridge:repl] Ingress URL: ${wsUrl}`)
        logForDebugging(`[bridge:repl] Creating HybridTransport: session=${workSessionId}`)
        // v1OauthToken 已在上方验证为非 null（否则会提前返回）。
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
              // 限制重试次数，使持续失败的 session-ingress 不会在整个 bridge 生命周期内
              // 卡住上传排空循环。50 次尝试 ≈ 20 分钟（稳态下每周期 15 秒 POST 超时 + 8 秒退避 + 抖动）。
              // 仅 bridge 使用——直接 API 保持无限次。
              {
                maxConsecutiveFailures: 50,
                isBridge: true,
                onBatchDropped: () => {
                  onStateChange?.(
                    'reconnecting',
                    'Lost sync with Remote Control — events could not be delivered',
                  )
                  // SI 已宕机约 20 分钟。唤醒轮询循环，使 SI 恢复时，
                  // 下次轮询 → onWorkReceived → 新传输 → 初始刷新成功 → onStateChange('connected')。
                  // 没有这个的话，即使在 SI 恢复后状态仍然保持 'reconnecting'——
                  // daemon.ts:437 拒绝所有权限，useReplBridge.ts:311 保持 replWireSessionActive=false。
                  // 如果宕机期间环境被归档，轮询 404 → onEnvironmentLost 恢复路径处理它。
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

  // 永久模式：每小时刷新崩溃恢复指针的 mtime。
  // onWorkReceived 刷新仅在用户提示时触发——
  // 空闲超过 4 小时的 daemon 会有陈旧的指针，下次重启会清除它
  // would clear it (readWirePointer TTL check) → fresh session. The
  // standalone bridge (bridgeMain.ts) has an identical hourly timer.
  const pointerRefreshTimer = perpetual
    ? setInterval(() => {
        // doReconnect() 非原子地重新赋值 currentSessionId/environmentId
        //（环境在 ~:634，会话在 ~:719，之间有 await）。
        // 如果该计时器在那个窗口触发，它的即发即忘写入可能会
        // 与 doReconnect 在 ~:740 自己的指针写入竞态（并覆盖它），
        // 使指针停留在已归档的旧会话。doReconnect 写入指针本身，
        // 所以在这里跳过是免费的。
        if (reconnectPromise) {
          return
        }
        void writeWirePointer(dir, {
          sessionId: currentSessionId,
          environmentId,
          source: 'repl',
        })
      }, 60 * 60_000)
    : null
  pointerRefreshTimer?.unref?.()

  // 以固定间隔发送静默 keep_alive 帧，使上游代理和
  // session-ingress 层不会 GC 一个空闲的远程控制会话。
  // keep_alive 类型在到达任何客户端 UI 之前被过滤掉
  //（Query.ts 丢弃它；web/iOS/Android 在它们的消息循环中永远看不到它）。
  // 间隔来自 GrowthBook（zy_bridge_poll_interval_config
  // session_keepalive_interval_v2_ms，默认 120 秒）；0 = 禁用。
  const keepAliveIntervalMs = getPollIntervalConfig().session_keepalive_interval_v2_ms
  const keepAliveTimer =
    keepAliveIntervalMs > 0
      ? setInterval(() => {
          if (!transport) {
            return
          }
          logForDebugging('[bridge:repl] keep_alive sent')
          void transport.write({ type: 'keep_alive' }).catch((err: unknown) => {
            logForDebugging(`[bridge:repl] keep_alive write failed: ${errorMessage(err)}`)
          })
        }, keepAliveIntervalMs)
      : null
  keepAliveTimer?.unref?.()

  // 共享清理序列，用于清理注册和返回句柄上的显式 teardown() 方法。
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
    if (isInternalBuild()) {
      clearWireDebugHandle()
      debugFireClose = null
    }
    pollController.abort()
    logForDebugging('[bridge:repl] Teardown: poll loop aborted')

    // 在 close() 之前捕获活跃传输的序列号——close() 是同步的
    //（只是中止 SSE 获取）且不会调用 onClose，所以 setOnClose 捕获路径
    // 永远不会为显式清理运行。没有这个的话，清理后的 getSSESequenceNum()
    // 返回旧的 lastTransportSequenceNum（在最后一次传输交换时捕获），
    // daemon 调用者持久化该值会丢失之后的所有事件。
    if (transport) {
      const finalSeq = transport.getLastSequenceNum()
      if (finalSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = finalSeq
      }
    }

    if (perpetual) {
      // 永久清理是仅本地的——不发送 result，不调用 stopWork，不关闭传输。
      // 所有这些都会向服务器（和任何移动设备/附加订阅者）信号会话正在结束。
      // 相反：停止轮询，让 socket 随进程消亡；后端自己计时将工作项租约
      // 恢复为 pending（TTL 300 秒）。下次 daemon 启动读取指针并通过
      // reconnectSession 重新入队工作。
      transport = null
      flushGate.drop()
      // 刷新指针 mtime，使超过 BRIDGE_POINTER_TTL_MS（4 小时）的会话在下次启动时不显得陈旧。
      await writeWirePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })
      logForDebugging(
        `[bridge:repl] Teardown (perpetual): leaving env=${environmentId} session=${currentSessionId} alive on server, duration=${Date.now() - teardownStart}ms`,
      )
      return
    }

    // 发送 result 消息，然后归档，再关闭。transport.write()
    // 只是入队（SerialBatchEventUploader 在 buffer-add 时解析）；
    // stopWork/archive 延迟（约 200-500ms）是 result POST 的排空窗口。
    // 在归档之前关闭意味着依赖 HybridTransport 的 void-ed 3 秒宽限期，
    // 没有任何东西等待它——forceExit 可以在 POST 中途杀死 socket。
    // 与 remoteBridgeCore.ts 清理相同的重排序（#22803）。
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
            logForDebugging(`[bridge:repl] Teardown stopWork failed: ${errorMessage(err)}`)
          })
      : Promise.resolve()

    // 并行运行 stopWork 和 archiveSession。gracefulShutdown.ts:407
    // 将 runCleanupFunctions() 与 2 秒竞态（而非 5 秒外部保险），
    // 因此归档在注入点被限制在 1.5 秒以保持在预算内。
    // archiveSession 按约定不抛出异常；注入的实现在内部记录自己的成功/失败。
    await Promise.all([stopWorkP, archiveSession(currentSessionId)])

    teardownTransport?.close()
    logForDebugging('[bridge:repl] Teardown: transport closed')

    await api.deregisterEnvironment(environmentId).catch((err: unknown) => {
      logForDebugging(`[bridge:repl] Teardown deregister failed: ${errorMessage(err)}`)
    })

    // 清除崩溃恢复指针——显式断开连接或干净的 REPL 退出
    // 意味着用户已完成此会话。崩溃/kill -9 永远不会到达这一行，
    // 留下指针供下次启动恢复。
    await clearWirePointer(dir)

    logForDebugging(
      `[bridge:repl] Teardown complete: env=${environmentId} duration=${Date.now() - teardownStart}ms`,
    )
  }

  // 8. 注册清理用于正常关闭
  const unregister = registerCleanup(() => doTeardownImpl?.())

  logForDebugging(`[bridge:repl] Ready: env=${environmentId} session=${currentSessionId}`)
  onStateChange?.('ready')

  return {
    get bridgeSessionId() {
      return currentSessionId
    },
    get environmentId() {
      return environmentId
    },
    getSSESequenceNum() {
      // lastTransportSequenceNum 仅在传输关闭时更新（在交换/onClose 时捕获）。
      // 在正常运行期间，当前传输的活跃序列号不会反映在那里。
      // 合并两者以便调用者（例如 daemon persistState()）获取实际的高水位标记。
      const live = transport?.getLastSequenceNum() ?? 0
      return Math.max(lastTransportSequenceNum, live)
    },
    sessionIngressUrl,
    writeMessages(messages) {
      // 过滤尚未发送的 user/assistant 消息。
      // 两层去重：
      //  - initialMessageUUIDs：作为会话创建事件发送的消息
      //  - recentPostedUUIDs：最近通过 POST 发送的消息
      const filtered = messages.filter(
        (m) =>
          isEligibleWireMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) {
        return
      }

      // 触发 onUserMessage 用于标题派生。在 flushGate 检查之前扫描——
      // 提示值得作为标题，即使它们在初始历史刷新之后排队。
      // 在每个值得作为标题的消息上持续调用，直到回调返回 true；调用者拥有策略。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, currentSessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      // 在初始刷新进行时将消息排队，防止它们与历史消息交错到达服务器。
      if (flushGate.enqueue(...filtered)) {
        logForDebugging(`[bridge:repl] Queued ${filtered.length} message(s) during initial flush`)
        return
      }

      if (!transport) {
        const types = filtered.map((m) => m.type).join(',')
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} message(s) [${types}] for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }

      // 在有界环形缓冲区中跟踪，用于回显过滤和去重。
      for (const msg of filtered) {
        recentPostedUUIDs.add(msg.uuid)
      }

      logForDebugging(`[bridge:repl] Sending ${filtered.length} message(s) via transport`)

      // 转换为 SDK 格式并通过 HTTP POST（HybridTransport）发送。
      // web UI 通过订阅 WebSocket 接收它们。
      const sdkMessages = toSDKMessages(filtered)
      const events = sdkMessages.map((sdkMsg) => ({
        ...sdkMsg,
        session_id: currentSessionId,
      }))
      void transport.writeBatch(events)
    },
    writeSdkMessages(messages) {
      // Daemon 路径：query() 已经产出 WireMessage，跳过转换。
      // 仍然运行回显去重（服务器在 WS 上弹回写入）。
      // 没有 initialMessageUUIDs 过滤——daemon 没有初始消息。
      // 没有 flushGate——daemon 永远不会启动它（没有初始刷新）。
      const filtered = messages.filter((m) => !m.uuid || !recentPostedUUIDs.has(m.uuid))
      if (filtered.length === 0) {
        return
      }
      if (!transport) {
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} SDK message(s) for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }
      for (const msg of filtered) {
        if (msg.uuid) {
          recentPostedUUIDs.add(msg.uuid)
        }
      }
      const events = filtered.map((m) => ({ ...m, session_id: currentSessionId }))
      void transport.writeBatch(events)
    },
    sendControlRequest(request: WireControlRequest) {
      if (!transport) {
        logForDebugging('[bridge:repl] Transport not configured, skipping control_request')
        return
      }
      const event = { ...request, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging(`[bridge:repl] Sent control_request request_id=${request.request_id}`)
    },
    sendControlResponse(response: WireControlResponse) {
      if (!transport) {
        logForDebugging('[bridge:repl] Transport not configured, skipping control_response')
        return
      }
      const event = { ...response, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging('[bridge:repl] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (!transport) {
        logForDebugging('[bridge:repl] Transport not configured, skipping control_cancel_request')
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: currentSessionId,
      }
      void transport.write(event)
      logForDebugging(`[bridge:repl] Sent control_cancel_request request_id=${requestId}`)
    },
    sendResult() {
      if (!transport) {
        logForDebugging(
          `[bridge:repl] sendResult: skipping, transport not configured session=${currentSessionId}`,
        )
        return
      }
      void transport.write(makeResultMessage(currentSessionId))
      logForDebugging(`[bridge:repl] Sent result for session=${currentSessionId}`)
    },
    async teardown() {
      unregister()
      await doTeardownImpl?.()
      logForDebugging('[bridge:repl] Torn down')
      logEvent('zy_bridge_repl_teardown', {})
    },
  }
}

/**
 * 工作项的持久轮询循环。在 bridge 连接的整个生命周期内在后台运行。
 *
 * 当工作项到达时，确认它并调用 onWorkReceived，
 * 传入会话 ID 和 ingress token（用于连接 ingress WebSocket）。
 * 然后继续轮询——如果 ingress WebSocket 断开，服务器会分发新工作项，
 * 实现自动重连而无需拆除 bridge。
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
  api: WireApiClient
  getCredentials: () => { environmentId: string; environmentSecret: string }
  signal: AbortSignal
  onStateChange?: (state: WireState, detail?: string) => void
  onWorkReceived: (
    sessionId: string,
    ingressToken: string,
    workId: string,
    useCodeSessions: boolean,
  ) => void
  /** 环境被删除时调用。返回新凭证或 null。 */
  onEnvironmentLost?: () => Promise<{
    environmentId: string
    environmentSecret: string
  } | null>
  /** 返回当前 WebSocket readyState 标签用于诊断日志。 */
  getWsState?: () => string
  /**
   * 当调用者无法接受新工作时返回 true（传输已连接）。
   * 为 true 时，循环以配置的容量间隔仅作为心跳轮询。
   * 服务器端 BRIDGE_LAST_POLL_TTL 为 4 小时——比这短的任何时间都足以维持活跃。
   */
  isAtCapacity?: () => boolean
  /**
   * 产生一个信号，当容量释放时（传输丢失）中止，
   * 与循环信号合并。用于中断容量睡眠，
   * 使恢复轮询立即开始。
   */
  capacitySignal?: () => CapacitySignal
  /** 在不可恢复的错误（如服务器端过期）时调用以触发完整清理。 */
  onFatalError?: () => void
  /** 轮询间隔配置获取器——默认为 DEFAULT_POLL_CONFIG。 */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * 返回当前工作 ID 和会话 ingress token 用于心跳。
   * 为 null 时，无法进行心跳（没有活跃工作项）。
   */
  getHeartbeatInfo?: () => {
    environmentId: string
    workId: string
    sessionToken: string
  } | null
  /**
   * 当 heartbeatWork 抛出 WireFatalError（401/403/404/410——
   * JWT 过期或工作项消失）时调用。调用者应该销毁传输
   * + 工作状态，使 isAtCapacity() 翻转为 false，循环快速轮询
   * 服务器重新分发的工作项。提供时，循环跳过
   * 容量退避睡眠（否则会导致恢复前约 10 分钟的死窗口）。
   * 省略时，回退到退避睡眠以避免紧密的轮询+心跳循环。
   */
  onHeartbeatFatal?: (err: WireFatalError) => void
}): Promise<void> {
  const MAX_ENVIRONMENT_RECREATIONS = 3

  logForDebugging(`[bridge:repl] Starting work poll loop for env=${getCredentials().environmentId}`)

  let consecutiveErrors = 0
  let firstErrorTime: number | null = null
  let lastPollErrorTime: number | null = null
  let environmentRecreations = 0
  // 当容量睡眠大幅超过其截止时间时设置（进程挂起）。
  // 在下一次迭代顶部消耗以强制一次快速轮询周期——
  // isAtCapacity() 是 `transport !== null`，在传输自动重连期间保持为 true，
  // 否则轮询循环会直接回到 10 分钟睡眠，而传输可能指向已死的 socket。
  let suspensionDetected = false

  while (!signal.aborted) {
    // 在 try 外部捕获凭证，使 catch 块可以检测并发重连是否替换了环境。
    const { environmentId: envId, environmentSecret: envSecret } = getCredentials()
    const pollConfig = getPollIntervalConfig()
    try {
      const work = await api.pollForWork(envId, envSecret, signal, pollConfig.reclaim_older_than_ms)

      // 成功的轮询证明环境确实健康——重置环境丢失计数器，
      // 使间隔数小时的事件各自从头开始。在下方状态变更守卫之外，
      // 因为 onEnvLost 的成功路径已经发出 'ready'；再次发出会是重复的。
      //（onEnvLost 返回凭证不会重置这个——那会在新环境立即死亡时
      // 破坏振荡保护。）
      environmentRecreations = 0

      // 成功轮询时重置错误跟踪
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
        // 读取并清除：检测到挂起后，仅跳过一次容量分支。
        // 上方的 pollForWork 已经刷新了服务器的 BRIDGE_LAST_POLL_TTL；
        // 这个快速周期给任何重新分发的工作项一个机会在我们回到睡眠之前到达。
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
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0 && getHeartbeatInfo) {
            logEvent('zy_bridge_heartbeat_mode_entered', {
              heartbeat_interval_ms: pollConfig.non_exclusive_heartbeat_interval_ms,
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
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) {
                break
              }

              const info = getHeartbeatInfo()
              if (!info) {
                break
              }

              // 在异步心跳调用之前捕获容量信号，以便
              // HTTP 请求期间的传输丢失被随后的睡眠捕获。
              const cap = capacitySignal()

              try {
                await api.heartbeatWork(info.environmentId, info.workId, info.sessionToken)
              } catch (err) {
                logForDebugging(`[bridge:repl:heartbeat] Failed: ${errorMessage(err)}`)
                if (err instanceof WireFatalError) {
                  cap.cleanup()
                  logEvent('zy_bridge_heartbeat_error', {
                    status:
                      err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    error_type: (err.status === 401 || err.status === 403
                      ? 'auth_failed'
                      : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                  // JWT 过期（401/403）或工作项消失（404/410）。
                  // 无论哪种情况，当前传输都已死亡——SSE 重连和 CCR 写入会在
                  // 相同的旧 token 上失败。如果调用者提供了恢复钩子，
                  // 销毁工作状态并跳过退避：isAtCapacity() 翻转为 false，
                  // 下一次外层循环迭代快速轮询服务器重新分发的工作项。
                  // 没有钩子时，退避以避免紧密的轮询+心跳循环。
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
              await sleep(hbConfig.non_exclusive_heartbeat_interval_ms, cap.signal)
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
            logEvent('zy_bridge_heartbeat_mode_exited', {
              reason: exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
            })

            // auth_failed 或 fatal 时，在轮询之前退避以避免紧密的轮询+心跳循环。
            // 回退到下方的共享睡眠——它与旧路径使用相同的 capacitySignal 包装睡眠，
            // 两者都需要挂起超限检查。
            if (!needsBackoff) {
              if (exitReason === 'poll_due') {
                // bridgeApi 限制空轮询日志（EMPTY_POLL_LOG_INTERVAL=100），
                // 使每 10 分钟一次的 poll_due 轮询在 counter=2 时不可见。
                // 在这里记录它，以便验证运行可以在调试日志中看到两个端点。
                logForDebugging(
                  `[bridge:repl] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
                )
              }
              continue
            }
          }
          // 容量睡眠——由旧路径（心跳禁用）和心跳退避路径（needsBackoff=true）
          // 都到达。合并以使挂起检测器覆盖两者；之前退避路径没有超限检查，
          // 在笔记本唤醒后可能直接回到 10 分钟睡眠。启用时使用 atCapMs，
          // 否则使用心跳间隔作为下限（在退避路径上保证 > 0），
          // 使仅心跳配置不会紧密循环。
          const sleepMs = atCapMs > 0 ? atCapMs : pollConfig.non_exclusive_heartbeat_interval_ms
          if (sleepMs > 0) {
            const cap = capacitySignal()
            const sleepStart = Date.now()
            await sleep(sleepMs, cap.signal)
            cap.cleanup()
            // 进程挂起检测器。setTimeout 超过截止时间 60 秒意味着
            // 进程被挂起了（笔记本合盖、SIGSTOP、VM 暂停）——即使是病态的
            // GC 暂停也是秒级，不是分钟级。早期中止（wakePollLoop → cap.signal）
            // 产生 overrun < 0 并跳过。注意：这只能捕获超过截止时间的睡眠；
            // WebSocketTransport 的 ping 间隔（10 秒粒度）是较短挂起的主要检测器。
            // 这是当该检测器未运行时的后备（传输重连中，间隔已停止）。
            const overrun = Date.now() - sleepStart - sleepMs
            if (overrun > 60_000) {
              logForDebugging(
                `[bridge:repl] At-capacity sleep overran by ${Math.round(overrun / 1000)}s — process suspension detected, forcing one fast-poll cycle`,
              )
              logEvent('zy_bridge_repl_suspension_detected', {
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

      // 在类型分发之前解码——需要 JWT 用于显式确认。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        logForDebugging(`[bridge:repl] Failed to decode work secret: ${errorMessage(err)}`)
        logEvent('zy_bridge_repl_work_secret_failed', {})
        // 无法确认（需要我们从解码失败的 JWT）。stopWork 使用 OAuth。
        // 防止 XAUTOCLAIM 每个周期重新分发这个中毒项。
        await api.stopWork(envId, work.id, false).catch(() => {})
        continue
      }

      // 显式确认以防止重新分发。失败时非致命：
      // 服务器会重新分发，onWorkReceived 回调处理去重。
      logForDebugging(`[bridge:repl] Acknowledging workId=${work.id}`)
      try {
        await api.acknowledgeWork(envId, work.id, secret.session_ingress_token)
      } catch (err) {
        logForDebugging(`[bridge:repl] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`)
      }

      if (work.data.type === 'healthcheck') {
        logForDebugging('[bridge:repl] Healthcheck received')
        continue
      }

      if (work.data.type === 'session') {
        const workSessionId = work.data.id
        try {
          validateWireId(workSessionId, 'session_id')
        } catch {
          logForDebugging(`[bridge:repl] Invalid session_id in work: ${workSessionId}`)
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
      if (signal.aborted) {
        break
      }

      // 检测永久的"环境已删除"错误——无论重试多少次都无法恢复。
      // 改为重新注册新环境。
      // 在通用 WireFatalError 退出之前检查。pollForWork 使用
      // validateStatus: s => s < 500，所以 404 总是被 handleErrorStatus()
      // 包装成 WireFatalError——永远不会是 axios 形状的错误。
      // 轮询端点唯一的路径参数是环境 ID；404 明确表示环境消失
      //（没有工作是 200 带 null body）。
      // 服务器发送 error.type='not_found_error'（标准 Anthropic API 形状），
      // 而不是 bridge 特定的字符串——但 status===404 是真正的信号，
      // 能经受 body 形状变化。
      if (err instanceof WireFatalError && err.status === 404 && onEnvironmentLost) {
        // 如果凭证已经被并发重连（例如 WS 关闭处理程序）刷新，
        // 旧轮询的错误是预期的——跳过 onEnvironmentLost 并用新凭证重试。
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
        logEvent('zy_bridge_repl_env_lost', {
          attempt: environmentRecreations,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

        if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
          logForDebugging(
            `[bridge:repl] Environment re-registration limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
          )
          onStateChange?.('failed', 'Environment deleted and re-registration limit reached')
          onFatalError?.()
          break
        }

        onStateChange?.('reconnecting', 'environment lost, recreating session')
        const newCreds = await onEnvironmentLost()
        // doReconnect() 进行多次连续网络调用（1-5 秒）。
        // 如果用户在该窗口内触发了清理，它的内部中止检查返回 false——
        // 但我们在这里需要重新检查，以避免在正常关闭期间发出虚假的
        // 'failed' + onFatalError()。
        if (signal.aborted) {
          break
        }
        if (newCreds) {
          // 凭证通过 reconnectEnvironmentWithSession 在外层作用域更新——
          // getCredentials() 将在下次轮询迭代返回新值。
          // 不要在这里重置 environmentRecreations——onEnvLost 返回凭证
          // 只证明我们尝试修复它，而不是环境是健康的。
          // 成功的轮询（上方）是重置点；如果新环境立即再次死亡，
          // 我们仍然希望限制触发。
          consecutiveErrors = 0
          firstErrorTime = null
          onStateChange?.('ready')
          logForDebugging(`[bridge:repl] Re-registered environment: ${newCreds.environmentId}`)
          continue
        }

        onStateChange?.('failed', 'Environment deleted and re-registration failed')
        onFatalError?.()
        break
      }

      // Fatal errors (401/403/404/410) — no point retrying
      if (err instanceof WireFatalError) {
        const isExpiry = isExpiredErrorType(err.errorType)
        const isSuppressible = isSuppressible403(err)
        logForDebugging(
          `[bridge:repl] Fatal poll error: ${err.message} (status=${err.status}, type=${err.errorType ?? 'unknown'})${isSuppressible ? ' (suppressed)' : ''}`,
        )
        logEvent('zy_bridge_repl_fatal_error', {
          status: err.status,
          error_type: err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(isExpiry ? 'info' : 'error', 'bridge_repl_fatal_error', {
          status: err.status,
          error_type: err.errorType,
        })
        // 装饰性 403 错误（例如 external_poll_sessions scope、
        // environments:manage 权限）——抑制用户可见错误但始终触发清理。
        if (!isSuppressible) {
          onStateChange?.(
            'failed',
            isExpiry ? 'session expired · /remote-control to reconnect' : err.message,
          )
        }
        // 始终触发清理——匹配 bridgeMain.ts，其中 fatalExit=true 是无条件的且循环后清理始终运行。
        onFatalError?.()
        break
      }

      const now = Date.now()

      // 检测系统睡眠/唤醒：如果自上次轮询错误以来的间隔
      // 大大超过最大退避延迟，机器可能睡眠了。
      // 重置错误跟踪，以便我们用新预算重试而不是立即放弃。
      if (lastPollErrorTime !== null && now - lastPollErrorTime > POLL_ERROR_MAX_DELAY_MS * 2) {
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
      logEvent('zy_bridge_repl_poll_error', {
        status: httpStatus,
        consecutiveErrors,
        elapsedMs: elapsed,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

      // 仅在第一次错误时转换到 'reconnecting'——保持在那里直到成功轮询（避免 UI 状态闪烁）。
      if (consecutiveErrors === 1) {
        onStateChange?.('reconnecting', errMsg)
      }

      // 连续失败后放弃
      if (elapsed >= POLL_ERROR_GIVE_UP_MS) {
        logForDebugging(
          `[bridge:repl] Poll failures exceeded ${POLL_ERROR_GIVE_UP_MS / 1000}s (${consecutiveErrors} errors), giving up`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_give_up')
        logEvent('zy_bridge_repl_poll_give_up', {
          consecutiveErrors,
          elapsedMs: elapsed,
          lastStatus: httpStatus,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        onStateChange?.('failed', 'connection to server lost')
        break
      }

      // 指数退避：2s → 4s → 8s → 16s → 32s → 60s（上限）
      const backoff = Math.min(
        POLL_ERROR_INITIAL_DELAY_MS * 2 ** (consecutiveErrors - 1),
        POLL_ERROR_MAX_DELAY_MS,
      )
      // poll_due 心跳循环退出留下了一个健康的租约暴露给这个退避路径。
      // 在每次睡眠之前心跳，以便 /poll 中断（引入 VerifyEnvironmentSecretAuth
      // DB 路径心跳就是为了避免）不会杀死 300 秒租约 TTL。
      if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
        const info = getHeartbeatInfo?.()
        if (info) {
          try {
            await api.heartbeatWork(info.environmentId, info.workId, info.sessionToken)
          } catch {
            // 尽力而为——如果心跳也失败了，租约死亡，与 poll_due 之前的行为相同
            //（那时唯一的心跳循环退出是租约已经在死亡的情况）。
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

// 仅供测试导出
export {
  startWorkPollLoop as _startWorkPollLoopForTesting,
  POLL_ERROR_INITIAL_DELAY_MS as _POLL_ERROR_INITIAL_DELAY_MS_ForTesting,
  POLL_ERROR_MAX_DELAY_MS as _POLL_ERROR_MAX_DELAY_MS_ForTesting,
  POLL_ERROR_GIVE_UP_MS as _POLL_ERROR_GIVE_UP_MS_ForTesting,
}
