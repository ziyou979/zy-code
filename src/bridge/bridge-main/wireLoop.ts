import { feature } from 'bun:bundle'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRemoteSessionUrl } from '../../constants/product.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import {
  isEnvTruthy,
  isInProtectedNamespace,
  isInternalBuild,
} from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { sleep } from '../../utils/sleep.js'
import { createAgentWorktree, removeAgentWorktree } from '../../services/worktree/worktree.js'
import {
  isExpiredErrorType,
  isSuppressible403,
  validateWireId,
  WireFatalError,
} from '../bridgeApi.js'
import { formatDuration } from '../bridgeStatusUtil.js'
import { createCapacityWake } from '../capacityWake.js'
import { describeAxiosError } from '../debugUtils.js'
import { getPollIntervalConfig } from '../pollConfig.js'
import { toCompatSessionId } from '../sessionIdCompat.js'
import { safeFilenameId } from '../sessionRunner.js'
import {
  DEFAULT_SESSION_TIMEOUT_MS,
  type SessionDoneStatus,
  type SessionHandle,
  type SessionSpawner,
  type WireApiClient,
  type WireConfig,
  type WireLogger,
} from '../types.js'
import {
  buildCCRv2SdkUrl,
  buildSdkUrl,
  decodeWorkSecret,
  registerWorker,
  sameSessionId,
} from '../workSecret.js'
import {
  BackoffConfig,
  DEFAULT_BACKOFF,
  pollSleepDetectionThresholdMs,
} from './wirePollingPolicy.js'
import { safeSpawn } from './sessionSpawner.js'
import {
  addJitter,
  deriveSessionTitle,
  fetchSessionTitle,
  formatDelay,
  isConnectionError,
  isServerError,
  onSessionTimeout,
  stopWorkWithRetry,
} from './cli.js'
import {
  createStatusController,
  createCleanupTracker,
  createWireTokenRefresh,
  heartbeatActiveWorkItems as heartbeatWireSessions,
  initializeWireLogger,
} from './wireLoopLifecycle.js'
export async function runWireLoop(
  config: WireConfig,
  environmentId: string,
  environmentSecret: string,
  api: WireApiClient,
  spawner: SessionSpawner,
  logger: WireLogger,
  signal: AbortSignal,
  backoffConfig: BackoffConfig = DEFAULT_BACKOFF,
  initialSessionId?: string,
  getAccessToken?: () => string | undefined | Promise<string | undefined>,
): Promise<void> {
  // Local abort controller so that onSessionDone can stop the poll loop.
  // Linked to the incoming signal so external aborts also work.
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const loopSignal = controller.signal

  const activeSessions = new Map<string, SessionHandle>()
  const sessionStartTimes = new Map<string, number>()
  const sessionWorkIds = new Map<string, string>()
  // Compat-surface ID (session_*) computed once at spawn and cached so
  // cleanup and status-update ticks use the same key regardless of whether
  // the zy_bridge_repl_v2_cse_shim_enabled gate flips mid-session.
  const sessionCompatIds = new Map<string, string>()
  // Session ingress JWTs for heartbeat auth, keyed by sessionId.
  // Stored separately from handle.accessToken because the token refresh
  // scheduler overwrites that field with the OAuth token (~3h55m in).
  const sessionIngressTokens = new Map<string, string>()
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const completedWorkIds = new Set<string>()
  const sessionWorktrees = new Map<
    string,
    {
      worktreePath: string
      worktreeBranch?: string
      gitRoot?: string
      hookBased?: boolean
    }
  >()
  // Track sessions killed by the timeout watchdog so onSessionDone can
  // distinguish them from server-initiated or shutdown interrupts.
  const timedOutSessions = new Set<string>()
  // Sessions that already have a title (server-set or bridge-derived) so
  // onFirstUserMessage doesn't clobber a user-assigned --name / web rename.
  // Keyed by compatSessionId to match logger.setSessionTitle's key.
  const titledSessions = new Set<string>()
  // Signal to wake the at-capacity sleep early when a session completes,
  // so the bridge can immediately accept new work.
  const capacityWake = createCapacityWake(loopSignal)

  const heartbeatActiveWorkItems = (): ReturnType<typeof heartbeatWireSessions> =>
    heartbeatWireSessions({
      activeSessions,
      sessionWorkIds,
      sessionIngressTokens,
      api,
      environmentId,
      logger,
    })

  // 记录必须通过服务端重新分发来刷新令牌的 CCR v2 会话。
  const v2Sessions = new Set<string>()

  const tokenRefresh = createWireTokenRefresh({
    getAccessToken,
    activeSessions,
    v2Sessions,
    api,
    environmentId,
    logger,
  })
  const loopStartTime = Date.now()
  const { pending: pendingCleanups, track: trackCleanup } = createCleanupTracker()
  let connBackoff = 0
  let generalBackoff = 0
  let connErrorStart: number | null = null
  let generalErrorStart: number | null = null
  let lastPollErrorTime: number | null = null
  // Set by WireFatalError and give-up paths so the shutdown block can
  // skip the resume message (resume is impossible after env expiry/auth
  // failure/sustained connection errors).
  let fatalExit = false

  initializeWireLogger(logger, config, environmentId, initialSessionId)
  const {
    update: updateStatusDisplay,
    start: startStatusUpdates,
    stop: stopStatusUpdates,
  } = createStatusController({
    activeSessions,
    sessionStartTimes,
    sessionCompatIds,
    config,
    logger,
  })

  function onSessionDone(
    sessionId: string,
    startTime: number,
    handle: SessionHandle,
  ): (status: SessionDoneStatus) => void {
    return (rawStatus: SessionDoneStatus): void => {
      const workId = sessionWorkIds.get(sessionId)
      activeSessions.delete(sessionId)
      sessionStartTimes.delete(sessionId)
      sessionWorkIds.delete(sessionId)
      sessionIngressTokens.delete(sessionId)
      const compatId = sessionCompatIds.get(sessionId) ?? sessionId
      sessionCompatIds.delete(sessionId)
      logger.removeSession(compatId)
      titledSessions.delete(compatId)
      v2Sessions.delete(sessionId)
      // Clear per-session timeout timer
      const timer = sessionTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        sessionTimers.delete(sessionId)
      }
      // Clear token refresh timer
      tokenRefresh?.cancel(sessionId)
      // Wake the at-capacity sleep so the bridge can accept new work immediately
      capacityWake.wake()

      // If the session was killed by the timeout watchdog, treat it as a
      // failed session (not a server/shutdown interrupt) so we still call
      // stopWork and archiveSession below.
      const wasTimedOut = timedOutSessions.delete(sessionId)
      const status: SessionDoneStatus =
        wasTimedOut && rawStatus === 'interrupted' ? 'failed' : rawStatus
      const durationMs = Date.now() - startTime

      logForDebugging(
        `[bridge:session] sessionId=${sessionId} workId=${workId ?? 'unknown'} exited status=${status} duration=${formatDuration(durationMs)}`,
      )
      logEvent('zy_bridge_session_done', {
        status: status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: durationMs,
      })
      logForDiagnosticsNoPII('info', 'bridge_session_done', {
        status,
        duration_ms: durationMs,
      })

      // Clear the status display before printing final log
      logger.clearStatus()
      stopStatusUpdates()

      // Build error message from stderr if available
      const stderrSummary = handle.lastStderr.length > 0 ? handle.lastStderr.join('\n') : undefined
      let failureMessage: string | undefined

      switch (status) {
        case 'completed':
          logger.logSessionComplete(sessionId, durationMs)
          break
        case 'failed':
          // Skip failure log during shutdown — the child exits non-zero when
          // killed, which is expected and not a real failure.
          // Also skip for timeout-killed sessions — the timeout watchdog
          // already logged a clear timeout message.
          if (!wasTimedOut && !loopSignal.aborted) {
            failureMessage = stderrSummary ?? 'Process exited with error'
            logger.logSessionFailed(sessionId, failureMessage)
            logError(new Error(`Bridge session failed: ${failureMessage}`))
          }
          break
        case 'interrupted':
          logger.logVerbose(`Session ${sessionId} interrupted`)
          break
      }

      // Notify the server that this work item is done. Skip for interrupted
      // sessions — interrupts are either server-initiated (the server already
      // knows) or caused by bridge shutdown (which calls stopWork() separately).
      if (status !== 'interrupted' && workId) {
        trackCleanup(
          stopWorkWithRetry(api, environmentId, workId, logger, backoffConfig.stopWorkBaseDelayMs),
        )
        completedWorkIds.add(workId)
      }

      // Clean up worktree if one was created for this session
      const wt = sessionWorktrees.get(sessionId)
      if (wt) {
        sessionWorktrees.delete(sessionId)
        trackCleanup(
          removeAgentWorktree(wt.worktreePath, wt.worktreeBranch, wt.gitRoot, wt.hookBased).catch(
            (err: unknown) =>
              logger.logVerbose(
                `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
              ),
          ),
        )
      }

      // Lifecycle decision: in multi-session mode, keep the bridge running
      // after a session completes. In single-session mode, abort the poll
      // loop so the bridge exits cleanly.
      if (status !== 'interrupted' && !loopSignal.aborted) {
        if (config.spawnMode !== 'single-session') {
          // Multi-session: archive the completed session so it doesn't linger
          // as stale in the web UI. archiveSession is idempotent (409 if already
          // archived), so double-archiving at shutdown is safe.
          // sessionId arrived as cse_* from the work poll (infrastructure-layer
          // tag). archiveSession hits /v1/sessions/{id}/archive which is the
          // compat surface and validates TagSession (session_*). Re-tag — same
          // UUID underneath.
          trackCleanup(
            api
              .archiveSession(compatId)
              .catch((err: unknown) =>
                logger.logVerbose(`Failed to archive session ${sessionId}: ${errorMessage(err)}`),
              ),
          )
          logForDebugging(
            `[bridge:session] Session ${status}, returning to idle (multi-session mode)`,
          )
        } else {
          // Single-session: coupled lifecycle — tear down environment
          logForDebugging(
            `[bridge:session] Session ${status}, aborting poll loop to tear down environment`,
          )
          controller.abort()
          return
        }
      }

      if (!loopSignal.aborted) {
        startStatusUpdates()
      }
    }
  }

  // Start the idle status display immediately — unless we have a pre-created
  // session, in which case setAttached() already set up the display and the
  // poll loop will start status updates when it picks up the session.
  if (!initialSessionId) {
    startStatusUpdates()
  }

  while (!loopSignal.aborted) {
    // Fetched once per iteration — the GrowthBook cache refreshes every
    // 5 min, so a loop running at the at-capacity rate picks up config
    // changes within one sleep cycle.
    const pollConfig = getPollIntervalConfig()

    try {
      const work = await api.pollForWork(
        environmentId,
        environmentSecret,
        loopSignal,
        pollConfig.reclaim_older_than_ms,
      )

      // Log reconnection if we were previously disconnected
      const wasDisconnected = connErrorStart !== null || generalErrorStart !== null
      if (wasDisconnected) {
        const disconnectedMs = Date.now() - (connErrorStart ?? generalErrorStart ?? Date.now())
        logger.logReconnected(disconnectedMs)
        logForDebugging(`[bridge:poll] Reconnected after ${formatDuration(disconnectedMs)}`)
        logEvent('zy_bridge_reconnected', {
          disconnected_ms: disconnectedMs,
        })
      }

      connBackoff = 0
      generalBackoff = 0
      connErrorStart = null
      generalErrorStart = null
      lastPollErrorTime = null

      // Null response = no work available in the queue.
      // Add a minimum delay to avoid hammering the server.
      if (!work) {
        // Use live check (not a snapshot) since sessions can end during poll.
        const atCap = activeSessions.size >= config.maxSessions
        if (atCap) {
          const atCapMs = pollConfig.multisession_poll_interval_ms_at_capacity
          // Heartbeat loops WITHOUT polling. When at-capacity polling is also
          // enabled (atCapMs > 0), the loop tracks a deadline and breaks out
          // to poll at that interval — heartbeat and poll compose instead of
          // one suppressing the other. We break out to poll when:
          //   - Poll deadline reached (atCapMs > 0 only)
          //   - Auth fails (JWT expired → poll refreshes tokens)
          //   - Capacity wake fires (session ended → poll for new work)
          //   - Loop aborted (shutdown)
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            logEvent('zy_bridge_heartbeat_mode_entered', {
              active_sessions: activeSessions.size,
              heartbeat_interval_ms: pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // Deadline computed once at entry — GB updates to atCapMs don't
            // shift an in-flight deadline (next entry picks up the new value).
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let hbResult: 'ok' | 'auth_failed' | 'fatal' | 'failed' = 'ok'
            let hbCycles = 0
            while (
              !loopSignal.aborted &&
              activeSessions.size >= config.maxSessions &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              // Re-read config each cycle so GrowthBook updates take effect
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) {
                break
              }

              // Capture capacity signal BEFORE the async heartbeat call so
              // a session ending during the HTTP request is caught by the
              // subsequent sleep (instead of being lost to a replaced controller).
              const cap = capacityWake.signal()

              hbResult = await heartbeatActiveWorkItems()
              if (hbResult === 'auth_failed' || hbResult === 'fatal') {
                cap.cleanup()
                break
              }

              hbCycles++
              await sleep(hbConfig.non_exclusive_heartbeat_interval_ms, cap.signal)
              cap.cleanup()
            }

            // Determine exit reason for telemetry
            const exitReason =
              hbResult === 'auth_failed' || hbResult === 'fatal'
                ? hbResult
                : loopSignal.aborted
                  ? 'shutdown'
                  : activeSessions.size < config.maxSessions
                    ? 'capacity_changed'
                    : pollDeadline !== null && Date.now() >= pollDeadline
                      ? 'poll_due'
                      : 'config_disabled'
            logEvent('zy_bridge_heartbeat_mode_exited', {
              reason: exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
              active_sessions: activeSessions.size,
            })
            if (exitReason === 'poll_due') {
              // bridgeApi throttles empty-poll logs (EMPTY_POLL_LOG_INTERVAL=100)
              // so the once-per-10min poll_due poll is invisible at counter=2.
              // Log it here so verification runs see both endpoints in the debug log.
              logForDebugging(
                `[bridge:poll] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
              )
            }

            // On auth_failed or fatal, sleep before polling to avoid a tight
            // poll+heartbeat loop. Auth_failed: heartbeatActiveWorkItems
            // already called reconnectSession — the sleep gives the server
            // time to propagate the re-queue. Fatal (404/410): may be a
            // single work item GCd while the environment is still valid.
            // Use atCapMs if enabled, else the heartbeat interval as a floor
            // (guaranteed > 0 here) so heartbeat-only configs don't tight-loop.
            if (hbResult === 'auth_failed' || hbResult === 'fatal') {
              const cap = capacityWake.signal()
              await sleep(
                atCapMs > 0 ? atCapMs : pollConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }
          } else if (atCapMs > 0) {
            // Heartbeat disabled: slow poll as liveness signal.
            const cap = capacityWake.signal()
            await sleep(atCapMs, cap.signal)
            cap.cleanup()
          }
        } else {
          const interval =
            activeSessions.size > 0
              ? pollConfig.multisession_poll_interval_ms_partial_capacity
              : pollConfig.multisession_poll_interval_ms_not_at_capacity
          await sleep(interval, loopSignal)
        }
        continue
      }

      // At capacity — we polled to keep the heartbeat alive, but cannot
      // accept new work right now. We still enter the switch below so that
      // token refreshes for existing sessions are processed (the case
      // 'session' handler checks for existing sessions before the inner
      // capacity guard).
      const atCapacityBeforeSwitch = activeSessions.size >= config.maxSessions

      // Skip work items that have already been completed and stopped.
      // The server may re-deliver stale work before processing our stop
      // request, which would otherwise cause a duplicate session spawn.
      if (completedWorkIds.has(work.id)) {
        logForDebugging(`[bridge:work] Skipping already-completed workId=${work.id}`)
        // Respect capacity throttle — without a sleep here, persistent stale
        // redeliveries would tight-loop at poll-request speed (the !work
        // branch above is the only sleep, and work != null skips it).
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(pollConfig.non_exclusive_heartbeat_interval_ms, cap.signal)
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(pollConfig.multisession_poll_interval_ms_at_capacity, cap.signal)
          }
          cap.cleanup()
        } else {
          await sleep(1000, loopSignal)
        }
        continue
      }

      // Decode the work secret for session spawning and to extract the JWT
      // used for the ack call below.
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        const errMsg = errorMessage(err)
        logger.logError(`Failed to decode work secret for workId=${work.id}: ${errMsg}`)
        logEvent('zy_bridge_work_secret_failed', {})
        // Can't ack (needs the JWT we failed to decode). stopWork uses OAuth,
        // so it's callable here — prevents XAUTOCLAIM from re-delivering this
        // poisoned item every reclaim_older_than_ms cycle.
        completedWorkIds.add(work.id)
        trackCleanup(
          stopWorkWithRetry(api, environmentId, work.id, logger, backoffConfig.stopWorkBaseDelayMs),
        )
        // Respect capacity throttle before retrying — without a sleep here,
        // repeated decode failures at capacity would tight-loop at
        // poll-request speed (work != null skips the !work sleep above).
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(pollConfig.non_exclusive_heartbeat_interval_ms, cap.signal)
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(pollConfig.multisession_poll_interval_ms_at_capacity, cap.signal)
          }
          cap.cleanup()
        }
        continue
      }

      // Explicitly acknowledge after committing to handle the work — NOT
      // before. The at-capacity guard inside case 'session' can break
      // without spawning; acking there would permanently lose the work.
      // Ack failures are non-fatal: server re-delivers, and existingHandle
      // / completedWorkIds paths handle the dedup.
      const ackWork = async (): Promise<void> => {
        logForDebugging(`[bridge:work] Acknowledging workId=${work.id}`)
        try {
          await api.acknowledgeWork(environmentId, work.id, secret.session_ingress_token)
        } catch (err) {
          logForDebugging(
            `[bridge:work] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
          )
        }
      }

      const workType: string = work.data.type
      switch (work.data.type) {
        case 'healthcheck':
          await ackWork()
          logForDebugging('[bridge:work] Healthcheck received')
          logger.logVerbose('Healthcheck received')
          break
        case 'session': {
          const sessionId = work.data.id
          try {
            validateWireId(sessionId, 'session_id')
          } catch {
            await ackWork()
            logger.logError(`Invalid session_id received: ${sessionId}`)
            break
          }

          // If the session is already running, deliver the fresh token so
          // the child process can reconnect its WebSocket with the new
          // session ingress token. This handles the case where the server
          // re-dispatches work for an existing session after the WS drops.
          const existingHandle = activeSessions.get(sessionId)
          if (existingHandle) {
            existingHandle.updateAccessToken(secret.session_ingress_token)
            sessionIngressTokens.set(sessionId, secret.session_ingress_token)
            sessionWorkIds.set(sessionId, work.id)
            // Re-schedule next refresh from the fresh JWT's expiry. onRefresh
            // branches on v2Sessions so both v1 and v2 are safe here.
            tokenRefresh?.schedule(sessionId, secret.session_ingress_token)
            logForDebugging(
              `[bridge:work] Updated access token for existing sessionId=${sessionId} workId=${work.id}`,
            )
            await ackWork()
            break
          }

          // At capacity — token refresh for existing sessions is handled
          // above, but we cannot spawn new ones. The post-switch capacity
          // sleep will throttle the loop; just break here.
          if (activeSessions.size >= config.maxSessions) {
            logForDebugging(
              `[bridge:work] At capacity (${activeSessions.size}/${config.maxSessions}), cannot spawn new session for workId=${work.id}`,
            )
            break
          }

          await ackWork()
          const spawnStartTime = Date.now()

          // CCR v2 path: register this bridge as the session worker, get the
          // epoch, and point the child at /v1/code/sessions/{id}. The child
          // already has the full v2 client (SSETransport + CCRClient) — same
          // code path environment-manager launches in containers.
          //
          // v1 path: Session-Ingress WebSocket. Uses config.sessionIngressUrl
          // (not secret.api_base_url, which may point to a remote proxy tunnel
          // that doesn't know about locally-created sessions).
          let sdkUrl: string
          let useCcrV2 = false
          let workerEpoch: number | undefined
          // Server decides per-session via the work secret; env var is the
          // ant-dev override (e.g. forcing v2 before the server flag is on).
          if (secret.use_code_sessions === true || isEnvTruthy(process.env.ZY_BRIDGE_USE_CCR)) {
            sdkUrl = buildCCRv2SdkUrl(config.apiBaseUrl, sessionId)
            // Retry once on transient failure (network blip, 500) before
            // permanently giving up and killing the session.
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                workerEpoch = await registerWorker(sdkUrl, secret.session_ingress_token)
                useCcrV2 = true
                logForDebugging(
                  `[bridge:session] CCR v2: registered worker sessionId=${sessionId} epoch=${workerEpoch} attempt=${attempt}`,
                )
                break
              } catch (err) {
                const errMsg = errorMessage(err)
                if (attempt < 2) {
                  logForDebugging(
                    `[bridge:session] CCR v2: registerWorker attempt ${attempt} failed, retrying: ${errMsg}`,
                  )
                  await sleep(2_000, loopSignal)
                  if (loopSignal.aborted) {
                    break
                  }
                  continue
                }
                logger.logError(
                  `CCR v2 worker registration failed for session ${sessionId}: ${errMsg}`,
                )
                logError(new Error(`registerWorker failed: ${errMsg}`))
                completedWorkIds.add(work.id)
                trackCleanup(
                  stopWorkWithRetry(
                    api,
                    environmentId,
                    work.id,
                    logger,
                    backoffConfig.stopWorkBaseDelayMs,
                  ),
                )
              }
            }
            if (!useCcrV2) {
              break
            }
          } else {
            sdkUrl = buildSdkUrl(config.sessionIngressUrl, sessionId)
          }

          // In worktree mode, on-demand sessions get an isolated git worktree
          // so concurrent sessions don't interfere with each other's file
          // changes. The pre-created initial session (if any) runs in
          // config.dir so the user's first session lands in the directory they
          // invoked `rc` from — matching the old single-session UX.
          // In same-dir and single-session modes, all sessions share config.dir.
          // Capture spawnMode before the await below — the `w` key handler
          // mutates config.spawnMode directly, and createAgentWorktree can
          // take 1-2s, so reading config.spawnMode after the await can
          // produce contradictory analytics (spawn_mode:'same-dir', in_worktree:true).
          const spawnModeAtDecision = config.spawnMode
          let sessionDir = config.dir
          let worktreeCreateMs = 0
          if (
            spawnModeAtDecision === 'worktree' &&
            (initialSessionId === undefined || !sameSessionId(sessionId, initialSessionId))
          ) {
            const wtStart = Date.now()
            try {
              const wt = await createAgentWorktree(`bridge-${safeFilenameId(sessionId)}`)
              worktreeCreateMs = Date.now() - wtStart
              sessionWorktrees.set(sessionId, {
                worktreePath: wt.worktreePath,
                worktreeBranch: wt.worktreeBranch,
                gitRoot: wt.gitRoot,
                hookBased: wt.hookBased,
              })
              sessionDir = wt.worktreePath
              logForDebugging(
                `[bridge:session] Created worktree for sessionId=${sessionId} at ${wt.worktreePath}`,
              )
            } catch (err) {
              const errMsg = errorMessage(err)
              logger.logError(`Failed to create worktree for session ${sessionId}: ${errMsg}`)
              logError(new Error(`Worktree creation failed: ${errMsg}`))
              completedWorkIds.add(work.id)
              trackCleanup(
                stopWorkWithRetry(
                  api,
                  environmentId,
                  work.id,
                  logger,
                  backoffConfig.stopWorkBaseDelayMs,
                ),
              )
              break
            }
          }

          logForDebugging(`[bridge:session] Spawning sessionId=${sessionId} sdkUrl=${sdkUrl}`)

          // compat-surface session_* form for logger/Sessions-API calls.
          // Work poll returns cse_* under v2 compat; convert before spawn so
          // the onFirstUserMessage callback can close over it.
          const compatSessionId = toCompatSessionId(sessionId)

          const spawnResult = safeSpawn(
            spawner,
            {
              sessionId,
              sdkUrl,
              accessToken: secret.session_ingress_token,
              useCcrV2,
              workerEpoch,
              onFirstUserMessage: (text) => {
                // Server-set titles (--name, web rename) win. fetchSessionTitle
                // runs concurrently; if it already populated titledSessions,
                // skip. If it hasn't resolved yet, the derived title sticks —
                // acceptable since the server had no title at spawn time.
                if (titledSessions.has(compatSessionId)) {
                  return
                }
                titledSessions.add(compatSessionId)
                const title = deriveSessionTitle(text)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(`[bridge:title] derived title for ${compatSessionId}: ${title}`)
                void import('../createSession.js')
                  .then(({ updateWireSessionTitle }) =>
                    updateWireSessionTitle(compatSessionId, title, {
                      baseUrl: config.apiBaseUrl,
                    }),
                  )
                  .catch((err) =>
                    logForDebugging(
                      `[bridge:title] failed to update title for ${compatSessionId}: ${err}`,
                      { level: 'error' },
                    ),
                  )
              },
            },
            sessionDir,
          )
          if (typeof spawnResult === 'string') {
            logger.logError(`Failed to spawn session ${sessionId}: ${spawnResult}`)
            // Clean up worktree if one was created for this session
            const wt = sessionWorktrees.get(sessionId)
            if (wt) {
              sessionWorktrees.delete(sessionId)
              trackCleanup(
                removeAgentWorktree(
                  wt.worktreePath,
                  wt.worktreeBranch,
                  wt.gitRoot,
                  wt.hookBased,
                ).catch((err: unknown) =>
                  logger.logVerbose(
                    `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
                  ),
                ),
              )
            }
            completedWorkIds.add(work.id)
            trackCleanup(
              stopWorkWithRetry(
                api,
                environmentId,
                work.id,
                logger,
                backoffConfig.stopWorkBaseDelayMs,
              ),
            )
            break
          }
          const handle = spawnResult

          const spawnDurationMs = Date.now() - spawnStartTime
          logEvent('zy_bridge_session_started', {
            active_sessions: activeSessions.size,
            spawn_mode:
              spawnModeAtDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
            inProtectedNamespace: isInProtectedNamespace(),
          })
          logForDiagnosticsNoPII('info', 'bridge_session_started', {
            spawn_mode: spawnModeAtDecision,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
          })

          activeSessions.set(sessionId, handle)
          sessionWorkIds.set(sessionId, work.id)
          sessionIngressTokens.set(sessionId, secret.session_ingress_token)
          sessionCompatIds.set(sessionId, compatSessionId)

          const startTime = Date.now()
          sessionStartTimes.set(sessionId, startTime)

          // Use a generic prompt description since we no longer get startup_context
          logger.logSessionStart(sessionId, `Session ${sessionId}`)

          // Compute the actual debug file path (mirrors sessionRunner.ts logic)
          const safeId = safeFilenameId(sessionId)
          let sessionDebugFile: string | undefined
          if (config.debugFile) {
            const ext = config.debugFile.lastIndexOf('.')
            if (ext > 0) {
              sessionDebugFile = `${config.debugFile.slice(0, ext)}-${safeId}${config.debugFile.slice(ext)}`
            } else {
              sessionDebugFile = `${config.debugFile}-${safeId}`
            }
          } else if (config.verbose || isInternalBuild()) {
            sessionDebugFile = join(tmpdir(), 'zy', `bridge-session-${safeId}.log`)
          }

          if (sessionDebugFile) {
            logger.logVerbose(`Debug log: ${sessionDebugFile}`)
          }

          // Register in the sessions Map before starting status updates so the
          // first render tick shows the correct count and bullet list in sync.
          logger.addSession(
            compatSessionId,
            getRemoteSessionUrl(compatSessionId, config.sessionIngressUrl),
          )

          // Start live status updates and transition to "Attached" state.
          startStatusUpdates()
          logger.setAttached(compatSessionId)

          // One-shot title fetch. If the session already has a title (set via
          // --name, web rename, or /remote-control), display it and mark as
          // titled so the first-user-message fallback doesn't overwrite it.
          // Otherwise onFirstUserMessage derives one from the first prompt.
          void fetchSessionTitle(compatSessionId, config.apiBaseUrl)
            .then((title) => {
              if (title && activeSessions.has(sessionId)) {
                titledSessions.add(compatSessionId)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(`[bridge:title] server title for ${compatSessionId}: ${title}`)
              }
            })
            .catch((err) =>
              logForDebugging(
                `[bridge:title] failed to fetch title for ${compatSessionId}: ${err}`,
                { level: 'error' },
              ),
            )

          // Start per-session timeout watchdog
          const timeoutMs = config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
          if (timeoutMs > 0) {
            const timer = setTimeout(
              onSessionTimeout,
              timeoutMs,
              sessionId,
              timeoutMs,
              logger,
              timedOutSessions,
              handle,
            )
            sessionTimers.set(sessionId, timer)
          }

          // Schedule proactive token refresh before the JWT expires.
          // onRefresh branches on v2Sessions: v1 delivers OAuth to the
          // child, v2 triggers server re-dispatch via reconnectSession.
          if (useCcrV2) {
            v2Sessions.add(sessionId)
          }
          tokenRefresh?.schedule(sessionId, secret.session_ingress_token)

          void handle.done.then(onSessionDone(sessionId, startTime, handle))
          break
        }
        default:
          await ackWork()
          // Gracefully ignore unknown work types. The backend may send new
          // types before the bridge client is updated.
          logForDebugging(`[bridge:work] Unknown work type: ${workType}, skipping`)
          break
      }

      // When at capacity, throttle the loop. The switch above still runs so
      // existing-session token refreshes are processed, but we sleep here
      // to avoid busy-looping. Include the capacity wake signal so the
      // sleep is interrupted immediately when a session completes.
      if (atCapacityBeforeSwitch) {
        const cap = capacityWake.signal()
        if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
          await sleep(pollConfig.non_exclusive_heartbeat_interval_ms, cap.signal)
        } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
          await sleep(pollConfig.multisession_poll_interval_ms_at_capacity, cap.signal)
        }
        cap.cleanup()
      }
    } catch (err) {
      if (loopSignal.aborted) {
        break
      }

      // Fatal errors (401/403) — no point retrying, auth won't fix itself
      if (err instanceof WireFatalError) {
        fatalExit = true
        // Server-enforced expiry gets a clean status message, not an error
        if (isExpiredErrorType(err.errorType)) {
          logger.logStatus(err.message)
        } else if (isSuppressible403(err)) {
          // Cosmetic 403 errors (e.g., external_poll_sessions scope,
          // environments:manage permission) — don't show to user
          logForDebugging(`[bridge:work] Suppressed 403 error: ${err.message}`)
        } else {
          logger.logError(err.message)
          logError(err)
        }
        logEvent('zy_bridge_fatal_error', {
          status: err.status,
          error_type: err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiredErrorType(err.errorType) ? 'info' : 'error',
          'bridge_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        break
      }

      const errMsg = describeAxiosError(err)

      if (isConnectionError(err) || isServerError(err)) {
        const now = Date.now()

        // Detect system sleep/wake: if the gap since the last poll error
        // greatly exceeds the expected backoff, the machine likely slept.
        // Reset error tracking so the bridge retries with a fresh budget.
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!connErrorStart) {
          connErrorStart = now
        }
        const elapsed = now - connErrorStart
        if (elapsed >= backoffConfig.connGiveUpMs) {
          logger.logError(
            `Server unreachable for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('zy_bridge_poll_give_up', {
            error_type: 'connection' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'connection',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // Reset the other track when switching error types
        generalErrorStart = null
        generalBackoff = 0

        connBackoff = connBackoff
          ? Math.min(connBackoff * 2, backoffConfig.connCapMs)
          : backoffConfig.connInitialMs
        const delay = addJitter(connBackoff)
        logger.logVerbose(
          `Connection error, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(formatDelay(delay), formatDuration(elapsed))
        // The poll_due heartbeat-loop exit leaves a healthy lease exposed to
        // this backoff path. Heartbeat before each sleep so /poll outages
        // (the VerifyEnvironmentSecretAuth DB path heartbeat was introduced
        // to avoid) don't kill the 300s lease TTL. No-op when activeSessions
        // is empty or heartbeat is disabled.
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      } else {
        const now = Date.now()

        // Sleep detection for general errors (same logic as connection errors)
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!generalErrorStart) {
          generalErrorStart = now
        }
        const elapsed = now - generalErrorStart
        if (elapsed >= backoffConfig.generalGiveUpMs) {
          logger.logError(
            `Persistent errors for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('zy_bridge_poll_give_up', {
            error_type: 'general' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'general',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // Reset the other track when switching error types
        connErrorStart = null
        connBackoff = 0

        generalBackoff = generalBackoff
          ? Math.min(generalBackoff * 2, backoffConfig.generalCapMs)
          : backoffConfig.generalInitialMs
        const delay = addJitter(generalBackoff)
        logger.logVerbose(
          `Poll failed, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(formatDelay(delay), formatDuration(elapsed))
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      }
    }
  }

  // Clean up
  stopStatusUpdates()
  logger.clearStatus()

  const loopDurationMs = Date.now() - loopStartTime
  logEvent('zy_bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })
  logForDiagnosticsNoPII('info', 'bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })

  // Graceful shutdown: kill active sessions, report them as interrupted,
  // archive sessions, then deregister the environment so the web UI shows
  // the bridge as offline.

  // Collect all session IDs to archive on exit. This includes:
  // 1. Active sessions (snapshot before killing — onSessionDone clears maps)
  // 2. The initial auto-created session (may never have had work dispatched)
  // api.archiveSession is idempotent (409 if already archived), so
  // double-archiving is safe.
  const sessionsToArchive = new Set(activeSessions.keys())
  if (initialSessionId) {
    sessionsToArchive.add(initialSessionId)
  }
  // Snapshot before killing — onSessionDone clears sessionCompatIds.
  const compatIdSnapshot = new Map(sessionCompatIds)

  if (activeSessions.size > 0) {
    logForDebugging(`[bridge:shutdown] Shutting down ${activeSessions.size} active session(s)`)
    logger.logStatus(`Shutting down ${activeSessions.size} active session(s)\u2026`)

    // Snapshot work IDs before killing — onSessionDone clears the maps when
    // each child exits, so we need a copy for the stopWork calls below.
    const shutdownWorkIds = new Map(sessionWorkIds)

    for (const [sessionId, handle] of activeSessions.entries()) {
      logForDebugging(`[bridge:shutdown] Sending SIGTERM to sessionId=${sessionId}`)
      handle.kill()
    }

    const timeout = new AbortController()
    await Promise.race([
      Promise.allSettled([...activeSessions.values()].map((h) => h.done)),
      sleep(backoffConfig.shutdownGraceMs ?? 30_000, timeout.signal),
    ])
    timeout.abort()

    // SIGKILL any processes that didn't respond to SIGTERM within the grace window
    for (const [sid, handle] of activeSessions.entries()) {
      logForDebugging(`[bridge:shutdown] Force-killing stuck sessionId=${sid}`)
      handle.forceKill()
    }

    // Clear any remaining session timeout and refresh timers
    for (const timer of sessionTimers.values()) {
      clearTimeout(timer)
    }
    sessionTimers.clear()
    tokenRefresh?.cancelAll()

    // Clean up any remaining worktrees from active sessions.
    // Snapshot and clear the map first so onSessionDone (which may fire
    // during the await below when handle.done resolves) won't try to
    // remove the same worktrees again.
    if (sessionWorktrees.size > 0) {
      const remainingWorktrees = [...sessionWorktrees.values()]
      sessionWorktrees.clear()
      logForDebugging(`[bridge:shutdown] Cleaning up ${remainingWorktrees.length} worktree(s)`)
      await Promise.allSettled(
        remainingWorktrees.map((wt) =>
          removeAgentWorktree(wt.worktreePath, wt.worktreeBranch, wt.gitRoot, wt.hookBased),
        ),
      )
    }

    // Stop all active work items so the server knows they're done
    await Promise.allSettled(
      [...shutdownWorkIds.entries()].map(([sessionId, workId]) => {
        return api
          .stopWork(environmentId, workId, true)
          .catch((err) =>
            logger.logVerbose(
              `Failed to stop work ${workId} for session ${sessionId}: ${errorMessage(err)}`,
            ),
          )
      }),
    )
  }

  // Ensure all in-flight cleanup (stopWork, worktree removal) from
  // onSessionDone completes before deregistering — otherwise
  // process.exit() can kill them mid-flight.
  if (pendingCleanups.size > 0) {
    await Promise.allSettled([...pendingCleanups])
  }

  // In single-session mode with a known session, leave the session and
  // environment alive so `zy remote-control --session-id=<id>` can resume.
  // The backend GCs stale environments via a 4h TTL (BRIDGE_LAST_POLL_TTL).
  // Archiving the session or deregistering the environment would make the
  // printed resume command a lie — deregister deletes Firestore + Redis stream.
  // Skip when the loop exited fatally (env expired, auth failed, give-up) —
  // resume is impossible in those cases and the message would contradict the
  // error already printed.
  // feature('KAIROS') gate: --session-id is ant-only; without the gate,
  // revert to the pre-PR behavior (archive + deregister on every shutdown).
  if (
    feature('KAIROS')
      ? config.spawnMode === 'single-session' && initialSessionId && !fatalExit
      : false
  ) {
    logger.logStatus(`Resume this session by running \`zy remote-control --continue\``)
    logForDebugging(
      `[bridge:shutdown] Skipping archive+deregister to allow resume of session ${initialSessionId}`,
    )
    return
  }

  // Archive all known sessions so they don't linger as idle/running on the
  // server after the bridge goes offline.
  if (sessionsToArchive.size > 0) {
    logForDebugging(`[bridge:shutdown] Archiving ${sessionsToArchive.size} session(s)`)
    await Promise.allSettled(
      [...sessionsToArchive].map((sessionId) =>
        api
          .archiveSession(compatIdSnapshot.get(sessionId) ?? toCompatSessionId(sessionId))
          .catch((err) =>
            logger.logVerbose(`Failed to archive session ${sessionId}: ${errorMessage(err)}`),
          ),
      ),
    )
  }

  // Deregister the environment so the web UI shows the bridge as offline
  // and the Redis stream is cleaned up.
  try {
    await api.deregisterEnvironment(environmentId)
    logForDebugging(`[bridge:shutdown] Environment deregistered, bridge offline`)
    logger.logVerbose('Environment deregistered.')
  } catch (err) {
    logger.logVerbose(`Failed to deregister environment: ${errorMessage(err)}`)
  }

  // Clear the crash-recovery pointer — the env is gone, pointer would be
  // stale. The early return above (resumable SIGINT shutdown) skips this,
  // leaving the pointer as a backup for the printed --session-id hint.
  const { clearWirePointer } = await import('../bridgePointer.js')
  await clearWirePointer(config.dir)

  logger.logVerbose('Environment offline.')
}
