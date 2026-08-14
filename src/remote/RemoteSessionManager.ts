import { type RemoteMessageContent, sendEventToRemoteSession } from '../services/teleport/api.js'
import type { WireMessage } from '../types/index.js'
import type {
  WireControlCancelRequest,
  WireControlPermissionRequest,
  WireControlRequest,
  WireControlResponse,
} from '../types/wire/control.js'
import { logForDebugging } from '../services/infra/debug.js'
import { logError } from '../services/infra/log.js'
import { SessionsWebSocket, type SessionsWebSocketCallbacks } from './sessionsWebSocket.js'

/**
 * 判断消息是否为 WireMessage（而非控制消息）的类型守卫。
 */
function isSDKMessage(
  message: WireMessage | WireControlRequest | WireControlResponse | WireControlCancelRequest,
): message is WireMessage {
  return (
    message.type !== 'control_request' &&
    message.type !== 'control_response' &&
    message.type !== 'control_cancel_request'
  )
}

/**
 * 远程会话使用的简化权限响应。
 * 这是为 CCR 通信精简过的 PermissionResult。
 */
export type RemotePermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
    }

export type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  /** 会话是否由一条仍在处理的初始 prompt 创建。 */
  hasInitialPrompt?: boolean
  /**
   * 为 true 时，此客户端仅用于查看。Ctrl+C/Escape 不会向远程 agent 发送中断，
   * 60 秒重连超时会禁用，且不会更新会话标题。供 `zy assistant` 使用。
   */
  viewerOnly?: boolean
}

export type RemoteSessionCallbacks = {
  /** 从会话收到 WireMessage 时调用。 */
  onMessage: (message: WireMessage) => void
  /** 从 CCR 收到权限请求时调用。 */
  onPermissionRequest: (request: WireControlPermissionRequest, requestId: string) => void
  /** 服务器取消待处理权限请求时调用。 */
  onPermissionCancelled?: (requestId: string, toolUseId: string | undefined) => void
  /** 连接建立时调用。 */
  onConnected?: () => void
  /** 连接丢失且无法恢复时调用。 */
  onDisconnected?: () => void
  /** WS 暂时断开且正处于重连退避时调用。 */
  onReconnecting?: () => void
  /** 发生错误时调用。 */
  onError?: (error: Error) => void
}

/**
 * 管理远程 CCR 会话。
 *
 * 负责协调：
 * - 通过 WebSocket 订阅接收 CCR 消息
 * - 通过 HTTP POST 向 CCR 发送用户消息
 * - 权限请求与响应流程
 */
export class RemoteSessionManager {
  private websocket: SessionsWebSocket | null = null
  private pendingPermissionRequests: Map<string, WireControlPermissionRequest> = new Map()

  constructor(
    private readonly config: RemoteSessionConfig,
    private readonly callbacks: RemoteSessionCallbacks,
  ) {}

  /**
   * 通过 WebSocket 连接远程会话。
   */
  connect(): void {
    logForDebugging(`[RemoteSessionManager] Connecting to session ${this.config.sessionId}`)

    const wsCallbacks: SessionsWebSocketCallbacks = {
      onMessage: (message) => this.handleMessage(message),
      onConnected: () => {
        logForDebugging('[RemoteSessionManager] Connected')
        this.callbacks.onConnected?.()
      },
      onClose: () => {
        logForDebugging('[RemoteSessionManager] Disconnected')
        this.callbacks.onDisconnected?.()
      },
      onReconnecting: () => {
        logForDebugging('[RemoteSessionManager] Reconnecting')
        this.callbacks.onReconnecting?.()
      },
      onError: (error) => {
        logError(error)
        this.callbacks.onError?.(error)
      },
    }

    this.websocket = new SessionsWebSocket(
      this.config.sessionId,
      this.config.orgUuid,
      this.config.getAccessToken,
      wsCallbacks,
    )

    void this.websocket.connect()
  }

