/** 每个会话的默认超时时间（24 小时）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** 附加在桥接认证错误后的通用登录指引。 */
export const BRIDGE_LOGIN_INSTRUCTION =
  'Remote Control is only available with zy.ai subscriptions. Please use `/login` to sign in with your zy.ai account.'

/** 未认证时运行 `zy remote-control` 所输出的完整错误。 */
export const BRIDGE_LOGIN_ERROR = `Error: You must be logged in to use Remote Control.\n\n${BRIDGE_LOGIN_INSTRUCTION}`

/** 用户通过 /remote-control 或 ultraplan 启动流程断开 Remote Control 时显示。 */
export const REMOTE_CONTROL_DISCONNECTED_MSG = 'Remote Control disconnected.'

// --- environments API 的协议类型 ---

export type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}

export type WorkResponse = {
  id: string
  type: 'work'
  environment_id: string
  state: string
  data: WorkData
  secret: string // base64url-encoded JSON
  created_at: string
}

export type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>
  zy_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  /**
   * 服务端驱动的 CCR v2 选择器。会话通过 v2 兼容层（ccr_v2_compat_enabled）创建时，
   * 由 prepare_work_secret() 设置。BYOC runner 在
   * environment-runner/sessionExecutor.ts 中读取的也是此字段。
   */
  use_code_sessions?: boolean
}

export type SessionDoneStatus = 'completed' | 'failed' | 'interrupted'

export type SessionActivityType = 'tool_start' | 'text' | 'result' | 'error'

export type SessionActivity = {
  type: SessionActivityType
  summary: string // e.g. "Editing src/foo.ts", "Reading package.json"
  timestamp: number
}

/**
 * `zy remote-control` 选择会话工作目录的方式。
 * - `single-session`：cwd 中只运行一个会话，会话结束时销毁桥接
 * - `worktree`：服务器持续运行，每个会话使用独立的 git worktree
 * - `same-dir`：服务器持续运行，所有会话共享 cwd（可能相互覆盖）
 */
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'

/**
 * 本代码库生成的已知 worker_type 值。注册环境时以 `metadata.worker_type` 发送，
 * 使 zy.ai 能按来源筛选会话选择器（例如 assistant 标签页只显示 assistant worker）。
 * 后端将其视为不透明字符串；桌面端 cowork 会发送不在此联合类型中的 `"cowork"`。
 * REPL 代码使用此窄类型保证自身分支完备，wire 层字段则接受任意字符串。
 */
export type WireWorkerType = 'zy_code' | 'zy_code_assistant'

export type WireConfig = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  spawnMode: SpawnMode
  verbose: boolean
  sandbox: boolean
  /** 客户端生成的 UUID，用于标识此桥接实例。 */
  bridgeId: string
  /**
   * 以 metadata.worker_type 发送，使 Web 客户端能按来源筛选。
   * 后端将其视为不透明值，可为任意字符串，不限于 WireWorkerType。
   */
  workerType: string
  /** 客户端生成的 UUID，用于保证环境注册幂等。 */
  environmentId: string
  /**
   * 后端签发的 environment_id，重新注册时复用。设置后，后端会将注册视为重连既有环境，
   * 而非新建环境。用于 `zy remote-control --session-id` 恢复。必须采用后端 ID 格式；
   * 客户端 UUID 会被以 400 拒绝。
   */
  reuseEnvironmentId?: string
  /** 桥接所连接的 API 基础 URL，用于轮询。 */
  apiBaseUrl: string
  /** WebSocket 连接使用的 Session Ingress 基础 URL；本地环境中可能与 apiBaseUrl 不同。 */
  sessionIngressUrl: string
  /** 通过 --debug-file 传入的调试文件路径。 */
  debugFile?: string
  /** 每个会话的超时时间（毫秒）；超过此时间的会话会被终止。 */
  sessionTimeoutMs?: number
}

// --- 依赖接口（便于测试） ---

/**
 * 发回会话的 control_response 事件，例如权限决定。
 * 按 SDK 协议，`subtype` 为 `'success'`；内部 `response` 携带权限决定载荷，
 * 例如 `{ behavior: 'allow' }`。
 */
export type PermissionResponseEvent = {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>
  }
}

