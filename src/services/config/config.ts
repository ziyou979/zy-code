import { feature } from 'bun:bundle'
import { randomBytes } from 'node:crypto'
import { unwatchFile, watchFile } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import type { MemoryType } from 'src/services/memory/types.js'
import { getOriginalCwd, getSessionTrustAccepted } from '../../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../../memdir/paths.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getGlobalZyFile } from '../../utils/env.js'
import { getZyConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { ConfigParseError, getErrnoCode } from '../../utils/errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { safeParseJSON } from '../../utils/json.js'
import { stripBOM } from '../../utils/jsonRead.js'
import * as lockfile from '../../utils/lockfile.js'
import { logError } from '../../utils/log.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import { getEssentialTrafficOnlyReason } from '../../utils/privacyLevel.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import type { ThemeSetting } from '../../utils/theme.js'
import { logEvent } from '../analytics/index.js'
import type { McpServerConfig } from '../mcp/types.js'
import type {
  // @ts-expect-error
  BillingType,
} from '../oauth/types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../../bridge/bridgeEnabled.js') as typeof import('../../bridge/bridgeEnabled.js'))
  : null

import type { ModelOption } from 'src/services/model/modelOptions.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from '../../utils/imageResizer.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

// 重入保护：防止 getConfig → logEvent → getGlobalConfig → getConfig
// 无限递归（配置文件损坏时）。logEvent 的采样检查会读取 GrowthBook 特性，
// 从而再次调用 getConfig。
let insideGetConfig = false

