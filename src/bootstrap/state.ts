import { isInternalBuild } from '../utils/envUtils.js'

import type { CreateParams } from '../types/llm.js'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// 浏览器 SDK 构建的间接引用（package.json 的 "browser" 字段会替换
// crypto.ts 为 crypto.browser.ts）。纯叶子节点重新导出 node:crypto —
// 零循环依赖风险。路径别名导入绕过了 bootstrap-isolation 检查
//（该规则仅检查 ./ 和 / 前缀）；显式禁用说明了意图。
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'

// 已注册钩子的联合类型 — 可以是 SDK 回调或原生插件钩子
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// 不要在此处添加更多状态 — 添加全局状态需谨慎

// dev: 标记通过 --dangerously-load-development-channels 传入的条目。
// 允许列表门控对每个条目单独检查（而非会话级别的
// hasDevChannels 位），因此同时传入两个标志不会让开发对话框的
// 接受行为泄漏 allowlist-bypass 到 --channels 条目。
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type State = {
  originalCwd: string
  // 稳定的项目根目录 — 启动时设置一次（包括 --worktree 标志），
  // 会话中的 EnterWorktreeTool 永远不会更新它。
  // 用于项目标识（历史记录、技能、会话），而非文件操作。
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // 为 true 时，ensureToolResultPairing 在不匹配时抛出异常，而非
  // 用合成占位符修复。HFI 在启动时选择加入，使轨迹快速失败，
  // 而不是让模型基于伪造的 tool_results 进行训练。
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // 遥测状态
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // 父会话 ID，用于追踪会话谱系（例如：计划模式 -> 实现模式）
  parentSessionId: SessionId | undefined
  // 日志记录器状态
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // Meter provider 状态
  meterProvider: MeterProvider | null
  // Tracer provider 状态
  tracerProvider: BasicTracerProvider | null
  // Agent 颜色状态
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // 最后一次 API 请求，用于 bug 报告
  lastAPIRequest: Omit<CreateParams, 'messages'> | null
  // 最后一次 API 请求的消息（仅 ant；引用而非克隆）。
  // 捕获压缩后、CLAUDE.md 注入后发送给 API 的完整消息集，
  // 以便 /share 的 serialized_conversation.json 反映真实情况。
  lastAPIRequestMessages: CreateParams['messages'] | null
  // 最后一次自动模式分类器请求，用于 /share 转录
  lastClassifierRequests: unknown[] | null
  // 由 context.ts 缓存的 ZY.md 内容，供自动模式分类器使用。
  // 打破 yoloClassifier → zymd → 文件系统 → 权限的循环依赖。
  cachedZyMdContent: string | null
  // 近期错误的内存日志
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // 来自 --plugin-dir 标志的会话级插件
  inlinePlugins: Array<string>
  // 显式的 --chrome / --no-chrome 标志值（undefined 表示未在 CLI 设置）
  chromeFlagOverride: boolean | undefined
  // 使用 cowork_plugins 目录替代 plugins（--cowork 标志或环境变量）
  useCoworkPlugins: boolean
  // 会话级绕过权限模式的标志（不持久化）
  sessionBypassPermissionsMode: boolean
  // 会话级标志，控制 .zy/scheduled_tasks.json 监听器
  //（useScheduledTasks）。由 cronScheduler.start() 在 JSON 有
  // 条目时设置，或由 CronCreateTool 设置。不持久化。
  scheduledTasksEnabled: boolean
  // 会话级 cron 任务，通过 CronCreate 创建且 durable: false。
  // 按计划触发，与文件支持的任务类似，但永远不会写入
  // .zy/scheduled_tasks.json — 进程结束时消失。通过
  // SessionCronTask 类型化（不从 cronTasks.ts 导入以保持
  // bootstrap 作为导入 DAG 的叶子节点）。
  sessionCronTasks: SessionCronTask[]
  // 本会话中通过 TeamCreate 创建的团队。gracefulShutdown 时
  // cleanupSessionTeams() 会移除这些，避免子 agent 创建的团队
  // 永久留在磁盘上（gh-32730）。TeamDelete 会移除条目以避免
  // 重复清理。放在此处（而非 teamHelpers.ts）以便
  // resetStateForTests() 在测试之间清除它。
  sessionCreatedTeams: Set<string>
  // 会话级信任标志，用于主目录（不持久化到磁盘）
  // 在主目录运行时，会显示信任对话框但不保存到磁盘。
  // 此标志允许需要信任的功能在会话期间正常工作。
  sessionTrustAccepted: boolean
  // 会话级标志，禁用会话持久化到磁盘
  sessionPersistenceDisabled: boolean
  // 追踪用户是否在此会话中退出了计划模式（用于重新进入引导）
  hasExitedPlanMode: boolean
  // 追踪是否需要显示计划模式退出附件（一次性通知）
  needsPlanModeExitAttachment: boolean
  // 追踪是否需要显示自动模式退出附件（一次性通知）
  needsAutoModeExitAttachment: boolean
  // 追踪本会话中是否已显示 LSP 插件推荐（仅显示一次）
  lspRecommendationShownThisSession: boolean
  // SDK init 事件状态 - 结构化输出的 jsonSchema
  initJsonSchema: Record<string, unknown> | null
  // 已注册的钩子 — SDK 回调和插件原生钩子
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // 计划 slug 缓存：sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // 追踪传送的会话，用于可靠性日志
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // 追踪已调用的技能，以便在压缩后保留
  // key 是组合的：`${agentId ?? ''}:${skillName}`，防止跨 agent 覆盖
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // 追踪慢速操作，用于 dev bar 显示（仅 ant）
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK 提供的 betas（例如 context-1m-2025-08-07）
  sdkBetas: string[] | undefined
  // 主线程 agent 类型（来自 --agent 标志或设置）
  mainThreadAgentType: string | undefined
  // 远程模式（--remote 标志）
  isRemoteMode: boolean
  // 直连服务器 URL（用于在标题栏显示）
  directConnectServerUrl: string | undefined
  // 系统提示词部分缓存状态
  systemPromptSectionCache: Map<string, string | null>
  // 向模型发出的最后日期（用于检测午夜日期变化）
  lastEmittedDate: string | null
  // 来自 --add-dir 标志的额外目录（用于加载 CLAUDE.md）
  additionalDirectoriesForzyMd: string[]
  // 来自 --channels 标志的频道服务器允许列表（其频道
  // 通知应注册此会话的服务器）。在 main.tsx 中解析一次 —
  // 标签决定信任模型：'plugin' → 市场验证 + 允许列表，
  // 'server' → 允许列表始终失败（schema 仅限 plugin）。
  // 两种类型都需要 entry.dev 来绕过允许列表。
  allowedChannels: ChannelEntry[]
  // 如果 allowedChannels 中有条目来自
  // --dangerously-load-development-channels（这样 ChannelsNotice 可以在
  // 策略阻止的消息中命名正确的标志）
  hasDevChannels: boolean
  // 包含会话 `.jsonl` 的目录；null = 从 originalCwd 推导。
  sessionProjectDir: string | null
  // 从 GrowthBook 缓存的提示词缓存 1h TTL 允许列表（会话级稳定）
  promptCache1hAllowlist: string[] | null
  // 缓存的 1h TTL 用户资格（会话级稳定）。在首次
  // 评估时锁定，使会话中的超额翻转不会改变 cache_control
  // TTL，否则会破坏服务端的提示词缓存。
  promptCache1hEligible: boolean | null
  // AFK_MODE_BETA_HEADER 的粘滞锁定。自动模式首次
  // 激活后，在会话剩余时间内持续发送该头，这样
  // Shift+Tab 切换就不会破坏约 50-70K token 的提示词缓存。
  afkModeHeaderLatched: boolean | null
  // 缓存编辑 beta 头的粘滞锁定。缓存的
  // microcompact 首次启用后持续发送该头，使会话中
  // 的 GrowthBook/设置切换不会破坏提示词缓存。
  cacheEditingHeaderLatched: boolean | null
  // 清除先前工具循环思考的粘滞锁定。当距上次
  // API 调用超过 1h 时触发（确认为缓存未命中 — 保留思考没有
  // 缓存命中优势）。一旦锁定，保持开启，使新预热的
  // 清除思考缓存不会被切换回 keep:'all' 所破坏。
  thinkingClearLatched: boolean | null
  // 当前提示词 ID（UUID），将用户提示词与后续 OTel 事件关联
  promptId: string | null
  // 主对话链的最后 API requestId（不包括子 agent）。
  // 在每次主会话查询成功 API 响应后更新。
  // 关闭时读取以向推理发送缓存驱逐提示。
  lastMainRequestId: string | undefined
  // 最后一次成功 API 调用完成的时间戳（Date.now()）。
  // 用于在 zy_api_success 中计算 timeSinceLastApiCallMs，
  // 将缓存未命中与空闲时间关联（缓存 TTL 约 5 分钟）。
  lastApiCompletionTimestamp: number | null
  // 压缩后设为 true（自动或手动 /compact）。由
  // logAPISuccess 消费，标记压缩后的首次 API 调用，以便
  // 区分压缩引起的缓存未命中和 TTL 过期。
  pendingPostCompaction: boolean
}

