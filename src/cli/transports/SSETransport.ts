import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/types/wire/control.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { errorMessage } from '../../utils/errors.js'
import { getSessionIngressAuthHeaders } from '../../services/auth/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../services/infra/slowOperations.js'
import { getZyCodeUserAgent } from '../../services/http/userAgent.js'
import type { Transport } from './transport.js'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30_000
/** 放弃重连前的尝试时间预算（10 分钟）。 */
const RECONNECT_GIVE_UP_MS = 600_000
/** 服务端每 15 秒发送 keepalive；静默 45 秒后视为连接失效。 */
const LIVENESS_TIMEOUT_MS = 45_000

/**
 * 表示服务端永久拒绝的 HTTP 状态码。transport 会立即转为 'closed'，不再重试。
 */
const PERMANENT_HTTP_CODES = new Set([401, 403, 404])

// POST 重试配置，与 HybridTransport 一致
const POST_MAX_RETRIES = 10
const POST_BASE_DELAY_MS = 500
const POST_MAX_DELAY_MS = 8000

/** 提升到模块级的 TextDecoder 选项，避免 readStream 为每个 chunk 分配对象。 */
const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

/** 提升到模块级的 axios validateStatus callback，避免每次请求分配闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

// ---------------------------------------------------------------------------
// SSE 帧 parser
// ---------------------------------------------------------------------------

type SSEFrame = {
  event?: string
  id?: string
  data?: string
}

/**
 * 从文本缓冲区增量解析 SSE 帧，返回已解析帧与剩余的不完整缓冲区。
 *
 * @internal 为测试导出
 */
export function parseSSEFrames(buffer: string): {
  frames: SSEFrame[]
  remaining: string
} {
  const frames: SSEFrame[] = []
  let pos = 0

  // SSE 帧以连续两个换行符分隔
  let idx: number
  while ((idx = buffer.indexOf('\n\n', pos)) !== -1) {
    const rawFrame = buffer.slice(pos, idx)
    pos = idx + 2

    // 跳过空帧
    if (!rawFrame.trim()) {
      continue
    }

    const frame: SSEFrame = {}
    let isComment = false

    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        // SSE 注释，例如 `:keepalive`
        isComment = true
        continue
      }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) {
        continue
      }

      const field = line.slice(0, colonIdx)
      // 按 SSE 规范，若冒号后有一个前导空格则移除
      const value = line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1)

      switch (field) {
        case 'event':
          frame.event = value
          break
        case 'id':
          frame.id = value
          break
        case 'data':
          // 按 SSE 规范，多行 data: 使用 \n 连接
          frame.data = frame.data ? `${frame.data}\n${value}` : value
          break
        // 忽略 retry: 等其他字段
      }
    }

    // 只发送含 data 的帧，或可重置存活检测的纯注释帧
    if (frame.data || isComment) {
      frames.push(frame)
    }
  }

  return { frames, remaining: buffer.slice(pos) }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type SSETransportState = 'idle' | 'connected' | 'reconnecting' | 'closing' | 'closed'

/**
 * `event: client_event` 帧的 payload，与 session_stream.proto 中 StreamClientEvent proto
 * 消息一致。这是发送给 worker subscriber 的唯一事件类型；delivery_update、session_update、
 * ephemeral_event 与 catch_up_truncated 仅用于 client channel，参见 notifier.go 与
 * event_stream.go 的 SubscriberClient 防护。
 */
export type StreamClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// SSETransport
// ---------------------------------------------------------------------------

/**
 * 使用 SSE 读取、HTTP POST 写入的 transport。
 *
 * 通过 Server-Sent Events 从 CCR v2 事件流端点读取事件，并通过带重试逻辑的 HTTP POST 写入，
 * 与 HybridTransport 的模式相同。
 *
 * 每个 `event: client_event` 帧都在 `data:` 中直接携带 StreamClientEvent proto JSON。
 * transport 提取 `payload`，并以换行分隔 JSON 传给 `onData`，供 StructuredIO 消费。
 *
 * 支持指数退避自动重连，并使用 Last-Event-ID 在断开后恢复。
 */
