import type { StdoutMessage } from 'src/types/wire/control.js'
import { CCRClient } from '../cli/transports/ccrClient.js'
import type { HybridTransport } from '../cli/transports/hybridTransport.js'
import { SSETransport } from '../cli/transports/sseTransport.js'
import { logForDebugging } from '../services/infra/debug.js'
import { errorMessage } from '../utils/errors.js'
import { updateSessionIngressAuthToken } from '../services/auth/sessionIngressAuth.js'
import type { SessionState } from '../services/session-state/sessionState.js'
import { registerWorker } from './workSecret.js'
/**
 * replBridge 的 transport 抽象。只覆盖 replBridge.ts 对 HybridTransport 使用的接口，使 v1/v2
 * 选择局限在构造位置。
 *
 * - v1：HybridTransport（WS 读取 + POST 写入 Session-Ingress）
 * - v2：SSETransport（读取）+ CCRClient（写入 CCR v2 /worker/*）
 *
 * v2 写入路径经过 CCRClient.writeEvent → SerialBatchEventUploader，而不经过
 * SSETransport.write()；后者使用 Session-Ingress POST URL 形式，不适用于 CCR v2。
 */
export type ReplWireTransport = {
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void
  isConnectedStatus(): boolean
  getStateLabel(): string
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  setOnConnect(callback: () => void): void
  connect(): void
  /**
   * 底层读取流事件 sequence number 的高水位。replBridge 在更换 transport 前读取，使新实例从
   * 旧实例停止处恢复；否则服务端会从 seq 0 重放整个会话历史。
   *
   * v1 返回 0；Session-Ingress WS 不使用 SSE sequence number，重连重放由服务端 message cursor
   * 处理。
   */
  getLastSequenceNum(): number
  /**
   * 因 maxConsecutiveFailures 丢弃的批次数量，单调递增。在 writeBatch() 前创建快照并于之后
   * 比较，以检测静默丢弃；即使批次被丢弃，writeBatch() 也会正常完成。v2 返回 0，因为其写入
   * 路径不设置 maxConsecutiveFailures。
   */
  readonly droppedBatchCount: number
  /**
   * PUT /worker 状态，仅 v2 生效，v1 不操作。`requires_action` 告知后端存在待处理权限 prompt，
   * zy.ai 会显示“等待输入”指示器。REPL/daemon 调用方不需要，因为用户在本地观察 REPL；
   * 多会话 worker 调用方需要。
   */
  reportState(state: SessionState): void
  /** PUT /worker external_metadata，仅 v2 生效，v1 不操作。 */
  reportMetadata(metadata: Record<string, unknown>): void
  /**
   * POST /worker/events/{id}/delivery，仅 v2 生效，v1 不操作。填充 CCR 的
   * processing_at/processed_at 列。`received` 由 CCRClient 对每个 SSE 帧自动触发，不在此暴露。
   */
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void
  /**
   * close() 前清空写入队列，仅 v2 生效；v1 立即完成，因为 HybridTransport 的每次 POST 已等待。
   */
  flush(): Promise<void>
}

/**
 * v1 adapter：HybridTransport 已提供完整接口；它继承 WebSocketTransport，后者包含
 * setOnConnect 与 getStateLabel。该 wrapper 不做额外操作，仅用于让 replBridge 的 `transport`
 * 变量拥有统一类型。
 */
export function createV1ReplTransport(hybrid: HybridTransport): ReplWireTransport {
  return {
    write: (msg) => hybrid.write(msg),
    writeBatch: (msgs) => hybrid.writeBatch(msgs),
    close: () => hybrid.close(),
    isConnectedStatus: () => hybrid.isConnectedStatus(),
    getStateLabel: () => hybrid.getStateLabel(),
    setOnData: (cb) => hybrid.setOnData(cb),
    setOnClose: (cb) => hybrid.setOnClose(cb),
    setOnConnect: (cb) => hybrid.setOnConnect(cb),
    connect: () => void hybrid.connect(),
    // v1 Session-Ingress WS 不使用 SSE sequence number，重放语义不同。始终返回 0，使
    // replBridge 的 seq-num 延续逻辑对 v1 不操作。
    getLastSequenceNum: () => 0,
    get droppedBatchCount() {
      return hybrid.droppedBatchCount
    },
    reportState: () => {},
    reportMetadata: () => {},
    reportDelivery: () => {},
    flush: () => Promise.resolve(),
  }
}