// 这里也是 — 修改前三思
function getInitialState(): State {
  // 解析 cwd 中的符号链接，与 shell.ts setCwd 的行为一致
  // 这确保了与会话存储路径清理方式的一致性
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // File Provider 在 CloudStorage 挂载点上 EPERM（每个路径组件 lstat）。
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // 遥测状态
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // 日志记录器状态
    loggerProvider: null,
    eventLogger: null,
    // Meter provider 状态
    meterProvider: null,
    tracerProvider: null,
    // Agent 颜色状态
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // 最后一次 API 请求，用于 bug 报告
    lastAPIRequest: null,
    lastAPIRequestMessages: null,
    // 最后一次自动模式分类器请求，用于 /share 转录
    lastClassifierRequests: null,
    cachedZyMdContent: null,
    // 近期错误的内存日志
    inMemoryErrorLog: [],
    // 来自 --plugin-dir 标志的会话级插件
    inlinePlugins: [],
    // 显式的 --chrome / --no-chrome 标志值（undefined 表示未在 CLI 设置）
    chromeFlagOverride: undefined,
    // 使用 cowork_plugins 目录替代 plugins
    useCoworkPlugins: false,
    // 会话级绕过权限模式的标志（不持久化）
    sessionBypassPermissionsMode: false,
    // 定时任务处于禁用状态，直到标志或对话框启用它们
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // 会话级信任标志（不持久化到磁盘）
    sessionTrustAccepted: false,
    // 会话级标志，禁用会话持久化到磁盘
    sessionPersistenceDisabled: false,
    // 追踪用户是否在此会话中退出了计划模式
    hasExitedPlanMode: false,
    // 追踪是否需要显示计划模式退出附件
    needsPlanModeExitAttachment: false,
    // 追踪是否需要显示自动模式退出附件
    needsAutoModeExitAttachment: false,
    // 追踪本会话中是否已显示 LSP 插件推荐
    lspRecommendationShownThisSession: false,
    // SDK init 事件状态
    initJsonSchema: null,
    registeredHooks: null,
    // 计划 slug 缓存
    planSlugCache: new Map(),
    // 追踪传送的会话，用于可靠性日志
    teleportedSessionInfo: null,
    // 追踪已调用的技能，以便在压缩后保留
    invokedSkills: new Map(),
    // 追踪慢速操作，用于 dev bar 显示
    slowOperations: [],
    // SDK 提供的 betas
    sdkBetas: undefined,
    // 主线程 agent 类型
    mainThreadAgentType: undefined,
    // 远程模式
    isRemoteMode: false,
    ...(isInternalBuild()
      ? {
          replBridgeActive: false,
        }
      : {}),
    // Direct connect server URL
    directConnectServerUrl: undefined,
    // 系统提示词部分缓存状态
    systemPromptSectionCache: new Map(),
    // Last date emitted to the model
    lastEmittedDate: null,
    // 来自 --add-dir 标志的额外目录（用于加载 CLAUDE.md）
    additionalDirectoriesForzyMd: [],
    // Channel server allowlist from --channels flag
    allowedChannels: [],
    hasDevChannels: false,
    // Session project dir (null = derive from originalCwd)
    sessionProjectDir: null,
    // 提示词缓存 1h 允许列表（null = 尚未从 GrowthBook 获取）
    promptCache1hAllowlist: null,
    // 提示词缓存 1h 资格（null = 尚未评估）
    promptCache1hEligible: null,
    // Beta 头锁定（null = 尚未触发）
    afkModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    // 当前提示词 ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }

  return state
}

