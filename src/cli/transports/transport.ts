// Transport 接口：所有 transport 实现的基础类型。

import type { StdinMessage, StdoutMessage } from 'src/types/wire/control.js'

export type TransportState = 'connecting' | 'open' | 'closed' | 'error'

export type MessageHandler = (message: StdoutMessage) => void
export type StateChangeHandler = (state: TransportState) => void

export interface Transport {
  state: TransportState
  connect(): Promise<void>
  disconnect(): void
  send(message: StdinMessage): void
  /** 发送 StdoutMessage 到远端（SSETransport / WebSocketTransport 共有）。 */
  write(message: StdoutMessage): Promise<void>
  /** 关闭连接并清理资源。 */
  close(): void
  onMessage(handler: MessageHandler): void
  onStateChange(handler: StateChangeHandler): void
  /** 注册原始入站数据回调(remoteIO 用它把数据喂给输入流)。 */
  setOnData(callback: (data: string) => void): void
  /** 注册连接关闭回调(用于触发优雅关闭)。 */
  setOnClose(callback: (closeCode?: number) => void): void
}

export type TransportConstructor = new (options: Record<string, unknown>) => Transport