/**
 * v2 adapter：包装 SSETransport（读取）与 CCRClient（写入、心跳、状态、投递跟踪）。
 *
 * 认证：v2 端点校验 JWT 的 session_id claim（register_worker.go:32）与 worker role
 *（environment_auth.py:856），OAuth token 两者都不含。这与有意使用 OAuth 的 v1 replBridge
 * 路径相反。轮询循环重新分发任务时刷新 JWT，调用方再用新 token 调用 createV2ReplTransport。
 *
 * 注册在此进行而非调用方，使整个 v2 握手成为一个异步步骤。registerWorker 失败会继续传播，
 * 由 replBridge 捕获并留在轮询循环。
 */
export async function createV2ReplTransport(opts: {
  sessionUrl: string
  ingressToken: string
  sessionId: string
  /**
   * 上一个 transport 的 SSE sequence number 高水位。传给新 SSETransport，使首次 connect()
   * 发送 from_sequence_num / Last-Event-ID，服务端从旧流停止处恢复。否则每次更换 transport
   * 都会要求服务端从 seq 0 重放整个会话历史。
   */
  initialSequenceNum?: number
  /**
   * POST /bridge 响应中的 worker epoch。提供时服务端已递增 epoch，因为 /bridge 调用本身就是注册，
   * 参见服务端 PR #293280。省略时，即 replBridge.ts 轮询循环的 v1 CCR-v2 路径，仍照常调用
   * registerWorker。
   */
  epoch?: number
  /** CCRClient 心跳间隔，省略时默认为 20 秒。 */
  heartbeatIntervalMs?: number
  /** 每次心跳的 ±fraction 随机抖动，省略时默认为 0，即无抖动。 */
  heartbeatJitterFraction?: number
  /**
   * 为 true 时不打开 SSE 读取流，只启用 CCRClient 写入路径。用于 mirror 模式 attachment：转发
   * 事件，但绝不接收入站 prompt 或控制请求。
   */
  outboundOnly?: boolean
  /**
   * 各实例独立的认证标头来源。提供时 CCRClient 与 SSETransport 从此闭包读取认证信息，而非进程级
   * ZY_CODE_SESSION_ACCESS_TOKEN 环境变量。管理多个并发会话的调用方必须提供，因为环境变量
   * 会导致会话互相覆盖。省略时回退到环境变量，适用于单会话调用方。
   */
  getAuthToken?: () => string | undefined
}): Promise<ReplWireTransport> {
  const { sessionUrl, ingressToken, sessionId, initialSequenceNum, getAuthToken } = opts

  // 认证标头 builder。提供 getAuthToken 时从中读取，各实例独立且多会话安全；否则将
  // ingressToken 写入进程级环境变量，沿用旧单会话路径。CCRClient 默认 getAuthHeaders 会通过
  // getSessionIngressAuthHeaders 读取。
  let getAuthHeaders: (() => Record<string, string>) | undefined
  if (getAuthToken) {
    getAuthHeaders = (): Record<string, string> => {
      const token = getAuthToken()
      if (!token) {
        return {}
      }
      return { Authorization: `Bearer ${token}` }
    }
  } else {
    // CCRClient.request() 与 SSETransport.connect() 都通过 getSessionIngressAuthHeaders() 从该
    // 环境变量读取认证信息，因此要在任一方访问网络前设置。
    updateSessionIngressAuthToken(ingressToken)
  }

  const epoch = opts.epoch ?? (await registerWorker(sessionUrl, ingressToken))
  logForDebugging(
    `[bridge:repl] CCR v2: worker sessionId=${sessionId} epoch=${epoch}${opts.epoch !== undefined ? ' (from /bridge)' : ' (via registerWorker)'}`,
  )

  // 推导 SSE 流 URL。逻辑与 transportUtils.ts:26-33 相同，但起点是 http(s) base，而非可能为
  // ws:// 的 --sdk-url。
  const sseUrl = new URL(sessionUrl)
  sseUrl.pathname = `${sseUrl.pathname.replace(/\/$/, '')}/worker/events/stream`

  const sse = new SSETransport(sseUrl, {}, sessionId, undefined, initialSequenceNum, getAuthHeaders)
  let onCloseCb: ((closeCode?: number) => void) | undefined
  const ccr = new CCRClient(sse, new URL(sessionUrl), {
    getAuthHeaders,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatJitterFraction: opts.heartbeatJitterFraction,
    // 默认执行 process.exit(1)，适用于 spawn 模式子进程；在进程内会终止 REPL，因此改为关闭。
    // replBridge 的 onClose 会唤醒轮询循环，取得服务端带新 epoch 的重新分发。
    onEpochMismatch: () => {
      logForDebugging(
        '[bridge:repl] CCR v2: epoch superseded (409) — closing for poll-loop recovery',
      )
      // 在 try 块中关闭资源，确保始终执行 throw。即使 ccr.close() 或 sse.close() 抛错，也必须
      // 展开调用方 request()；否则运行时会违反 handleEpochMismatch 的 `never` 返回类型并继续执行。
      try {
        ccr.close()
        sse.close()
        onCloseCb?.(4090)
      } catch (closeErr: unknown) {
        logForDebugging(
          `[bridge:repl] CCR v2: error during epoch-mismatch cleanup: ${errorMessage(closeErr)}`,
          { level: 'error' },
        )
      }
      // 不要 return；调用方 request() 会在 409 分支后继续，使上层只看到已记录警告与 false 返回。
      // 此处抛错以展开调用，uploader 会将其捕获为发送失败。
      throw new Error('epoch superseded')
    },
  })

  // CCRClient 构造函数已绑定 sse.setOnEvent → reportDelivery('received')。remoteIO.ts 还通过
  // setCommandLifecycleListener 发送 'processing'/'processed'，由进程内 query 循环触发。但此
  // transport 的唯一调用方 replBridge/daemonBridge 没有该绑定；daemon 的 agent 子进程是独立
  // ProcessTransport，其 notifyCommandLifecycle 在自身模块作用域中以 listener=null 触发。因此
  // 事件会永久停在 'received'，reconnectSession 每次 daemon 重启都会重新入队；已观察到
  // 21→24→25 个幽灵 prompt，以“工作期间用户发来新消息”的 system reminder 呈现。
  //
  // 修复：在 'received' 同时立即 ack 'processed'。SSE 接收与写入 transcript 之间的窗口很窄
  //（queue → SDK → 子进程 stdin → model）；此处崩溃最多丢一条 prompt，而旧行为每次重启都会
  // 产生 N 条洪泛。覆盖构造函数绑定以同时完成两者；setOnEvent 会替换而非追加
  //（SSETransport.ts:658）。
  sse.setOnEvent((event) => {
    ccr.reportDelivery(event.event_id, 'received')
    ccr.reportDelivery(event.event_id, 'processed')
  })

  // sse.connect() 与 ccr.initialize() 均延迟到下方 connect()。replBridge 调用顺序是
  // newTransport → setOnConnect → setOnData → setOnClose → connect()，两次调用都需先绑定这些
  // callback：sse.connect() 打开流后事件会立即进入 onData/onClose，ccr.initialize().then()
  // 会触发 onConnectCb。
  //
  // ccr.initialize() 完成后触发 onConnect。写入经 CCRClient HTTP POST
  //（SerialBatchEventUploader）而非 SSE，因此 workerEpoch 设置后写入路径即就绪。
  // SSE.connect() 会等待读取循环，永不正常完成，不能以它作为关卡。SSE 流并行打开，约 30ms，
  // 随后通过 setOnData 投递入站事件；出站无需等待。
  let onConnectCb: (() => void) | undefined
  let ccrInitialized = false
  let closed = false

  return {
    write(msg) {
      return ccr.writeEvent(msg)
    },
    async writeBatch(msgs) {
      // SerialBatchEventUploader 内部已按 maxBatchSize=100 批处理；顺序入队保持次序，并由
      // uploader 合并。每次写入之间检查 closed，避免 transport 因 epoch 不匹配或 SSE 断开而
      // teardown 后继续发送部分批次。
      for (const m of msgs) {
        if (closed) {
          break
        }
        await ccr.writeEvent(m)
      }
    },
    close() {
      closed = true
      ccr.close()
      sse.close()
    },
    isConnectedStatus() {
      // 表示写入就绪而非读取就绪；replBridge 在调用 writeBatch 前检查。SSE 打开状态与此正交。
      return ccrInitialized
    },
    getStateLabel() {
      // SSETransport 不暴露状态字符串，根据可观察信息合成。replBridge 只将其用于 debug 日志。
      if (sse.isClosedStatus()) {
        return 'closed'
      }
      if (sse.isConnectedStatus()) {
        return ccrInitialized ? 'connected' : 'init'
      }
      return 'connecting'
    },
    setOnData(cb) {
      sse.setOnData(cb)
    },
    setOnClose(cb) {
      onCloseCb = cb
      // SSE 重连预算耗尽时触发 onClose(undefined)，映射为 4092，使 ws_closed telemetry 能将其
      // 与 HTTP 状态关闭区分；SSETransport:280 会传入 response.status。通知 replBridge 前停止
      // CCRClient 心跳定时器。sse.close() 不会调用此处，因此上方 epoch 不匹配路径不会重复触发。
      sse.setOnClose((code) => {
        ccr.close()
        cb(code ?? 4092)
      })
    },
    setOnConnect(cb) {
      onConnectCb = cb
    },
    getLastSequenceNum() {
      return sse.getLastSequenceNum()
    },
    // v2 写入路径 CCRClient 不设置 maxConsecutiveFailures，不会因此丢弃。
    droppedBatchCount: 0,
    reportState(state) {
      ccr.reportState(state)
    },
    reportMetadata(metadata) {
      ccr.reportMetadata(metadata)
    },
    reportDelivery(eventId, status) {
      ccr.reportDelivery(eventId, status)
    },
    flush() {
      return ccr.flush()
    },
    connect() {
      // 仅出站：完全跳过 SSE 读取流，不接收入站事件，也不发送投递 ACK。只需要 CCRClient 写入
      // 路径（POST /worker/events）与心跳。
      if (!opts.outboundOnly) {
        // fire-and-forget：SSETransport.connect() 等待 readStream() 读取循环，只在流关闭或出错时
        // 完成。remoteIO.ts 的 spawn 模式路径同样使用 void 丢弃 promise。
        void sse.connect()
      }
      void ccr.initialize(epoch).then(
        () => {
          ccrInitialized = true
          logForDebugging(
            `[bridge:repl] v2 transport ready for writes (epoch=${epoch}, sse=${sse.isConnectedStatus() ? 'open' : 'opening'})`,
          )
          onConnectCb?.()
        },
        (err: unknown) => {
          logForDebugging(`[bridge:repl] CCR v2 initialize failed: ${errorMessage(err)}`, {
            level: 'error',
          })
          // 关闭 transport 资源并通过 onClose 通知 replBridge，使轮询循环能在下次任务分发时重试。
          // 缺少此 callback 时，replBridge 无法得知 transport 初始化失败，会永远停在
          // transport === null。
          ccr.close()
          sse.close()
          onCloseCb?.(4091) // 4091 = init failure, distinguishable from 4090 epoch mismatch
        },
      )
    },
  }
}
