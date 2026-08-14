import { randomUUID } from 'node:crypto'
import type { StdoutMessage } from 'src/types/wire/control.js'
import type { WirePartialAssistantMessage } from 'src/types/wire/messages.js'
import { decodeJwtExpiry } from '../../bridge/jwtUtils.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { createAxiosInstance } from '../../services/http/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../services/session-storage/sessionActivity.js'
import {
  getSessionIngressAuthHeaders,
  getSessionIngressAuthToken,
} from '../../services/auth/sessionIngressAuth.js'
import type {
  RequiresActionDetails,
  SessionState,
} from '../../services/session-state/sessionState.js'
import { sleep } from '../../utils/sleep.js'
import { getZyCodeUserAgent } from '../../services/http/userAgent.js'
import { RetryableError, SerialBatchEventUploader } from './serialBatchEventUploader.js'
import type { SSETransport, StreamClientEvent } from './sseTransport.js'
import { WorkerStateUploader } from './workerStateUploader.js'

/** 心跳事件的默认间隔（20 秒；服务端 TTL 为 60 秒）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * stream_event 消息在入队前最多于延迟缓冲区中积累这么多毫秒，与 HybridTransport 的批处理
 * 窗口一致。同一 content block 的 text_delta 事件在每次 flush 时合并为一个截至当前的完整
 * 快照；每个发送事件都自包含，使中途连接的 client 看到完整文本而非片段。
 */
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100

/** 提升到模块级的 axios validateStatus callback，避免每次请求分配闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

export type CCRInitFailReason = 'no_auth_headers' | 'missing_epoch' | 'worker_register_failed'

/** 由 initialize() 抛出，携带供诊断 classifier 使用的类型化原因。 */
export class CCRInitError extends Error {
  constructor(readonly reason: CCRInitFailReason) {
    super(`CCRClient init failed: ${reason}`)
  }
}

/**
 * 使用看似有效的 token 连续收到多少次 401/403 后放弃。JWT 已过期时会直接短路退出，因为结果
 * 确定且重试无效。此阈值用于不确定情况：token 的 exp 尚未到期，但服务端返回 401，例如
 * userauth 故障、KMS 短暂异常或时钟偏差。10 × 20 秒心跳约可容忍 200 秒。
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 10

type EventPayload = {
  uuid: string
  type: string
  [key: string]: unknown
}

type ClientEvent = {
  payload: EventPayload
  ephemeral?: boolean
}

/**
 * 携带 text_delta 的 stream_event 结构子集。它不是 WirePartialAssistantMessage 的缩窄类型；
 * RawMessageStreamEvent 的 delta 是 union，跨两层缩窄会使判别字段失效。
 */
type CoalescedStreamEvent = {
  type: 'stream_event'
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}

/**
 * text_delta 合并所用的累积状态。以 API message ID 为 key，使生命周期绑定到 assistant 消息；
 * 完整 WireAssistantMessage 到达 writeEvent 时清除。即使 abort/error 路径跳过
 * content_block_stop/message_stop 投递，该信号仍可靠。
 */
export type StreamAccumulatorState = {
  /** API message ID（msg_...）→ blocks[blockIndex] → chunk 数组。 */
  byMessage: Map<string, string[][]>
  /**
   * {session_id}:{parent_tool_use_id} → 活跃 message ID。content_block_delta 事件不携带
   * message ID，只有 message_start 携带，因此按 scope 跟踪当前正在流式传输的消息。每个 scope
   * 同时最多传输一条消息。
   */
  scopeToMessage: Map<string, string>
}

export function createStreamAccumulator(): StreamAccumulatorState {
  return { byMessage: new Map(), scopeToMessage: new Map() }
}

function scopeKey(m: { session_id: string; parent_tool_use_id: string | null }): string {
  return `${m.session_id}:${m.parent_tool_use_id ?? ''}`
}

/**
 * 按 content block 将 text_delta stream_event 累积为截至当前的完整快照。每次 flush 对每个有
 * 变化的 block 只发送一个事件，其中包含从 block 开头起的完整累积文本；中途连接的 client
 * 收到自包含快照，而非片段。
 *
 * 非 text_delta 事件原样透传。message_start 记录 scope 的活跃 message ID，
 * content_block_delta 追加 chunk；快照事件复用本次 flush 中该 block 首个 text_delta UUID，
 * 使服务端幂等性在重试间保持稳定。
 *
 * 清理在完整 assistant 消息到达 writeEvent 时进行，这一信号可靠；不依赖此处的 stop 事件，
 * 因为 abort/error 路径会跳过这些事件。
 */
