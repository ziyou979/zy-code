// bootstrap/state 内部核心：State 类型 + STATE 单例 + 初始化 + 测试重置 + session 切换 signal。
// STATE 仅供同目录状态模块使用；外部消费者统一通过 runtimeContext 获取运行时能力。
//
// 设计要点：
// - STATE 是模块级单例，所有域模块通过本文件共享同一份引用，避免循环依赖。
// - 三个本属于"模块本地"的 token 状态（outputTokensAtTurnStart 等）已迁入 STATE，
//   使 resetStateForTests 无需反向调用域模块即可一并重置。
// - sessionSwitched signal 同步暴露 emit/clear/subscribe 给 session.ts 与测试重置使用。

import { realpathSync } from 'node:fs'
import { cwd } from 'node:process'
import type { Attributes, Meter } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import type { ModelSetting } from 'src/services/model/model.js'
import type { ModelStrings } from 'src/services/model/modelStrings.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks/index.js'
import type { SessionId } from 'src/types/ids.js'
import type { HookEvent, ModelUsage } from 'src/types/index.js'
// 浏览器 SDK 构建的间接引用（package.json 的 "browser" 字段会替换
// crypto.ts 为 crypto.browser.ts）。纯叶子节点重新导出 node:crypto —
// 零循环依赖风险。路径别名导入绕过了 bootstrap-isolation 检查
//（该规则仅检查 ./ 和 / 前缀）；显式禁用说明了意图。
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { SettingSource } from '../../services/settings/constants.js'
import type { PluginHookMatcher } from '../../services/settings/types.js'
import { createSignal } from 'src/utils/signal.js'
import { createSessionId } from 'src/utils/uuid.js'
import type { CreateParams } from '../../types/llm.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'

// 已注册钩子的联合类型 — 可以是 SDK 回调或原生插件钩子
export type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

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

// 已调用技能信息，供 invokedSkills Map 使用。
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export type State = {
  originalCwd: string
  // 稳定的项目根目录 — 启动时设置一次（包括 --worktree 标志），
  // 会话中的 EnterWorktreeTool 永远不会更新它。
  // 用于项目标识（历史记录、技能、会话），而非文件操作。
  projectRoot: string
  totalCost: number
  /** 按币种分别累计的费用，用于多币种场景下的分别展示 */
  totalCostByCurrency: Record<string, number>
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
  // 捕获压缩后、AGENTS.md 注入后发送给 API 的完整消息集，
  // 以便 /share 的 serialized_conversation.json 反映真实情况。
  lastAPIRequestMessages: CreateParams['messages'] | null
  // 最后一次自动模式分类器请求，用于 /share 转录
  lastClassifierRequests: unknown[] | null
  // 由 context.ts 缓存的 AGENTS.md 内容，供自动模式分类器使用。
  // 打破 yoloClassifier → agentsMd → 文件系统 → 权限的循环依赖。
  cachedAgentsMdContent: string | null
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
  invokedSkills: Map<string, InvokedSkillInfo>
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
  // 来自 --add-dir 标志的额外目录（用于加载 AGENTS.md）
  additionalDirectoriesForAgentsMd: string[]
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
  // 当前轮次开始时的 totalOutputTokens 快照，用于计算 turnOutputTokens。
  // 从模块本地迁入以便 resetStateForTests 一并清零。
  outputTokensAtTurnStart: number
  // 当前轮次的 token 预算（null 表示无预算限制）。
  currentTurnTokenBudget: number | null
  // budget 触发的连续续轮次数。
  budgetContinuationCount: number
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
    totalCost: 0,
    totalCostByCurrency: { CNY: 0, USD: 0 },
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
    sessionId: createSessionId(),
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
    cachedAgentsMdContent: null,
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
          replWireActive: false,
        }
      : {}),
    // Direct connect server URL
    directConnectServerUrl: undefined,
    // 系统提示词部分缓存状态
    systemPromptSectionCache: new Map(),
    // Last date emitted to the model
    lastEmittedDate: null,
    // 来自 --add-dir 标志的额外目录（用于加载 AGENTS.md）
    additionalDirectoriesForAgentsMd: [],
    // Channel server allowlist from --channels flag
    allowedChannels: [],
    hasDevChannels: false,
    // Session project dir (null = derive from originalCwd)
    sessionProjectDir: null,
    // Beta 头锁定（null = 尚未触发）
    afkModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    // 当前提示词 ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
    // 轮次 token 计数本地状态（从模块本地迁入，便于 resetStateForTests 统一清零）
    outputTokensAtTurnStart: 0,
    currentTurnTokenBudget: null,
    budgetContinuationCount: 0,
  }

  return state
}

// AND ESPECIALLY HERE
export const STATE: State = getInitialState()

// session 切换 signal — 在 session.ts 中通过 switchSession 触发。
// 暴露 emit/clear/subscribe，避免域模块各自重新创建 signal。
const sessionSwitched = createSignal<[id: SessionId]>()
export const emitSessionSwitched: (id: SessionId) => void = sessionSwitched.emit
export const clearSessionSwitched: () => void = sessionSwitched.clear
/**
 * 注册一个回调，在 switchSession 更改活跃
 * sessionId 时触发。bootstrap 无法直接导入监听器（DAG 叶子节点），
 * 因此调用者自行注册。concurrentSessions.ts 使用此功能使
 * PID 文件的 sessionId 与 --resume 保持同步。
 */
export const onSessionSwitch = sessionSwitched.subscribe

// 仅用于测试 —— 重置 STATE 与 session signal。
// outputTokensAtTurnStart 等已迁入 STATE，由 getInitialState() 一并重置。
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  clearSessionSwitched()
}

// 暴露给少数需要直接读取初始值的场景（例如 resetCostState 之外的非测试重置路径）。
// 业务代码不应使用 —— 用语义化的 reset 函数代替。
export { getInitialState as _getInitialStateForTestsOnly }
