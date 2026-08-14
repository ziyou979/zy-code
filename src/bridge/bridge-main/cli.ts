import { feature } from 'bun:bundle'
import { resolve } from 'node:path'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { errorMessage } from '../../utils/errors.js'
import { truncateToWidth } from '../../utils/format.js'
import { sleep } from '../../utils/sleep.js'
import { isSuppressible403, WireFatalError } from '../bridgeApi.js'
import { formatDuration } from '../bridgeStatusUtil.js'
import {
  type SessionHandle,
  type SpawnMode,
  type WireApiClient,
  type WireLogger,
} from '../types.js'
import { SPAWN_SESSIONS_DEFAULT, isMultiSessionSpawnEnabled } from './wirePollingPolicy.js'
export const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

export function isConnectionError(err: unknown): boolean {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    CONNECTION_ERROR_CODES.has(err.code)
  ) {
    return true
  }
  return false
}

/** 识别 axios 返回的 HTTP 5xx 错误（code 为 `ERR_BAD_RESPONSE`）。 */
export function isServerError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code === 'ERR_BAD_RESPONSE'
  )
}

/** 为延迟时间增加 ±25% 的随机抖动。 */
export function addJitter(ms: number): number {
  return Math.max(0, ms + ms * 0.25 * (2 * Math.random() - 1))
}

export function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * 以指数退避重试 stopWork（最多尝试 3 次，重试间隔为 1s/2s）。
 * 确保服务端获知工作项已经结束，避免残留僵尸任务。
 */
export async function stopWorkWithRetry(
  api: WireApiClient,
  environmentId: string,
  workId: string,
  logger: WireLogger,
  baseDelayMs = 1000,
): Promise<void> {
  const MAX_ATTEMPTS = 3

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await api.stopWork(environmentId, workId, false)
      logForDebugging(
        `[bridge:work] stopWork succeeded for workId=${workId} on attempt ${attempt}/${MAX_ATTEMPTS}`,
      )
      return
    } catch (err) {
      // 重试无法解决认证或权限错误
      if (err instanceof WireFatalError) {
        if (isSuppressible403(err)) {
          logForDebugging(`[bridge:work] Suppressed stopWork 403 for ${workId}: ${err.message}`)
        } else {
          logger.logError(`Failed to stop work ${workId}: ${err.message}`)
        }
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: attempt,
          fatal: true,
        })
        return
      }
      const errMsg = errorMessage(err)
      if (attempt < MAX_ATTEMPTS) {
        const delay = addJitter(baseDelayMs * 2 ** (attempt - 1))
        logger.logVerbose(
          `Failed to stop work ${workId} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${formatDelay(delay)}: ${errMsg}`,
        )
        await sleep(delay)
      } else {
        logger.logError(`Failed to stop work ${workId} after ${MAX_ATTEMPTS} attempts: ${errMsg}`)
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: MAX_ATTEMPTS,
        })
      }
    }
  }
}

export function onSessionTimeout(
  sessionId: string,
  timeoutMs: number,
  logger: WireLogger,
  timedOutSessions: Set<string>,
  handle: SessionHandle,
): void {
  logForDebugging(
    `[bridge:session] sessionId=${sessionId} timed out after ${formatDuration(timeoutMs)}`,
  )
  logEvent('zy_bridge_session_timeout', {
    timeout_ms: timeoutMs,
  })
  logger.logSessionFailed(sessionId, `Session timed out after ${formatDuration(timeoutMs)}`)
  timedOutSessions.add(sessionId)
  handle.kill()
}

export type ParsedArgs = {
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  sessionTimeoutMs?: number
  permissionMode?: string
  name?: string
  /** 传给 --spawn 的值；未提供该参数时为 undefined。 */
  spawnMode: SpawnMode | undefined
  /** 传给 --capacity 的值；未提供该参数时为 undefined。 */
  capacity: number | undefined
  /** --[no-]create-session-in-dir 的覆盖值；undefined 表示使用默认值（开启）。 */
  createSessionInDir: boolean | undefined
  /** 恢复已有会话，而不是新建会话。 */
  sessionId?: string
  /** 恢复此目录中的上一个会话（读取 bridge-pointer.json）。 */
  continueSession: boolean
  help: boolean
  error?: string
}

export const SPAWN_FLAG_VALUES = ['session', 'same-dir', 'worktree'] as const

