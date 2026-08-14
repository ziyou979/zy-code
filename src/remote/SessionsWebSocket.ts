import { randomUUID } from 'node:crypto'
import { getOauthConfig } from '../constants/oauth.js'
import type { WireMessage } from '../types/index.js'
import type {
  WireControlCancelRequest,
  WireControlRequest,
  WireControlRequestInner,
  WireControlResponse,
} from '../types/wire/control.js'
import { logForDebugging } from '../services/infra/debug.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../services/infra/log.js'
import { getWebSocketTLSOptions } from '../services/http/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../services/http/proxy.js'
import { jsonParse, jsonStringify } from '../services/infra/slowOperations.js'

const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 5
const PING_INTERVAL_MS = 30000

/**
 * 收到 4001（找不到会话）时的最大重试次数。compaction 期间，服务器可能短暂地
 * 将会话视为过期；短暂的重试窗口能让客户端恢复，而不是永久放弃。
 */
const MAX_SESSION_NOT_FOUND_RETRIES = 3

/**
 * 表示服务器永久拒绝连接的 WebSocket 关闭码，客户端遇到后会立即停止重连。
 * 注意：4001（找不到会话）在 compaction 期间可能只是暂时状态，因此单独进行有限重试。
 */
const PERMANENT_CLOSE_CODES = new Set([
  4003, // unauthorized
])

type WebSocketState = 'connecting' | 'connected' | 'closed'

type SessionsMessage =
  | WireMessage
  | WireControlRequest
  | WireControlResponse
  | WireControlCancelRequest

function isSessionsMessage(value: unknown): value is SessionsMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  // 接受所有带字符串 `type` 字段的消息。下游 handler
  //（messageAdapter、RemoteSessionManager）负责决定如何处理，
  // unknown types. A hardcoded allowlist here would silently drop new
  // 从而兼容后端先于客户端更新而开始发送的新消息类型。
  return typeof value.type === 'string'
}

export type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  /** 检测到临时断开并安排重连时触发。
   *  onClose 只在永久关闭时触发（服务器终止或重试次数耗尽）。 */
  onReconnecting?: () => void
}

// Common interface between globalThis.WebSocket and ws.WebSocket
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void // Bun & ws both support this
}

/**
 * 通过 /v1/sessions/ws/{id}/subscribe 连接 CCR 会话的 WebSocket 客户端。
 *
 * 协议流程：
 * 1. 连接 wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...
 * 2. 发送认证消息：{ type: 'auth', credential: { type: 'oauth', token: '...' } }
 * 3. 接收会话的 WireMessage 流
 */
