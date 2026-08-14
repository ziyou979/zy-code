import { isAbortError as isLlmAbortError } from '../types/llm.js'

export class ZyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class MalformedCommandError extends Error {}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * 当且仅当 `e` 是代码库中可能出现的任一中止类错误时返回 true：
 * 自定义 AbortError、AbortController.abort() 产生的 DOMException
 *（.name === 'AbortError'），或 SDK 的 APIUserAbortError。SDK 类通过 instanceof 检查，
 * 因为压缩 build 会改写类名，constructor.name 可能变为 'nJT' 之类，
 * 且 SDK 从不设置 this.name，字符串匹配会在生产环境静默失败。
 */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError || isLlmAbortError(e) || (e instanceof Error && e.name === 'AbortError')
  )
}

/**
 * 配置文件解析错误的自定义错误类。
 * 包含文件路径和应使用的默认配置。
 */
export class ConfigParseError extends Error {
  filePath: string
  defaultConfig: unknown

  constructor(message: string, filePath: string, defaultConfig: unknown) {
    super(message)
    this.name = 'ConfigParseError'
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}

export class ShellError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    super('Shell command failed')
    this.name = 'ShellError'
  }
}

export class TeleportOperationError extends Error {
  constructor(
    message: string,
    public readonly formattedMessage: string,
  ) {
    super(message)
    this.name = 'TeleportOperationError'
  }
}

/**
 * 消息可安全记录到 telemetry 的错误。
 * 长类名用于强调：必须已确认消息不包含敏感数据
 *（文件路径、URL、代码片段）。
 *
 * 单参数：用户和 telemetry 使用同一条消息。
 * 双参数：分别使用不同消息（如完整消息含文件路径，telemetry 消息不含）。
 *
 * @example
 * // Same message for both
 * throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
 *   'MCP server "slack" connection timed out'
 * )
 *
 * // Different messages
 * throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
 *   `MCP tool timed out after ${ms}ms`,  // Full message for logs/user
 *   'MCP tool timed out'                  // Telemetry message
 * )
 */
export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  readonly telemetryMessage: string

  constructor(message: string, telemetryMessage?: string) {
    super(message)
    this.name = 'TelemetrySafeError'
    this.telemetryMessage = telemetryMessage ?? message
  }
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message
}

/**
 * 将 unknown 值规范化为 Error。
 * 在 catch 边界需要 Error 实例时使用。
 */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * 从 unknown 错误类值中提取字符串消息。
 * 仅需消息时使用（如记录日志或显示）。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 从捕获的错误中提取 errno code（如 'ENOENT'、'EACCES'）。
 * 错误没有 code 或不是 ErrnoException 时返回 undefined。
 * 用于替代 `(e as NodeJS.ErrnoException).code` 断言模式。
 */
export function getErrnoCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  return undefined
}

/**
 * 错误为 ENOENT（文件或目录不存在）时返回 true。
 * 用于替代 `(e as NodeJS.ErrnoException).code === 'ENOENT'`。
 */
export function isENOENT(e: unknown): boolean {
  return getErrnoCode(e) === 'ENOENT'
}

/**
 * 从捕获的错误中提取 errno path（触发错误的文件系统路径）。
 * 错误没有 path 时返回 undefined。
 * 用于替代 `(e as NodeJS.ErrnoException).path` 断言模式。
 */
export function getErrnoPath(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'path' in e && typeof e.path === 'string') {
    return e.path
  }
  return undefined
}

/**
 * 从 unknown 错误中提取错误消息和前 N 个堆栈帧。
 * 错误作为 tool_result 流向 model 时使用：完整堆栈约有 500–2000 个字符，
 * 且大多是无关的内部帧，会浪费 context token。完整堆栈应保留在 debug 日志中。
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error)) {
    return String(e)
  }
  if (!e.stack) {
    return e.message
  }
  // V8/Bun 堆栈格式："Name: message\n    at frame1\n    at frame2..."
  // 首行是消息，后续 "    at " 行是堆栈帧。
  const lines = e.stack.split('\n')
  const header = lines[0] ?? e.message
  const frames = lines.slice(1).filter((l) => l.trim().startsWith('at '))
  if (frames.length <= maxFrames) {
    return e.stack
  }
  return [header, ...frames.slice(0, maxFrames)].join('\n')
}

/**
 * 错误表示路径缺失、无法访问或结构上不可达时返回 true。
 * 用于 fs 操作后的 catch block，区分预期的“不存在 / 无权访问”与意外错误。
 *
 * Covers:
 *  ENOENT    — path does not exist
 *  EACCES    — permission denied
 *  EPERM     — operation not permitted
 *  ENOTDIR   — a path component is not a directory (e.g. a file named
 *              `.zy` exists where a directory is expected)
 *  ELOOP     — too many symlink levels (circular symlinks)
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  const code = getErrnoCode(e)
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  )
}

export type AxiosErrorKind =
  | 'auth' // 401/403 — caller typically sets skipRetry
  | 'timeout' // ECONNABORTED
  | 'network' // ECONNREFUSED/ENOTFOUND
  | 'http' // other axios error (may have status)
  | 'other' // not an axios error

/**
 * 将 axios 请求捕获的错误归入少数几个类别。
 * 用于替代多个同步式 service（settingsSync、policyLimits、remoteManagedSettings、
 * teamMemorySync）中重复的约 20 行 isAxiosError → 401/403 → ECONNABORTED → ECONNREFUSED 判断链。
 *
 * 直接检查 `.isAxiosError` 标记属性（与 axios.isAxiosError() 等价），
 * 以保持本模块无依赖。
 */
export function classifyAxiosError(e: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  const message = errorMessage(e)
  if (!e || typeof e !== 'object' || !('isAxiosError' in e) || !e.isAxiosError) {
    return { kind: 'other', message }
  }
  const err = e as {
    response?: { status?: number }
    code?: string
  }
  const status = err.response?.status
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message }
  }
  if (err.code === 'ECONNABORTED') {
    return { kind: 'timeout', status, message }
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return { kind: 'network', status, message }
  }
  return { kind: 'http', status, message }
}
