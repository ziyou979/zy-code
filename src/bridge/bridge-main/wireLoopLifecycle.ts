import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { WireFatalError } from '../bridgeApi.js'
import { formatDuration } from '../bridgeStatusUtil.js'
import { createTokenRefreshScheduler } from '../jwtUtils.js'
import type { SessionHandle, WireApiClient, WireConfig, WireLogger } from '../types.js'
import { STATUS_UPDATE_INTERVAL_MS } from './wireLoopSupport.js'

export type HeartbeatResult = 'ok' | 'auth_failed' | 'fatal' | 'failed'

type HeartbeatContext = {
  activeSessions: Map<string, SessionHandle>
  sessionWorkIds: Map<string, string>
  sessionIngressTokens: Map<string, string>
  api: WireApiClient
  environmentId: string
  logger: WireLogger
}

/** 对活跃工作项发送心跳，并在 JWT 失效时触发服务端重新分发。 */
export async function heartbeatActiveWorkItems({
  activeSessions,
  sessionWorkIds,
  sessionIngressTokens,
  api,
  environmentId,
  logger,
}: HeartbeatContext): Promise<HeartbeatResult> {
  let anySuccess = false
  let anyFatal = false
  const authFailedSessions: string[] = []
  for (const [sessionId] of activeSessions) {
    const workId = sessionWorkIds.get(sessionId)
    const ingressToken = sessionIngressTokens.get(sessionId)
    if (!workId || !ingressToken) continue
    try {
      await api.heartbeatWork(environmentId, workId, ingressToken)
      anySuccess = true
    } catch (error) {
      logForDebugging(
        `[bridge:heartbeat] Failed for sessionId=${sessionId} workId=${workId}: ${errorMessage(error)}`,
      )
      if (error instanceof WireFatalError) {
        logEvent('zy_bridge_heartbeat_error', {
          status:
            error.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_type: (error.status === 401 || error.status === 403
            ? 'auth_failed'
            : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        if (error.status === 401 || error.status === 403) authFailedSessions.push(sessionId)
        else anyFatal = true
      }
    }
  }

  for (const sessionId of authFailedSessions) {
    logger.logVerbose(`Session ${sessionId} token expired — re-queuing via bridge/reconnect`)
    try {
      await api.reconnectSession(environmentId, sessionId)
      logForDebugging(`[bridge:heartbeat] Re-queued sessionId=${sessionId} via bridge/reconnect`)
    } catch (error) {
      logger.logError(`Failed to refresh session ${sessionId} token: ${errorMessage(error)}`)
      logForDebugging(
        `[bridge:heartbeat] reconnectSession(${sessionId}) failed: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }
  if (anyFatal) return 'fatal'
  if (authFailedSessions.length > 0) return 'auth_failed'
  return anySuccess ? 'ok' : 'failed'
}

type StatusContext = {
  activeSessions: Map<string, SessionHandle>
  sessionStartTimes: Map<string, number>
  sessionCompatIds: Map<string, string>
  config: WireConfig
  logger: WireLogger
}

/** 封装状态刷新定时器，避免轮询编排函数同时管理展示细节。 */
export function createStatusController(context: StatusContext): {
  update: () => void
  start: () => void
  stop: () => void
} {
  let timer: ReturnType<typeof setInterval> | null = null
  const update = (): void => {
    const { activeSessions, sessionStartTimes, sessionCompatIds, config, logger } = context
    logger.updateSessionCount(activeSessions.size, config.maxSessions, config.spawnMode)
    for (const [sessionId, handle] of activeSessions) {
      if (handle.currentActivity) {
        logger.updateSessionActivity(
          sessionCompatIds.get(sessionId) ?? sessionId,
          handle.currentActivity,
        )
      }
    }
    if (activeSessions.size === 0) {
      logger.updateIdleStatus()
      return
    }
    const [sessionId, handle] = [...activeSessions.entries()].pop()!
    const startTime = sessionStartTimes.get(sessionId)
    const activity = handle.currentActivity
    if (!startTime || !activity || activity.type === 'result' || activity.type === 'error') {
      if (config.maxSessions > 1) logger.refreshDisplay()
      return
    }
    const trail = handle.activities
      .filter((item) => item.type === 'tool_start')
      .slice(-5)
      .map((item) => item.summary)
    logger.updateSessionStatus(sessionId, formatDuration(Date.now() - startTime), activity, trail)
  }
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const start = (): void => {
    stop()
    update()
    timer = setInterval(update, STATUS_UPDATE_INTERVAL_MS)
  }
  return { update, start, stop }
}

/** 初始化只与展示有关的日志器状态。 */
export function initializeWireLogger(
  logger: WireLogger,
  config: WireConfig,
  environmentId: string,
  initialSessionId?: string,
): void {
  logForDebugging(
    `[bridge:work] Starting poll loop spawnMode=${config.spawnMode} maxSessions=${config.maxSessions} environmentId=${environmentId}`,
  )
  logForDiagnosticsNoPII('info', 'bridge_loop_started', {
    max_sessions: config.maxSessions,
    spawn_mode: config.spawnMode,
  })
  if (isInternalBuild()) {
    let debugGlob: string
    if (config.debugFile) {
      const extensionIndex = config.debugFile.lastIndexOf('.')
      debugGlob =
        extensionIndex > 0
          ? `${config.debugFile.slice(0, extensionIndex)}-*${config.debugFile.slice(extensionIndex)}`
          : `${config.debugFile}-*`
    } else {
      debugGlob = join(tmpdir(), 'zy', 'bridge-session-*.log')
    }
    logger.setDebugLogPath(debugGlob)
  }
  logger.printBanner(config, environmentId)
  logger.updateSessionCount(0, config.maxSessions, config.spawnMode)
  if (initialSessionId) logger.setAttached(initialSessionId)
}

/** 跟踪关闭前必须等待的异步清理任务。 */
export function createCleanupTracker(): {
  pending: Set<Promise<unknown>>
  track: (promise: Promise<unknown>) => void
} {
  const pending = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>): void => {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }
  return { pending, track }
}

type TokenRefreshContext = {
  getAccessToken?: () => string | undefined | Promise<string | undefined>
  activeSessions: Map<string, SessionHandle>
  v2Sessions: Set<string>
  api: WireApiClient
  environmentId: string
  logger: WireLogger
}

/** 为 v1/v2 会话建立各自正确的令牌刷新路径。 */
export function createWireTokenRefresh({
  getAccessToken,
  activeSessions,
  v2Sessions,
  api,
  environmentId,
  logger,
}: TokenRefreshContext): ReturnType<typeof createTokenRefreshScheduler> | null {
  if (!getAccessToken) return null
  return createTokenRefreshScheduler({
    getAccessToken,
    onRefresh: (sessionId, oauthToken) => {
      const handle = activeSessions.get(sessionId)
      if (!handle) return
      if (!v2Sessions.has(sessionId)) {
        handle.updateAccessToken(oauthToken)
        return
      }
      logger.logVerbose(`Refreshing session ${sessionId} token via bridge/reconnect`)
      void api.reconnectSession(environmentId, sessionId).catch((error: unknown) => {
        logger.logError(`Failed to refresh session ${sessionId} token: ${errorMessage(error)}`)
        logForDebugging(
          `[bridge:token] reconnectSession(${sessionId}) failed: ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    },
    label: 'bridge',
  })
}