export class SessionsWebSocket {
  private ws: WebSocketLike | null = null
  private state: WebSocketState = 'closed'
  private reconnectAttempts = 0
  private sessionNotFoundRetries = 0
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly sessionId: string,
    private readonly orgUuid: string,
    private readonly getAccessToken: () => string,
    private readonly callbacks: SessionsWebSocketCallbacks,
  ) {}

  /**
   * 连接会话的 WebSocket endpoint。
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting') {
      logForDebugging('[SessionsWebSocket] Already connecting')
      return
    }

    this.state = 'connecting'

    const baseUrl = getOauthConfig().BASE_API_URL.replace('https://', 'wss://')
    const url = `${baseUrl}/v1/sessions/ws/${this.sessionId}/subscribe?organization_uuid=${this.orgUuid}`

    logForDebugging(`[SessionsWebSocket] Connecting to ${url}`)

    // 每次尝试连接时获取新的 token。
    const accessToken = this.getAccessToken()
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
    }

    if (typeof Bun !== 'undefined') {
      // Bun WebSocket 支持 headers/proxy 选项，但 DOM 类型未声明。
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const ws = new globalThis.WebSocket(url, {
        headers,
        proxy: getWebSocketProxyUrl(url),
        tls: getWebSocketTLSOptions() || undefined,
      } as unknown as string[])
      this.ws = ws

      ws.addEventListener('open', () => {
        logForDebugging('[SessionsWebSocket] Connection opened, authenticated via headers')
        this.state = 'connected'
        this.reconnectAttempts = 0
        this.sessionNotFoundRetries = 0
        this.startPingInterval()
        this.callbacks.onConnected?.()
      })

      ws.addEventListener('message', (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data)
        this.handleMessage(data)
      })

      ws.addEventListener('error', () => {
        const err = new Error('[SessionsWebSocket] WebSocket error')
        logError(err)
        this.callbacks.onError?.(err)
      })

      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ws.addEventListener('close', (event: CloseEvent) => {
        logForDebugging(`[SessionsWebSocket] Closed: code=${event.code} reason=${event.reason}`)
        this.handleClose(event.code)
      })

      ws.addEventListener('pong', () => {
        logForDebugging('[SessionsWebSocket] Pong received')
      })
    } else {
      const { default: WS } = await import('ws')
      const ws = new WS(url, {
        headers,
        agent: getWebSocketProxyAgent(url),
        ...getWebSocketTLSOptions(),
      })
      this.ws = ws

      ws.on('open', () => {
        logForDebugging('[SessionsWebSocket] Connection opened, authenticated via headers')
        // Auth is handled via headers, so we're immediately connected
        this.state = 'connected'
        this.reconnectAttempts = 0
        this.sessionNotFoundRetries = 0
        this.startPingInterval()
        this.callbacks.onConnected?.()
      })

      ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString())
      })

      ws.on('error', (err: Error) => {
        logError(new Error(`[SessionsWebSocket] Error: ${err.message}`))
        this.callbacks.onError?.(err)
      })

      ws.on('close', (code: number, reason: Buffer) => {
        logForDebugging(`[SessionsWebSocket] Closed: code=${code} reason=${reason.toString()}`)
        this.handleClose(code)
      })

      ws.on('pong', () => {
        logForDebugging('[SessionsWebSocket] Pong received')
      })
    }
  }

  /**
   * 处理收到的 WebSocket 消息。
   */
  private handleMessage(data: string): void {
    try {
      const message: unknown = jsonParse(data)

      // Forward SDK messages to callback
      if (isSessionsMessage(message)) {
        this.callbacks.onMessage(message)
      } else {
        logForDebugging(
          `[SessionsWebSocket] Ignoring message type: ${typeof message === 'object' && message !== null && 'type' in message ? String(message.type) : 'unknown'}`,
        )
      }
    } catch (error) {
      logError(new Error(`[SessionsWebSocket] Failed to parse message: ${errorMessage(error)}`))
    }
  }

  /**
   * 处理 WebSocket 关闭事件。
   */
  private handleClose(closeCode: number): void {
    this.stopPingInterval()

    if (this.state === 'closed') {
      return
    }

    this.ws = null

    const previousState = this.state
    this.state = 'closed'

    // 永久关闭码：服务器已明确终止会话，停止重连。
    if (PERMANENT_CLOSE_CODES.has(closeCode)) {
      logForDebugging(`[SessionsWebSocket] Permanent close code ${closeCode}, not reconnecting`)
      this.callbacks.onClose?.()
      return
    }

    // compact 期间，4001（session not found）可能只是暂时状态：CLI worker
    // 忙于 compact API 调用且未发出事件时，服务器可能短暂地将会话视为过期。
    if (closeCode === 4001) {
      this.sessionNotFoundRetries++
      if (this.sessionNotFoundRetries > MAX_SESSION_NOT_FOUND_RETRIES) {
        logForDebugging(
          `[SessionsWebSocket] 4001 retry budget exhausted (${MAX_SESSION_NOT_FOUND_RETRIES}), not reconnecting`,
        )
        this.callbacks.onClose?.()
        return
      }
      this.scheduleReconnect(
        RECONNECT_DELAY_MS * this.sessionNotFoundRetries,
        `4001 attempt ${this.sessionNotFoundRetries}/${MAX_SESSION_NOT_FOUND_RETRIES}`,
      )
      return
    }

    // 若此前已连接，则尝试重连。
    if (previousState === 'connected' && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++
      this.scheduleReconnect(
        RECONNECT_DELAY_MS,
        `attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      )
    } else {
      logForDebugging('[SessionsWebSocket] Not reconnecting')
      this.callbacks.onClose?.()
    }
  }

  private scheduleReconnect(delay: number, label: string): void {
    this.callbacks.onReconnecting?.()
    logForDebugging(`[SessionsWebSocket] Scheduling reconnect (${label}) in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private startPingInterval(): void {
    this.stopPingInterval()

    this.pingInterval = setInterval(() => {
      if (this.ws && this.state === 'connected') {
        try {
          this.ws.ping?.()
        } catch {
          // 忽略 ping 错误，由 close handler 处理连接问题。
        }
      }
    }, PING_INTERVAL_MS)
  }

  /**
   * 停止定时 ping。
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * 向会话发回控制响应。
   */
  sendControlResponse(response: WireControlResponse): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    logForDebugging('[SessionsWebSocket] Sending control response')
    this.ws.send(jsonStringify(response))
  }

  /**
   * 向会话发送控制请求，例如 interrupt。
   */
  sendControlRequest(request: WireControlRequestInner): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    const controlRequest: WireControlRequest = {
      type: 'control_request',
      request_id: randomUUID(),
      request,
    }

    logForDebugging(`[SessionsWebSocket] Sending control request: ${request.subtype}`)
    this.ws.send(jsonStringify(controlRequest))
  }

  /**
   * 检查是否已连接。
   */
  isConnected(): boolean {
    return this.state === 'connected'
  }

  /**
   * 关闭 WebSocket 连接。
   */
  close(): void {
    logForDebugging('[SessionsWebSocket] Closing connection')
    this.state = 'closed'
    this.stopPingInterval()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      // Null out event handlers to prevent race conditions during reconnect.
      // Bun（原生 WebSocket）下，通过 onX handler 解除绑定最直接。
      // Node（ws package）下，listener 在 connect() 中通过 .on() 绑定；但此处即将
      // 关闭连接并清空 this.ws，因此无需额外清理。
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * 强制重连：关闭现有连接并建立新连接。
   * 适用于订阅失效的情况，例如容器关闭后。
   */
  reconnect(): void {
    logForDebugging('[SessionsWebSocket] Force reconnecting')
    this.reconnectAttempts = 0
    this.sessionNotFoundRetries = 0
    this.close()
    // 短暂延迟后重连；计时器保存在 reconnectTimer 中，以便取消。
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 500)
  }
}