export class SSETransport implements Transport {
  // @ts-expect-error
  private state: SSETransportState = 'idle'
  private onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onEventCallback?: (event: StreamClientEvent) => void
  private headers: Record<string, string>
  private sessionId?: string
  private refreshHeaders?: () => Record<string, string>
  private readonly getAuthHeaders: () => Record<string, string>

  // SSE 连接状态
  private abortController: AbortController | null = null
  private lastSequenceNum = 0
  private seenSequenceNums = new Set<number>()

  // 重连状态
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  // 存活检测
  private livenessTimer: NodeJS.Timeout | null = null

  // POST URL，由 SSE URL 推导
  private postUrl: string

  // CCR v2 事件格式使用的运行时 epoch

  constructor(
    private readonly url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    initialSequenceNum?: number,
    /**
     * 各实例独立的认证标头来源。省略时读取进程级 ZY_CODE_SESSION_ACCESS_TOKEN，适用于单会话
     * 调用方。并发多会话调用方必须提供；环境变量是进程全局状态，会导致会话互相覆盖。
     */
    getAuthHeaders?: () => Record<string, string>,
  ) {
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.getAuthHeaders = getAuthHeaders ?? getSessionIngressAuthHeaders
    this.postUrl = convertSSEUrlToPostUrl(url)
    // 以调用方提供的高水位为种子，使首次 connect() 发送 from_sequence_num / Last-Event-ID。
    // 否则每个新 SSETransport 都会要求服务端从 sequence 0 重放，即每次更换 transport 都重放
    // 整个会话历史。
    if (initialSequenceNum !== undefined && initialSequenceNum > 0) {
      this.lastSequenceNum = initialSequenceNum
    }
    logForDebugging(`SSETransport: SSE URL = ${url.href}`)
    logForDebugging(`SSETransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_sse_transport_initialized')
  }

  /**
   * 此流已见 sequence number 的高水位。重建 transport 的调用方（如 replBridge
   * onWorkReceived）在 close() 前读取，并作为 `initialSequenceNum` 传给下个实例，使服务端从
   * 正确位置恢复，而非重放所有内容。
   */
  getLastSequenceNum(): number {
    return this.lastSequenceNum
  }

  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(`SSETransport: Cannot connect, current state is ${this.state}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_sse_connect_failed')
      return
    }

    this.state = 'reconnecting'
    const connectStartTime = Date.now()

    // 构建包含 sequence number 的 SSE URL，供恢复使用
    const sseUrl = new URL(this.url.href)
    if (this.lastSequenceNum > 0) {
      sseUrl.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }

    // 构建标头：使用新认证标头，并支持以 Cookie 携带 session key。使用 Cookie 认证时，从
    // this.headers 移除陈旧 Authorization；同时发送二者会干扰认证 interceptor。
    const authHeaders = this.getAuthHeaders()
    const headers: Record<string, string> = {
      ...this.headers,
      ...authHeaders,
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'User-Agent': getZyCodeUserAgent(),
    }
    if (authHeaders.Cookie) {
      delete headers.Authorization
    }
    if (this.lastSequenceNum > 0) {
      headers['Last-Event-ID'] = String(this.lastSequenceNum)
    }

    logForDebugging(`SSETransport: Opening ${sseUrl.href}`)
    logForDiagnosticsNoPII('info', 'cli_sse_connect_opening')

    this.abortController = new AbortController()

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(sseUrl.href, {
        headers,
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const isPermanent = PERMANENT_HTTP_CODES.has(response.status)
        logForDebugging(
          `SSETransport: HTTP ${response.status}${isPermanent ? ' (permanent)' : ''}`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_sse_connect_http_error', {
          status: response.status,
        })

        if (isPermanent) {
          this.state = 'closed'
          this.onCloseCallback?.(response.status)
          return
        }

        this.handleConnectionError()
        return
      }

      if (!response.body) {
        logForDebugging('SSETransport: No response body')
        this.handleConnectionError()
        return
      }

      // 连接成功
      const connectDuration = Date.now() - connectStartTime
      logForDebugging('SSETransport: Connected')
      logForDiagnosticsNoPII('info', 'cli_sse_connect_connected', {
        duration_ms: connectDuration,
      })

      this.state = 'connected'
      this.reconnectAttempts = 0
      this.reconnectStartTime = null
      this.resetLivenessTimer()

      // 读取 SSE 流
      await this.readStream(response.body)
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        // 主动关闭
        return
      }

