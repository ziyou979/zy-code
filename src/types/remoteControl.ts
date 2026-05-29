/**
 * Remote-control bridge types.
 *
 * Used by the daemon and remote-control hooks to manage the WebSocket
 * connection back to zy.ai when a user takes over a session from another
 * device.
 */

import type { WireMessage } from './wire/messages.js'

/**
 * A user message typed on zy.ai, extracted from the bridge WS.
 */
export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

/**
 * Handle returned by connectRemoteControl. Write query() yields in,
 * read inbound prompts out. See src/assistant/daemonBridge.ts for full
 * field documentation.
 */
export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: WireMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (state: 'ready' | 'connected' | 'reconnecting' | 'failed', detail?: string) => void,
  ): void
  teardown(): Promise<void>
}