  /**
   * 处理 WebSocket 消息。
   */
  private handleMessage(
    message: WireMessage | WireControlRequest | WireControlResponse | WireControlCancelRequest,
  ): void {
    // 处理 control request（来自 CCR 的权限提示）。
    if (message.type === 'control_request') {
      this.handleControlRequest(message)
      return
    }

    // 处理 control cancel request（服务器取消待处理的权限提示）。
    if (message.type === 'control_cancel_request') {
      const { request_id } = message
      const pendingRequest = this.pendingPermissionRequests.get(request_id)
      logForDebugging(`[RemoteSessionManager] Permission request cancelled: ${request_id}`)
      this.pendingPermissionRequests.delete(request_id)
      this.callbacks.onPermissionCancelled?.(request_id, pendingRequest?.tool_use_id)
      return
    }

    // 处理 control response（确认回执）。
    if (message.type === 'control_response') {
      logForDebugging('[RemoteSessionManager] Received control response')
      return
    }

    // 将 SDK 消息转发给 callback；类型守卫确保正确收窄。
    if (isSDKMessage(message)) {
      this.callbacks.onMessage(message)
    }
  }

  /**
   * 处理 CCR 发来的控制请求，例如权限请求。
   */
  private handleControlRequest(request: WireControlRequest): void {
    const { request_id, request: inner } = request

    if (inner.subtype === 'can_use_tool') {
      logForDebugging(`[RemoteSessionManager] Permission request for tool: ${inner.tool_name}`)
      this.pendingPermissionRequests.set(request_id, inner)
      this.callbacks.onPermissionRequest(inner, request_id)
    } else {
      // 对无法识别的 subtype 返回错误，避免服务器一直等待不会到来的响应。
      logForDebugging(
        `[RemoteSessionManager] Unsupported control request subtype: ${inner.subtype}`,
      )
      const response: WireControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id,
          error: `Unsupported control request subtype: ${inner.subtype}`,
        },
      }
      this.websocket?.sendControlResponse(response)
    }
  }

  /**
   * 通过 HTTP POST 向远程会话发送用户消息。
   */
  async sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean> {
    logForDebugging(`[RemoteSessionManager] Sending message to session ${this.config.sessionId}`)

    const success = await sendEventToRemoteSession(this.config.sessionId, content, opts)

    if (!success) {
      logError(
        new Error(
          `[RemoteSessionManager] Failed to send message to session ${this.config.sessionId}`,
        ),
      )
    }

    return success
  }

  /**
   * 响应 CCR 发来的权限请求。
   */
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
    const pendingRequest = this.pendingPermissionRequests.get(requestId)
    if (!pendingRequest) {
      logError(
        new Error(`[RemoteSessionManager] No pending permission request with ID: ${requestId}`),
      )
      return
    }

    this.pendingPermissionRequests.delete(requestId)

    const response: WireControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    }

    logForDebugging(`[RemoteSessionManager] Sending permission response: ${result.behavior}`)

    this.websocket?.sendControlResponse(response)
  }

  /**
   * 检查是否已连接远程会话。
   */
  isConnected(): boolean {
    return this.websocket?.isConnected() ?? false
  }

  /**
   * 发送中断信号，取消远程会话中的当前请求。
   */
  cancelSession(): void {
    logForDebugging('[RemoteSessionManager] Sending interrupt signal')
    this.websocket?.sendControlRequest({ subtype: 'interrupt' })
  }

  /**
   * 获取会话 ID。
   */
  getSessionId(): string {
    return this.config.sessionId
  }

  /**
   * 断开远程会话连接。
   */
  disconnect(): void {
    logForDebugging('[RemoteSessionManager] Disconnecting')
    this.websocket?.close()
    this.websocket = null
    this.pendingPermissionRequests.clear()
  }

  /**
   * 强制重连 WebSocket。
   * 适用于容器关闭后订阅失效的情况。
   */
  reconnect(): void {
    logForDebugging('[RemoteSessionManager] Reconnecting WebSocket')
    this.websocket?.reconnect()
  }
}

/**
 * 根据 OAuth token 创建远程会话配置。
 */
export function createRemoteSessionConfig(
  sessionId: string,
  getAccessToken: () => string,
  orgUuid: string,
  hasInitialPrompt = false,
  viewerOnly = false,
): RemoteSessionConfig {
  return {
    sessionId,
    getAccessToken,
    orgUuid,
    hasInitialPrompt,
    viewerOnly,
  }
}
