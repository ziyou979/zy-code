import { errorMessage } from '../../utils/errors.js'

/** 错误分类类型，与 AgentToolResult.errorKind 保持一致。 */
export type AgentErrorKind =
  | 'usage_limit'
  | 'rate_limited'
  | 'server_error'
  | 'refusal'
  | 'stream_failure'
  | 'internal'

/**
 * 将未知错误归类为可传播的 Agent 错误类型。
 * 调用者应在进入此函数前单独处理 AbortError。
 */
export function categorizeAgentError(error: unknown): AgentErrorKind {
  const message = errorMessage(error).toLowerCase()
  if (
    message.includes('usage limit') ||
    message.includes('usage_limit') ||
    message.includes('billing') ||
    message.includes('quota') ||
    message.includes('insufficient_quota')
  ) {
    return 'usage_limit'
  }
  if (
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('429') ||
    message.includes('too many requests')
  ) {
    return 'rate_limited'
  }
  if (
    message.includes('529') ||
    message.includes('overloaded') ||
    message.includes('server error') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('5xx') ||
    message.includes('service_unavailable') ||
    message.includes('internal_server_error')
  ) {
    return 'server_error'
  }
  if (
    message.includes('refusal') ||
    message.includes('refused') ||
    message.includes('safety') ||
    message.includes('harmful') ||
    message.includes('content_filter')
  ) {
    return 'refusal'
  }
  if (
    message.includes('stream') ||
    message.includes('watchdog') ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('network') ||
    message.includes('eof') ||
    message.includes('socket') ||
    message.includes('reset')
  ) {
    return 'stream_failure'
  }
  return 'internal'
}