// 图像维度信息，用于坐标映射（仅在图像被缩放时设置）
export type PastedContent = {
  id: number // 连续数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 如 'image/png'、'image/jpeg'
  filename?: string // 附件槽中图像的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string // 拖放到终端上的图像的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
      currency?: 'CNY' | 'USD'
    }
  >
  lastSessionMetrics?: Record<string, number>
  /** 按 sessionId 存储每个会话的费用状态，用于 /resume 可靠恢复 */
  sessionCosts?: Record<
    string,
    {
      totalCostUSD: number
      totalAPIDuration: number
      totalAPIDurationWithoutRetries: number
      totalToolDuration: number
      totalLinesAdded: number
      totalLinesRemoved: number
      lastDuration: number | undefined
      lastModelUsage?: Record<
        string,
        {
          inputTokens: number
          outputTokens: number
          cacheReadInputTokens: number
          cacheCreationInputTokens: number
          webSearchRequests: number
          costUSD: number
          currency?: 'CNY' | 'USD'
        }
      >
      /** 按币种分别累计的费用 */
      totalCostByCurrency?: Record<'CNY' | 'USD', number>
    }
  >
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // 信任对话框设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasAgentsMdExternalIncludesApproved?: boolean
  hasAgentsMdExternalIncludesWarningShown?: boolean
  // MCP 服务器审批字段 — 已迁移到 settings，保留以兼容旧版本
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 已禁用的 MCP 服务器列表（所有作用域）— 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 内置 MCP 服务器的 opt-in 列表（默认禁用的服务器）
  enabledMcpServers?: string[]
  // Worktree 会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** `zy remote-control` 多会话的生成模式。由首次运行对话框或 `w` 切换设置。 */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasAgentsMdExternalIncludesApproved: false,
  hasAgentsMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from '../../utils/configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from '../../utils/configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // 2025-04-23 新增，老用户未填充此字段
  organizationRole?: string | null
  workspaceRole?: string | null
  // 由 /api/oauth/profile 填充
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO: 'emacs' 保留以兼容旧版本 — 几个版本后移除
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated Use settings.apiKeyHelper instead.
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 区分基于保护机制的禁用与用户偏好设置
  autoUpdatesProtectedForNative?: boolean
  // Doctor 上次展示时的会话计数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 上次重置 onboarding 的版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 配合使用
  lastOnboardingVersion?: string
  // 上次查看 release notes 的版本，用于管理 release notes
  lastReleaseNotesSeen?: string
  // 上次获取 changelog 的时间戳（内容存储在 ~/.zy/cache/changelog.md）
  changelogLastFetched?: number
  // @已废弃 - 已迁移到 ~/.zy/cache/changelog.md。保留以支持迁移兼容。
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // 已成功连接过至少一次的 zy.ai MCP 连接器。
  // 用于控制"连接器不可用"/"需要认证"的启动通知：
  // 用户实际使用过的连接器在出问题时值得提醒，
  // 但组织配置且从一开始就需要认证的连接器，
  // 用户显然已忽略，不应反复提醒。
  zyAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated. Use the Notification hook instead (docs/hooks.md).
   */
  customNotifyCommand?: string
  verbose: boolean
  apiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 未设置环境变量时的主 API key，通过 oauth 设置（TODO: 重命名）
  /** onboarding 期间配置的 API 提供商 — 值来自 PROVIDER_REGISTRY 的 id */
  configuredProvider?: string
  /** onboarding 期间配置的 API 基地址（预设平台自动填充，generic 平台由用户手动设置） */
  configuredBaseUrl?: string
  /** onboarding 期间配置的 API key */
  configuredApiKey?: string
  /** 对话默认模型，onboarding 期间配置 */
  configuredModel?: string
  hasSeenUndercoverAutoNotice?: boolean // ant-only: 一次性自动 undercover 说明是否已展示
  hasSeenUltraplanTerms?: boolean // ant-only: 是否在 ultraplan 启动弹窗中展示过一次 CCR 条款
  hasResetAutoModeOptInForDefaultOffer?: boolean // ant-only: 一次性迁移保护，重新提示已流失的 auto-mode 用户
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // 旧版 — 保留以兼容旧版本
  editorMode?: EditorMode
  tui?: 'fullscreen' | 'default' // 用户持久化的渲染模式偏好（/tui 命令）
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 是否启用 auto-compact
  showTurnDuration: boolean // 是否显示轮次耗时消息（如 "Cooked for 1m 6s"）
  /**
   * @deprecated Use settings.env instead.
   */
  env: { [key: string]: string } // 为 CLI 设置的环境变量
  hasSeenTasksHint?: boolean // 用户是否已看到 tasks 提示
  hasUsedStash?: boolean // 用户是否使用过 stash 功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否使用过后台任务（Ctrl+B）
  queuedCommandUpHintCount?: number // 用户看到排队命令上移提示的次数
  diffTool?: DiffTool // 显示 diff 时使用的工具（terminal 或 vscode）

  // 终端设置状态追踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 偏好设置备份文件路径
  appleTerminalBackupPath?: string // Terminal.app 偏好设置备份文件路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 设置是否正在进行中

  // 按键绑定设置追踪
  shiftEnterKeyBindingInstalled?: boolean // 是否已安装 Shift+Enter 按键绑定（iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // 是否已安装 Option 作为 Meta 键（Terminal.app）

  // IDE 配置
  autoConnectIde?: boolean // 启动时如果恰好只有一个有效 IDE 可用，是否自动连接
  autoInstallIdeExtension?: boolean // 在 IDE 内运行时是否自动安装 IDE 扩展

  // IDE 弹窗
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 记录终端名称到 IDE onboarding 是否已展示
  ideHintShownCount?: number // /ide 命令提示已展示的次数
  hasIdeAutoConnectDialogBeenShown?: boolean // IDE 自动连接弹窗是否已展示

  tipsHistory: {
    [tipId: string]: number // key 为 tipId，value 为上次展示该提示时的 numStartups
  }

  // 反馈调查追踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 转录分享弹窗追踪（"不再询问"）
  transcriptShareDismissed?: boolean

  // 记忆使用追踪
  memoryUsageCount: number // 用户向记忆添加内容的次数

  // Powerup 课程进度追踪
  powerupsUnlocked?: string[] // 已完成的 powerup 课程 id 列表

  // 语音模式通知追踪
  voiceNoticeSeenCount?: number // 语音模式可用通知已展示的次数
  voiceLangHintShownCount?: number // /voice 听写语言提示已展示的次数
  voiceLangHintLastLanguage?: string // 上次展示提示时解析的 STT 语言代码 — 变更时重置计数
  voiceFooterHintSeenCount?: number // "按住 X 说话" 底部提示已展示的会话数

  // 实验注册通知追踪（按实验 ID 索引）
  experimentNoticesSeenCount?: Record<string, number>

  // 队列使用追踪
  promptQueueUseCount: number // 用户使用提示队列的次数

  // Btw 使用追踪
  btwUseCount: number // 用户使用 /btw 的次数

  // 计划模式使用追踪
  lastPlanModeUse?: number // 上次使用计划模式的时间戳

  // 订阅通知追踪
  subscriptionNoticeCount?: number // 订阅通知已展示的次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅升级弹窗已展示的次数（已废弃）
  recommendedSubscription?: string // 来自 Statsig 的缓存配置值（已废弃）

  // Todo 功能配置
  todoFeatureEnabled: boolean // 是否启用 todo 功能
  showExpandedTodos?: boolean // 是否展开显示 todos（即使为空）
  showSpinnerTree?: boolean // 是否显示 teammate spinner tree 而不是 pills

  // 首次启动时间追踪
  firstStartTime?: string // ZY Code 在本机首次启动的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户空闲多久后推送"Zy 已生成完毕"通知

  githubActionSetupCount?: number // 用户设置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack app 的次数

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端标签页状态指示器（OSC 21337）。开启时，向标签页侧边栏发射
  // 彩色圆点 + 状态文本，并从标题中移除 spinner 前缀（圆点已冗余）。
  showStatusInTerminalTab?: boolean

  // 推送通知切换（通过 /config 设置）。默认关闭 — 需要显式开启。
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // ZY Code 使用追踪
  ZyCodeFirstTokenDate?: string // 用户首次获取 ZY Code OAuth token 的 ISO 时间戳

  // 模型切换提示追踪（ant-only）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择了"不再显示"
  modelSwitchCalloutLastShown?: number // 上次展示的时间戳（24小时内不再展示）
  modelSwitchCalloutVersion?: string

  // Remote 弹窗追踪 — 首次启用 bridge 前展示一次
  remoteDialogSeen?: boolean

  // 跨进程退避：initReplBridge 的 oauth_expired_unrefreshable 跳过。
  // `expiresAt` 为去重 key — 内容寻址，/login 替换 token 时自动清除。
  // `failCount` 限制误报：短暂刷新失败（认证服务器 5xx、锁错误）
  // 会重试 3 次后才触发退避，与 useReplBridge 的 MAX_CONSECUTIVE_INIT_FAILURES
  // 一致。死 token 账户最多 3 次配置写入；健康+短暂异常 ~210s 自愈。
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // Desktop 升级弹窗启动弹窗追踪
  desktopUpsellSeenCount?: number // 总展示次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 已选择"不再询问"

  // 全屏模式推广追踪
  fullscreenUpsellSeenCount?: number // upsell 对话框展示次数（最多 3 次）
  fullscreenUpsellDismissed?: boolean // 已选择"不再询问"
  fullscreenDownsellSeenCount?: number // downsell 提示条展示次数（5 次后静默毕业）

  // 空闲返回弹窗追踪
  idleReturnDismissed?: boolean // 已选择"不再询问"

  // 缓存的 statsig gate 值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook 特性值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖值（ant-only，通过 /config Gates 标签页设置）。
  // 在环境变量覆盖之后、真实解析值之前检查。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示追踪 — 存储上次展示的提示以防止重复展示
  lastShownEmergencyTip?: string

  // 文件选择器 gitignore 行为
  respectGitignore: boolean // 文件选择器是否应尊重 .gitignore 文件（默认: true）。注意: .ignore 文件始终受尊重

  // 复制命令行为
  copyFullResponse: boolean // /copy 是否始终复制完整响应而不是显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 鼠标松开时自动复制到剪贴板（undefined → true；让 cmd+c "生效"（空操作））

  // GitHub 仓库路径映射，用于 teleport 目录切换
  // Key: "owner/repo"（小写），Value: 仓库克隆到的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // 用于 zy-cli:// deep link 启动的终端模拟器。在交互式会话期间
  // 从 TERM_PROGRAM 捕获，因为 deep link 处理器在无头模式（LaunchServices/xdg）
  // 下运行，没有设置 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 设置
  iterm2It2SetupComplete?: boolean // it2 设置是否已验证
  preferTmuxOverIterm2?: boolean // 用户偏好：始终使用 tmux 而不是 iTerm2 分割面板

  // Skill 使用追踪，用于自动补全排序
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方市场自动安装追踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否已尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（如适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 上次尝试时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 最早可重试时间

  // Claude in Chrome 设置
  hasCompletedClaudeInChromeOnboarding?: boolean // Claude in Chrome onboarding 是否已展示
  ClaudeInChromeDefaultEnabled?: boolean // Claude in Chrome 是否默认启用（undefined 表示平台默认）
  cachedChromeExtensionInstalled?: boolean // Chrome 扩展是否已安装的缓存结果

  // Chrome 扩展配对状态（跨会话持久化）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP 插件推荐偏好设置
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件推荐
  lspRecommendationNeverPlugins?: string[] // 不再建议的插件 ID
  lspRecommendationIgnoredCount?: number // 追踪已忽略的推荐次数（5 次后停止）

  // ZY Code 提示协议状态（来自 CLI/SDK 的 <zy-code-hint /> 标签）。
  // 按提示类型嵌套，以便未来类型（docs、mcp 等）无需新增顶层 key。
  ZyCodeHints?: {
    // 已向用户提示过的插件 ID。展示一次语义：
    // 无论回答是/否都记录，不再重复提示。上限
    // 100 条以限制配置增长 — 超过后提示完全停止。
    plugin?: string[]
    // 用户在对话框中选择了"不再显示插件安装提示"。
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 启用 Haiku 生成的权限请求解释（默认: true）

  // Teammate 启动模式: 'auto' | 'tmux' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'in-process' // 如何启动 teammate（默认: 'auto'）
  // 新 teammate 的默认模型（当工具调用未传递模型时）。
  // undefined = 用户配置的 advanced 模型；null = leader 的模型；string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 特性开关）
  prStatusFooterEnabled?: boolean // 在页脚显示 PR 审核状态（默认: true）

  // Tmux 实时面板可见性（ant-only，通过 tmux pill 上的 Enter 切换）
  tungstenPanelVisible?: boolean

  // 从 API 缓存的组织级状态。
  // 用于检测跨会话变更并通知用户。
  penguinModeOrgEnabled?: boolean

  // 上次运行后台刷新的时间（毫秒，配额、passes、客户端数据）。
  // 与 zy_cicada_nap_ms 配合使用以限制 API 调用
  startupPrefetchedAt?: number

  // 启动时运行 Remote Control（需要 BRIDGE_MODE）
  // undefined = 使用默认值（优先级见 getRemoteControlAtStartup()）
  remoteControlAtStartup?: boolean

  // 缓存的额外额度禁用原因（来自上次 API 响应）
  // undefined = 无缓存，null = 已启用额外额度，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知追踪（ant-only）
  autoPermissionsNotificationCount?: number // 自动权限通知已展示的次数

  // 推测配置（ant-only）
  speculationEnabled?: boolean // 是否启用推测（默认: true）

  // 服务端实验的客户端数据（在 bootstrap 期间获取）。
  clientDataCache?: Record<string, unknown> | null

  // 模型选择器的额外模型选项（在 bootstrap 期间获取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // 组织级设置很少变化；跨进程持久化避免每次 `zy -p` 都调用冷 API。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 上次应用的迁移集版本。等于
  // CURRENT_MIGRATION_VERSION 时，runMigrations() 跳过所有同步迁移
  //（避免每次启动 11 次 saveGlobalConfig 锁+重读）。
  migrationVersion?: number
}