export type WireApiClient = {
  registerWireEnvironment(config: WireConfig): Promise<{
    environment_id: string
    environment_secret: string
  }>
  pollForWork(
    environmentId: string,
    environmentSecret: string,
    signal?: AbortSignal,
    reclaimOlderThanMs?: number,
  ): Promise<WorkResponse | null>
  acknowledgeWork(environmentId: string, workId: string, sessionToken: string): Promise<void>
  /** 通过 environments API 停止工作项。 */
  stopWork(environmentId: string, workId: string, force: boolean): Promise<void>
  /** 优雅关闭时注销并删除桥接环境。 */
  deregisterEnvironment(environmentId: string): Promise<void>
  /** 通过会话事件 API 向会话发送权限响应（control_response）。 */
  sendPermissionResponseEvent(
    sessionId: string,
    event: PermissionResponseEvent,
    sessionToken: string,
  ): Promise<void>
  /** 归档会话，使其不再作为活跃会话显示在服务器上。 */
  archiveSession(sessionId: string): Promise<void>
  /**
   * 强制停止陈旧 worker 实例，并在某个环境上重新排队会话。
   * 原桥接失效后，`--session-id` 使用此方法恢复会话。
   */
  reconnectSession(environmentId: string, sessionId: string): Promise<void>
  /**
   * 为活跃工作项发送轻量心跳并延长租约。使用 SessionIngressAuth
   *（JWT，无需访问数据库）而非 EnvironmentSecretAuth，返回含租约状态的服务器响应。
   */
  heartbeatWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<{ lease_extended: boolean; state: string }>
}

export type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>
  kill(): void
  forceKill(): void
  activities: SessionActivity[] // ring buffer of recent activities (last ~10)
  currentActivity: SessionActivity | null // most recent
  accessToken: string // session_ingress_token for API calls
  lastStderr: string[] // ring buffer of last stderr lines
  writeStdin(data: string): void // write directly to child stdin
  /** 更新运行中会话的访问令牌，例如令牌刷新后。 */
  updateAccessToken(token: string): void
}

export type SessionSpawnOpts = {
  sessionId: string
  sdkUrl: string
  accessToken: string
  /** 为 true 时，使用 CCR v2 环境变量启动子进程（SSE transport + CCRClient）。 */
  useCcrV2?: boolean
  /** useCcrV2 为 true 时必填，取自 POST /worker/register。 */
  workerEpoch?: number
  /**
   * 从子进程 stdout（通过 --replay-user-messages）看到第一条真实用户消息时触发一次，
   * 并传入该消息文本。若尚无标题，调用方可据此生成会话标题；工具结果和合成用户消息会跳过。
   */
  onFirstUserMessage?: (text: string) => void
}

export type SessionSpawner = {
  spawn(opts: SessionSpawnOpts, dir: string): SessionHandle
}

export type WireLogger = {
  printBanner(config: WireConfig, environmentId: string): void
  logSessionStart(sessionId: string, prompt: string): void
  logSessionComplete(sessionId: string, durationMs: number): void
  logSessionFailed(sessionId: string, error: string): void
  logStatus(message: string): void
  logVerbose(message: string): void
  logError(message: string): void
  /** 从连接错误中恢复后记录重连成功事件。 */
  logReconnected(disconnectedMs: number): void
  /** 显示含仓库/分支信息及微光动画的空闲状态。 */
  updateIdleStatus(): void
  /** 在实时界面中显示正在重连状态。 */
  updateReconnectingStatus(delayStr: string, elapsedStr: string): void
  updateSessionStatus(
    sessionId: string,
    elapsed: string,
    activity: SessionActivity,
    trail: string[],
  ): void
  clearStatus(): void
  /** 设置状态行显示的仓库信息。 */
  setRepoInfo(repoName: string, branch: string): void
  /** 设置状态行上方显示的调试日志 glob，供 ant 用户使用。 */
  setDebugLogPath(path: string): void
  /** 会话启动时切换到“Attached”状态。 */
  setAttached(sessionId: string): void
  /** 在实时界面中显示失败状态。 */
  updateFailedStatus(error: string): void
  /** 切换二维码可见性。 */
  toggleQr(): void
  /** 更新“<n> of <m> sessions”指示器和启动模式提示。 */
  updateSessionCount(active: number, max: number, mode: SpawnMode): void
  /** 更新会话计数行中的启动模式；传入 null 时隐藏（单会话或无法切换时）。 */
  setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void
  /** 注册新会话以供多会话界面显示；启动成功后调用。 */
  addSession(sessionId: string, url: string): void
  /** 更新多会话列表中各会话的活动摘要，即正在运行的工具。 */
  updateSessionActivity(sessionId: string, activity: SessionActivity): void
  /**
   * 设置会话显示标题。多会话模式下更新项目列表条目；单会话模式下还会在主状态行显示标题。
   * 此操作会触发渲染，但重连或失败状态下有防护。
   */
  setSessionTitle(sessionId: string, title: string): void
  /** 会话结束时将其从多会话界面移除。 */
  removeSession(sessionId: string): void
  /** 强制重新渲染状态界面，用于刷新多会话活动。 */
  refreshDisplay(): void
}
