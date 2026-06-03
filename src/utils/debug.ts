import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import memoize from 'lodash-es/memoize.js'
import { getSessionId } from 'src/bootstrap/state.js'

import { type BufferedWriter, createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { type DebugFilter, parseDebugFilter, shouldShowDebugMessage } from './debugFilter.js'
import { getZyConfigHomeDir, isEnvTruthy, isInternalBuild } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slowOperations.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

// --- DebugContext: 轻量关联上下文，用于关联并发请求/agent 的日志 ---

export type DebugContext = {
  reqId?: string
  turnId?: number
}

const debugContextStorage = new AsyncLocalStorage<DebugContext>()

export function getDebugContext(): DebugContext | undefined {
  return debugContextStorage.getStore()
}

export function runWithDebugContext<T>(ctx: DebugContext, fn: () => T): T {
  return debugContextStorage.run(ctx, fn)
}

export function setDebugContextField(field: Partial<DebugContext>): void {
  const current = debugContextStorage.getStore()
  if (current) {
    Object.assign(current, field)
  }
}

function formatDebugContextPrefix(): string {
  const ctx = debugContextStorage.getStore()
  let agentLabel: string | undefined
  try {
    // 懒加载避免循环依赖，getAgentContext 来自 agentContext.ts
    const { getAgentContext } = require('./agentContext.js')
    const agentCtx = getAgentContext()
    if (agentCtx) {
      agentLabel =
        agentCtx.agentType === 'teammate' ? agentCtx.agentName : agentCtx.subagentName || 'subagent'
    }
  } catch {
    // agentContext 尚未加载
  }

  if (!ctx && !agentLabel) {
    return ''
  }

  const parts: string[] = []
  if (agentLabel) {
    parts.push(`agent=${agentLabel}`)
  }
  if (ctx?.turnId !== undefined) {
    parts.push(`turn=${ctx.turnId}`)
  }
  if (ctx?.reqId) {
    parts.push(`req=${ctx.reqId}`)
  }
  return parts.length > 0 ? `[${parts.join(' ')}] ` : ''
}

/**
 * Minimum log level to include in debug output. Defaults to 'debug', which
 * filters out 'verbose' messages. Set ZY_CODE_DEBUG_LOG_LEVEL=verbose to
 * include high-volume diagnostics (e.g. full statusLine command, shell, cwd,
 * stdout/stderr) that would otherwise drown out useful debug output.
 */
export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.ZY_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    // Also check for --debug=pattern syntax
    process.argv.some((arg) => arg.startsWith('--debug=')) ||
    // --debug-file implicitly enables debug mode
    getDebugFilePath() !== null ||
    // --debug-format=json implicitly enables debug mode
    getDebugOutputFormat() === 'json'
  )
})