/**
 * 创建新的默认 GlobalConfig 工厂函数。使用此代替深克隆共享常量 —
 * 嵌套容器（数组、记录）均为空，因此工厂函数以零克隆成本提供全新引用。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    apiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'tui',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'ClaudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查用户是否已对 cwd 接受信任对话框。
 *
 * 此函数遍历父目录以检查父目录是否有审批。接受某目录的信任
 * 意味着信任其子目录。
 *
 * @returns 是否已接受信任对话框（即"不应再次显示"）
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // 信任仅从 false→true 单向转换（不会反过来），
  // 所以一旦为 true 就可以锁存。false 不缓存 — 每次调用都重新检查，
  // 以便在会话中获取信任对话框的接受。（lodash memoize 不适合这里，因为它也会缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // 检查会话级信任（针对不持久化信任的主目录情况）
  // 从主目录运行时，会显示信任对话框但接受记录仅存储在内存中。
  // 这允许 hook 和其他功能在本次会话中正常工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 始终检查信任将被保存的位置（git 根目录或原始 cwd）
  // 这是 saveCurrentProjectConfig 持久化信任的主要位置
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 从当前工作目录及其父目录检查
  // 规范化路径以确保 JSON key 查找一致
  let currentPath = normalizePathForConfigKey(getCwd())

  // 遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 到达根目录时停止（父目录与当前相同时）
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录的信任（非会话 cwd）。
 * 从 `dir` 向上遍历，如果任何祖先目录有持久化的信任则返回 true。
 * 与 checkHasTrustDialogAccepted 不同，此函数不查询会话信任或
 * 缓存的项目路径 — 用于目标目录与 cwd 不同的场景（如
 * /assistant 安装到用户输入的路径）。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) {
      return true
    }
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) {
      return false
    }
    currentPath = parentPath
  }
}

// 测试代码放在这里因为 Jest 不支持 mock ES 模块 :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测写入 `fresh` 是否会丢失内存缓存中仍有的认证/onboarding 状态。
 * 当 `getConfig` 命中损坏或被截断的文件时（另一个进程或非原子回退写入），
 * 会返回 DEFAULT_GLOBAL_CONFIG。将其写回会永久清除认证。见 GH #3117。
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) {
    return false
  }
  const lostOauth = cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true && fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

export function saveGlobalConfig(updater: (currentConfig: GlobalConfig) => GlobalConfig): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // 无变更则跳过（返回了相同引用）
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(getGlobalZyFile(), createDefaultGlobalConfig, (current) => {
      const config = updater(current)
      // 无变更则跳过（返回了相同引用）
      if (config === current) {
        return current
      }
      written = {
        ...config,
        projects: removeProjectHistory(current.projects),
      }
      return written
    })
    // 仅在实际写入时才 write-through。如果认证丢失保护
    // 触发（或 updater 未做变更），文件未被触碰且缓存
    // 仍有效 — 触碰它会破坏保护。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // 错误时回退到非锁定版本。这个回退是一个竞争窗口：
    // 如果另一个进程正在写入中（或文件被截断），
    // getConfig 返回默认值。拒绝将这些默认值写入好的缓存配置，
    // 以避免清除认证。见 GH #3117。
    const currentConfig = getConfig(getGlobalZyFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('zy_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // 无变更则跳过（返回了相同引用）
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalZyFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置缓存
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// 配置文件操作追踪（遥测）
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// 全局配置文件的实际磁盘写入会话总计数。
// 仅 ant-only 开发诊断暴露（见 inc-4552），以便异常写入
// 率在损坏 ~/.zy.json 之前在 UI 中暴露。
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('zy_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// 注册清理函数以在会话结束时报告缓存统计
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * 将旧的 autoUpdaterStatus 迁移到新的 installMethod 和 autoUpdates 字段
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // 已迁移
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus 已从类型中移除，但可能存在于旧配置中
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // 从旧字段确定安装方法和自动更新偏好
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // 除非明确禁用，否则默认启用

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // 禁用时，我们不知道安装方法
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // 这些意味着全局安装
      installMethod = 'global'
      break
    case undefined:
      // 没有旧状态，保持默认值
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * 从项目中移除 history 字段（已迁移到 history.jsonl）
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history 已从类型中移除，但可能存在于旧配置中
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile 轮询间隔，用于检测其他实例的写入（毫秒）
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile 在 libuv 线程池上轮询 stat，仅在 mtime
// 变更时回调 — 挂起的 stat 不会阻塞主线程。
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') {
    return
  }
  freshnessWatcherStarted = true
  const file = getGlobalZyFile()
  watchFile(file, { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false }, (curr) => {
    // 我们自己的写入也会触发此回调 — write-through 的 Date.now()
    // 超调使 cache.mtime > 文件 mtime，因此我们跳过重读。
    // Bun/Node 在文件不存在时（初始回调或删除）也会触发 curr.mtimeMs=0 —
    // <= 也处理了这种情况。
    if (curr.mtimeMs <= globalConfigCache.mtime) {
      return
    }
    void getFsImplementation()
      .readFile(file, { encoding: 'utf-8' })
      .then((content) => {
        // write-through 可能在我们读取前推进了缓存；
        // 不要回退到 watchFile stat 的过时快照。
        if (curr.mtimeMs <= globalConfigCache.mtime) {
          return
        }
        const parsed = safeParseJSON(stripBOM(content))
        if (parsed === null || typeof parsed !== 'object') {
          return
        }
        globalConfigCache = {
          config: migrateConfigFields({
            ...createDefaultGlobalConfig(),
            ...(parsed as Partial<GlobalConfig>),
          }),
          mtime: curr.mtimeMs,
        }
        lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
      })
      .catch(() => {})
  })
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through: 刚写入的就是新配置。cache.mtime 超过
// 文件的真实 mtime（Date.now() 在写入后记录），这样
// 新鲜度检查器下次轮询时跳过重读我们自己的写入。
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读取。启动后，这始终命中 — 我们自己的
  // 写入走 write-through，其他实例的写入由后台新鲜度检查器获取（不阻塞此路径）。
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // 慢速路径：启动加载。此处的同步 I/O 可以接受，因为它只运行
  // 一次，在任何 UI 渲染之前。先 stat 后 read，这样任何竞态都能自愈
  //（旧 mtime + 新内容 → 检查器下次重读）。
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalZyFile())
    } catch {
      // 文件不存在
    }
    const config = migrateConfigFields(getConfig(getGlobalZyFile(), createDefaultGlobalConfig))
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats ? { mtime: stats.mtimeMs, size: stats.size } : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 如果出了任何问题，回退到非缓存行为
    return migrateConfigFields(getConfig(getGlobalZyFile(), createDefaultGlobalConfig))
  }
}

/**
 * 返回 remoteControlAtStartup 的有效值。优先级：
 *   1. 用户的显式配置值（始终获胜 — 尊重 opt-out）
 *   2. CCR 自动连接默认值（ant-only 构建，GrowthBook 门控）
 *   3. false（Remote Control 必须显式 opt-in）
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) {
    return explicit
  }
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) {
      return true
    }
  }
  return false
}

export function getApiKeyStatus(truncatedApiKey: string): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.apiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.apiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(file: string, config: A, defaultConfig: A): void {
  // 写入配置前确保目录存在
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync 在 FsOperations 实现中已经是递归的
  fs.mkdirSync(dir)

  // 过滤掉与默认值匹配的所有值
  const filteredConfig = pickBy(
    config,
    (value, key) => jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 以安全权限写入配置文件 — mode 仅适用于新文件
  writeFileSyncAndFlush_DEPRECATED(file, jsonStringify(filteredConfig, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  if (file === getGlobalZyFile()) {
    globalConfigWriteCount++
  }
}

/**
 * 返回 true 表示执行了写入；false 表示跳过了写入
 *（无变更，或认证丢失保护触发）。调用者用此决定是否
 * 使缓存失效 — 在跳过写入后失效会破坏认证保护依赖的好缓存状态。
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（mkdirSync 在 FsOperations 中已经递归）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: (err) => {
        // 默认 onCompromised 从 setTimeout 回调抛出，会变成
        // 未处理异常。改为记录日志 — 锁被偷走（例如事件循环
        // 停滞 10s 后）是可恢复的。
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Zy instance may be running',
      )
      logEvent('zy_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // 检查陈旧写入 — 文件自上次读取后是否变更
    // 仅检查全局配置文件，因为 lastReadFileStats 追踪的是该特定文件
    if (lastReadFileStats && file === getGlobalZyFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('zy_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // 文件尚不存在，不需要陈旧检查
      }
    }

    // 重读当前配置以获取最新状态。如果文件
    // 暂时损坏（并发写入、写入期间中断），这会
    // 返回默认值 — 我们绝不能将这些默认值写回好配置。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalZyFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.zy.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('zy_config_auth_loss_prevented', {})
      return false
    }

    // 应用合并函数以获取更新后的配置
    const mergedConfig = mergeFn(currentConfig)

    // 无变更则跳过写入（返回了相同引用）
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉与默认值匹配的所有值
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) => jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 写入前为现有配置文件创建时间戳备份。
    // 保留多个备份以防止重置/损坏的配置覆盖好的备份。
    // 备份存储在 ~/.zy/backups/ 以保持主目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 先检查现有备份 — 如果近期已有备份则跳过创建新备份。
      // 启动期间，许多 saveGlobalConfig 调用在几毫秒内连续触发；
      // 没有此检查，每次调用都会创建新备份文件堆积在磁盘上。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter((f) => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最新的在前（时间戳按字典序排序）

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // 清理旧备份，仅保留最近 5 个
      const MAX_BACKUPS = 5
      // 刚创建了一个则重读列表；否则复用
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter((f) => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // 忽略清理错误
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // 无文件可备份或备份失败，继续写入
    }

    // 以安全权限写入配置文件 — mode 仅适用于新文件
    writeFileSyncAndFlush_DEPRECATED(file, jsonStringify(filteredConfig, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    if (file === getGlobalZyFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 追踪配置读取是否被允许的标志
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 确保幂等
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 设置此标志前读取配置会显示控制台警告
  // 以防止我们在模块初始化期间添加配置读取
  configReadingAllowed = true
  // 目前只检查全局配置，因为所有配置共享一个文件
  getConfig(getGlobalZyFile(), createDefaultGlobalConfig, true /* throw on invalid */)

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * 返回配置文件备份文件的存储目录。
 * 使用 ~/.zy/backups/ 以保持主目录整洁。
 */