export function accumulateStreamEvents(
  buffer: WirePartialAssistantMessage[],
  state: StreamAccumulatorState,
): EventPayload[] {
  const out: EventPayload[] = []
  // chunks[] → 本次 flush 已放入 `out` 的快照。以 chunks 数组引用为 key；每个
  // {messageId, index} 的引用稳定，因此后续 delta 会重写同一项，而不是每个 delta 都发送事件。
  const touched = new Map<string[], CoalescedStreamEvent>()
  for (const msg of buffer) {
    // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
    switch ((msg.event as any).type) {
      case 'message_start': {
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        const id = (msg.event as any).message.id
        const prevId = state.scopeToMessage.get(scopeKey(msg))
        if (prevId) {
          state.byMessage.delete(prevId)
        }
        state.scopeToMessage.set(scopeKey(msg), id)
        state.byMessage.set(id, [])
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        out.push(msg as any)
        break
      }
      case 'content_block_delta': {
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        if ((msg.event as any).delta.type !== 'text_delta') {
          // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
          out.push(msg as any)
          break
        }
        const messageId = state.scopeToMessage.get(scopeKey(msg))
        const blocks = messageId ? state.byMessage.get(messageId) : undefined
        if (!blocks) {
          // delta 前没有 message_start，可能是流式传输中途重连，或 message_start 位于已丢弃的上个
          // 缓冲区。原样透传；没有此前 chunk 也无法生成截至当前的完整快照。
          // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
          out.push(msg as any)
          break
        }
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        const chunks = (blocks[(msg.event as any).index] ??= [])
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        chunks.push((msg.event as any).delta.text)
        const existing = touched.get(chunks)
        if (existing) {
          existing.event.delta.text = chunks.join('')
          break
        }
        const snapshot: CoalescedStreamEvent = {
          type: 'stream_event',
          uuid: msg.uuid,
          session_id: msg.session_id,
          parent_tool_use_id: msg.parent_tool_use_id,
          event: {
            type: 'content_block_delta',
            // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
            index: (msg.event as any).index,
            delta: { type: 'text_delta', text: chunks.join('') },
          },
        }
        touched.set(chunks, snapshot)
        out.push(snapshot)
        break
      }
      default:
        // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
        out.push(msg as any)
    }
  }
  return out
}

/**
 * 清除已完成 assistant 消息的累积项。WireAssistantMessage 到达时由 writeEvent 调用；这是可靠的
 * 流结束信号，即使 abort/interrupt/error 跳过 SSE stop 事件也会触发。
 */
export function clearStreamAccumulatorForMessage(
  state: StreamAccumulatorState,
  assistant: {
    session_id: string
    parent_tool_use_id: string | null
    message: { id: string }
  },
): void {
  state.byMessage.delete(assistant.message.id)
  const scope = scopeKey(assistant)
  if (state.scopeToMessage.get(scope) === assistant.message.id) {
    state.scopeToMessage.delete(scope)
  }
}

type RequestResult = { ok: true } | { ok: false; retryAfterMs?: number }

type WorkerEvent = {
  payload: EventPayload
  is_compaction?: boolean
  agent_id?: string
}

export type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}

type ListInternalEventsResponse = {
  data: InternalEvent[]
  next_cursor?: string
}

type WorkerStateResponse = {
  worker?: {
    external_metadata?: Record<string, unknown>
  }
}

/**
 * 管理 CCR v2 worker 生命周期协议：
 * - Epoch 管理：从 ZY_CODE_WORKER_EPOCH 环境变量读取 worker_epoch
 * - 运行时状态报告：PUT /sessions/{id}/worker
 * - 心跳：POST /sessions/{id}/worker/heartbeat，用于存活检测
 *
 * 所有写入都经由 this.request()。
 */
export class CCRClient {
  private workerEpoch = 0
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatJitterFraction: number
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private closed = false
  private consecutiveAuthFailures = 0
  private currentState: SessionState | null = null
  private readonly sessionBaseUrl: string
  private readonly sessionId: string
  private readonly http = createAxiosInstance({ keepAlive: true })