export function parseSpawnValue(raw: string | undefined): SpawnMode | string {
  if (raw === 'session') {
    return 'single-session'
  }
  if (raw === 'same-dir') {
    return 'same-dir'
  }
  if (raw === 'worktree') {
    return 'worktree'
  }
  return `--spawn requires one of: ${SPAWN_FLAG_VALUES.join(', ')} (got: ${raw ?? '<missing>'})`
}

export function parseCapacityValue(raw: string | undefined): number | string {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    return `--capacity requires a positive integer (got: ${raw ?? '<missing>'})`
  }
  const value = Number(raw)
  return Number.isSafeInteger(value)
    ? value
    : `--capacity requires a positive integer (got: ${raw})`
}

export function parseSessionTimeoutValue(raw: string | undefined): number | string {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    return `--session-timeout requires a positive integer (got: ${raw ?? '<missing>'})`
  }
  const seconds = Number(raw)
  if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1000) {
    return `--session-timeout requires a positive integer (got: ${raw})`
  }
  return seconds * 1000
}

export function parseArgs(args: string[]): ParsedArgs {
  let verbose = false
  let sandbox = false
  let debugFile: string | undefined
  let sessionTimeoutMs: number | undefined
  let permissionMode: string | undefined
  let name: string | undefined
  let help = false
  let spawnMode: SpawnMode | undefined
  let capacity: number | undefined
  let createSessionInDir: boolean | undefined
  let sessionId: string | undefined
  let continueSession = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--sandbox') {
      sandbox = true
    } else if (arg === '--no-sandbox') {
      sandbox = false
    } else if (arg === '--debug-file' && i + 1 < args.length) {
      debugFile = resolve(args[++i]!)
    } else if (arg.startsWith('--debug-file=')) {
      debugFile = resolve(arg.slice('--debug-file='.length))
    } else if (arg === '--session-timeout' || arg.startsWith('--session-timeout=')) {
      const raw = arg.startsWith('--session-timeout=')
        ? arg.slice('--session-timeout='.length)
        : args[++i]
      const value = parseSessionTimeoutValue(raw)
      if (typeof value === 'string') {
        return makeError(value)
      }
      sessionTimeoutMs = value
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--name' && i + 1 < args.length) {
      name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (feature('KAIROS') ? arg === '--session-id' && i + 1 < args.length : false) {
      sessionId = args[++i]!
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') ? arg.startsWith('--session-id=') : false) {
      sessionId = arg.slice('--session-id='.length)
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') ? arg === '--continue' || arg === '-c' : false) {
      continueSession = true
    } else if (arg === '--spawn' || arg.startsWith('--spawn=')) {
      if (spawnMode !== undefined) {
        return makeError('--spawn may only be specified once')
      }
      const raw = arg.startsWith('--spawn=') ? arg.slice('--spawn='.length) : args[++i]
      const v = parseSpawnValue(raw)
      if (v === 'single-session' || v === 'same-dir' || v === 'worktree') {
        spawnMode = v
      } else {
        return makeError(v)
      }
    } else if (arg === '--capacity' || arg.startsWith('--capacity=')) {
      if (capacity !== undefined) {
        return makeError('--capacity may only be specified once')
      }
      const raw = arg.startsWith('--capacity=') ? arg.slice('--capacity='.length) : args[++i]
      const v = parseCapacityValue(raw)
      if (typeof v === 'number') {
        capacity = v
      } else {
        return makeError(v)
      }
    } else if (arg === '--create-session-in-dir') {
      createSessionInDir = true
    } else if (arg === '--no-create-session-in-dir') {
      createSessionInDir = false
    } else {
      return makeError(`Unknown argument: ${arg}\nRun 'zy remote-control --help' for usage.`)
    }
  }

  // --spawn/--capacity/--create-session-in-dir 的功能开关检查位于 bridgeMain，
  // 以便给出与开关状态对应的错误；此处只做参数间的交叉校验。

  // --capacity 仅适用于多会话模式。
  if (spawnMode === 'single-session' && capacity !== undefined) {
    return makeError(
      `--capacity cannot be used with --spawn=session (single-session mode has fixed capacity 1).`,
    )
  }

  // --session-id 和 --continue 都会在原环境中恢复特定会话，因此不能与配置新会话创建方式的
  // spawn 相关参数共用，二者之间也互斥。
  if (
    (sessionId || continueSession) &&
    (spawnMode !== undefined || capacity !== undefined || createSessionInDir !== undefined)
  ) {
    return makeError(
      `--session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.`,
    )
  }
  if (sessionId && continueSession) {
    return makeError(`--session-id and --continue cannot be used together.`)
  }

  return {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode,
    capacity,
    createSessionInDir,
    sessionId,
    continueSession,
    help,
  }

  function makeError(error: string): ParsedArgs {
    return {
      verbose,
      sandbox,
      debugFile,
      sessionTimeoutMs,
      permissionMode,
      name,
      spawnMode,
      capacity,
      createSessionInDir,
      sessionId,
      continueSession,
      help,
      error,
    }
  }
}

