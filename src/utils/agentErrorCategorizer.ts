import { errorMessage } from './errors.js'

/**
 * 错误分类类型 — 映射到 AgentToolResult.errorKind
 */
export type AgentErrorKind =
  | 'usage_limit'
  | 'rate_limited'
  | 'server_error'
  | 'refusal'
  | 'stream_failure'
  | 'internal'

/**
 * Categorize an error into a structured errorKind for agent error propagation.
 * Used by the async agent lifecycle to classify errors so parent agents can
 * make informed retry/fallback decisions.
 *
 * 注意：调用者应在调用前处理 AbortError，本函数不处理终止类错误。
 */
export function categorizeAgentError(error: unknown): AgentErrorKind | undefined {
  const msg = errorMessage(error).toLowerCase()
  if (
    msg.includes('usage limit') ||
    msg.includes('usage_limit') ||
    msg.includes('billing') ||
    msg.includes('quota') ||
    msg.includes('insufficient_quota')
  ) {
    return 'usage_limit'
  }
  if (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('too many requests')
  ) {
    return 'rate_limited'
  }
  if (
    msg.includes('529') ||
    msg.includes('overloaded') ||
    msg.includes('server error') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('5xx') ||
    msg.includes('service_unavailable') ||
    msg.includes('internal_server_error')
  ) {
    return 'server_error'
  }
  if (
    msg.includes('refusal') ||
    msg.includes('refused') ||
    msg.includes('safety') ||
    msg.includes('harmful') ||
    msg.includes('content_filter')
  ) {
    return 'refusal'
  }
  if (
    msg.includes('stream') ||
    msg.includes('watchdog') ||
    msg.includes('timeout') ||
    msg.includes('connection') ||
    msg.includes('network') ||
    msg.includes('eof') ||
    msg.includes('socket') ||
    msg.includes('reset')
  ) {
    return 'stream_failure'
  }
  return 'internal'
}