// AND ESPECIALLY HERE
const STATE: State = getInitialState()

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(options: { setCurrentAsParent?: boolean } = {}): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 移除传出会话的计划 slug 条目，防止 Map
  // 积累过期 key。需要在 clearConversation 之前读取的调用者
  //（如 REPL.tsx clearContext）在此调用前获取 slug。
  STATE.planSlugCache.delete(STATE.sessionId)
  // 重新生成的会话留在当前项目中：重置 projectDir 为
  // null，使 getTranscriptPath() 从 originalCwd 推导。
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子性地切换活跃会话。`sessionId` 和 `sessionProjectDir`
 * 始终一起变更 — 没有单独的 setter，因此它们不会
 * 不同步（CC-34）。
 *
 * @param projectDir — 包含 `<sessionId>.jsonl` 的目录。省略（或
 *   传 `null`）表示当前项目中的会话 — 路径将在读取时从
 *   originalCwd 推导。当会话位于不同项目目录时
 *   传 `dirname(transcriptPath)`（git worktree、跨项目恢复）。
 *   每次调用都会重置项目目录，不会从前一个会话继承。
 */
export function switchSession(sessionId: SessionId, projectDir: string | null = null): void {
  // 移除传出会话的计划 slug 条目，使 Map 在
  // 重复 /resume 时保持有界。只有当前会话的 slug 会被读取
  //（plans.ts getPlanSlug 默认为 getSessionId()）。
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}

