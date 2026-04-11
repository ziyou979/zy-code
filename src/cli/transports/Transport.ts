// Transport Interface - base type for all transport implementations.

import type { StdoutMessage, StdinMessage } from '../../entrypoints/sdk/controlTypes.js'

export type TransportState = 'connecting' | 'open' | 'closed' | 'error'

export type MessageHandler = (message: StdoutMessage) => void
export type StateChangeHandler = (state: TransportState) => void

export interface Transport {
  state: TransportState
  connect(): Promise<void>
  disconnect(): void
  send(message: StdinMessage): void
  onMessage(handler: MessageHandler): void
  onStateChange(handler: StateChangeHandler): void
}

export type TransportConstructor = new (options: Record<string, unknown>) => Transport
