import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'

/**
 * 当 MCP 服务器返回 401 或需要 OAuth 重新认证时抛出。
 * 此错误应在工具执行层被捕获，以将客户端状态更新为 'needs-auth'。
 */
export class McpAuthError extends Error {
  serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpAuthError'
    this.serverName = serverName
  }
}

/**
 * 当 MCP 会话过期且连接缓存已清除时抛出。
 * 调用方应通过 ensureConnectedClient 获取新的客户端并重试。
 */
export class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" session expired`)
    this.name = 'McpSessionExpiredError'
  }
}

/**
 * 当 MCP 工具返回 `isError: true` 时抛出。携带结果的 `_meta`，
 * 以便 SDK 消费者仍可接收 — 根据 MCP 规范，`_meta` 位于
 * 基础 Result 类型上，在错误结果中也有效。
 */
export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    readonly mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

/**
 * 检测错误是否为 MCP "Session not found" 错误（HTTP 404 + JSON-RPC 代码 -32001）。
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus = 'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  return error.message.includes('"code":-32001') || error.message.includes('"code": -32001')
}

/**
 * Default timeout for MCP tool calls (effectively infinite - ~27.8 hours).
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000

/**
 * Cap on MCP tool descriptions and server instructions sent to the model.
 */
export const MAX_MCP_DESCRIPTION_LENGTH = 2048

/**
 * Gets the timeout for MCP tool calls in milliseconds.
 */
export function getMcpToolTimeoutMs(): number {
  return parseInt(process.env.MCP_TOOL_TIMEOUT || '', 10) || DEFAULT_MCP_TOOL_TIMEOUT_MS
}