  // stream_event 延迟缓冲区：入队前最多积累 STREAM_EVENT_FLUSH_INTERVAL_MS 的 content delta，
  // 以减少 POST 数量并支持 text_delta 合并。做法与 HybridTransport 一致。
  private streamEventBuffer: WirePartialAssistantMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null
  // 截至当前的完整文本累积器。跨 flush 保留，使每个 text_delta 事件都携带从 block 开头起的
  // 完整文本，中途重连也能看到自包含快照。以 API message ID 为 key，完整 assistant 消息到达
  // writeEvent 时清除。
  private streamTextAccumulator = createStreamAccumulator()

  private readonly workerState: WorkerStateUploader
  private readonly eventUploader: SerialBatchEventUploader<ClientEvent>
  private readonly internalEventUploader: SerialBatchEventUploader<WorkerEvent>
  private readonly deliveryUploader: SerialBatchEventUploader<{
    eventId: string
    status: 'received' | 'processing' | 'processed'
  }>

  /**
   * 服务端返回 409（更新的 worker epoch 已取代当前实例）时调用。默认执行 process.exit(1)，
   * 适用于由父 bridge 重新启动的 spawn 模式子进程。进程内调用方 replBridge 必须覆盖为优雅
   * 关闭，否则 exit 会终止用户的 REPL。
   */
  private readonly onEpochMismatch: () => never

  /**
   * 认证标头来源。默认为进程级 session-ingress token，即 ZY_CODE_SESSION_ACCESS_TOKEN 环境
   * 变量。管理多个并发会话且各自使用不同 JWT 的调用方必须注入此值；环境变量是进程全局状态，
   * 会导致会话互相覆盖。
   */
  private readonly getAuthHeaders: () => Record<string, string>

