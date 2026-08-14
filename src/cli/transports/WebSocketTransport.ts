import type { StdoutMessage } from 'src/types/wire/control.js'
import type WsWebSocket from 'ws'
import { logEvent } from '../../services/analytics/index.js'
import { CircularBuffer } from '../../utils/circularBuffer.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { getWebSocketTLSOptions } from '../../services/http/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../../services/http/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../services/session-storage/sessionActivity.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import type { Transport } from './transport.js'

const KEEP_ALIVE_FRAME = '{"type":"keep_alive"}\n'

const DEFAULT_MAX_BUFFER_SIZE = 1000
const DEFAULT_BASE_RECONNECT_DELAY = 1000
const DEFAULT_MAX_RECONNECT_DELAY = 30000
/** 放弃重连前的尝试时间预算（10 分钟）。 */
const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000
const DEFAULT_PING_INTERVAL = 10000
const DEFAULT_KEEPALIVE_INTERVAL = 300_000 // 5 分钟

/**
 * 检测系统休眠与唤醒的阈值。若连续两次重连尝试的间隔超过此值，说明机器可能进入过休眠。
 * 此时重置重连预算并重试；若会话已在休眠期间被回收，服务端会返回永久关闭码（4001/1002）。
 */
const SLEEP_DETECTION_THRESHOLD_MS = DEFAULT_MAX_RECONNECT_DELAY * 2 // 60s

/**
 * 表示服务端永久拒绝连接的 WebSocket 关闭码。
 * transport 会立即转为 'closed'，不再重试。
 */
const PERMANENT_CLOSE_CODES = new Set([
  1002, // 协议错误：服务端拒绝握手，例如会话已被回收
  4001, // 会话已过期或不存在
  4003, // 未授权
])

export type WebSocketTransportOptions = {
  /** 为 false 时，transport 断开后不会自动重连。调用方具备自身恢复机制（例如 REPL bridge
   *  轮询循环）时使用。默认为 true。 */
  autoReconnect?: boolean
  /** 控制是否发送 zy_ws_transport_* telemetry 事件。在 REPL bridge 构造处设为 true，
   *  使其仅由 Remote Control 会话（受 Cloudflare 空闲超时影响的群体）发送；print 模式的
   *  worker 不发送。默认为 false。 */
  isBridge?: boolean
}

type WebSocketTransportState = 'idle' | 'connected' | 'reconnecting' | 'closing' | 'closed'

// globalThis.WebSocket 与 ws.WebSocket 的公共接口
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void // Bun 与 ws 均支持
}

export class WebSocketTransport implements Transport {
  private ws: WebSocketLike | null = null
  private lastSentId: string | null = null
  protected url: URL
  // @ts-expect-error
  protected state: WebSocketTransportState = 'idle'
  protected onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onConnectCallback?: () => void
  private headers: Record<string, string>
  private sessionId?: string
  private autoReconnect: boolean
  private isBridge: boolean

  // 重连状态
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastReconnectAttemptTime: number | null = null
  // 最近一次 WS 数据帧活动（收到消息或调用 ws.send）的墙上时钟时间。用于计算关闭时的
  // 空闲时长，以诊断代理空闲超时导致的 RST（例如 Cloudflare 的 5 分钟限制）。不计入
  // ping/pong 控制帧，因为代理不会将它们视为活动。
  private lastActivityTime = 0

  // 用于连接健康检查的 ping 定时器
  private pingInterval: NodeJS.Timeout | null = null
  private pongReceived = true

  // 定期发送 keep_alive 数据帧，以重置代理的空闲计时器
  private keepAliveInterval: NodeJS.Timeout | null = null

  // 缓冲消息，供重连时重放
  private messageBuffer: CircularBuffer<StdoutMessage>
  // 记录当前使用哪个运行时的 WS，以便通过对应 API（removeEventListener 或 off）移除 listener。
  private isBunWs = false

  // 在 connect() 时记录，供 handleOpenEvent 计算耗时。保存为实例字段后，onOpen handler
  // 可使用稳定的类属性箭头函数并由 doDisconnect 移除，而不必闭包捕获局部变量。
  private connectStartTime = 0

