import { URL } from 'node:url'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { HybridTransport } from './hybridTransport.js'
import { SSETransport } from './sseTransport.js'
import type { Transport } from './transport.js'
import { WebSocketTransport } from './webSocketTransport.js'

/**
 * 根据 URL 获取合适 transport 的辅助函数。
 *
 * Transport 选择优先级：
 * 1. 设置 ZY_CODE_ 时使用 SSETransport（SSE 读取 + POST 写入）
 * 2. 设置 ZY_CODE_ 时使用 HybridTransport（WS 读取 + POST 写入）
 * 3. 默认使用 WebSocketTransport（WS 读取 + WS 写入）
 */
export function getTransportForUrl(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
): Transport {
  if (isEnvTruthy(process.env.ZY_CODE_)) {
    // v2 使用 SSE 读取、HTTP POST 写入。--sdk-url 是会话 URL（.../sessions/{id}），追加
    // /worker/events/stream 得到 SSE 流 URL。
    const sseUrl = new URL(url.href)
    if (sseUrl.protocol === 'wss:') {
      sseUrl.protocol = 'https:'
    } else if (sseUrl.protocol === 'ws:') {
      sseUrl.protocol = 'http:'
    }
    sseUrl.pathname = `${sseUrl.pathname.replace(/\/$/, '')}/worker/events/stream`
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders) as unknown as Transport
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (isEnvTruthy(process.env.ZY_CODE_)) {
      return new HybridTransport(url, headers, sessionId, refreshHeaders) as unknown as Transport
    }
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders) as unknown as Transport
  } else {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
}
