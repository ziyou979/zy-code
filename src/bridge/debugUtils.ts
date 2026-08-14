import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from '../services/infra/debug.js'
import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
const DEBUG_MSG_LIMIT = 2000

const SECRET_FIELD_NAMES = [
  'session_ingress_token',
  'environment_secret',
  'access_token',
  'secret',
  'token',
]

const SECRET_PATTERN = new RegExp(`"(${SECRET_FIELD_NAMES.join('|')})"\\s*:\\s*"([^"]*)"`, 'g')

const REDACT_MIN_LENGTH = 16

export function redactSecrets(s: string): string {
  return s.replace(SECRET_PATTERN, (_match, field: string, value: string) => {
    if (value.length < REDACT_MIN_LENGTH) {
      return `"${field}":"[REDACTED]"`
    }
    const redacted = `${value.slice(0, 8)}...${value.slice(-4)}`
    return `"${field}":"${redacted}"`
  })
}

/** 截断 debug 日志字符串，并折叠换行。 */
export function debugTruncate(s: string): string {
  const flat = s.replace(/\n/g, '\\n')
  if (flat.length <= DEBUG_MSG_LIMIT) {
    return flat
  }
  return `${flat.slice(0, DEBUG_MSG_LIMIT)}... (${flat.length} chars)`
}

/** 截断用于 debug 日志的 JSON 可序列化值。 */
export function debugBody(data: unknown): string {
  const raw = typeof data === 'string' ? data : jsonStringify(data)
  const s = redactSecrets(raw)
  if (s.length <= DEBUG_MSG_LIMIT) {
    return s
  }
  return `${s.slice(0, DEBUG_MSG_LIMIT)}... (${s.length} chars)`
}

/**
 * 从 axios error（或任意 error）提取具有描述性的错误消息。
 * 对 HTTP 错误，若服务端响应 body 包含消息则附加该消息，因为 axios 默认消息只有状态码。
 */
export function describeAxiosError(err: unknown): string {
  const msg = errorMessage(err)
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: unknown } }).response
    if (response?.data && typeof response.data === 'object') {
      const data = response.data as Record<string, unknown>
      const detail =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'object' &&
              data.error &&
              'message' in data.error &&
              typeof (data.error as Record<string, unknown>).message === 'string'
            ? (data.error as Record<string, unknown>).message
            : undefined
      if (detail) {
        return `${msg}: ${detail}`
      }
    }
  }
  return msg
}

/**
 * 从 axios error 中提取 HTTP 状态码。非 HTTP 错误（如网络故障）返回 undefined。
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response?: { status?: unknown } }).response &&
    typeof (err as { response: { status?: unknown } }).response.status === 'number'
  ) {
    return (err as { response: { status: number } }).response.status
  }
  return undefined
}

/**
 * 从 API 错误响应 body 中提取便于阅读的消息。
 * 先检查 `data.message`，再检查 `data.error.message`。
 */
export function extractErrorDetail(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined
  }
  if ('message' in data && typeof data.message === 'string') {
    return data.message
  }
  if (
    'error' in data &&
    data.error !== null &&
    typeof data.error === 'object' &&
    'message' in data.error &&
    typeof data.error.message === 'string'
  ) {
    return data.error.message
  }
  return undefined
}

/**
 * 记录 bridge 初始化跳过事件：debug 消息 + `zy_bridge_repl_skipped` analytics event。
 * 统一管理 event 名称与 AnalyticsMetadata 断言，避免每个调用点重复 5 行模板代码。
 */
export function logWireSkip(reason: string, debugMsg?: string, v2?: boolean): void {
  if (debugMsg) {
    logForDebugging(debugMsg)
  }
  logEvent('zy_bridge_repl_skipped', {
    reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(v2 !== undefined && { v2 }),
  })
}