  constructor(
    transport: SSETransport,
    sessionUrl: URL,
    opts?: {
      onEpochMismatch?: () => never
      heartbeatIntervalMs?: number
      heartbeatJitterFraction?: number
      /**
       * 各实例独立的认证标头来源。省略时读取进程级 ZY_CODE_SESSION_ACCESS_TOKEN，适用于 REPL、
       * daemon 等单会话调用方。并发多会话调用方必须提供。
       */
      getAuthHeaders?: () => Record<string, string>
    },
  ) {
    this.onEpochMismatch =
      opts?.onEpochMismatch ??
      (() => {
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      })
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatJitterFraction = opts?.heartbeatJitterFraction ?? 0
    this.getAuthHeaders = opts?.getAuthHeaders ?? getSessionIngressAuthHeaders
    // 会话 URL：https://host/v1/code/sessions/{id}
    if (sessionUrl.protocol !== 'http:' && sessionUrl.protocol !== 'https:') {
      throw new Error(`CCRClient: Expected http(s) URL, got ${sessionUrl.protocol}`)
    }
    const pathname = sessionUrl.pathname.replace(/\/$/, '')
    this.sessionBaseUrl = `${sessionUrl.protocol}//${sessionUrl.host}${pathname}`
    // 从 URL 路径最后一段提取 session ID
    this.sessionId = pathname.split('/').pop() || ''

    this.workerState = new WorkerStateUploader({
      send: (body) =>
        this.request(
          'put',
          '/worker',
          { worker_epoch: this.workerEpoch, ...body },
          'PUT worker',
        ).then((r) => r.ok),
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.eventUploader = new SerialBatchEventUploader<ClientEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      // flushStreamEventBuffer() 一次将完整 100ms 窗口内累积的 stream_event 入队。若混合 delta
      // 突发无法合并为单个快照，可能超过旧上限 50，并在 SerialBatchEventUploader 背压检查处
      // 死锁。改为与 HybridTransport 相同的上限，足够高且只受内存约束。
      maxQueueSize: 100_000,
      send: async (batch) => {
        const result = await this.request(
          'post',
          '/worker/events',
          { worker_epoch: this.workerEpoch, events: batch },
          'client events',
        )
        if (!result.ok) {
          // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
          throw new RetryableError('client event POST failed', (result as any).retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.internalEventUploader = new SerialBatchEventUploader<WorkerEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 200,
      send: async (batch) => {
        const result = await this.request(
          'post',
          '/worker/internal-events',
          { worker_epoch: this.workerEpoch, events: batch },
          'internal events',
        )
        if (!result.ok) {
          // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
          throw new RetryableError('internal event POST failed', (result as any).retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.deliveryUploader = new SerialBatchEventUploader<{
      eventId: string
      status: 'received' | 'processing' | 'processed'
    }>({
      maxBatchSize: 64,
      maxQueueSize: 64,
      send: async (batch) => {
        const result = await this.request(
          'post',
          '/worker/events/delivery',
          {
            worker_epoch: this.workerEpoch,
            updates: batch.map((d) => ({
              event_id: d.eventId,
              status: d.status,
            })),
          },
          'delivery batch',
        )
        if (!result.ok) {
          // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
          throw new RetryableError('delivery POST failed', (result as any).retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    // 对每个收到的 client_event 发送 ack，使 CCR 能跟踪投递状态。在此绑定而非 initialize()，
    // 确保 new CCRClient() 返回时 callback 已注册；remoteIO 随后应能立即调用 transport.connect()，
    // 不会让首个 SSE 追赶帧与尚未绑定的 onEventCallback 竞争。
    transport.setOnEvent((event: StreamClientEvent) => {
      this.reportDelivery(event.event_id, 'received')
    })
  }

  /**
   * 初始化会话 worker：
   * 1. 从参数读取 worker_epoch，缺失时回退到 env-manager / bridge spawner 设置的
   *    ZY_CODE_WORKER_EPOCH
   * 2. 将状态报告为 'idle'
   * 3. 启动心跳定时器
   *
   * 进程内调用方 replBridge 直接传入 epoch；它们自行注册 worker，不存在设置环境变量的父进程。
   */
  async initialize(epoch?: number): Promise<Record<string, unknown> | null> {
    const startMs = Date.now()
    if (Object.keys(this.getAuthHeaders()).length === 0) {
      throw new CCRInitError('no_auth_headers')
    }
    if (epoch === undefined) {
      const rawEpoch = process.env.ZY_CODE_WORKER_EPOCH
      epoch = rawEpoch ? parseInt(rawEpoch, 10) : NaN
    }
    if (Number.isNaN(epoch)) {
      throw new CCRInitError('missing_epoch')
    }
    this.workerEpoch = epoch

    // 与初始化 PUT 并发执行，二者互不依赖。
    const restoredPromise = this.getWorkerState()

    const result = await this.request(
      'put',
      '/worker',
      {
        worker_status: 'idle',
        worker_epoch: this.workerEpoch,
        // 清除上一个 worker 崩溃遗留的 pending_action/task_summary；会话内清除操作无法跨进程重启保留。
        external_metadata: {
          pending_action: null,
          task_summary: null,
        },
      },
      'PUT worker (init)',
    )
    if (!result.ok) {
      // 收到 409 时 onEpochMismatch 可能抛错，但 request() 会捕获并返回 false。若不检查，仍会
      // 继续 startHeartbeat()，针对失效 epoch 泄漏一个 20 秒定时器。此处抛错，使 connect() 的
      // rejection handler 触发而非成功路径。
      throw new CCRInitError('worker_register_failed')
    }
    this.currentState = 'idle'
    this.startHeartbeat()

    // API 调用或 tool 进行期间，sessionActivity 的 refcount 控制定时器会触发；若不写入，容器
    // lease 可能在等待中途过期。v1 在 WebSocketTransport 中按连接绑定此逻辑。
    registerSessionActivityCallback(() => {
      void this.writeEvent({ type: 'keep_alive' })
    })

    logForDebugging(`CCRClient: initialized, epoch=${this.workerEpoch}`)
    logForDiagnosticsNoPII('info', 'cli_worker_lifecycle_initialized', {
      epoch: this.workerEpoch,
      duration_ms: Date.now() - startMs,
    })

    // PUT 成功后在此等待并发 GET，并记录 state_restored。此前在 getWorkerState() 内记录存在竞争：
    // 若 GET 在 PUT 失败前完成，同一会话的诊断会同时出现 init_failed 与 state_restored。
    const { metadata, durationMs } = await restoredPromise
    if (!this.closed) {
      logForDiagnosticsNoPII('info', 'cli_worker_state_restored', {
        duration_ms: durationMs,
        had_state: metadata !== null,
      })
    }
    return metadata
  }

  // control_request 会标记为已处理，重启后不再投递，因此需读回上一个 worker 写入的内容。
  private async getWorkerState(): Promise<{
    metadata: Record<string, unknown> | null
    durationMs: number
  }> {
    const startMs = Date.now()
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return { metadata: null, durationMs: 0 }
    }
    const data = await this.getWithRetry<WorkerStateResponse>(
      `${this.sessionBaseUrl}/worker`,
      authHeaders,
      'worker_state',
    )
    return {
      metadata: data?.worker?.external_metadata ?? null,
      durationMs: Date.now() - startMs,
    }
  }

  /**
   * 向 CCR 发送经过认证的 HTTP 请求，处理认证标头、409 epoch 不匹配与错误日志。2xx 时返回
   * { ok: true }。429 时读取以整数秒表示的 Retry-After，使 uploader 遵守服务端退避提示，
   * 而非盲目指数增长。
   */
  private async request(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    label: string,
    { timeout = 10_000 }: { timeout?: number } = {},
  ): Promise<RequestResult> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return { ok: false }
    }

    try {
      const response = await this.http[method](`${this.sessionBaseUrl}${path}`, body, {
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': getZyCodeUserAgent(),
        },
        validateStatus: alwaysValidStatus,
        timeout,
      })

      if (response.status >= 200 && response.status < 300) {
        this.consecutiveAuthFailures = 0
        return { ok: true }
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      if (response.status === 401 || response.status === 403) {
        // JWT 已过期时收到 401 是确定性结果，重试永远不会成功。在阈值循环消耗实际时间前检查
        // token 自身的 exp。
        const tok = getSessionIngressAuthToken()
        const exp = tok ? decodeJwtExpiry(tok) : null
        if (exp !== null && exp * 1000 < Date.now()) {
          logForDebugging(
            `CCRClient: session_token expired (exp=${new Date(exp * 1000).toISOString()}) — no refresh was delivered, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_token_expired_no_refresh')
          this.onEpochMismatch()
        }
        // token 看似有效但服务端返回 401，可能是服务端短暂故障（userauth 不可用、KMS 异常）。
        // 计入阈值。
        this.consecutiveAuthFailures++
        if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          logForDebugging(
            `CCRClient: ${this.consecutiveAuthFailures} consecutive auth failures with a valid-looking token — server-side auth unrecoverable, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_auth_failures_exhausted')
          this.onEpochMismatch()
        }
      }
      logForDebugging(`CCRClient: ${label} returned ${response.status}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_failed', {
        method,
        path,
        status: response.status,
      })
      if (response.status === 429) {
        const raw = response.headers?.['retry-after']
        const seconds = typeof raw === 'string' ? parseInt(raw, 10) : NaN
        if (!Number.isNaN(seconds) && seconds >= 0) {
          return { ok: false, retryAfterMs: seconds * 1000 }
        }
      }
      return { ok: false }
    } catch (error) {
      logForDebugging(`CCRClient: ${label} failed: ${errorMessage(error)}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_error', {
        method,
        path,
        error_code: getErrnoCode(error),
      })
      return { ok: false }
    }
  }

  /** 通过 PUT /sessions/{id}/worker 向 CCR 报告 worker 状态。 */
  reportState(state: SessionState, details?: RequiresActionDetails): void {
    if (state === this.currentState && !details) {
      return
    }
    this.currentState = state
    this.workerState.enqueue({
      worker_status: state,
      requires_action_details: details
        ? {
            tool_name: details.tool_name,
            action_description: details.action_description,
            request_id: details.request_id,
          }
        : null,
    })
  }

  /** 通过 PUT /worker 向 CCR 报告外部 metadata。 */
  reportMetadata(metadata: Record<string, unknown>): void {
    this.workerState.enqueue({ external_metadata: metadata })
  }

  /**
   * 处理 epoch 不匹配（409 Conflict）。更新的 CC 实例已取代当前实例，应立即退出。
   */
  private handleEpochMismatch(): never {
    logForDebugging('CCRClient: Epoch mismatch (409), shutting down', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_worker_epoch_mismatch')
    this.onEpochMismatch()
  }

  /** 启动定期心跳。 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const schedule = (): void => {
      const jitter =
        this.heartbeatIntervalMs * this.heartbeatJitterFraction * (2 * Math.random() - 1)
      this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs + jitter)
    }
    let tick!: () => void
    tick = (): void => {
      void this.sendHeartbeat()
      // stopHeartbeat 会清空定时器；在 fire-and-forget 发送后、重新调度前检查，使
      // sendHeartbeat 期间调用的 close() 能生效。
      if (this.heartbeatTimer === null) {
        return
      }
      schedule()
    }
    schedule()
  }

  /** 停止心跳定时器。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 通过 POST /sessions/{id}/worker/heartbeat 发送心跳。 */
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) {
      return
    }
    this.heartbeatInFlight = true
    try {
      const result = await this.request(
        'post',
        '/worker/heartbeat',
        { session_id: this.sessionId, worker_epoch: this.workerEpoch },
        'Heartbeat',
        { timeout: 5_000 },
      )
      if (result.ok) {
        logForDebugging('CCRClient: Heartbeat sent')
      }
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /**
   * 通过 POST /sessions/{id}/worker/events 将 StdoutMessage 写为 client 事件。这些事件可由前端
   * client 通过 SSE 流看到。缺少 UUID 时自动注入，确保重试时服务端幂等。
   *
   * stream_event 消息会在 100ms 延迟缓冲区中保留并累积；同一 content block 的 text_delta
   * 每次 flush 发送截至当前的完整快照。写入非 stream_event 前先 flush 缓冲区，以保持下游顺序。
   */
  async writeEvent(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => void this.flushStreamEventBuffer(),
          STREAM_EVENT_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    await this.flushStreamEventBuffer()
    if (message.type === 'assistant') {
      // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
      clearStreamAccumulatorForMessage(this.streamTextAccumulator, message as any)
    }
    await this.eventUploader.enqueue(this.toClientEvent(message))
  }

  /** 将 StdoutMessage 包装为 ClientEvent，缺少 UUID 时自动注入。 */
  private toClientEvent(message: StdoutMessage): ClientEvent {
    const msg = message as unknown as Record<string, unknown>
    return {
      payload: {
        ...msg,
        uuid: typeof msg.uuid === 'string' ? msg.uuid : randomUUID(),
      } as EventPayload,
    }
  }

  /**
   * 清空 stream_event 延迟缓冲区：将 text_delta 累积为截至当前的完整快照，清除定时器，并将
   * 结果事件入队。由定时器、writeEvent 写入非流消息时以及 flush() 调用。close() 会丢弃
   * 缓冲区；若需要保证投递，请先调用 flush()。
   */
  private async flushStreamEventBuffer(): Promise<void> {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    if (this.streamEventBuffer.length === 0) {
      return
    }
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    const payloads = accumulateStreamEvents(buffered, this.streamTextAccumulator)
    await this.eventUploader.enqueue(payloads.map((payload) => ({ payload, ephemeral: true })))
  }

  /**
   * 通过 POST /sessions/{id}/worker/internal-events 写入 worker 内部事件。这些事件对前端 client
   * 不可见，用于保存恢复会话所需的 worker 内部状态，如 transcript 消息与 compaction 标记。
   */
  async writeInternalEvent(
    eventType: string,
    payload: Record<string, unknown>,
    {
      isCompaction = false,
      agentId,
    }: {
      isCompaction?: boolean
      agentId?: string
    } = {},
  ): Promise<void> {
    const event: WorkerEvent = {
      payload: {
        type: eventType,
        ...payload,
        uuid: typeof payload.uuid === 'string' ? payload.uuid : randomUUID(),
      } as EventPayload,
      ...(isCompaction && { is_compaction: true }),
      ...(agentId && { agent_id: agentId }),
    }
    await this.internalEventUploader.enqueue(event)
  }

  /**
   * flush 待处理的内部事件。在 turn 之间及关停时调用，确保 transcript 项持久化。
   */
  flushInternalEvents(): Promise<void> {
    return this.internalEventUploader.flush()
  }

  /**
   * flush 待处理的 client 事件，即 writeEvent 队列。调用方需要投递确认时应在 close() 前调用，
   * 因为 close() 会放弃队列。uploader 清空或拒绝后完成；无论单次 POST 是否成功都会返回，
   * 若结果重要需另行检查服务端状态。
   */
  async flush(): Promise<void> {
    await this.flushStreamEventBuffer()
    return this.eventUploader.flush()
  }

  /**
   * 通过 GET /sessions/{id}/worker/internal-events 读取前台 agent 内部事件。返回上个
   * compaction 边界后的 transcript 项，失败时返回 null。用于恢复会话。
   */
  async readInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet('/worker/internal-events', {}, 'internal_events')
  }

  /**
   * 通过 GET /sessions/{id}/worker/internal-events?subagents=true 读取所有子代理内部事件。
   * 返回所有非前台 agent 自各自 compaction 点起的合并流。用于恢复会话。
   */
  async readSubagentInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet('/worker/internal-events', { subagents: 'true' }, 'subagent_events')
  }

  /**
   * 带重试的分页 GET。从列表端点获取所有页，每页失败时以指数退避与随机抖动重试。
   */
  private async paginatedGet(
    path: string,
    params: Record<string, string>,
    context: string,
  ): Promise<InternalEvent[] | null> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return null
    }

    const allEvents: InternalEvent[] = []
    let cursor: string | undefined

    do {
      const url = new URL(`${this.sessionBaseUrl}${path}`)
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }

      const page = await this.getWithRetry<ListInternalEventsResponse>(
        url.toString(),
        authHeaders,
        context,
      )
      if (!page) {
        return null
      }

      allEvents.push(...(page.data ?? []))
      cursor = page.next_cursor
    } while (cursor)

    logForDebugging(
      `CCRClient: Read ${allEvents.length} internal events from ${path}${params.subagents ? ' (subagents)' : ''}`,
    )
    return allEvents
  }

  /**
   * 带重试的单次 GET 请求。成功时返回解析后的响应体，重试全部耗尽时返回 null。
   */
  private async getWithRetry<T>(
    url: string,
    authHeaders: Record<string, string>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      let response
      try {
        response = await this.http.get<T>(url, {
          headers: {
            ...authHeaders,
            'anthropic-version': '2023-06-01',
            'User-Agent': getZyCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout: 30_000,
        })
      } catch (error) {
        logForDebugging(
          `CCRClient: GET ${url} failed (attempt ${attempt}/10): ${errorMessage(error)}`,
          { level: 'warn' },
        )
        if (attempt < 10) {
          const delay = Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
          await sleep(delay)
        }
        continue
      }

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      logForDebugging(`CCRClient: GET ${url} returned ${response.status} (attempt ${attempt}/10)`, {
        level: 'warn',
      })

      if (attempt < 10) {
        const delay = Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
        await sleep(delay)
      }
    }

    logForDebugging('CCRClient: GET retries exhausted', { level: 'error' })
    logForDiagnosticsNoPII('error', 'cli_worker_get_retries_exhausted', {
      context,
    })
    return null
  }

  /**
   * 报告 client 到 worker 事件的投递状态。
   * POST /v1/code/sessions/{id}/worker/events/delivery（批量端点）
   */
  reportDelivery(eventId: string, status: 'received' | 'processing' | 'processed'): void {
    void this.deliveryUploader.enqueue({ eventId, status })
  }

  /** 获取当前 epoch，供外部使用。 */
  getWorkerEpoch(): number {
    return this.workerEpoch
  }

  /** 内部事件队列深度，作为关停快照的背压信号。 */
  get internalEventsPending(): number {
    return this.internalEventUploader.pendingCount
  }

  /**
   * 内存优化：仅清理 stream 相关的临时状态（buffer + accumulator + timer），
   * 不关闭底层连接和 uploader。供 abort/中断路径调用，避免长时未完成的
   * stream（异常断流、模型 503、abortController 触发）在 accumulator 中
   * 留下永远等不到 finalize 的孤儿条目。
   */
  clearStreamState(): void {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    this.streamTextAccumulator.byMessage.clear()
    this.streamTextAccumulator.scopeToMessage.clear()
  }

  /** 清理 uploader 与定时器。 */
  close(): void {
    this.closed = true
    this.stopHeartbeat()
    unregisterSessionActivityCallback()
    // 复用 clearStreamState：close 前必须释放 buffer/accumulator 引用，
    // 否则 uploader.close() 异步收尾期间这些对象仍被强引用。
    this.clearStreamState()
    this.workerState.close()
    this.eventUploader.close()
    this.internalEventUploader.close()
    this.deliveryUploader.close()
  }
}