      logForDebugging(`SSETransport: Connection error: ${errorMessage(error)}`, { level: 'error' })
      logForDiagnosticsNoPII('error', 'cli_sse_connect_error')
      this.handleConnectionError()
    }
  }

  /**
   * 读取并处理 SSE 流响应体。
   */
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, STREAM_DECODE_OPTS)
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          // 任意帧（包括 keepalive 注释）都能证明连接存活
          this.resetLivenessTimer()

          if (frame.id) {
            const seqNum = parseInt(frame.id, 10)
            if (!Number.isNaN(seqNum)) {
              if (this.seenSequenceNums.has(seqNum)) {
                logForDebugging(
                  `SSETransport: DUPLICATE frame seq=${seqNum} (lastSequenceNum=${this.lastSequenceNum}, seenCount=${this.seenSequenceNums.size})`,
                  { level: 'warn' },
                )
                logForDiagnosticsNoPII('warn', 'cli_sse_duplicate_sequence')
              } else {
                this.seenSequenceNums.add(seqNum)
                // 防止无界增长：积累较多项后，清理远低于高水位的旧 sequence number。去重只关心
                // lastSequenceNum 附近的值。
                if (this.seenSequenceNums.size > 1000) {
                  const threshold = this.lastSequenceNum - 200
                  for (const s of this.seenSequenceNums) {
                    if (s < threshold) {
                      this.seenSequenceNums.delete(s)
                    }
                  }
                }
              }
              if (seqNum > this.lastSequenceNum) {
                this.lastSequenceNum = seqNum
              }
            }
          }

          if (frame.event && frame.data) {
            this.handleSSEFrame(frame.event, frame.data)
          } else if (frame.data) {
            // 出现无 event: 的 data:，说明服务端仍在发送旧 envelope 格式或存在 bug。记录日志，
            // 使事故表现为可见信号而非静默丢弃。
            logForDebugging('SSETransport: Frame has data: but no event: field — dropped', {
              level: 'warn',
            })
            logForDiagnosticsNoPII('warn', 'cli_sse_frame_missing_event_field')
          }
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return
      }
      logForDebugging(`SSETransport: Stream read error: ${errorMessage(error)}`, { level: 'error' })
      logForDiagnosticsNoPII('error', 'cli_sse_stream_read_error')
    } finally {
      reader.releaseLock()
    }

    // 流已结束；除非正在关闭，否则重连
    if (this.state !== 'closing' && this.state !== 'closed') {
      logForDebugging('SSETransport: Stream ended, reconnecting')
      this.handleConnectionError()
    }
  }

  /**
   * 处理单个 SSE 帧。event: 字段标识 variant，data: 直接携带内部 proto JSON，不含 envelope。
   *
   * worker subscriber 只接收 client_event 帧，参见 notifier.go；其他事件类型说明服务端发生了
   * CC 尚不理解的变化。记录诊断以便在 telemetry 中发现。
   */
  private handleSSEFrame(eventType: string, data: string): void {
    if (eventType !== 'client_event') {
      logForDebugging(`SSETransport: Unexpected SSE event type '${eventType}' on worker stream`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_sse_unexpected_event_type', {
        event_type: eventType,
      })
      return
    }

    let ev: StreamClientEvent
    try {
      ev = jsonParse(data) as StreamClientEvent
    } catch (error) {
      logForDebugging(`SSETransport: Failed to parse client_event data: ${errorMessage(error)}`, {
        level: 'error',
      })
      return
    }

    const payload = ev.payload
    if (payload && typeof payload === 'object' && 'type' in payload) {
      const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
      logForDebugging(
        `SSETransport: Event seq=${ev.sequence_num} event_id=${ev.event_id} event_type=${ev.event_type} payload_type=${String(payload.type)}${sessionLabel}`,
      )
      logForDiagnosticsNoPII('info', 'cli_sse_message_received')
      // 将解包后的 payload 作为换行分隔 JSON 传递，与 StructuredIO/WebSocketTransport 消费方
      // 预期格式一致
      this.onData?.(`${jsonStringify(payload)}\n`)
    } else {
      logForDebugging(
        `SSETransport: Ignoring client_event with no type in payload: event_id=${ev.event_id}`,
      )
    }

    this.onEventCallback?.(ev)
  }

  /**
   * 在时间预算内以指数退避处理连接错误。
   */
  private handleConnectionError(): void {
    this.clearLivenessTimer()

    if (this.state === 'closing' || this.state === 'closed') {
      return
    }

    // 中止正在进行的 SSE 请求
    this.abortController?.abort()
    this.abortController = null

    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    const elapsed = now - this.reconnectStartTime
    if (elapsed < RECONNECT_GIVE_UP_MS) {
      // 清除已有定时器
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新标头
      if (this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('SSETransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      // 增加 ±25% 随机抖动
      const delay = Math.max(0, baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1))

      logForDebugging(
        `SSETransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `SSETransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'
      this.onCloseCallback?.()
    }
  }

  /**
   * 已绑定的超时 callback。从内联闭包提升出来，避免每帧调用的 resetLivenessTimer 为每个 SSE
   * 帧分配新闭包。
   */
  private readonly onLivenessTimeout = (): void => {
    this.livenessTimer = null
    logForDebugging('SSETransport: Liveness timeout, reconnecting', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_sse_liveness_timeout')
    this.abortController?.abort()
    this.handleConnectionError()
  }

  /**
   * 重置存活定时器。超时时间内未收到 SSE 帧时，视为连接失效并重连。
   */
  private resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  // -----------------------------------------------------------------------
  // 写入（HTTP POST），模式与 HybridTransport 相同
  // -----------------------------------------------------------------------

  async write(message: StdoutMessage): Promise<void> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      logForDebugging('SSETransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_sse_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': getZyCodeUserAgent(),
    }

    logForDebugging(
      `SSETransport: POST body keys=${Object.keys(message as unknown as Record<string, unknown>).join(',')}`,
    )

    for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(this.postUrl, message, {
          headers,
          validateStatus: alwaysValidStatus,
        })

        if (response.status === 200 || response.status === 201) {
          logForDebugging(`SSETransport: POST success type=${message.type}`)
          return
        }

        logForDebugging(
          `SSETransport: POST ${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        // 除 429 外的 4xx 错误均为永久错误，不重试
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          logForDebugging(
            `SSETransport: POST returned ${response.status} (client error), not retrying`,
          )
          logForDiagnosticsNoPII('warn', 'cli_sse_post_client_error', {
            status: response.status,
          })
          return
        }

        // 429 或 5xx 错误需要重试
        logForDebugging(
          `SSETransport: POST returned ${response.status}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retryable_error', {
          status: response.status,
          attempt,
        })
      } catch (error) {
        const axiosError = error as AxiosError
        logForDebugging(
          `SSETransport: POST error: ${axiosError.message}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_network_error', {
          attempt,
        })
      }

      if (attempt === POST_MAX_RETRIES) {
        logForDebugging(`SSETransport: POST failed after ${POST_MAX_RETRIES} attempts, continuing`)
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retries_exhausted')
        return
      }

      const delayMs = Math.min(POST_BASE_DELAY_MS * 2 ** (attempt - 1), POST_MAX_DELAY_MS)
      await sleep(delayMs)
    }
  }

  // -----------------------------------------------------------------------
  // Transport 接口
  // -----------------------------------------------------------------------

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEventCallback = callback
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearLivenessTimer()

    this.state = 'closing'
    this.abortController?.abort()
    this.abortController = null
  }
}

// ---------------------------------------------------------------------------
// URL 转换
// ---------------------------------------------------------------------------

/**
 * 将 SSE URL 转换为 HTTP POST 端点 URL。SSE 流 URL 与 POST URL 共用同一 base，POST 端点位于
 * `/events`，不含 `/stream`。
 *
 * From: https://api.example.com/v2/session_ingress/session/<session_id>/events/stream
 * To:   https://api.example.com/v2/session_ingress/session/<session_id>/events
 */
function convertSSEUrlToPostUrl(sseUrl: URL): string {
  let pathname = sseUrl.pathname
  // 移除 /stream 后缀，得到 POST events 端点
  if (pathname.endsWith('/stream')) {
    pathname = pathname.slice(0, -'/stream'.length)
  }
  return `${sseUrl.protocol}//${sseUrl.host}${pathname}`
}
