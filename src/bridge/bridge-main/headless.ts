import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import { shutdownDatadog } from '../../services/analytics/datadog.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
  logEventAsync,
} from '../../services/analytics/index.js'
import { shutdownZyEventLogging } from '../../services/analytics/zyEventLogger.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { createWireApiClient, validateWireId, WireFatalError } from '../bridgeApi.js'
import { createWireLogger } from '../bridgeUI.js'
import { getPollIntervalConfig } from '../pollConfig.js'
import { toInfraSessionId } from '../sessionIdCompat.js'
import { createSessionSpawner } from '../sessionRunner.js'
import { getTrustedDeviceToken } from '../trustedDevice.js'
import { BRIDGE_LOGIN_ERROR, type SpawnMode, type WireConfig, type WireLogger } from '../types.js'
import {
  SPAWN_SESSIONS_DEFAULT,
  isMultiSessionSpawnEnabled,
  spawnScriptArgs,
} from './wireLoopSupport.js'
import { runWireLoop } from './wireLoop.js'
import { parseArgs, printHelp } from './cli.js'
export async function bridgeMain(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    await printHelp()
    return
  }
  if (parsed.error) {
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error(`Error: ${parsed.error}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode: parsedSpawnMode,
    capacity: parsedCapacity,
    createSessionInDir: parsedCreateSessionInDir,
    sessionId: parsedSessionId,
    continueSession,
  } = parsed
  // Mutable so --continue can set it from the pointer file. The #20460
  // resume flow below then treats it the same as an explicit --session-id.
  let resumeSessionId = parsedSessionId
  // When --continue found a pointer, this is the directory it came from
  // (may be a worktree sibling, not `dir`). On resume-flow deterministic
  // failure, clear THIS file so --continue doesn't keep hitting the same
  // dead session. Undefined for explicit --session-id (leaves pointer alone).
  let resumePointerDir: string | undefined

  const usedMultiSessionFeature =
    parsedSpawnMode !== undefined ||
    parsedCapacity !== undefined ||
    parsedCreateSessionInDir !== undefined

  // Validate permission mode early so the user gets an error before
  // the bridge starts polling for work.
  if (permissionMode !== undefined) {
    const { PERMISSION_MODES } = await import('../../types/permissions.js')
    const valid: readonly string[] = PERMISSION_MODES
    if (!valid.includes(permissionMode)) {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Invalid permission mode '${permissionMode}'. Valid modes: ${valid.join(', ')}`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  const dir = resolve('.')

  // The bridge fast-path bypasses init.ts, so we must enable config reading
  // before any code that transitively calls getGlobalConfig()
  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../../services/config/config.js'
  )
  enableConfigs()

  // Initialize analytics and error reporting sinks. The bridge bypasses the
  // setup() init flow, so we call initSinks() directly to attach sinks here.
  const { initSinks } = await import('../../services/telemetry/sinks.js')
  initSinks()

  // Gate-aware validation: --spawn / --capacity / --create-session-in-dir require
  // the multi-session gate. parseArgs has already validated flag combinations;
  // here we only check the gate since that requires an async GrowthBook call.
  // Runs after enableConfigs() (GrowthBook cache reads global config) and after
  // initSinks() so the denial event can be enqueued.
  const multiSessionEnabled = await isMultiSessionSpawnEnabled()
  if (usedMultiSessionFeature && !multiSessionEnabled) {
    await logEventAsync('zy_bridge_multi_session_denied', {
      used_spawn: parsedSpawnMode !== undefined,
      used_capacity: parsedCapacity !== undefined,
      used_create_session_in_dir: parsedCreateSessionInDir !== undefined,
    })
    // logEventAsync only enqueues — process.exit() discards buffered events.
    // Flush explicitly, capped at 500ms to match gracefulShutdown.ts.
    // (sleep() doesn't unref its timer, but process.exit() follows immediately
    // so the ref'd timer can't delay shutdown.)
    await Promise.race([
      Promise.all([shutdownZyEventLogging(), shutdownDatadog()]),
      sleep(500, undefined, { unref: true }),
    ]).catch(() => {})
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error('Error: Multi-session Remote Control is not enabled for your account yet.')
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // Set the bootstrap CWD so that trust checks, project config lookups, and
  // git utilities (getBranch, getRemoteUrl) resolve against the correct path.
  const { setOriginalCwd, setCwdState } = await import('../../bootstrap/runtime/runtimeContext.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  // The bridge bypasses main.tsx (which renders the interactive TrustDialog via showSetupScreens),
  // so we must verify trust was previously established by a normal `zy` session.
  if (!checkHasTrustDialogAccepted()) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Error: Workspace not trusted. Please run \`zy\` in ${dir} first to review and accept the workspace trust dialog.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // Resolve auth
  const { clearOAuthTokenCache, checkAndRefreshOAuthTokenIfNeeded } = await import(
    '../../services/auth/auth.js'
  )
  const { getWireAccessToken, getWireBaseUrl } = await import('../bridgeConfig.js')

  const bridgeToken = getWireAccessToken()
  if (!bridgeToken) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(BRIDGE_LOGIN_ERROR)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // First-time remote dialog — explain what bridge does and get consent
  const { getGlobalConfig, saveGlobalConfig, getCurrentProjectConfig, saveCurrentProjectConfig } =
    await import('../../services/config/config.js')
  if (!getGlobalConfig().remoteDialogSeen) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      '\nRemote Control lets you access this CLI session from the web (zy.ai/code)\nor the Zy app, so you can pick up where you left off on any device.\n\nYou can disconnect remote access anytime by running /remote-control again.\n',
    )
    const answer = await new Promise<string>((resolve) => {
      rl.question('Enable Remote Control? (y/n) ', resolve)
    })
    rl.close()
    saveGlobalConfig((current) => {
      if (current.remoteDialogSeen) {
        return current
      }
      return { ...current, remoteDialogSeen: true }
    })
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }

  // --continue: resolve the most recent session from the crash-recovery
  // pointer and chain into the #20460 --session-id flow. Worktree-aware:
  // checks current dir first (fast path, zero exec), then fans out to git
  // worktree siblings if that misses — the REPL bridge writes to
  // getOriginalCwd() which EnterWorktreeTool/activeWorktreeSession can
  // point at a worktree while the user's shell is at the repo root.
  // KAIROS-gated at parseArgs — continueSession is always false in external
  // builds, so this block tree-shakes.
  if (feature('KAIROS') ? continueSession : false) {
    const { readWirePointerAcrossWorktrees } = await import('../bridgePointer.js')
    const found = await readWirePointerAcrossWorktrees(dir)
    if (!found) {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: No recent session found in this directory or its worktrees. Run \`zy remote-control\` to start a new one.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    const { pointer, dir: pointerDir } = found
    const ageMin = Math.round(pointer.ageMs / 60_000)
    const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`
    const fromWt = pointerDir !== dir ? ` from worktree ${pointerDir}` : ''
    // biome-ignore lint/suspicious/noConsole: intentional info output
    console.error(`Resuming session ${pointer.sessionId} (${ageStr} ago)${fromWt}\u2026`)
    resumeSessionId = pointer.sessionId
    // Track where the pointer came from so the #20460 exit(1) paths below
    // clear the RIGHT file on deterministic failure — otherwise --continue
    // would keep hitting the same dead session. May be a worktree sibling.
    resumePointerDir = pointerDir
  }

  // In production, baseUrl is the Anthropic API (from OAuth config).
  // CLAUDE_BRIDGE_BASE_URL overrides this for ant local dev only.
  const baseUrl = getWireBaseUrl()

  // For non-localhost targets, require HTTPS to protect credentials.
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      'Error: Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // Session ingress URL for WebSocket connections. In production this is the
  // same as baseUrl (Envoy routes /v1/session_ingress/* to session-ingress).
  // Locally, session-ingress runs on a different port (9413) than the
  // contain-provide-api (8211), so CLAUDE_BRIDGE_SESSION_INGRESS_URL must be
  // set explicitly. Ant-only, matching CLAUDE_BRIDGE_BASE_URL.
  const sessionIngressUrl =
    isInternalBuild() && process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import('../../utils/git.js')

  // Precheck worktree availability for the first-run dialog and the `w`
  // toggle. Unconditional so we know upfront whether worktree is an option.
  const { hasWorktreeCreateHook } = await import('../../services/hooks.js')
  const worktreeAvailable = hasWorktreeCreateHook() || findGitRoot(dir) !== null

  // Load saved per-project spawn-mode preference. Gated by multiSessionEnabled
  // so a GrowthBook rollback cleanly reverts users to single-session —
  // otherwise a saved pref would silently re-enable multi-session behavior
  // (worktree isolation, 32 max sessions, w toggle) despite the gate being off.
  // Also guard against a stale worktree pref left over from when this dir WAS
  // a git repo (or the user copied config) — clear it on disk so the warning
  // doesn't repeat on every launch.
  let savedSpawnMode = multiSessionEnabled
    ? getCurrentProjectConfig().remoteControlSpawnMode
    : undefined
  if (savedSpawnMode === 'worktree' && !worktreeAvailable) {
    // biome-ignore lint/suspicious/noConsole: intentional warning output
    console.error(
      'Warning: Saved spawn mode is worktree but this directory is not a git repository. Falling back to same-dir.',
    )
    savedSpawnMode = undefined
    saveCurrentProjectConfig((current) => {
      if (current.remoteControlSpawnMode === undefined) {
        return current
      }
      return { ...current, remoteControlSpawnMode: undefined }
    })
  }

  // First-run spawn-mode choice: ask once per project when the choice is
  // meaningful (gate on, both modes available, no explicit override, not
  // resuming). Saves to ProjectConfig so subsequent runs skip this.
  if (
    multiSessionEnabled &&
    !savedSpawnMode &&
    worktreeAvailable &&
    parsedSpawnMode === undefined &&
    !resumeSessionId &&
    process.stdin.isTTY
  ) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    // biome-ignore lint/suspicious/noConsole: intentional dialog output
    console.log(
      `\nZy Remote Control is launching in spawn mode which lets you create new sessions in this project from ZY Code on Web or your Mobile app. Learn more here: https://code.zy.com/docs/en/remote-control\n\n` +
        `Spawn mode for this project:\n` +
        `  [1] same-dir \u2014 sessions share the current directory (default)\n` +
        `  [2] worktree \u2014 each session gets an isolated git worktree\n\n` +
        `This can be changed later or explicitly set with --spawn=same-dir or --spawn=worktree.\n`,
    )
    const answer = await new Promise<string>((resolve) => {
      rl.question('Choose [1/2] (default: 1): ', resolve)
    })
    rl.close()
    const chosen: 'same-dir' | 'worktree' = answer.trim() === '2' ? 'worktree' : 'same-dir'
    savedSpawnMode = chosen
    logEvent('zy_bridge_spawn_mode_chosen', {
      spawn_mode: chosen as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    saveCurrentProjectConfig((current) => {
      if (current.remoteControlSpawnMode === chosen) {
        return current
      }
      return { ...current, remoteControlSpawnMode: chosen }
    })
  }

  // Determine effective spawn mode.
  // Precedence: resume > explicit --spawn > saved project pref > gate default
  // - resuming via --continue / --session-id: always single-session (resume
  //   targets one specific session in its original directory)
  // - explicit --spawn flag: use that value directly (does not persist)
  // - saved ProjectConfig.remoteControlSpawnMode: set by first-run dialog or `w`
  // - default with gate on: same-dir (persistent multi-session, shared cwd)
  // - default with gate off: single-session (unchanged legacy behavior)
  // Track how spawn mode was determined, for rollout analytics.
  type SpawnModeSource = 'resume' | 'flag' | 'saved' | 'gate_default'
  let spawnModeSource: SpawnModeSource
  let spawnMode: SpawnMode
  if (resumeSessionId) {
    spawnMode = 'single-session'
    spawnModeSource = 'resume'
  } else if (parsedSpawnMode !== undefined) {
    spawnMode = parsedSpawnMode
    spawnModeSource = 'flag'
  } else if (savedSpawnMode !== undefined) {
    spawnMode = savedSpawnMode
    spawnModeSource = 'saved'
  } else {
    spawnMode = multiSessionEnabled ? 'same-dir' : 'single-session'
    spawnModeSource = 'gate_default'
  }
  const maxSessions =
    spawnMode === 'single-session' ? 1 : (parsedCapacity ?? SPAWN_SESSIONS_DEFAULT)
  // Pre-create an empty session on start so the user has somewhere to type
  // immediately, running in the current directory (exempted from worktree
  // creation in the spawn loop). On by default; --no-create-session-in-dir
  // opts out for a pure on-demand server where every session is isolated.
  // The effectiveResumeSessionId guard at the creation site handles the
  // resume case (skip creation when resume succeeded; fall through to
  // fresh creation on env-mismatch fallback).
  const preCreateSession = parsedCreateSessionInDir ?? true

  // Without --continue: a leftover pointer means the previous run didn't
  // shut down cleanly (crash, kill -9, terminal closed). Clear it so the
  // stale env doesn't linger past its relevance. Runs in all modes
  // (clearWirePointer is a no-op when no file exists) — covers the
  // gate-transition case where a user crashed in single-session mode then
  // starts fresh in worktree mode. Only single-session mode writes new
  // pointers.
  if (!resumeSessionId) {
    const { clearWirePointer } = await import('../bridgePointer.js')
    await clearWirePointer(dir)
  }

  // Worktree mode requires either git or WorktreeCreate/WorktreeRemove hooks.
  // Only reachable via explicit --spawn=worktree (default is same-dir);
  // saved worktree pref was already guarded above.
  if (spawnMode === 'worktree' && !worktreeAvailable) {
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error(
      `Error: Worktree mode requires a git repository or WorktreeCreate hooks configured. Use --spawn=session for single-session mode.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const { handleOAuth401Error } = await import('../../services/auth/auth.js')
  const api = createWireApiClient({
    baseUrl,
    getAccessToken: getWireAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401: handleOAuth401Error,
    getTrustedDeviceToken,
  })

  // When resuming a session via --session-id, fetch it to learn its
  // environment_id and reuse that for registration (idempotent on the
  // backend). Left undefined otherwise — the backend rejects
  // client-generated UUIDs and will allocate a fresh environment.
  // feature('KAIROS') gate: --session-id is ant-only; parseArgs already
  // rejects the flag when the gate is off, so resumeSessionId is always
  // undefined here in external builds — this guard is for tree-shaking.
  let reuseEnvironmentId: string | undefined
  if (feature('KAIROS') ? resumeSessionId !== undefined : false) {
    try {
      validateWireId(resumeSessionId!, 'sessionId')
    } catch {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Invalid session ID "${resumeSessionId}". Session IDs must not contain unsafe characters.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    // Proactively refresh the OAuth token — getWireSession uses raw axios
    // without the withOAuthRetry 401-refresh logic. An expired-but-present
    // token would otherwise produce a misleading "not found" error.
    await checkAndRefreshOAuthTokenIfNeeded()
    clearOAuthTokenCache()
    const { getWireSession } = await import('../createSession.js')
    const session = await getWireSession(resumeSessionId!, {
      baseUrl,
      getAccessToken: getWireAccessToken,
    })
    if (!session) {
      // Session gone on server → pointer is stale. Clear it so the user
      // isn't re-prompted next launch. (Explicit --session-id leaves the
      // pointer alone — it's an independent file they may not even have.)
      // resumePointerDir may be a worktree sibling — clear THAT file.
      if (resumePointerDir) {
        const { clearWirePointer } = await import('../bridgePointer.js')
        await clearWirePointer(resumePointerDir)
      }
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Session ${resumeSessionId} not found. It may have been archived or expired, or your login may have lapsed (run \`zy /login\`).`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    if (!session.environment_id) {
      if (resumePointerDir) {
        const { clearWirePointer } = await import('../bridgePointer.js')
        await clearWirePointer(resumePointerDir)
      }
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Session ${resumeSessionId} has no environment_id. It may never have been attached to a bridge.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    reuseEnvironmentId = session.environment_id
    logForDebugging(
      `[bridge:init] Resuming session ${resumeSessionId} on environment ${reuseEnvironmentId}`,
    )
  }

  const config: WireConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions,
    spawnMode,
    verbose,
    sandbox,
    bridgeId,
    workerType: 'zy_code',
    environmentId: randomUUID(),
    reuseEnvironmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    debugFile,
    sessionTimeoutMs,
  }

  logForDebugging(
    `[bridge:init] bridgeId=${bridgeId}${reuseEnvironmentId ? ` reuseEnvironmentId=${reuseEnvironmentId}` : ''} dir=${dir} branch=${branch} gitRepoUrl=${gitRepoUrl} machine=${machineName}`,
  )
  logForDebugging(`[bridge:init] apiBaseUrl=${baseUrl} sessionIngressUrl=${sessionIngressUrl}`)
  logForDebugging(`[bridge:init] sandbox=${sandbox}${debugFile ? ` debugFile=${debugFile}` : ''}`)

  // Register the bridge environment before entering the poll loop.
  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerWireEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logEvent('zy_bridge_registration_failed', {
      status: err instanceof WireFatalError ? err.status : undefined,
    })
    // Registration failures are fatal — print a clean message instead of a stack trace.
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      err instanceof WireFatalError && err.status === 404
        ? 'Remote Control environments are not available for your account.'
        : `Error: ${errorMessage(err)}`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // Tracks whether the --session-id resume flow completed successfully.
  // Used below to skip fresh session creation and seed initialSessionId.
  // Cleared on env mismatch so we gracefully fall back to a new session.
  let effectiveResumeSessionId: string | undefined
  if (feature('KAIROS') ? resumeSessionId !== undefined : false) {
    if (reuseEnvironmentId && environmentId !== reuseEnvironmentId) {
      // Backend returned a different environment_id — the original env
      // expired or was reaped. Reconnect won't work against the new env
      // (session is bound to the old one). Log to sentry for visibility
      // and fall through to fresh session creation on the new env.
      logError(
        new Error(
          `Bridge resume env mismatch: requested ${reuseEnvironmentId}, backend returned ${environmentId}. Falling back to fresh session.`,
        ),
      )
      // biome-ignore lint/suspicious/noConsole: intentional warning output
      console.warn(
        `Warning: Could not resume session ${resumeSessionId} — its environment has expired. Creating a fresh session instead.`,
      )
      // Don't deregister — we're going to use this new environment.
      // effectiveResumeSessionId stays undefined → fresh session path below.
    } else {
      // Force-stop any stale worker instances for this session and re-queue
      // it so our poll loop picks it up. Must happen after registration so
      // the backend knows a live worker exists for the environment.
      //
      // The pointer stores a session_* ID but /bridge/reconnect looks
      // sessions up by their infra tag (cse_*) when ccr_v2_compat_enabled
      // is on. Try both; the conversion is a no-op if already cse_*.
      const infraResumeId = toInfraSessionId(resumeSessionId!)
      const reconnectCandidates =
        infraResumeId === resumeSessionId ? [resumeSessionId!] : [resumeSessionId!, infraResumeId]
      let reconnected = false
      let lastReconnectErr: unknown
      for (const candidateId of reconnectCandidates) {
        try {
          await api.reconnectSession(environmentId, candidateId)
          logForDebugging(`[bridge:init] Session ${candidateId} re-queued via bridge/reconnect`)
          effectiveResumeSessionId = resumeSessionId
          reconnected = true
          break
        } catch (err) {
          lastReconnectErr = err
          logForDebugging(
            `[bridge:init] reconnectSession(${candidateId}) failed: ${errorMessage(err)}`,
          )
        }
      }
      if (!reconnected) {
        const err = lastReconnectErr

        // Do NOT deregister on transient reconnect failure — at this point
        // environmentId IS the session's own environment. Deregistering
        // would make retry impossible. The backend's 4h TTL cleans up.
        const isFatal = err instanceof WireFatalError
        // Clear pointer only on fatal reconnect failure. Transient failures
        // ("try running the same command again") should keep the pointer so
        // next launch re-prompts — that IS the retry mechanism.
        if (resumePointerDir && isFatal) {
          const { clearWirePointer } = await import('../bridgePointer.js')
          await clearWirePointer(resumePointerDir)
        }
        // biome-ignore lint/suspicious/noConsole: intentional error output
        console.error(
          isFatal
            ? `Error: ${errorMessage(err)}`
            : `Error: Failed to reconnect session ${resumeSessionId}: ${errorMessage(err)}\nThe session may still be resumable — try running the same command again.`,
        )
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      }
    }
  }

  logForDebugging(`[bridge:init] Registered, server environmentId=${environmentId}`)
  const startupPollConfig = getPollIntervalConfig()
  logEvent('zy_bridge_started', {
    max_sessions: config.maxSessions,
    has_debug_file: !!config.debugFile,
    sandbox: config.sandbox,
    verbose: config.verbose,
    heartbeat_interval_ms: startupPollConfig.non_exclusive_heartbeat_interval_ms,
    spawn_mode: config.spawnMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    spawn_mode_source:
      spawnModeSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    multi_session_gate: multiSessionEnabled,
    pre_create_session: preCreateSession,
    worktree_available: worktreeAvailable,
  })
  logForDiagnosticsNoPII('info', 'bridge_started', {
    max_sessions: config.maxSessions,
    sandbox: config.sandbox,
    spawn_mode: config.spawnMode,
  })

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose,
    sandbox,
    debugFile,
    permissionMode,
    onDebug: logForDebugging,
    onActivity: (sessionId, activity) => {
      logForDebugging(
        `[bridge:activity] sessionId=${sessionId} ${activity.type} ${activity.summary}`,
      )
    },
    onPermissionRequest: (sessionId, request, _accessToken) => {
      logForDebugging(
        `[bridge:perm] sessionId=${sessionId} tool=${request.request.tool_name} request_id=${request.request_id} (not auto-approving)`,
      )
    },
  })

  const logger = createWireLogger({ verbose })
  const { parseGitHubRepository } = await import('../../utils/detectRepository.js')
  const ownerRepo = gitRepoUrl ? parseGitHubRepository(gitRepoUrl) : null
  // Use the repo name from the parsed owner/repo, or fall back to the dir basename
  const repoName = ownerRepo ? ownerRepo.split('/').pop()! : basename(dir)
  logger.setRepoInfo(repoName, branch)

  // `w` toggle is available iff we're in a multi-session mode AND worktree
  // is a valid option. When unavailable, the mode suffix and hint are hidden.
  const toggleAvailable = spawnMode !== 'single-session' && worktreeAvailable
  if (toggleAvailable) {
    // Safe cast: spawnMode is not single-session (checked above), and the
    // saved-worktree-in-non-git guard + exit check above ensure worktree
    // is only reached when available.
    logger.setSpawnModeDisplay(spawnMode as 'same-dir' | 'worktree')
  }

  // Listen for keys: space toggles QR code, w toggles spawn mode
  const onStdinData = (data: Buffer): void => {
    if (data[0] === 0x03 || data[0] === 0x04) {
      // Ctrl+C / Ctrl+D — trigger graceful shutdown
      process.emit('SIGINT')
      return
    }
    if (data[0] === 0x20 /* space */) {
      logger.toggleQr()
      return
    }
    if (data[0] === 0x77 /* 'w' */) {
      if (!toggleAvailable) {
        return
      }
      const newMode: 'same-dir' | 'worktree' =
        config.spawnMode === 'same-dir' ? 'worktree' : 'same-dir'
      config.spawnMode = newMode
      logEvent('zy_bridge_spawn_mode_toggled', {
        spawn_mode: newMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logger.logStatus(
        newMode === 'worktree'
          ? 'Spawn mode: worktree (new sessions get isolated git worktrees)'
          : 'Spawn mode: same-dir (new sessions share the current directory)',
      )
      logger.setSpawnModeDisplay(newMode)
      logger.refreshDisplay()
      saveCurrentProjectConfig((current) => {
        if (current.remoteControlSpawnMode === newMode) {
          return current
        }
        return { ...current, remoteControlSpawnMode: newMode }
      })
      return
    }
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onStdinData)
  }

  const controller = new AbortController()
  const onSigint = (): void => {
    logForDebugging('[bridge:shutdown] SIGINT received, shutting down')
    controller.abort()
  }
  const onSigterm = (): void => {
    logForDebugging('[bridge:shutdown] SIGTERM received, shutting down')
    controller.abort()
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // Auto-create an empty session so the user has somewhere to type
  // immediately (matching /remote-control behavior). Controlled by
  // preCreateSession: on by default; --no-create-session-in-dir opts out.
  // When a --session-id resume succeeded, skip creation entirely — the
  // session already exists and bridge/reconnect has re-queued it.
  // When resume was requested but failed on env mismatch, effectiveResumeSessionId
  // is undefined, so we fall through to fresh session creation (honoring the
  // "Creating a fresh session instead" warning printed above).
  let initialSessionId: string | null = feature('KAIROS')
    ? (effectiveResumeSessionId ?? null)
    : null
  if (preCreateSession && !(feature('KAIROS') ? effectiveResumeSessionId : false)) {
    const { createWireSession } = await import('../createSession.js')
    try {
      initialSessionId = await createWireSession({
        environmentId,
        title: name,
        events: [],
        gitRepoUrl,
        branch,
        signal: controller.signal,
        baseUrl,
        getAccessToken: getWireAccessToken,
        permissionMode,
      })
      if (initialSessionId) {
        logForDebugging(`[bridge:init] Created initial session ${initialSessionId}`)
      }
    } catch (err) {
      logForDebugging(`[bridge:init] Session creation failed (non-fatal): ${errorMessage(err)}`)
    }
  }

  // Crash-recovery pointer: write immediately so kill -9 at any point
  // after this leaves a recoverable trail. Covers both fresh sessions and
  // resumed ones (so a second crash after resume is still recoverable).
  // Cleared when runWireLoop falls through to archive+deregister; left in
  // place on the SIGINT resumable-shutdown return (backup for when the user
  // closes the terminal before copying the printed --session-id hint).
  // Refreshed hourly so a 5h+ session that crashes still has a fresh
  // pointer (staleness checks file mtime, backend TTL is rolling-from-poll).
  let pointerRefreshTimer: ReturnType<typeof setInterval> | null = null
  // Single-session only: --continue forces single-session mode on resume,
  // so a pointer written in multi-session mode would contradict the user's
  // config when they try to resume. The resumable-shutdown path is also
  // gated to single-session (line ~1254) so the pointer would be orphaned.
  if (initialSessionId && spawnMode === 'single-session') {
    const { writeWirePointer } = await import('../bridgePointer.js')
    const pointerPayload = {
      sessionId: initialSessionId,
      environmentId,
      source: 'standalone' as const,
    }
    await writeWirePointer(config.dir, pointerPayload)
    pointerRefreshTimer = setInterval(writeWirePointer, 60 * 60 * 1000, config.dir, pointerPayload)
    // Don't let the interval keep the process alive on its own.
    pointerRefreshTimer.unref?.()
  }

  try {
    await runWireLoop(
      config,
      environmentId,
      environmentSecret,
      api,
      spawner,
      logger,
      controller.signal,
      undefined,
      initialSessionId ?? undefined,
      async () => {
        // Clear the memoized OAuth token cache so we re-read from secure
        // storage, picking up tokens refreshed by child processes.
        clearOAuthTokenCache()
        // Proactively refresh the token if it's expired on disk too.
        await checkAndRefreshOAuthTokenIfNeeded()
        return getWireAccessToken()
      },
    )
  } finally {
    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.stdin.off('data', onStdinData)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  // The bridge bypasses init.ts (and its graceful shutdown handler), so we
  // must exit explicitly.
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(0)
}

// ─── 无头 bridge（daemon worker）────────────────────────────────────────────────

/**
 * 由 runWireHeadless 抛出，用于监督器不应该重试的配置问题
 *（未接受信任、worktree 不可用、http 非 https）。
 * daemon worker 捕获此错误并以 EXIT_CODE_PERMANENT 退出，
 * 使监督器停放 worker 而不是在退避时重新生成它。
 */
export class WireHeadlessPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireHeadlessPermanentError'
  }
}

export type HeadlessWireOpts = {
  dir: string
  name?: string
  spawnMode: 'same-dir' | 'worktree'
  capacity: number
  permissionMode?: string
  sandbox: boolean
  sessionTimeoutMs?: number
  createSessionOnStart: boolean
  getAccessToken: () => string | undefined
  onAuth401: (failedToken: string) => Promise<boolean>
  log: (s: string) => void
}

/**
 * `remoteControl` daemon worker 的无交互 bridge 入口点。
 *
 * bridgeMain() 的线性子集：没有 readline 对话框、没有 stdin 键处理程序、
 * 没有 TUI、没有 process.exit()。配置来自调用者（daemon.json），
 * 认证通过 IPC（监督器的 AuthManager），日志输出到 worker 的 stdout 管道。
 * 致命错误时抛出——worker 捕获并将永久 vs 瞬态映射到正确的退出码。
 *
 * 当 `signal` 中止且轮询循环清理时干净地解析。
 */
export async function runWireHeadless(opts: HeadlessWireOpts, signal: AbortSignal): Promise<void> {
  const { dir, log } = opts

  // Worker 继承监督器的 CWD。先 chdir 以便 git 工具
  //（getBranch/getRemoteUrl）——从下方设置的 bootstrap CWD 状态读取——
  // 能正确解析到对应的仓库。
  process.chdir(dir)
  const { setOriginalCwd, setCwdState } = await import('../../bootstrap/runtime/runtimeContext.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../../services/config/config.js'
  )
  enableConfigs()
  const { initSinks } = await import('../../services/telemetry/sinks.js')
  initSinks()

  if (!checkHasTrustDialogAccepted()) {
    throw new WireHeadlessPermanentError(
      `Workspace not trusted: ${dir}. Run \`zy\` in that directory first to accept the trust dialog.`,
    )
  }

  if (!opts.getAccessToken()) {
    // 瞬态——监督器的 AuthManager 可能在下一个周期获取到 token。
    throw new Error(BRIDGE_LOGIN_ERROR)
  }

  const { getWireBaseUrl } = await import('../bridgeConfig.js')
  const baseUrl = getWireBaseUrl()
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    throw new WireHeadlessPermanentError(
      'Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
  }
  const sessionIngressUrl =
    isInternalBuild() && process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import('../../utils/git.js')
  const { hasWorktreeCreateHook } = await import('../../services/hooks.js')

  if (opts.spawnMode === 'worktree') {
    const worktreeAvailable = hasWorktreeCreateHook() || findGitRoot(dir) !== null
    if (!worktreeAvailable) {
      throw new WireHeadlessPermanentError(
        `Worktree mode requires a git repository or WorktreeCreate hooks. Directory ${dir} has neither.`,
      )
    }
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const config: WireConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: opts.capacity,
    spawnMode: opts.spawnMode,
    verbose: false,
    sandbox: opts.sandbox,
    bridgeId,
    workerType: 'zy_code',
    environmentId: randomUUID(),
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    sessionTimeoutMs: opts.sessionTimeoutMs,
  }

  const api = createWireApiClient({
    baseUrl,
    getAccessToken: opts.getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: log,
    onAuth401: opts.onAuth401,
    getTrustedDeviceToken,
  })

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerWireEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    // 瞬态——让监督器退避重试。
    throw new Error(`Bridge registration failed: ${errorMessage(err)}`)
  }

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose: false,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode,
    onDebug: log,
  })

  const logger = createHeadlessWireLogger(log)
  logger.printBanner(config, environmentId)

  let initialSessionId: string | undefined
  if (opts.createSessionOnStart) {
    const { createWireSession } = await import('../createSession.js')
    try {
      const sid = await createWireSession({
        environmentId,
        title: opts.name,
        events: [],
        gitRepoUrl,
        branch,
        signal,
        baseUrl,
        getAccessToken: opts.getAccessToken,
        permissionMode: opts.permissionMode,
      })
      if (sid) {
        initialSessionId = sid
        log(`created initial session ${sid}`)
      }
    } catch (err) {
      log(`session pre-creation failed (non-fatal): ${errorMessage(err)}`)
    }
  }

  await runWireLoop(
    config,
    environmentId,
    environmentSecret,
    api,
    spawner,
    logger,
    signal,
    undefined,
    initialSessionId,
    async () => opts.getAccessToken(),
  )
}

