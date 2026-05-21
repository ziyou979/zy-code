import { tSync } from '../../i18n/index.js'
import type { APIErrorLike } from '../../types/llm.js'

// 来自 OpenSSL 的 SSL/TLS 错误码（Node.js 和 Bun 均使用）
// 参见：https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
const SSL_ERROR_CODES = new Set([
  // 证书验证错误
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // 自签名证书错误
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // 证书链错误
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // 主机名/altname 错误
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS 握手错误
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * 从错误的 cause 链中提取连接错误详情。
 * Anthropic SDK 将底层错误包装在 `cause` 属性中。
 * 此函数遍历 cause 链以找到根错误码/消息。
 */
export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  // 遍历 cause 链以找到带有 code 的根错误
  let current: unknown = error
  const maxDepth = 5 // 防止无限循环
  let depth = 0

  while (current && depth < maxDepth) {
    if (current instanceof Error && 'code' in current && typeof current.code === 'string') {
      const code = current.code
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // 移动到链中的下一个 cause
    if (current instanceof Error && 'cause' in current && current.cause !== current) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

  return null
}

/**
 * 返回 SSL/TLS 错误的可操作提示，适用于主 API 客户端之外的上下文
 * （OAuth 令牌交换、预连接性检查），这些场景不适用 `formatAPIError`。
 *
 * 动机：使用 TLS 拦截代理（Zscaler 等）的企业用户在浏览器中完成 OAuth，
 * 但 CLI 的令牌交换因原始 SSL 错误码而静默失败。展示可能的修复方案
 * 可以节省一次支持往返。
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) {
    return null
  }
  return tSync('errorUtils.ssl.hint', { code: details.code })
}

/**
 * 从消息字符串中去除 HTML 内容（如 CloudFlare 错误页面），
 * 如果检测到 HTML 则返回用户友好的标题或空字符串。
 * 如果未检测到 HTML，则原样返回消息。
 */
function sanitizeMessageHTML(message: string): string {
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch?.[1]) {
      return titleMatch[1].trim()
    }
    return ''
  }
  return message
}

/**
 * 检测错误消息是否包含 HTML 内容（如 CloudFlare 错误页面），
 * 并返回用户友好的消息替代
 */
export function sanitizeAPIError(apiError: APIErrorLike): string {
  const message = apiError.message
  if (!message) {
    // 有时 message 为 undefined
    // TODO: 查明原因
    return ''
  }
  return sanitizeMessageHTML(message)
}

/**
 * 从会话 JSONL 反序列化的 API 错误的形状。
 *
 * 经过 JSON 往返后，SDK 的 APIError 会丢失其 `.message` 属性。
 * 实际消息根据提供商位于不同的嵌套层级：
 *
 * - Bedrock/代理：`{ error: { message: "..." } }`
 * - 标准 Anthropic API：`{ error: { error: { message: "..." } } }`
 *   （外层 `.error` 是响应体，内层 `.error` 是 API 错误）
 *
 * 另见：`logging.ts` 中的 `getErrorMessage`，它处理相同的形状。
 */
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * 从缺少顶层 `.message` 的反序列化 API 错误中提取可读消息。
 *
 * 检查两个嵌套层级（更深的优先，以提高特异性）：
 * 1. `error.error.error.message` — 标准 Anthropic API 形状
 * 2. `error.error.message` — Bedrock 形状
 */
function extractNestedErrorMessage(error: APIErrorLike): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // 通过收窄类型访问 `.error`，使 TypeScript 能看到嵌套形状
  // 而非 SDK 的 `Object | undefined`。
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // 标准 Anthropic API 形状：{ error: { error: { message } } }
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock 形状：{ error: { message } }
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

export function formatAPIError(error: APIErrorLike): string {
  // 从 cause 链中提取连接错误详情
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // 处理超时错误
    if (code === 'ETIMEDOUT') {
      return tSync('errorUtils.connection.timeout')
    }

    // 处理 SSL/TLS 错误，返回特定消息
    if (isSSLError) {
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return tSync('errorUtils.ssl.certVerificationFailed')
        case 'CERT_HAS_EXPIRED':
          return tSync('errorUtils.ssl.certExpired')
        case 'CERT_REVOKED':
          return tSync('errorUtils.ssl.certRevoked')
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return tSync('errorUtils.ssl.selfSigned')
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return tSync('errorUtils.ssl.hostnameMismatch')
        case 'CERT_NOT_YET_VALID':
          return tSync('errorUtils.ssl.certNotYetValid')
        default:
          return tSync('errorUtils.ssl.genericError', { code })
      }
    }
  }

  if (error.message === 'Connection error.') {
    // 如果有错误码但不是 SSL 错误，包含在消息中供调试
    if (connectionDetails?.code) {
      return tSync('errorUtils.connection.withCode', { code: connectionDetails.code })
    }
    return tSync('errorUtils.connection.failed')
  }

  // 防护：从 JSONL 反序列化时（如 --resume），错误对象可能是
  // 没有 `.message` 属性的普通对象。返回安全的回退值，
  // 而非 undefined，否则访问 `.length` 的调用方会崩溃。
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      tSync('errorUtils.api.errorWithStatus', { status: String(error.status ?? 'unknown') })
    )
  }

  const sanitizedMessage = sanitizeAPIError(error)
  // 如果清理后的消息与原始消息不同（即 HTML 被清理了），使用清理后的消息
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}
