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
import { logForDebugging } from '../../services/infra/debug.js'
import { logForDiagnosticsNoPII } from '../../services/telemetry/diagLogs.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { sleep } from '../../utils/sleep.js'
import { createWireApiClient, validateWireId, WireFatalError } from '../bridgeApi.js'
import { createWireLogger } from '../bridgeUI.js'
import { getPollIntervalConfig } from '../pollConfig.js'
import { toInfraSessionId } from '../sessionIdCompat.js'
import { createSessionSpawner } from '../sessionRunner.js'
import { getTrustedDeviceToken } from '../trustedDevice.js'
import { BRIDGE_LOGIN_ERROR, type SpawnMode, type WireConfig, type WireLogger } from '../types.js'
import { SPAWN_SESSIONS_DEFAULT, isMultiSessionSpawnEnabled } from './wirePollingPolicy.js'
import { spawnScriptArgs } from './sessionSpawner.js'
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
  // 保持可变，使 --continue 能从 pointer 文件设置该值。下方 #20460 恢复流程随后会将其视同
  // 显式传入的 --session-id。
  let resumeSessionId = parsedSessionId
  // --continue 找到 pointer 时，此值是 pointer 所在目录，可能是相邻 worktree 而非 `dir`。
  // 恢复流程确定失败时清除此文件，避免 --continue 反复命中同一失效会话。显式传入
  // --session-id 时为 undefined，不处理 pointer。
  let resumePointerDir: string | undefined

  const usedMultiSessionFeature =
    parsedSpawnMode !== undefined ||
    parsedCapacity !== undefined ||
    parsedCreateSessionInDir !== undefined

  // 尽早校验 permission mode，使用户在 bridge 开始轮询任务前看到错误。
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

  // bridge 快速路径绕过 init.ts，因此必须在任何间接调用 getGlobalConfig() 的代码前启用配置读取。
  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../../services/config/config.js'
  )
  enableConfigs()

  // 初始化 analytics 与错误报告 sink。bridge 绕过 setup() 初始化流程，因此在此直接调用
  // initSinks() 挂载 sink。
  const { initSinks } = await import('../../services/telemetry/sinks.js')
  initSinks()

  // 感知功能开关的校验：--spawn / --capacity / --create-session-in-dir 需要多会话开关。
  // parseArgs 已校验参数组合，此处只检查需要异步调用 GrowthBook 的开关。应在 enableConfigs()
  //（GrowthBook 缓存会读取全局配置）和 initSinks() 之后运行，以便拒绝事件可以入队。
  const multiSessionEnabled = await isMultiSessionSpawnEnabled()
  if (usedMultiSessionFeature && !multiSessionEnabled) {
    await logEventAsync('zy_bridge_multi_session_denied', {
      used_spawn: parsedSpawnMode !== undefined,
      used_capacity: parsedCapacity !== undefined,
      used_create_session_in_dir: parsedCreateSessionInDir !== undefined,
    })
    // logEventAsync 只负责入队，process.exit() 会丢弃缓冲事件。显式 flush，500ms 上限与
    // gracefulShutdown.ts 一致。sleep() 虽不会 unref 定时器，但紧接着会调用 process.exit()，
    // 因此该定时器不会延迟关停。
    await Promise.race([
      Promise.all([shutdownZyEventLogging(), shutdownDatadog()]),
      sleep(500, undefined, { unref: true }),
    ]).catch(() => {})
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error('Error: Multi-session Remote Control is not enabled for your account yet.')
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 设置 bootstrap CWD，使信任检查、项目配置查找以及 git 工具（getBranch、getRemoteUrl）
  // 均针对正确路径解析。
  const { setOriginalCwd, setCwdState } = await import('../../bootstrap/runtime/runtimeContext.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  // bridge 绕过 main.tsx（它通过 showSetupScreens 渲染交互式 TrustDialog），因此必须确认用户
  // 此前已通过普通 `zy` 会话建立信任。
  if (!checkHasTrustDialogAccepted()) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Error: Workspace not trusted. Please run \`zy\` in ${dir} first to review and accept the workspace trust dialog.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 解析认证信息
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

  // 首次远程连接对话框：说明 bridge 的作用并获取同意
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

  // --continue：从崩溃恢复 pointer 解析最近会话，并接入 #20460 的 --session-id 流程。该逻辑
  // 感知 worktree：先检查当前目录（快速路径，不执行命令），未命中时再扩展检查相邻 git
  // worktree。REPL bridge 写入 getOriginalCwd()，而 EnterWorktreeTool/activeWorktreeSession
  // 可能使其指向某个 worktree，即使用户 shell 位于仓库根目录。parseArgs 受 KAIROS 控制；
  // 外部构建中 continueSession 始终为 false，因此此代码块会被 tree-shake。
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
    // 记录 pointer 来源，使下方 #20460 的 exit(1) 路径在确定失败时清除正确文件；否则
    // --continue 会反复命中同一失效会话。来源可能是相邻 worktree。
    resumePointerDir = pointerDir
  }

  // 生产环境中的 baseUrl 是 OAuth 配置提供的 Anthropic API；CLAUDE_BRIDGE_BASE_URL 仅供
  // ant 本地开发覆盖。
  const baseUrl = getWireBaseUrl()

  // 非 localhost 目标必须使用 HTTPS，以保护凭据。
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

  // WebSocket 连接使用的 session ingress URL。生产环境中与 baseUrl 相同，Envoy 会将
  // /v1/session_ingress/* 路由到 session-ingress。本地的 session-ingress 与
  // contain-provide-api 分别运行在 9413 和 8211 端口，因此必须显式设置
  // CLAUDE_BRIDGE_SESSION_INGRESS_URL。与 CLAUDE_BRIDGE_BASE_URL 一样仅供 ant 使用。
  const sessionIngressUrl =
    isInternalBuild() && process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import('../../services/infra/git.js')

  // 预先检查首次运行对话框和 `w` 切换所需的 worktree 可用性。无条件执行，以便提前知道
  // worktree 是否可选。
  const { hasWorktreeCreateHook } = await import('../../services/hooks.js')
  const worktreeAvailable = hasWorktreeCreateHook() || findGitRoot(dir) !== null

  // 加载各项目保存的启动模式偏好，并受 multiSessionEnabled 控制，使 GrowthBook 回滚能干净地
  // 将用户恢复为单会话。否则即使开关关闭，已保存偏好也会静默重新启用多会话行为（worktree
  // 隔离、最多 32 个会话、`w` 切换）。同时防止目录曾是 git 仓库或用户复制配置后遗留陈旧的
  // worktree 偏好；从磁盘清除它，避免每次启动重复警告。
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

  // 首次运行时选择启动模式：仅当选择有意义（开关启用、两种模式均可用、无显式覆盖且不是恢复）
  // 时，每个项目询问一次。结果保存到 ProjectConfig，后续运行不再询问。
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

  // 确定最终启动模式。优先级：恢复 > 显式 --spawn > 保存的项目偏好 > 开关默认值。
  // - 通过 --continue / --session-id 恢复：始终使用单会话，因为目标是原目录中的特定会话
  // - 显式 --spawn：直接使用该值，不持久化
  // - 保存的 ProjectConfig.remoteControlSpawnMode：由首次运行对话框或 `w` 设置
  // - 开关启用时默认：same-dir（持久多会话，共享 cwd）
  // - 开关关闭时默认：single-session（保持旧行为）
  // 同时记录启动模式的确定方式，供发布 analytics 使用。
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
  // 启动时预创建空会话，让用户可以立即输入。该会话在当前目录运行，轮询循环启动时免于创建
  // worktree。默认开启；--no-create-session-in-dir 可改为纯按需服务，使每个会话相互隔离。
  // 创建处的 effectiveResumeSessionId 检查负责恢复场景：恢复成功时跳过创建，环境不匹配而
  // 回退时继续创建新会话。
  const preCreateSession = parsedCreateSessionInDir ?? true

  // 未使用 --continue 时，遗留 pointer 表明上次运行未正常关停（崩溃、kill -9、终端关闭）。
  // 清除它，避免陈旧环境继续滞留。所有模式均执行；文件不存在时 clearWirePointer 不操作。
  // 这也覆盖用户在单会话模式崩溃、随后切换开关并以 worktree 模式重新启动的情况。仅单会话
  // 模式会写入新 pointer。
  if (!resumeSessionId) {
    const { clearWirePointer } = await import('../bridgePointer.js')
    await clearWirePointer(dir)
  }

  // worktree 模式需要 git 或 WorktreeCreate/WorktreeRemove hook。这里只能通过显式
  // --spawn=worktree 到达（默认是 same-dir）；上方已检查保存的 worktree 偏好。
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

  // 通过 --session-id 恢复会话时，先获取会话的 environment_id 并复用于注册；后端对此操作
  // 幂等。其他情况保持 undefined，因为后端拒绝客户端生成的 UUID，并会分配新环境。
  // feature('KAIROS') 开关：--session-id 仅供 ant 使用；parseArgs 在开关关闭时已拒绝该参数，
  // 因此外部构建中的 resumeSessionId 在此始终为 undefined，该检查用于 tree-shake。
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
    // 主动刷新 OAuth token。getWireSession 使用原始 axios，不含 withOAuthRetry 的 401 刷新
    // 逻辑；否则存在但已过期的 token 会产生误导性的 “not found” 错误。
    await checkAndRefreshOAuthTokenIfNeeded()
    clearOAuthTokenCache()
    const { getWireSession } = await import('../createSession.js')
    const session = await getWireSession(resumeSessionId!, {
      baseUrl,
      getAccessToken: getWireAccessToken,
    })
    if (!session) {
      // 服务端已无此会话，说明 pointer 陈旧。将其清除，避免用户下次启动再次收到提示。显式
      // --session-id 不处理 pointer，因为它是独立文件，甚至可能不存在。resumePointerDir
      // 可能是相邻 worktree，因此要清除该目录中的文件。
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

  // 进入轮询循环前注册 bridge 环境。
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
    // 注册失败属于致命错误，输出清晰消息而非堆栈。
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      err instanceof WireFatalError && err.status === 404
        ? 'Remote Control environments are not available for your account.'
        : `Error: ${errorMessage(err)}`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 跟踪 --session-id 恢复流程是否成功完成。下方据此跳过新会话创建，并设置 initialSessionId。
  // 环境不匹配时清除，使流程能平稳回退到新会话。
  let effectiveResumeSessionId: string | undefined
  if (feature('KAIROS') ? resumeSessionId !== undefined : false) {
    if (reuseEnvironmentId && environmentId !== reuseEnvironmentId) {
      // 后端返回了不同的 environment_id，说明原环境已过期或被回收。会话绑定在旧环境，无法在
      // 新环境上重连。记录到 Sentry 以便观察，并继续在新环境中创建新会话。
      logError(
        new Error(
          `Bridge resume env mismatch: requested ${reuseEnvironmentId}, backend returned ${environmentId}. Falling back to fresh session.`,
        ),
      )
      // biome-ignore lint/suspicious/noConsole: intentional warning output
      console.warn(
        `Warning: Could not resume session ${resumeSessionId} — its environment has expired. Creating a fresh session instead.`,
      )
      // 不注销，因为接下来会使用此新环境。effectiveResumeSessionId 保持 undefined，进入下方
      // 新会话路径。
    } else {
      // 强制停止此会话所有陈旧 worker 实例并重新入队，使本地轮询循环可以取得。必须在注册后
      // 执行，让后端知道该环境存在活跃 worker。
      //
      // pointer 保存 session_* ID，但启用 ccr_v2_compat_enabled 时，/bridge/reconnect 会按
      // 基础设施 tag（cse_*）查找会话。两者都尝试；若已是 cse_*，转换不会改变值。
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

        // 瞬时重连失败时不要注销；此时 environmentId 就是会话自身的环境，注销会导致无法重试。
        // 后端会通过 4 小时 TTL 清理。
        const isFatal = err instanceof WireFatalError
        // 仅在致命重连失败时清除 pointer。瞬时失败（“再次运行相同命令”）应保留 pointer，使下次
        // 启动再次提示；这本身就是重试机制。
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
  const { parseGitHubRepository } = await import('../../services/git/detectRepository.js')
  const ownerRepo = gitRepoUrl ? parseGitHubRepository(gitRepoUrl) : null
  // 使用解析出的 owner/repo 中的仓库名，缺失时回退到目录 basename
  const repoName = ownerRepo ? ownerRepo.split('/').pop()! : basename(dir)
  logger.setRepoInfo(repoName, branch)

  // 仅当处于多会话模式且 worktree 可用时，才允许用 `w` 切换；不可用时隐藏模式后缀与提示。
  const toggleAvailable = spawnMode !== 'single-session' && worktreeAvailable
  if (toggleAvailable) {
    // 安全断言：上方已确认 spawnMode 不是 single-session，非 git 目录的已保存 worktree 防护与
    // 退出检查也确保只有可用时才会进入 worktree。
    logger.setSpawnModeDisplay(spawnMode as 'same-dir' | 'worktree')
  }

  // 监听按键：空格切换二维码，`w` 切换启动模式
  const onStdinData = (data: Buffer): void => {
    if (data[0] === 0x03 || data[0] === 0x04) {
      // Ctrl+C / Ctrl+D 触发优雅关停
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

  // 自动创建空会话，让用户可以立即输入，与 /remote-control 行为一致。由 preCreateSession
  // 控制，默认开启；--no-create-session-in-dir 可关闭。通过 --session-id 恢复成功时完全
  // 跳过创建，因为会话已存在且 bridge/reconnect 已重新入队。请求恢复但因环境不匹配失败时，
  // effectiveResumeSessionId 为 undefined，因此继续创建新会话，与上方“改为创建新会话”的
  // 警告一致。
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

  // 崩溃恢复 pointer：立即写入，使此后任意时刻发生 kill -9 都留下可恢复线索。新会话与恢复会话
  // 均覆盖，因此恢复后再次崩溃仍可恢复。runWireLoop 继续执行归档与注销时清除；SIGINT 可恢复
  // 关停提前返回时保留，防止用户复制已输出的 --session-id 提示前关闭终端。每小时刷新一次，
  // 使运行超过 5 小时的会话崩溃时仍有新鲜 pointer；陈旧检查使用文件 mtime，后端 TTL 随轮询滚动。
  let pointerRefreshTimer: ReturnType<typeof setInterval> | null = null
  // 仅限单会话：--continue 会在恢复时强制单会话模式，因此多会话模式写入的 pointer 会与用户
  // 恢复时的配置冲突。可恢复关停路径也仅限单会话，否则 pointer 会成为孤儿。
  if (initialSessionId && spawnMode === 'single-session') {
    const { writeWirePointer } = await import('../bridgePointer.js')
    const pointerPayload = {
      sessionId: initialSessionId,
      environmentId,
      source: 'standalone' as const,
    }
    await writeWirePointer(config.dir, pointerPayload)
    pointerRefreshTimer = setInterval(writeWirePointer, 60 * 60 * 1000, config.dir, pointerPayload)
    // 不让该定时器单独阻止进程退出。
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
        // 清除记忆化 OAuth token 缓存，以便从安全存储重新读取子进程刷新的 token。
        clearOAuthTokenCache()
        // 若磁盘中的 token 也已过期，则主动刷新。
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

  // bridge 绕过 init.ts 及其优雅关停 handler，因此必须显式退出。
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

  const { getBranch, getRemoteUrl, findGitRoot } = await import('../../services/infra/git.js')
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