/** WireLogger 适配器，将所有内容路由到单行日志函数。 */
export function createHeadlessWireLogger(log: (s: string) => void): WireLogger {
  const noop = (): void => {}
  return {
    printBanner: (cfg, envId) =>
      log(
        `registered environmentId=${envId} dir=${cfg.dir} spawnMode=${cfg.spawnMode} capacity=${cfg.maxSessions}`,
      ),
    logSessionStart: (id, _prompt) => log(`session start ${id}`),
    logSessionComplete: (id, ms) => log(`session complete ${id} (${ms}ms)`),
    logSessionFailed: (id, err) => log(`session failed ${id}: ${err}`),
    logStatus: log,
    logVerbose: log,
    logError: (s) => log(`error: ${s}`),
    logReconnected: (ms) => log(`reconnected after ${ms}ms`),
    addSession: (id, _url) => log(`session attached ${id}`),
    removeSession: (id) => log(`session detached ${id}`),
    updateIdleStatus: noop,
    updateReconnectingStatus: noop,
    updateSessionStatus: noop,
    updateSessionActivity: noop,
    updateSessionCount: noop,
    updateFailedStatus: noop,
    setSpawnModeDisplay: noop,
    setRepoInfo: noop,
    setDebugLogPath: noop,
    setAttached: noop,
    setSessionTitle: noop,
    clearStatus: noop,
    toggleQr: noop,
    refreshDisplay: noop,
  }
}