/**
 * Enables debug logging mid-session (e.g. via /debug). Non-ants don't write
 * debug logs by default, so this lets them start capturing without restarting
 * with --debug. Returns true if logging was already active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode() || isInternalBuild()
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

// Extract and parse debug filter from command line arguments
// Exported for testing purposes
export const getDebugFilter = memoize((): DebugFilter | null => {
  // Look for --debug=pattern in argv
  const debugArg = process.argv.find((arg) => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }

  // Extract the pattern after the equals sign
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export let isDebugToStdErr: (() => boolean) & { cache: { clear?(): void } }
isDebugToStdErr = memoize((): boolean => {
  return process.argv.includes('--debug-to-stderr') || process.argv.includes('-d2e')
})

export type DebugOutputFormat = 'text' | 'json'

export const getDebugOutputFormat = memoize((): DebugOutputFormat => {
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--debug-format' && process.argv[i + 1] === 'json') {
      return 'json'
    }
    if (process.argv[i] === '--debug-format=json') {
      return 'json'
    }
  }
  return 'text'
})

export let getDebugFilePath: (() => string | null) & { cache: { clear?(): void } }
getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  // Non-ants only write debug logs when debug mode is active (via --debug at
  // startup or /debug mid-session). Ants always log for /share, bug reports.
  if (!isInternalBuild() && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}

let hasFormattedOutput = false
export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}
export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()

// Module-level so .bind captures only its explicit args, not the
// writeFn closure's parent scope (Jarred, #22257).
async function appendAsync(
  needMkdir: boolean,
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  if (needMkdir) {
    await mkdir(dir, { recursive: true }).catch(() => {})
  }
  await appendFile(path, content)
  void updateLatestDebugLogSymlink()
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: (content) => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode: must stay sync. Async writes are lost on direct
          // process.exit() and keep the event loop alive in beforeExit
          // handlers (infinite loop with Perfetto tracing). See #22257.
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch {
              // Directory already exists
            }
          }
          getFsImplementation().appendFileSync(path, content)
          void updateLatestDebugLogSymlink()
          return
        }
        // Buffered path (ants without --debug): flushes ~1/sec so chain
        // depth stays ~1. .bind over a closure so only the bound args are
        // retained, not this scope.
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = {
    level: 'debug',
  },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  if (!shouldLogDebugMessage(message)) {
    return
  }
  const filter = getDebugFilter()
  if (filter?.minLevel && LEVEL_ORDER[level] < LEVEL_ORDER[filter.minLevel as DebugLogLevel]) {
    return
  }

  // Multiline messages break the jsonl output format, so make any multiline messages JSON.
  if (hasFormattedOutput && message.includes('\n')) {
    message = jsonStringify(message)
  }
  const timestamp = new Date().toISOString()
  const ctxPrefix = formatDebugContextPrefix()

  let output: string
  if (getDebugOutputFormat() === 'json') {
    const entry: Record<string, unknown> = { t: timestamp, l: level, m: message.trim() }
    const ctx = debugContextStorage.getStore()
    let agentLabel: string | undefined
    try {
      const { getAgentContext } = require('./agentContext.js')
      const agentCtx = getAgentContext()
      if (agentCtx) {
        agentLabel =
          agentCtx.agentType === 'teammate'
            ? agentCtx.agentName
            : agentCtx.subagentName || 'subagent'
      }
    } catch {
      // not loaded yet
    }
    if (ctx || agentLabel) {
      entry.ctx = {
        ...(agentLabel && { agent: agentLabel }),
        ...(ctx?.turnId !== undefined && { turn: ctx.turnId }),
        ...(ctx?.reqId && { req: ctx.reqId }),
      }
    }
    const bracketMatch = message.match(/^\[([^\]]+)]/)
    if (bracketMatch?.[1]) {
      entry.cat = bracketMatch[1]
    }
    output = jsonStringify(entry) + '\n'
  } else {
    output = `${timestamp} [${level.toUpperCase()}] ${ctxPrefix}${message.trim()}\n`
  }

  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }

  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  const ext = getDebugOutputFormat() === 'json' ? '.jsonl' : '.txt'
  return (
    getDebugFilePath() ??
    process.env.ZY_CODE_DEBUG_LOGS_DIR ??
    join(getZyConfigHomeDir(), 'debug', `${getSessionId()}${ext}`)
  )
}

/**
 * Updates the latest debug log symlink to point to the current debug log file.
 * Creates or updates a symlink at ~/.zy/debug/latest
 */
let updateLatestDebugLogSymlink: (() => Promise<void>) & { cache: { clear?(): void } }
updateLatestDebugLogSymlink = memoize(async (): Promise<void> => {
  try {
    const debugLogPath = getDebugLogPath()
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
  } catch {
    // Silently fail if symlink creation fails
  }
})

/**
 * Logs errors for Ants only, always visible in production.
 */
export function logAntError(context: string, error: unknown): void {
  if (!isInternalBuild()) {
    return
  }

  if (error instanceof Error && error.stack) {
    logForDebugging(`[INNER-ONLY] ${context} stack trace:\n${error.stack}`, {
      level: 'error',
    })
  }
}

/**
 * 创建带固定 category 前缀的 debug 日志函数。
 * 每个模块在顶部调用一次即可：`const log = createDebugLog('api')`
 */
export function createDebugLog(category: string) {
  return function debugLog(message: string, options?: { level?: DebugLogLevel }): void {
    logForDebugging(`[${category}] ${message}`, { level: options?.level ?? 'debug' })
  }
}

/**
 * 计时包装器，自动记录异步操作的耗时到 debug 日志。
 */
export async function withDebugTiming<T>(
  category: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    logForDebugging(`[${category}] ${operation} ${Math.round(performance.now() - start)}ms`)
    return result
  } catch (e) {
    logForDebugging(
      `[${category}] ${operation} FAILED ${Math.round(performance.now() - start)}ms`,
      { level: 'error' },
    )
    throw e
  }
}

/**
 * 通用的 Logger 适配器，将标准 Logger 接口桥接到 logForDebugging。
 * 适用于需要 Logger 实例的第三方库（MCP server、computer-use 等）。
 */
export class DebugLogger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}
