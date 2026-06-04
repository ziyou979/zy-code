import { URL } from 'node:url'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { HybridTransport } from './HybridTransport.js'
import { SSETransport } from './SSETransport.js'
import type { Transport } from './Transport.js'
import { WebSocketTransport } from './WebSocketTransport.js'

/**
 * Helper function to get the appropriate transport for a URL.
 *
 * Transport selection priority:
 * 1. SSETransport (SSE reads + POST writes) when ZY_CODE_ is set
 * 2. HybridTransport (WS reads + POST writes) when ZY_CODE_ is set
 * 3. WebSocketTransport (WS reads + WS writes) — default
 */
export function getTransportForUrl(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
): Transport {
  if (isEnvTruthy(process.env.ZY_CODE_)) {
    // v2: SSE for reads, HTTP POST for writes
    // --sdk-url is the session URL (.../sessions/{id});
    // derive the SSE stream URL by appending /worker/events/stream
    const sseUrl = new URL(url.href)
    if (sseUrl.protocol === 'wss:') {
      sseUrl.protocol = 'https:'
    } else if (sseUrl.protocol === 'ws:') {
      sseUrl.protocol = 'http:'
    }
    sseUrl.pathname = `${sseUrl.pathname.replace(/\/$/, '')}/worker/events/stream`
    // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders) as any
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (isEnvTruthy(process.env.ZY_CODE_)) {
      // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
      return new HybridTransport(url, headers, sessionId, refreshHeaders) as any
    }
    // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders) as any
  } else {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
}