let sessionSwitched
sessionSwitched = createSignal<[id: SessionId]>()

/**
 * 注册一个回调，在 switchSession 更改活跃
 * sessionId 时触发。bootstrap 无法直接导入监听器（DAG 叶子节点），
 * 因此调用者自行注册。concurrentSessions.ts 使用此功能使
 * PID 文件的 sessionId 与 --resume 保持同步。
 */
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * 当前会话转录所在的项目目录，如果
 * 会话是在当前项目中创建的（常见情况 — 从
 * originalCwd 推导）则为 `null`。参见 `switchSession()`。
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录。
 * 与 getOriginalCwd() 不同，它永远不会被会话中的 EnterWorktreeTool 更新
 *（因此技能/历史记录在进入一次性 worktree 时保持稳定）。
 * 启动时由 --worktree 设置，因为该 worktree 就是会话的项目。
 * 用于项目标识（历史记录、技能、会话），而非文件操作。
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * 仅用于 --worktree 启动标志。会话中的 EnterWorktreeTool 绝不能
 * 调用此函数 — 技能/历史记录应锚定在会话启动的位置。
 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

export function getCwdState(): string {
  return STATE.cwd
}

export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

export function addToTotalDurationState(duration: number, durationWithoutRetries: number): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

export function addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

export function setStatsStore(store: { observe(name: string, value: number): void } | null): void {
  STATE.statsStore = store
}

/**
 * 标记发生了一次交互。
 *
 * 默认情况下，实际的 Date.now() 调用会延迟到下一次 Ink 渲染
 * 帧（通过 flushInteractionTime()），这样我们可以避免在每次
 * 按键时都调用 Date.now()。
 *
 * 当从 React useEffect 回调或其他在 Ink 渲染周期之后
 * 运行的代码中调用时，传 `immediate = true`。
 * 否则时间戳会保持过期，直到下一次渲染，而如果用户空闲
 *（例如权限对话框等待输入），可能永远不会到来。
 */
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * 如果自上次刷新以来记录了交互，则立即更新时间戳。
 * 由 Ink 在每次渲染周期前调用，以便将多次按键批量处理为
 * 单次 Date.now() 调用。
 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}