function getConfigBackupDir(): string {
  return join(getZyConfigHomeDir(), 'backups')
}

/**
 * 查找指定配置文件的最新备份文件。
 * 先检查 ~/.zy/backups/，然后回退到旧位置
 *（配置文件旁边）以兼容旧版本。
 * 返回最新备份的完整路径，如无备份则返回 null。
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 先检查新备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter((f) => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  // 回退到旧位置（配置文件旁边）
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter((f) => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // 检查旧版备份文件（无时间戳）
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // 旧版备份不存在
    }
  } catch {
    // 忽略读取目录的错误
  }

  return null
}

function getConfig<A>(file: string, createDefault: () => A, throwOnInvalid?: boolean): A {
  // 配置在被允许之前访问时记录警告
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 解析前去除 BOM — PowerShell 5.x 会给 UTF-8 文件添加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 抛出带有文件路径和默认配置的 ConfigParseError
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件未找到 — 检查备份并返回默认值
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nZy configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // 如果 throwOnInvalid 为 true，则重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误，让用户知道发生了什么
    if (error instanceof ConfigParseError) {
      logForDebugging(`Config file corrupted, resetting to defaults: ${error.message}`, {
        level: 'error',
      })

      // 防护：logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // 配置文件损坏时会导致无限递归，因为
      // 采样检查从全局配置读取 GrowthBook 特性。
      // 仅在最外层调用时记录分析事件。
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // 记录错误以便监控
          logError(error)

          // 记录配置损坏的分析事件
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // 无备份
          }
          logEvent('zy_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(`\nZy configuration file at ${file} is corrupted: ${error.message}\n`)

      // 尝试备份损坏的配置文件（仅当尚未备份时）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter((f) => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏内容是否与现有备份匹配
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(join(corruptedBackupDir, backup), {
            encoding: 'utf-8',
          })
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // 忽略备份读取错误
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(corruptedBackupDir, `${fileBase}.corrupted.${Date.now()}`)
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(`Corrupted config backed up to: ${corruptedBackupPath}`, {
            level: 'error',
          })
        } catch {
          // 忽略备份错误
        }
      }

      // 通知用户配置文件损坏及可用备份
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(`The corrupted file has been backed up to: ${corruptedBackupPath}\n`)
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// 缓存的函数，用于获取配置查找的项目路径
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 规范化以确保 JSON key 一致（所有平台使用正斜杠）
    // 这确保 C:\Users\... 和 C:/Users/... 映射到相同的 key
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // 不确定这个怎么变成 string 的
  // TODO: 在上游修复
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools = (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 无变更则跳过（返回了相同引用）
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(getGlobalZyFile(), createDefaultGlobalConfig, (current) => {
      const currentProjectConfig = current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
      const newProjectConfig = updater(currentProjectConfig)
      // 无变更则跳过（返回了相同引用）
      if (newProjectConfig === currentProjectConfig) {
        return current
      }
      written = {
        ...current,
        projects: {
          ...current.projects,
          [absolutePath]: newProjectConfig,
        },
      }
      return written
    })
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // 与 saveGlobalConfig 的竞争窗口相同 — 拒绝将
    // 默认值写入好的缓存配置。见 GH #3117。
    const config = getConfig(getGlobalZyFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('zy_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig = config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 无变更则跳过（返回了相同引用）
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalZyFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * 返回是否应跳过插件自动更新。
 * 检查自动更新器是否已禁用且 FORCE_AUTOUPDATE_PLUGINS
 * 环境变量未设置为 'true'。该环境变量允许在
 * 自动更新器被禁用时强制插件自动更新。
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return isAutoUpdaterDisabled() && !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(reason: AutoUpdaterDisabledReason): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' || config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig((current) => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig((current) => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getZyConfigHomeDir(), 'AGENTS.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'AGENTS.md')
    case 'Managed':
      return join(getManagedFilePath(), 'AGENTS.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem 仅在 feature('TEAMMEM') 为 true 时才是有效的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 在 TeamMem 不在 MemoryType 中的外部构建中不可达
}

export function getManagedZyRulesDir(): string {
  return join(getManagedFilePath(), '.zy', 'rules')
}

export function getUserZyRulesDir(): string {
  return join(getZyConfigHomeDir(), 'rules')
}

// 仅用于测试导出
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(config: GlobalConfig | null): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