export async function printHelp(): Promise<void> {
  // 帮助文本仅展示 EXTERNAL_PERMISSION_MODES；内部模式 bubble 仅供 ant 使用，auto 受功能开关
  // 控制，但参数校验仍会接受这些值。
  const { EXTERNAL_PERMISSION_MODES } = await import('../../types/permissions.js')
  const modes = EXTERNAL_PERMISSION_MODES.join(', ')
  const showServer = await isMultiSessionSpawnEnabled()
  const serverOptions = showServer
    ? `  --spawn <mode>                   Spawn mode: same-dir, worktree, session
                                   (default: same-dir)
  --capacity <N>                   Max concurrent sessions in worktree or
                                   same-dir mode (default: ${SPAWN_SESSIONS_DEFAULT})
  --[no-]create-session-in-dir     Pre-create a session in the current
                                   directory; in worktree mode this session
                                   stays in cwd while on-demand sessions get
                                   isolated worktrees (default: on)
`
    : ''
  const serverDescription = showServer
    ? `
  Remote Control runs as a persistent server that accepts multiple concurrent
  sessions in the current directory. One session is pre-created on start so
  you have somewhere to type immediately. Use --spawn=worktree to isolate
  each on-demand session in its own git worktree, or --spawn=session for
  the classic single-session mode (exits when that session ends). Press 'w'
  during runtime to toggle between same-dir and worktree.
`
    : ''
  const serverNote = showServer
    ? `  - Worktree mode requires a git repository or WorktreeCreate/WorktreeRemove hooks
`
    : ''
  const help = `
Remote Control - Connect your local environment to zy-code

USAGE
  zy remote-control [options]
OPTIONS
  --name <name>                    Name for the session (shown in zy-code)
${
  feature('KAIROS')
    ? `  -c, --continue                   Resume the last session in this directory
  --session-id <id>                Resume a specific session by ID (cannot be
                                   used with spawn flags or --continue)
`
    : ''
}  --permission-mode <mode>         Permission mode for spawned sessions
                                   (${modes})
  --debug-file <path>              Write debug logs to file
  -v, --verbose                    Enable verbose output
  -h, --help                       Show this help
${serverOptions}
DESCRIPTION
  Remote Control allows you to control sessions on your local device from
  zy.ai/code (https://zy.ai/code). Run this command in the
  directory you want to work in, then connect from the Zy app or web.
${serverDescription}
NOTES
  - You must be logged in with a Zy account that has a subscription
  - Run \`zy\` first in the directory to accept the workspace trust dialog
${serverNote}`
  // biome-ignore lint/suspicious/noConsole: intentional help output
  console.log(help)
}

export const TITLE_MAX_LEN = 80

/** 从用户消息生成会话标题：取第一行并截断。 */
export function deriveSessionTitle(text: string): string {
  // 合并空白字符，避免换行符或制表符破坏单行状态展示。
  const flat = text.replace(/\s+/g, ' ').trim()
  return truncateToWidth(flat, TITLE_MAX_LEN)
}

/**
 * 通过 GET /v1/sessions/{id} 单次获取会话标题。
 *
 * 这里使用 createSession.ts 中的 `getWireSession`（携带 ccr-byoc 标头和组织 UUID），
 * 不使用环境层级的 bridgeApi 客户端，因为后者的标头会导致 Sessions API 返回 404。
 * 会话尚无标题或获取失败时返回 undefined，由调用方改为根据第一条用户消息生成标题。
 */
export async function fetchSessionTitle(
  compatSessionId: string,
  baseUrl: string,
): Promise<string | undefined> {
  const { getWireSession } = await import('../createSession.js')
  const session = await getWireSession(compatSessionId, { baseUrl })
  return session?.title || undefined
}
