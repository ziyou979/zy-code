import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * 进程内关联 transport 对，用于在同一进程中运行 MCP server 和 client，无需启动子进程。
 *
 * 任一端调用 `send()` 会投递到另一端的 `onmessage`；任一端调用 `close()` 会触发两端的
 * `onclose`。
 */
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /** @internal */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed')
    }
    // 异步投递到另一端，避免同步请求/响应循环导致调用栈过深
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
    // peer 尚未关闭时将其关闭
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.onclose?.()
    }
  }
}

/**
 * 创建一对关联 transport，用于进程内 MCP 通信。一端发送的消息会投递到另一端的
 * `onmessage`。
 *
 * @returns `[clientTransport, serverTransport]`
 */
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]
}