let budgetContinuationCount = 0
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** 标记压缩刚刚发生。下一次 API 成功事件将
 *  包含 isPostCompaction=true，然后标志自动重置。 */
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/** 消费压缩后标志。压缩后返回一次 true，
 *  然后返回 false 直到下次压缩。 */
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// 滚动排出暂停 — 后台间隔在执行工作前检查此标志，
// 因此它们不会与滚动帧竞争事件循环。由
// ScrollBox scrollBy/scrollTo 设置，在最后一次
// 滚动事件后 SCROLL_DRAIN_IDLE_MS 清除。模块作用域（不在 STATE 中）—
// 临时热路径标志，不需要测试重置，因为防抖定时器会自清除。
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** 标记滚动事件刚刚发生。后台间隔通过
 *  getIsScrollDraining() 门控，在防抖清除前跳过工作。 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** 滚动正在排出时为 true（最后一次事件后 150ms 内）。
 *  间隔在此设置时应提前返回 — 工作会在滚动平息后的
 *  下一次 tick 继续。 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** 在可能与滚动同时发生的昂贵一次性工作
 *  （网络、子进程）前等待此函数。如果未滚动则立即解析；
 *  否则以空闲间隔轮询直到标志清除。 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation 禁止从 src/utils/ 导入 sleep()
    // eslint-disable-next-line no-restricted-syntax
    await new Promise((r) => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/**
 * 获取通过 --model CLI 标志设置的模型覆盖，或用户在
 * 更新其配置的模型后设置。
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

export function setMainLoopModelOverride(model: ModelSetting | undefined): void {
  STATE.mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * 设置会话恢复的成本状态值。
 * 由 cost-tracker.ts 中的 restoreCostStateForSession 调用。
 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复每个模型的使用明细
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整 startTime 使累计时长正确累加
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

// 仅用于测试
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

// 你不应该直接使用。参见 src/utils/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// 你不应该直接使用。参见 src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// 测试工具函数，重置 model strings 以便重新初始化。
// 与 setModelStrings 分开，因为我们只想在测试中接受 'null'。
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // 使用提供的工厂初始化所有计数器
  STATE.sessionCounter = createCounter('zy_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('zy_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('zy_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('zy_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('zy_code.cost.usage', {
    description: 'Cost of the ZY Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('zy_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter('zy_code.code_edit_tool.decision', {
    description:
      'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
  })
  STATE.activeTimeCounter = createCounter('zy_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return STATE.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

export function setEventLogger(logger: ReturnType<typeof logs.getLogger> | null): void {
  STATE.eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

export function getClientType(): string {
  return STATE.clientType
}

export function setClientType(type: string): void {
  STATE.clientType = type
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

export function getKairosActive(): boolean {
  return STATE.kairosActive
}

export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

// 字段名 'userMsgOptIn' 避免了排除字符串的子串（'BriefTool'、
// 'SendUserMessage' — 不区分大小写）。所有调用者都在 feature()
// 守卫内，因此这些访问器不需要自己的守卫（与 getKairosActive 一致）。
export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

export function setFlagSettingsInline(settings: Record<string, unknown> | null): void {
  STATE.flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

export function setApiKeyFromFd(key: string | null): void {
  STATE.apiKeyFromFd = key
}

export function setLastAPIRequest(params: Omit<CreateParams, 'messages'> | null): void {
  STATE.lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<CreateParams, 'messages'> | null {
  return STATE.lastAPIRequest
}

export function setLastAPIRequestMessages(messages: CreateParams['messages'] | null): void {
  STATE.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages(): CreateParams['messages'] | null {
  return STATE.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

export function setCachedZyMdContent(content: string | null): void {
  STATE.cachedZyMdContent = content
}

export function getCachedZyMdContent(): string | null {
  return STATE.cachedZyMdContent
}

export function addToInMemoryErrorLog(errorInfo: { error: string; timestamp: string }): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // 移除最旧的错误
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  // IDE 扩展在认证方面应表现为直接 API。
  return getIsNonInteractiveSession() && STATE.clientType !== 'zy-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  resetSettingsCache()
}

export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * 设置后，任务由进程内的队友创建（而非团队领导）。
   * 调度器将触发路由到该队友的 pendingUserMessages 队列，
   * 而不是主 REPL 命令队列。仅会话级 — 永远不会写入磁盘。
   */
  agentId?: string
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * 返回实际移除的任务数量。调用者使用此值跳过
 * 下游工作（例如 removeCronTasks 中的磁盘读取），当所有 id
 * 都已在此处理时。
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter((t) => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(fromMode: string, toMode: string): void {
  // 切换到计划模式时，清除任何待处理的退出附件
  // 这防止用户快速切换时同时发送 plan_mode 和 plan_mode_exit
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // 退出计划模式时，触发 plan_mode_exit 附件
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(fromMode: string, toMode: string): void {
  // 自动↔计划模式的切换由 prepareContextForPlanMode 处理
  //（如果选择加入，自动模式可能在计划模式中保持活跃）
  // 和 ExitPlanMode（恢复模式）。跳过两个方向，因此
  // 此函数仅处理直接的自动模式切换。
  if ((fromMode === 'auto' && toMode === 'plan') || (fromMode === 'plan' && toMode === 'auto')) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // 切换到自动模式时，清除任何待处理的退出附件
  // 这防止用户快速切换时同时发送 auto_mode 和 auto_mode_exit
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // 退出自动模式时，触发 auto_mode_exit 附件
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP 插件推荐会话追踪
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK init event state
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks` 可能被多次调用，因此需要合并（而非覆盖）
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...matchers)
  }
}

export function getRegisteredHooks(): Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null {
  return STATE.registeredHooks
}

export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // 仅保留回调钩子（那些没有 pluginRoot 的）
    const callbackHooks = matchers.filter((m) => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// Teleported session tracking for reliability logging
export function setTeleportedSessionInfo(info: { sessionId: string | null }): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// 已调用技能追踪，用于压缩后保留
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(preservedAgentIds?: ReadonlySet<string>): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// 慢速操作追踪，用于 dev bar
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (!isInternalBuild()) return
  // 跳过编辑器会话的追踪（用户在 $EDITOR 中编辑提示文件）
  // 这些是有意慢速的，因为用户在起草文本
  if (operation.includes('exec') && operation.includes('zy-prompt-')) {
    return
  }
  const now = Date.now()
  // 移除过期的操作
  STATE.slowOperations = STATE.slowOperations.filter(
    (op) => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // 添加新操作
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // 仅保留最近的操作
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // 最常见的情况：没有追踪任何内容。返回稳定引用，使
  // 调用者的 setState() 可以通过 Object.is 跳过，而不是以 2fps 重新渲染。
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // 仅在有操作真正过期时才分配新数组；否则在
  // 操作仍然新鲜时保持引用稳定。
  if (STATE.slowOperations.some((op) => now - op.timestamp >= SLOW_OPERATION_TTL_MS)) {
    STATE.slowOperations = STATE.slowOperations.filter(
      (op) => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // 可以直接返回：addSlowOperation() 在推入前重新赋值 STATE.slowOperations，
  // 因此 React 状态持有的数组永远不会被修改。
  return STATE.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

// 系统提示词部分访问器

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(name: string, value: string | null): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// 最后发出日期访问器（用于检测午夜日期变化）

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForzyMd(): string[] {
  return STATE.additionalDirectoriesForzyMd
}

export function setAdditionalDirectoriesForzyMd(directories: string[]): void {
  STATE.additionalDirectoriesForzyMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(v: boolean): void {
  STATE.cacheEditingHeaderLatched = v
}

export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

/**
 * 将 beta 头锁定重置为 null。在 /clear 和 /compact 时调用，
 * 使新对话获得新的头评估。
 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}

export function getPromptId(): string | null {
  return STATE.promptId
}

export function setPromptId(id: string | null): void {
  STATE.promptId = id
}
