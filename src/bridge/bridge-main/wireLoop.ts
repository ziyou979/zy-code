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
  // 本地 abort controller 让 onSessionDone 可以停止轮询循环；同时关联传入的 signal，
  // 使外部 abort 也能生效。
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
  // 启动时计算并缓存兼容接口 ID（session_*），确保即使
  // zy_bridge_repl_v2_cse_shim_enabled 开关在会话中途变化，清理与状态更新仍使用同一 key。
  const sessionCompatIds = new Map<string, string>()
  // 用于心跳认证的 session ingress JWT，以 sessionId 为 key。单独存储，不复用
  // handle.accessToken，因为 token 刷新调度器会在约 3 小时 55 分后用 OAuth token 覆盖该字段。
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
  // 记录被超时 watchdog 终止的会话，使 onSessionDone 能将其与服务端发起或关停导致的中断区分。
  const timedOutSessions = new Set<string>()
  // 记录已有标题（服务端设置或 bridge 推导）的会话，避免 onFirstUserMessage 覆盖用户通过
  // --name 或 Web 重命名设置的标题。以 compatSessionId 为 key，与 logger.setSessionTitle 一致。
  const titledSessions = new Set<string>()
  // 会话结束时提前唤醒容量已满的休眠，使 bridge 能立即接收新任务。
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
  // WireFatalError 与放弃重试路径会设置此值，使关停逻辑跳过恢复提示；环境过期、认证失败或
  // 持续连接错误后已无法恢复。
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
      // 清除该会话的超时定时器
      const timer = sessionTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        sessionTimers.delete(sessionId)
      }
      // 清除 token 刷新定时器
      tokenRefresh?.cancel(sessionId)
      // 唤醒容量已满的休眠，使 bridge 立即接收新任务
      capacityWake.wake()

      // 若会话被超时 watchdog 终止，将其视为失败而非服务端或关停中断，以便下方仍调用
      // stopWork 和 archiveSession。
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

      // 输出最终日志前清除状态展示
      logger.clearStatus()
      stopStatusUpdates()

      // 尽可能根据 stderr 构造错误消息
      const stderrSummary = handle.lastStderr.length > 0 ? handle.lastStderr.join('\n') : undefined
      let failureMessage: string | undefined

      switch (status) {
        case 'completed':
          logger.logSessionComplete(sessionId, durationMs)
          break
        case 'failed':
          // 关停时跳过失败日志；子进程被终止后非零退出属于预期行为，并非真实故障。被超时终止的
          // 会话也跳过，因为 timeout watchdog 已输出明确的超时消息。
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

      // 通知服务端工作项已结束。中断的会话跳过：中断要么由服务端发起（服务端已知），要么由
      // bridge 关停导致（关停流程会另行调用 stopWork()）。
      if (status !== 'interrupted' && workId) {
        trackCleanup(
          stopWorkWithRetry(api, environmentId, workId, logger, backoffConfig.stopWorkBaseDelayMs),
        )
        completedWorkIds.add(workId)
      }

      // 若为此会话创建过 worktree，则执行清理
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

      // 生命周期策略：多会话模式下，会话结束后继续运行 bridge；单会话模式下 abort 轮询循环，
      // 让 bridge 干净退出。
      if (status !== 'interrupted' && !loopSignal.aborted) {
        if (config.spawnMode !== 'single-session') {
          // 多会话：归档已完成会话，避免其以陈旧状态留在 Web UI。archiveSession 是幂等操作
          //（已归档时返回 409），因此关停时再次归档也安全。工作轮询返回的 sessionId 是基础设施层
          // tag `cse_*`，而 archiveSession 调用兼容接口 /v1/sessions/{id}/archive，该接口校验
          // TagSession（session_*）；二者底层 UUID 相同，只需重新标记。
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
          // 单会话：生命周期耦合，销毁环境
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

  // 立即启动空闲状态展示；若存在预创建会话则除外，因为 setAttached() 已设置展示，轮询循环
  // 取得该会话后会开始更新状态。
  if (!initialSessionId) {
    startStatusUpdates()
  }

  while (!loopSignal.aborted) {
    // 每轮获取一次。GrowthBook 缓存每 5 分钟刷新，因此按容量已满频率运行的循环能在一个
    // 休眠周期内获取配置变化。
    const pollConfig = getPollIntervalConfig()

    try {
      const work = await api.pollForWork(
        environmentId,
        environmentSecret,
        loopSignal,
        pollConfig.reclaim_older_than_ms,
      )

      // 若此前已断开，则记录重连
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

      // null 响应表示队列中没有任务；增加最小延迟，避免频繁请求服务端。
      if (!work) {
        // 使用实时检查而非快照，因为会话可能在轮询期间结束。
        const atCap = activeSessions.size >= config.maxSessions
        if (atCap) {
          const atCapMs = pollConfig.multisession_poll_interval_ms_at_capacity
          // 心跳循环本身不轮询。若同时启用容量已满轮询（atCapMs > 0），循环会跟踪截止时间，
          // 到期后退出并执行轮询，使心跳与轮询组合运行而非彼此抑制。以下情况会退出并轮询：
          //   - 到达轮询截止时间（仅 atCapMs > 0）
          //   - 认证失败（JWT 过期，由轮询刷新 token）
          //   - 容量唤醒触发（会话结束，轮询新任务）
          //   - 循环被 abort（关停）
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            logEvent('zy_bridge_heartbeat_mode_entered', {
              active_sessions: activeSessions.size,
              heartbeat_interval_ms: pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // 截止时间只在进入时计算一次；GB 对 atCapMs 的更新不会改变进行中的截止时间，下次进入
            // 时才采用新值。
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let hbResult: 'ok' | 'auth_failed' | 'fatal' | 'failed' = 'ok'
            let hbCycles = 0
            while (
              !loopSignal.aborted &&
              activeSessions.size >= config.maxSessions &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              // 每个周期重新读取配置，使 GrowthBook 更新生效
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) {
                break
              }

              // 在异步心跳调用前捕获容量 signal，使 HTTP 请求期间结束的会话能被后续休眠感知，
              // 而不会因 controller 被替换而丢失通知。
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

            // 确定 telemetry 所需的退出原因
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
              // bridgeApi 会限流空轮询日志（EMPTY_POLL_LOG_INTERVAL=100），因此每 10 分钟一次的
              // poll_due 在计数为 2 时不可见。此处补记日志，让验证运行能在 debug 日志中看到两个端点。
              logForDebugging(
                `[bridge:poll] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
              )
            }

            // auth_failed 或 fatal 后先休眠再轮询，避免轮询与心跳形成紧密循环。auth_failed 时
            // heartbeatActiveWorkItems 已调用 reconnectSession，休眠为服务端传播重新入队留出时间。
            // fatal（404/410）可能只是单个工作项被 GC，而环境仍有效。启用时采用 atCapMs，否则
            // 以心跳间隔为下限（此处保证大于 0），避免仅启用心跳的配置紧密循环。
            if (hbResult === 'auth_failed' || hbResult === 'fatal') {
              const cap = capacityWake.signal()
              await sleep(
                atCapMs > 0 ? atCapMs : pollConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }
          } else if (atCapMs > 0) {
            // 心跳禁用时，以低频轮询作为存活信号。
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

      // 已达容量上限：轮询用于维持心跳，但当前无法接收新任务。仍进入下方 switch，以处理已有
      // 会话的 token 刷新；'session' handler 会在内部容量检查前先检查已有会话。
      const atCapacityBeforeSwitch = activeSessions.size >= config.maxSessions

      // 跳过已完成并停止的工作项。服务端处理 stop 请求前可能再次投递陈旧任务，否则会重复
      // 启动会话。
      if (completedWorkIds.has(work.id)) {
        logForDebugging(`[bridge:work] Skipping already-completed workId=${work.id}`)
        // 遵守容量限流；若此处不休眠，持续重新投递陈旧任务会以轮询请求速度紧密循环，因为
        // 上方 !work 分支是唯一休眠点，而 work != null 会跳过该分支。
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

      // 解码 work secret，供启动会话并提取下方 ack 调用使用的 JWT。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        const errMsg = errorMessage(err)
        logger.logError(`Failed to decode work secret for workId=${work.id}: ${errMsg}`)
        logEvent('zy_bridge_work_secret_failed', {})
        // 无法 ack，因为所需 JWT 解码失败。stopWork 使用 OAuth，因此此处仍可调用，避免
        // XAUTOCLAIM 在每个 reclaim_older_than_ms 周期重新投递这一损坏项。
        completedWorkIds.add(work.id)
        trackCleanup(
          stopWorkWithRetry(api, environmentId, work.id, logger, backoffConfig.stopWorkBaseDelayMs),
        )
        // 重试前遵守容量限流；若此处不休眠，容量已满时反复解码失败会以轮询请求速度紧密
        // 循环，因为 work != null 会跳过上方 !work 休眠。
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

      // 确定处理工作项后才显式 ack，不能提前。case 'session' 内的容量检查可能在未启动会话时
      // break，此时若已 ack 会永久丢失任务。ack 失败不是致命错误：服务端会重新投递，
      // existingHandle 与 completedWorkIds 路径负责去重。
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

          // 若会话已运行，则传递新 token，使子进程能用新的 session ingress token 重连
          // WebSocket。这用于处理 WS 断开后服务端再次分发已有会话任务的情况。
          const existingHandle = activeSessions.get(sessionId)
          if (existingHandle) {
            existingHandle.updateAccessToken(secret.session_ingress_token)
            sessionIngressTokens.set(sessionId, secret.session_ingress_token)
            sessionWorkIds.set(sessionId, work.id)
            // 根据新 JWT 的过期时间重新安排下次刷新。onRefresh 会按 v2Sessions 分支，
            // 因此 v1 与 v2 在此都安全。
            tokenRefresh?.schedule(sessionId, secret.session_ingress_token)
            logForDebugging(
              `[bridge:work] Updated access token for existing sessionId=${sessionId} workId=${work.id}`,
            )
            await ackWork()
            break
          }

          // 已达容量上限：上方已处理已有会话的 token 刷新，但不能启动新会话。switch 后的容量
          // 休眠会限流循环，此处直接 break。
          if (activeSessions.size >= config.maxSessions) {
            logForDebugging(
              `[bridge:work] At capacity (${activeSessions.size}/${config.maxSessions}), cannot spawn new session for workId=${work.id}`,
            )
            break
          }

          await ackWork()
          const spawnStartTime = Date.now()

          // CCR v2 路径：将此 bridge 注册为会话 worker，获取 epoch，并让子进程连接
          // /v1/code/sessions/{id}。子进程已包含完整 v2 客户端（SSETransport + CCRClient），
          // 与 environment-manager 在容器中启动的代码路径相同。
          //
          // v1 路径使用 Session-Ingress WebSocket，地址取 config.sessionIngressUrl，而非
          // secret.api_base_url；后者可能指向不了解本地创建会话的远程代理隧道。
          let sdkUrl: string
          let useCcrV2 = false
          let workerEpoch: number | undefined
          // 服务端通过 work secret 按会话决定；环境变量是 ant 开发覆盖项，例如服务端开关启用前
          // 强制使用 v2。
          if (secret.use_code_sessions === true || isEnvTruthy(process.env.ZY_BRIDGE_USE_CCR)) {
            sdkUrl = buildCCRv2SdkUrl(config.apiBaseUrl, sessionId)
            // 瞬时失败（短暂网络故障、500）时重试一次，再永久放弃并终止会话。
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

          // worktree 模式下，按需会话会获得独立 git worktree，避免并发会话的文件改动互相干扰。
          // 预创建的初始会话（若有）在 config.dir 中运行，使用户首个会话位于调用 `rc` 的目录，
          // 与旧版单会话体验一致。same-dir 与单会话模式下，所有会话共享 config.dir。
          // 在下方 await 前捕获 spawnMode：`w` 键 handler 会直接修改 config.spawnMode，而
          // createAgentWorktree 可能耗时 1 至 2 秒；若 await 后再读取，可能产生矛盾 analytics
          //（spawn_mode:'same-dir', in_worktree:true）。
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

          // logger 与 Sessions API 调用使用兼容接口的 session_* 形式。v2 兼容模式下工作轮询返回
          // cse_*，启动前完成转换，使 onFirstUserMessage 回调可以闭包捕获。
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
                // 服务端设置的标题（--name、Web 重命名）优先。fetchSessionTitle 并发运行；若已填充
                // titledSessions 则跳过。若尚未完成，则保留推导标题；启动时服务端没有标题，故可接受。
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
            // 若为此会话创建过 worktree，则执行清理
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

          // 不再接收 startup_context，因此使用通用 prompt 描述
          logger.logSessionStart(sessionId, `Session ${sessionId}`)

          // 计算实际 debug 文件路径，与 sessionRunner.ts 的逻辑一致
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

          // 在启动状态更新前注册到 sessions Map，使首个渲染 tick 同步显示正确数量和项目列表。
          logger.addSession(
            compatSessionId,
            getRemoteSessionUrl(compatSessionId, config.sessionIngressUrl),
          )

          // 启动实时状态更新，并切换到 “Attached” 状态。
          startStatusUpdates()
          logger.setAttached(compatSessionId)

          // 单次获取标题。若会话已有通过 --name、Web 重命名或 /remote-control 设置的标题，
          // 则展示并标记为已有标题，避免首条用户消息的回退逻辑覆盖；否则由 onFirstUserMessage
          // 根据首个 prompt 推导。
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

          // 启动该会话的超时 watchdog
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

          // 在 JWT 过期前主动安排 token 刷新。onRefresh 按 v2Sessions 分支：v1 向子进程传递
          // OAuth，v2 通过 reconnectSession 触发服务端重新分发。
          if (useCcrV2) {
            v2Sessions.add(sessionId)
          }
          tokenRefresh?.schedule(sessionId, secret.session_ingress_token)

          void handle.done.then(onSessionDone(sessionId, startTime, handle))
          break
        }
        default:
          await ackWork()
          // 安全忽略未知工作类型；后端可能先于 bridge 客户端更新而发送新类型。
          logForDebugging(`[bridge:work] Unknown work type: ${workType}, skipping`)
          break
      }

      // 达到容量上限时限流循环。上方 switch 仍会运行以处理已有会话的 token 刷新，但此处休眠
      // 以避免忙循环；同时加入容量唤醒 signal，使会话结束时立即中断休眠。
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

      // 致命错误（401/403）无需重试，认证问题不会自行恢复
      if (err instanceof WireFatalError) {
        fatalExit = true
        // 服务端强制过期时展示清晰状态消息，而非错误
        if (isExpiredErrorType(err.errorType)) {
          logger.logStatus(err.message)
        } else if (isSuppressible403(err)) {
          // 表面性的 403 错误，例如 external_poll_sessions scope 或 environments:manage 权限，
          // 不向用户展示
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

        // 检测系统休眠与唤醒：若距上次轮询错误的间隔远超预期退避，机器可能进入过休眠。重置
        // 错误跟踪，使 bridge 使用全新预算重试。
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

        // 错误类型切换时重置另一条跟踪记录
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
        // poll_due 退出心跳循环后，健康 lease 会进入此退避路径。每次休眠前发送心跳，避免 /poll
        // 故障（引入 VerifyEnvironmentSecretAuth 数据库路径心跳正是为规避此问题）耗尽 300 秒
        // lease TTL。activeSessions 为空或禁用心跳时不执行。
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      } else {
        const now = Date.now()

        // 检测一般错误期间的休眠，逻辑与连接错误相同
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

        // 错误类型切换时重置另一条跟踪记录
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

  // 清理
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

  // 优雅关停：终止活跃会话并报告为中断，归档会话，随后注销环境，使 Web UI 将 bridge 显示为离线。

  // 收集退出时要归档的所有会话 ID，包括：
  // 1. 活跃会话（终止前创建快照，因为 onSessionDone 会清空 map）
  // 2. 自动创建的初始会话（可能从未分发过任务）
  // api.archiveSession 是幂等操作（已归档时返回 409），因此重复归档安全。
  const sessionsToArchive = new Set(activeSessions.keys())
  if (initialSessionId) {
    sessionsToArchive.add(initialSessionId)
  }
  // 终止前创建快照，因为 onSessionDone 会清空 sessionCompatIds。
  const compatIdSnapshot = new Map(sessionCompatIds)

  if (activeSessions.size > 0) {
    logForDebugging(`[bridge:shutdown] Shutting down ${activeSessions.size} active session(s)`)
    logger.logStatus(`Shutting down ${activeSessions.size} active session(s)\u2026`)

    // 终止前创建 work ID 快照；每个子进程退出时 onSessionDone 会清空 map，下方 stopWork 调用
    // 因此需要副本。
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

    // 对宽限期内未响应 SIGTERM 的进程发送 SIGKILL
    for (const [sid, handle] of activeSessions.entries()) {
      logForDebugging(`[bridge:shutdown] Force-killing stuck sessionId=${sid}`)
      handle.forceKill()
    }

    // 清除所有剩余的会话超时与刷新定时器
    for (const timer of sessionTimers.values()) {
      clearTimeout(timer)
    }
    sessionTimers.clear()
    tokenRefresh?.cancelAll()

    // 清理活跃会话遗留的所有 worktree。先创建快照并清空 map，避免下方 await 期间 handle.done
    // 完成并触发 onSessionDone 时再次尝试移除同一 worktree。
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

    // 停止所有活跃工作项，使服务端获知其已结束
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

  // 注销前确保 onSessionDone 发起的所有清理（stopWork、移除 worktree）完成，否则
  // process.exit() 可能在执行中途终止它们。
  if (pendingCleanups.size > 0) {
    await Promise.allSettled([...pendingCleanups])
  }

  // 单会话模式且会话已知时，保留会话与环境，使 `zy remote-control --session-id=<id>` 可以恢复。
  // 后端通过 4 小时 TTL（BRIDGE_LAST_POLL_TTL）回收陈旧环境。若归档会话或注销环境，输出的
  // 恢复命令将无法使用，因为注销会删除 Firestore 与 Redis stream。若循环因致命错误退出
  //（环境过期、认证失败、放弃重试）则跳过；这些情况下无法恢复，提示也会与已输出错误矛盾。
  // feature('KAIROS') 开关：--session-id 仅供 ant 使用；未启用时恢复 PR 前的行为，即每次关停
  // 都归档并注销。
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

  // 归档所有已知会话，避免 bridge 离线后它们仍以 idle/running 状态滞留在服务端。
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

  // 注销环境，使 Web UI 将 bridge 显示为离线，并清理 Redis stream。
  try {
    await api.deregisterEnvironment(environmentId)
    logForDebugging(`[bridge:shutdown] Environment deregistered, bridge offline`)
    logger.logVerbose('Environment deregistered.')
  } catch (err) {
    logger.logVerbose(`Failed to deregister environment: ${errorMessage(err)}`)
  }

  // 清除崩溃恢复 pointer；环境已不存在，pointer 会失效。上方可恢复的 SIGINT 关停会提前返回，
  // 跳过此处并保留 pointer，作为已输出 --session-id 提示的备用方案。
  const { clearWirePointer } = await import('../bridgePointer.js')
  await clearWirePointer(config.dir)

  logger.logVerbose('Environment offline.')
}