  private refreshHeaders?: () => Record<string, string>

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions,
  ) {
    this.url = url
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.autoReconnect = options?.autoReconnect ?? true
    this.isBridge = options?.isBridge ?? false
    this.messageBuffer = new CircularBuffer(DEFAULT_MAX_BUFFER_SIZE)
  }

  public async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(`WebSocketTransport: Cannot connect, current state is ${this.state}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_failed')
      return
    }
    this.state = 'reconnecting'

    this.connectStartTime = Date.now()
    logForDebugging(`WebSocketTransport: Opening ${this.url.href}`)
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_opening')

    // 以传入的标头为基础，再补充运行时标头
    const headers = { ...this.headers }
    if (this.lastSentId) {
      headers['X-Last-Request-Id'] = this.lastSentId
      logForDebugging(`WebSocketTransport: Adding X-Last-Request-Id header: ${this.lastSentId}`)
    }

    if (typeof Bun !== 'undefined') {
      // Bun 的 WebSocket 支持 headers/proxy 选项，但 DOM 类型未声明
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const ws = new globalThis.WebSocket(this.url.href, {
        headers,
        proxy: getWebSocketProxyUrl(this.url.href),
        tls: getWebSocketTLSOptions() || undefined,
      } as unknown as string[])
      this.ws = ws
      this.isBunWs = true

      ws.addEventListener('open', this.onBunOpen)
      ws.addEventListener('message', this.onBunMessage)
      ws.addEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ws.addEventListener('close', this.onBunClose)
      // 'pong' 是 Bun 专有事件，不在 DOM 类型中
      ws.addEventListener('pong', this.onPong)
    } else {
      const { default: WS } = await import('ws')
      const ws = new WS(this.url.href, {
        headers,
        agent: getWebSocketProxyAgent(this.url.href),
        ...getWebSocketTLSOptions(),
      })
      this.ws = ws
      this.isBunWs = false

      ws.on('open', this.onNodeOpen)
      ws.on('message', this.onNodeMessage)
      ws.on('error', this.onNodeError)
      ws.on('close', this.onNodeClose)
      ws.on('pong', this.onPong)
    }
  }

  // --- Bun（原生 WebSocket）事件 handler ---
  // 以类属性箭头函数保存，使 doDisconnect() 能将其移除。若不移除，每次重连都会遗留旧 WS
  // 对象及其 5 个闭包，直到 GC 才释放，在网络不稳定时会不断累积。做法与
  // src/utils/mcpWebSocketTransport.ts 一致。

  private onBunOpen = () => {
    this.handleOpenEvent()
    // Bun 的 WebSocket 不暴露升级响应标头，因此重放所有缓冲消息，由服务端按 UUID 去重。
    if (this.lastSentId) {
      this.replayBufferedMessages('')
    }
  }

  private onBunMessage = (event: MessageEvent) => {
    const message = typeof event.data === 'string' ? event.data : String(event.data)
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onBunError = () => {
    logForDebugging('WebSocketTransport: Error', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // error 后还会触发 close 事件，由后者调用 handleConnectionError
  }

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private onBunClose = (event: CloseEvent) => {
    const isClean = event.code === 1000 || event.code === 1001
    logForDebugging(
      `WebSocketTransport: Closed: ${event.code}`,
      isClean ? undefined : { level: 'error' },
    )
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(event.code)
  }

  // --- Node（ws 包）事件 handler ---

  private onNodeOpen = () => {
    // 在 handleOpenEvent() 调用 onConnectCallback 前保存 ws；若回调同步关闭 transport，
    // this.ws 会变为 null。旧版内联闭包通过捕获变量隐式具备此保障。
    const ws = this.ws
    this.handleOpenEvent()
    if (!ws) {
      return
    }
    // 检查升级响应标头中的 last-id（仅 ws 包支持）
    const nws = ws as unknown as WsWebSocket & {
      upgradeReq?: { headers?: Record<string, string> }
    }
    const upgradeResponse = nws.upgradeReq
    if (upgradeResponse?.headers?.['x-last-request-id']) {
      const serverLastId = upgradeResponse.headers['x-last-request-id']
      this.replayBufferedMessages(serverLastId)
    }
  }

  private onNodeMessage = (data: Buffer) => {
    const message = data.toString()
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onNodeError = (err: Error) => {
    logForDebugging(`WebSocketTransport: Error: ${err.message}`, {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // error 后还会触发 close 事件，由后者调用 handleConnectionError
  }

  private onNodeClose = (code: number, _reason: Buffer) => {
    const isClean = code === 1000 || code === 1001
    logForDebugging(`WebSocketTransport: Closed: ${code}`, isClean ? undefined : { level: 'error' })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(code)
  }

  // --- 公共 handler ---

  private onPong = () => {
    this.pongReceived = true
  }

  private handleOpenEvent(): void {
    const connectDuration = Date.now() - this.connectStartTime
    logForDebugging('WebSocketTransport: Connected')
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_connected', {
      duration_ms: connectDuration,
    })

    // 重连成功：重置前先记录尝试次数与中断时长。首次连接时 reconnectStartTime 为 null，
    // 再次连接时不为 null。
    if (this.isBridge && this.reconnectStartTime !== null) {
      logEvent('zy_ws_transport_reconnected', {
        attempts: this.reconnectAttempts,
        downtimeMs: Date.now() - this.reconnectStartTime,
      })
    }

    this.reconnectAttempts = 0
    this.reconnectStartTime = null
    this.lastReconnectAttemptTime = null
    this.lastActivityTime = Date.now()
    this.state = 'connected'
    this.onConnectCallback?.()

    // 启动定期 ping，检测失效连接
    this.startPingInterval()

    // 启动定期 keep_alive 数据帧，重置代理空闲计时器
    this.startKeepaliveInterval()

    // 注册会话活动信号回调
    registerSessionActivityCallback(() => {
      void this.write({ type: 'keep_alive' })
    })
  }

  protected sendLine(line: string): boolean {
    if (!this.ws || this.state !== 'connected') {
      logForDebugging('WebSocketTransport: Not connected')
      logForDiagnosticsNoPII('info', 'cli_websocket_send_not_connected')
      return false
    }

    try {
      this.ws.send(line)
      this.lastActivityTime = Date.now()
      return true
    } catch (error) {
      logForDebugging(`WebSocketTransport: Failed to send: ${error}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_send_error')
      // 此处不要清空 this.ws；交给 handleConnectionError 调用的 doDisconnect() 清理，
      // 确保释放 WS 前先移除 listener。
      this.handleConnectionError()
      return false
    }
  }

  /**
   * 移除 connect() 为给定 WebSocket 注册的所有 listener。
   * 否则每次重连都会遗留旧 WS 对象及其闭包，直到 GC 才释放，在网络不稳定时会不断累积。
   * 做法与 src/utils/mcpWebSocketTransport.ts 一致。
   */
  private removeWsListeners(ws: WebSocketLike): void {
    if (this.isBunWs) {
      const nws = ws as unknown as globalThis.WebSocket
      nws.removeEventListener('open', this.onBunOpen)
      nws.removeEventListener('message', this.onBunMessage)
      nws.removeEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      nws.removeEventListener('close', this.onBunClose)
      // 'pong' 是 Bun 专有事件，不在 DOM 类型中
      nws.removeEventListener('pong' as 'message', this.onPong)
    } else {
      const nws = ws as unknown as WsWebSocket
      nws.off('open', this.onNodeOpen)
      nws.off('message', this.onNodeMessage)
      nws.off('error', this.onNodeError)
      nws.off('close', this.onNodeClose)
      nws.off('pong', this.onPong)
    }
  }

  protected doDisconnect(): void {
    // 断开时停止 ping 与 keepalive
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销会话活动回调
    unregisterSessionActivityCallback()

    if (this.ws) {
      // 在 close() 前移除 listener，使旧 WS 与闭包能及时被 GC，而非滞留到下一次标记清除。
      this.removeWsListeners(this.ws)
      this.ws.close()
      this.ws = null
    }
  }

  private handleConnectionError(closeCode?: number): void {
    logForDebugging(
      `WebSocketTransport: Disconnected from ${this.url.href}` +
        (closeCode != null ? ` (code ${closeCode})` : ''),
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_disconnected')
    if (this.isBridge) {
      // 每次关闭均发送，包括重连风暴中的中间事件（这些不会传给 onCloseCallback 消费方）。
      // 要验证 Cloudflare 5 分钟空闲假设，可观察 msSinceLastActivity 的聚类；若峰值约为
      // 300 秒且 closeCode 为 1006，即表明是代理 RST。
      logEvent('zy_ws_transport_closed', {
        closeCode,
        msSinceLastActivity: this.lastActivityTime > 0 ? Date.now() - this.lastActivityTime : -1,
        // 'connected' 表示健康连接意外断开（Cloudflare 场景）；'reconnecting' 表示重连风暴中
        // 连接被拒。下方分支才会修改 state，因此这里读取的是关闭前的值。
        wasConnected: this.state === 'connected',
        reconnectAttempts: this.reconnectAttempts,
      })
    }
    this.doDisconnect()

    if (this.state === 'closing' || this.state === 'closed') {
      return
    }

    // 永久关闭码不重试，服务端已明确结束会话。例外是 4003（未授权）：若 refreshHeaders
    // 可用且返回新 token，便可重试，例如父进程在重连期间签发了新的 session ingress token。
    let headersRefreshed = false
    if (closeCode === 4003 && this.refreshHeaders) {
      const freshHeaders = this.refreshHeaders()
      if (freshHeaders.Authorization !== this.headers.Authorization) {
        Object.assign(this.headers, freshHeaders)
        headersRefreshed = true
        logForDebugging(
          'WebSocketTransport: 4003 received but headers refreshed, scheduling reconnect',
        )
        logForDiagnosticsNoPII('info', 'cli_websocket_4003_token_refreshed')
      }
    }

    if (closeCode != null && PERMANENT_CLOSE_CODES.has(closeCode) && !headersRefreshed) {
      logForDebugging(`WebSocketTransport: Permanent close code ${closeCode}, not reconnecting`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_permanent_close', {
        closeCode,
      })
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // 禁用 autoReconnect 时直接进入 closed 状态，由调用方（例如 REPL bridge 轮询循环）恢复。
    if (!this.autoReconnect) {
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // 在时间预算内按指数退避安排重连
    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    // 检测系统休眠与唤醒：若距上次重连尝试的间隔远超最大延迟，机器可能进入过休眠（例如合上
    // 笔记本）。此时重置预算并从头重试；若会话已在休眠期间被回收，服务端会返回永久关闭码
    // 4001/1002。
    if (
      this.lastReconnectAttemptTime !== null &&
      now - this.lastReconnectAttemptTime > SLEEP_DETECTION_THRESHOLD_MS
    ) {
      logForDebugging(
        `WebSocketTransport: Detected system sleep (${Math.round((now - this.lastReconnectAttemptTime) / 1000)}s gap), resetting reconnection budget`,
      )
      logForDiagnosticsNoPII('info', 'cli_websocket_sleep_detected', {
        gapMs: now - this.lastReconnectAttemptTime,
      })
      this.reconnectStartTime = now
      this.reconnectAttempts = 0
    }
    this.lastReconnectAttemptTime = now

    const elapsed = now - this.reconnectStartTime
    if (elapsed < DEFAULT_RECONNECT_GIVE_UP_MS) {
      // 清除已有重连定时器，避免重复安排
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新标头，例如获取新的会话 token；若上方 4003 分支已刷新则跳过。
      if (!headersRefreshed && this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('WebSocketTransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        DEFAULT_BASE_RECONNECT_DELAY * 2 ** (this.reconnectAttempts - 1),
        DEFAULT_MAX_RECONNECT_DELAY,
      )
      // 增加 ±25% 随机抖动，避免惊群
      const delay = Math.max(0, baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1))

      logForDebugging(
        `WebSocketTransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })
      if (this.isBridge) {
        logEvent('zy_ws_transport_reconnecting', {
          attempt: this.reconnectAttempts,
          elapsedMs: elapsed,
          delayMs: Math.round(delay),
        })
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `WebSocketTransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s for ${this.url.href}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'

      // 通知关闭回调
      if (this.onCloseCallback) {
        this.onCloseCallback(closeCode)
      }
    }
  }

  close(): void {
    // 清除待执行的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // 清除 ping 与 keepalive 定时器
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销会话活动回调
    unregisterSessionActivityCallback()

    this.state = 'closing'
    this.doDisconnect()
  }

  private replayBufferedMessages(lastId: string): void {
    const messages = this.messageBuffer.toArray()
    if (messages.length === 0) {
      return
    }

    // 根据服务端最后收到的消息确定重放起点
    let startIndex = 0
    if (lastId) {
      const lastConfirmedIndex = messages.findIndex(
        (message) => 'uuid' in message && message.uuid === lastId,
      )
      if (lastConfirmedIndex >= 0) {
        // 服务端已确认截至 lastConfirmedIndex 的消息，将其移出缓冲区
        startIndex = lastConfirmedIndex + 1
        // 仅用未确认消息重建缓冲区
        const remaining = messages.slice(startIndex)
        this.messageBuffer.clear()
        this.messageBuffer.addAll(remaining)
        if (remaining.length === 0) {
          this.lastSentId = null
        }
        logForDebugging(
          `WebSocketTransport: Evicted ${startIndex} confirmed messages, ${remaining.length} remaining`,
        )
        logForDiagnosticsNoPII('info', 'cli_websocket_evicted_confirmed_messages', {
          evicted: startIndex,
          remaining: remaining.length,
        })
      }
    }

    const messagesToReplay = messages.slice(startIndex)
    if (messagesToReplay.length === 0) {
      logForDebugging('WebSocketTransport: No new messages to replay')
      logForDiagnosticsNoPII('info', 'cli_websocket_no_messages_to_replay')
      return
    }

    logForDebugging(`WebSocketTransport: Replaying ${messagesToReplay.length} buffered messages`)
    logForDiagnosticsNoPII('info', 'cli_websocket_messages_to_replay', {
      count: messagesToReplay.length,
    })

    for (const message of messagesToReplay) {
      const line = `${jsonStringify(message)}\n`
      const success = this.sendLine(line)
      if (!success) {
        this.handleConnectionError()
        break
      }
    }
    // 重放后不要清空缓冲区；消息会保留到服务端在下次重连时确认收到为止。这样即使连接在
    // 重放后、服务端处理消息前断开，也不会丢失消息。
  }

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  getStateLabel(): string {
    return this.state
  }

  async write(message: StdoutMessage): Promise<void> {
    if ('uuid' in message && typeof message.uuid === 'string') {
      this.messageBuffer.add(message)
      this.lastSentId = message.uuid
    }

    const line = `${jsonStringify(message)}\n`

    if (this.state !== 'connected') {
      // 带 UUID 的消息已缓冲，连接后将重放
      return
    }

    const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
    const detailLabel = this.getControlMessageDetailLabel(message)

    logForDebugging(
      `WebSocketTransport: Sending message type=${message.type}${sessionLabel}${detailLabel}`,
    )

    this.sendLine(line)
  }

  private getControlMessageDetailLabel(message: StdoutMessage): string {
    if (message.type === 'control_request') {
      const { request_id, request } = message
      const toolName = request.subtype === 'can_use_tool' ? request.tool_name : ''
      return ` subtype=${request.subtype} request_id=${request_id}${toolName ? ` tool=${toolName}` : ''}`
    }
    if (message.type === 'control_response') {
      const { subtype, request_id } = message.response
      return ` subtype=${subtype} request_id=${request_id}`
    }
    return ''
  }

  private startPingInterval(): void {
    // 清除已有定时器
    this.stopPingInterval()

    this.pongReceived = true
    let lastTickTime = Date.now()

    // 定期发送 ping 以检测失效连接；若上一次 ping 未收到 pong，则视为连接已失效。
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        const now = Date.now()
        const gap = now - lastTickTime
        lastTickTime = now

        // 进程挂起检测：若两次 tick 的墙上时钟间隔远超 10 秒，说明进程曾被挂起（合盖、
        // SIGSTOP 或虚拟机暂停）。setInterval 不会排队补发错过的 tick，而会合并，因此唤醒后
        // 本回调只触发一次且间隔极大。此时 socket 几乎必然失效：NAT 映射会在 30 秒至 5 分钟
        // 内失效，服务端也一直在向空连接重传。无需等待 ping/pong 往返确认，因为在失效 socket
        // 上调用 ws.ping() 也会立即无错返回，字节只是进入内核发送缓冲区。直接视为失效并重连。
        // 短暂休眠导致的误重连代价很低，replayBufferedMessages() 会处理重放，服务端按 UUID 去重。
        if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
          logForDebugging(
            `WebSocketTransport: ${Math.round(gap / 1000)}s tick gap detected — process was suspended, forcing reconnect`,
          )
          logForDiagnosticsNoPII('info', 'cli_websocket_sleep_detected_on_ping', { gapMs: gap })
          this.handleConnectionError()
          return
        }

        if (!this.pongReceived) {
          logForDebugging('WebSocketTransport: No pong received, connection appears dead', {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_pong_timeout')
          this.handleConnectionError()
          return
        }

        this.pongReceived = false
        try {
          this.ws.ping?.()
        } catch (error) {
          logForDebugging(`WebSocketTransport: Ping failed: ${error}`, {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_ping_failed')
        }
      }
    }, DEFAULT_PING_INTERVAL)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private startKeepaliveInterval(): void {
    this.stopKeepaliveInterval()

    // CCR 会话由会话活动心跳负责 keep-alive
    if (isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
      return
    }

    this.keepAliveInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        try {
          this.ws.send(KEEP_ALIVE_FRAME)
          this.lastActivityTime = Date.now()
          logForDebugging('WebSocketTransport: Sent periodic keep_alive data frame')
        } catch (error) {
          logForDebugging(`WebSocketTransport: Periodic keep_alive failed: ${error}`, {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_keepalive_failed')
        }
      }
    }, DEFAULT_KEEPALIVE_INTERVAL)
  }

  private stopKeepaliveInterval(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }
}
