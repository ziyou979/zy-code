import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/services/todo/types.js'
import type { WirePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import type { ModelSetting } from '../services/model/model.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import { getEmptyToolPermissionContext, type Tool, type ToolPermissionContext } from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import { type AttributionState, createEmptyAttributionState } from '../utils/commitAttribution.js'
import type { EffortLevel } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Store } from './store.js'

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // Mutable ref - avoids array spreading per message
      writtenPathsRef: { current: Set<string> } // Mutable ref - relative paths written to overlay
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem = 'tasks' | 'tmux' | 'bagel' | 'teams' | 'bridge'

export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // 可选字段 - 仅在 ENABLE_AGENT_SWARMS 为 true 时存在（用于死代码消除）
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // CoordinatorTaskPanel 选择：-1 = 药丸，0 = 主视图，1..N = agent 行。
  // 放在 AppState（而非 local）中，这样面板可以直接读取，无需通过
  // PromptInput → PromptInputFooter 逐层传递 props
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // 哪个 footer 药丸处于聚焦状态（提示符下方的箭头键导航）。
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // Agent 名称，来自 --agent CLI 标志或 settings（用于 logo 显示）
  agent: string | undefined
  // Assistant 模式完全启用（settings + GrowthBook 门控 + 信任）。
  // 单一事实来源 - 在 main.tsx 中于 option 变更之前计算一次，
  // 消费者读取此值而非重新调用 isAssistantMode()。
  kairosEnabled: boolean
  // --remote 模式的远程会话 URL（在 footer 指示器中显示）
  remoteSessionUrl: string | undefined
  // 远程会话 WS 状态（`zy assistant` 查看器）。'connected' 表示
  // 实时事件流已打开；'reconnecting' = 临时 WS 断开，正在进行退避重试；
  // 'disconnected' = 永久关闭或重试次数已耗尽。
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  // `zy assistant`：运行在远程守护进程子进程中的后台任务
  //（Agent 调用、teammates、workflows）数量。通过 WS 上的
  // system/task_started 和 system/task_notification 事件驱动。
  // 本地 AppState.tasks 在查看器模式下始终为空 —— 任务位于不同的进程中。
  remoteBackgroundTaskCount: number
  // 常开 bridge：期望状态（由 /config 或 footer 切换控制）
  replBridgeEnabled: boolean
  // 常开 bridge：通过 /remote-control 命令激活时为 true，由配置驱动时为 false
  replWireExplicit: boolean
  // 仅出站模式：将事件转发到 CCR 但拒绝入站提示/控制
  replBridgeOutboundOnly: boolean
  // 常开 bridge：环境已注册 + 会话已创建（= "就绪"）
  replWireConnected: boolean
  // 常开 bridge：入站 WebSocket 已打开（= "已连接" - 用户在 zy.ai 上）
  replWireSessionActive: boolean
  // 常开 bridge：轮询循环处于错误退避状态（= "重新连接中"）
  replWireReconnecting: boolean
  // 常开 bridge：就绪状态的连接 URL（?bridge=envId）
  replWireConnectUrl: string | undefined
  // 常开 bridge：zy.ai 上的会话 URL（连接后设置）
  replWireSessionUrl: string | undefined
  // 常开 bridge：用于调试的 ID（在 --verbose 时在对话框中显示）
  replWireEnvironmentId: string | undefined
  replWireSessionId: string | undefined
  // 常开 bridge：连接失败时的错误消息（在 BridgeDialog 中显示）
  replWireError: string | undefined
  // 常开 bridge：通过 `/remote-control <name>` 设置的会话名称（用作会话标题）
  replWireInitialName: string | undefined
  // 常开 bridge：首次远程对话框待处理（由 /remote-control 命令设置）
  showRemoteCallout: boolean
}> & {
  // 统一 task 状态 - 从 DeepImmutable 中排除，因为 TaskState 包含函数类型
  tasks: { [taskId: string]: TaskState }
  // 名称 → AgentId 注册表，由 Agent tool 在提供 `name` 时填充。
  // 冲突时以最新的为准。SendMessage 通过名称路由时使用。
  agentNameRegistry: Map<string, AgentId>
  // 已前置的 task ID - 其消息显示在主视图中
  foregroundedTaskId?: string
  // 正在查看其转录的进行中 teammate task 的 task ID（undefined = 领导者视图）
  viewingAgentTaskId?: string

  // TODO (ashwin): see if we can use utility-types DeepReadonly for this
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /**
     * 由 /reload-plugins 递增，以触发 MCP effect 重新运行
     * 并拾取新启用的插件 MCP 服务器。Effect 将其读取为依赖项；
     * 该值本身不会被消费。
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /**
     * 插件系统在加载和初始化期间收集的错误。
     * 完整的错误结构、上下文字段和显示格式请参阅 {@link PluginError} 类型文档。
     */
    errors: PluginError[]
    // 后台插件/市场安装的状态
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * 当磁盘上的插件状态发生变化时（后台协调、/plugin 菜单安装、
     * 外部 settings 编辑）设置为 true，此时活跃组件已过时。
     * 在交互模式下，用户运行 /reload-plugins 来消费。在
     * 无头模式下，refreshPluginState() 通过 refreshActivePlugins() 自动消费。
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  remoteAgentTaskSuggestions: { summary: string; task: string }[]
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  // /goal 命令的活跃目标状态（session-scoped Stop hook 驱动）
  activeGoal?: {
    condition: string
    iterations: number
    setAt: number
    tokensAtStart: number
    lastReason?: string
  }
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // tmux 目标（例如 "session:window.pane"）
  }
  tungstenLastCapturedTime?: number // 为模型捕获帧的时间戳
  tungstenLastCommand?: {
    command: string // 要显示的命令字符串（例如 "Enter"、"echo hello"）
    timestamp: number // 命令发送的时间
  }
  // 粘性 tmux 面板可见性 —— 镜像 globalConfig.tungstenPanelVisible 以保持响应性。
  tungstenPanelVisible?: boolean
  // 回合结束时的临时自动隐藏 —— 与 tungstenPanelVisible 分离，这样
  // 药丸仍保留在 footer 中（用户可以重新打开），但面板内容在空闲时
  // 不占用屏幕空间。下次 Tmux tool 使用或用户切换时清除。不持久化。
  tungstenPanelAutoHidden?: boolean
  // WebBrowser tool（代号 bagel）：药丸在 footer 中可见
  bagelActive?: boolean
  // WebBrowser tool：药丸标签中显示的当前页面 URL
  bagelUrl?: string
  // WebBrowser tool：粘性面板可见性切换
  bagelPanelVisible?: boolean
  // chicago MCP 会话状态。类型内联（而非从
  // @ant/computer-use-mcp/types 导入），以便外部类型检查通过，
  // 无需解析 ant 作用域依赖。结构与 `AppGrant`/`CuGrantFlags`
  // 一致 —— wrapper.tsx 通过结构兼容性进行赋值。
  // 仅在 feature('CHICAGO_MCP') 激活时填充。
  computerUseMcpState?: {
    // 会话作用域的应用允许列表。不在恢复时持久化。
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // 剪贴板/系统键授权标志（与允许列表正交）。
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // 压缩后的 scaleCoord 的仅尺寸信息（非完整 blob）。完整
    // 的 `ScreenshotResult`（含 base64）在 wrapper.tsx 中进程本地存储。
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // 由 onAppsHidden 累积，在回合结束时清除并取消隐藏。
    hiddenDuringTurn?: ReadonlySet<string>
    // CU 目标哪个显示器。由包的 `autoTargetDisplay` 解析器
    // 通过 `onResolvedDisplayUpdated` 回写。在恢复时持久化，
    // 这样点击操作仍停留在模型上次看到的显示器上。
    selectedDisplayId?: number
    // 模型通过 `switch_display` 显式选择显示器时为 true。
    // 使 `handleScreenshot` 跳过解析器追踪链，直接使用
    // `selectedDisplayId`。在解析器回写时清除（已固定的
    // 显示器拔出 -> Swift 回退到主显示器）以及
    // `switch_display("auto")` 时清除。
    displayPinnedByModel?: boolean
    // 显示器上次自动解析时对应的已排序逗号连接的 bundle-ID 集合。
    // `handleScreenshot` 仅在允许集合自上次发生变化后才重新解析 ——
    // 防止解析器在每次截图时都频繁切换。
    displayResolvedForApps?: string
  }
  // REPL tool VM 上下文 - 在 REPL 调用之间持久化，用于状态共享
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // Swarm 成员的自身身份（tmux 面板中的独立进程）
    // 注意：这与 toolUseContext.agentId 不同，后者用于进程内子 agent
    selfAgentId?: string // Swarm 成员自身的 ID（对于领导者与 leadAgentId 相同）
    selfAgentName?: string // Swarm 成员的名称（领导者为 'team-lead'）
    isLeader?: boolean // 如果此 swarm 成员是团队领导者则为 true
    selfAgentColor?: string // 分配给 UI 的颜色（用于动态加入的会话）
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // 独立 agent 上下文，用于具有自定义名称/颜色的非 swarm 会话
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // Worker 沙箱权限请求（领导者侧）- 用于网络访问审批
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // Worker 侧待处理的权限请求（在等待领导者批准时显示）
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // Worker 侧待处理的沙箱权限请求
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // 认证版本 - 在登录/注销时递增，以触发重新获取依赖认证的数据
  authVersion: number
  // 要处理的初始消息（来自 CLI 参数或 plan 模式退出）
  // 设置后，REPL 将处理该消息并触发查询
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // plan 模式的会话作用域权限规则（例如 "run tests"、"install dependencies"）
    allowedPrompts?: AllowedPrompt[]
  } | null
  // 待处理的 plan 验证状态（退出 plan 模式时设置）
  // VerifyPlanExecution tool 使用该状态来触发后台验证
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // 分类器模式（YOLO、headless 等）的拒绝跟踪 - 超出限制时回退到提示
  denialTracking?: DenialTrackingState
  // 活跃的覆盖层（Select 对话框等），用于 Escape 键协调
  activeOverlays: ReadonlySet<string>
  // 服务端 advisor tool 的 advisor 模型（undefined = 禁用）。
  advisorModel?: string
  // 投入程度值
  effortValue?: EffortLevel
  // 在 launchUltraplan 中同步设置，在 detached 流程开始之前。
  // 在 ultraplanSessionUrl 被 teleportToRemote 设置之前的约 5 秒窗口内
  // 防止重复启动。一旦 URL 设置完成或失败，由 launchDetached 清除。
  ultraplanLaunching?: boolean
  // 活跃的 ultraplan CCR 会话 URL。在 RemoteAgentTask 运行时设置；
  // 为真时禁用关键字触发 + 彩虹效果。轮询到达终止状态时清除。
  ultraplanSessionUrl?: string
  // 已批准等待用户选择的 ultraplan（在此处实现而非新建会话）。
  // 由 RemoteAgentTask 轮询在批准时设置；由 UltraplanChoiceDialog 清除。
  ultraplanPendingChoice?: { plan: string; sessionId: string; taskId: string }
  // 启动前权限对话框。由 /ultraplan（斜杠或关键字）设置；
  // 由 UltraplanLaunchDialog 在用户选择后清除。
  ultraplanLaunchPending?: { blurb: string }
  // 远程 harness 侧：通过 set_permission_mode control_request 设置，
  // 由 onChangeAppState 推送到 CCR external_metadata.is_ultraplan_mode。
  isUltraplanMode?: boolean
  // 常开 bridge：双向权限检查的权限回调
  replWirePermissionCallbacks?: WirePermissionCallbacks
  // 渠道权限回调 —— Telegram/iMessage 等渠道的权限提示。
  // 在 interactiveHandler.ts 中通过 claim() 与本地 UI + bridge + hooks + 分类器竞争。
  // 在 useManageMCPConnections 中一次性构建。
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  // 确定使用 plan_mode_required 生成的 teammate 的初始权限模式
  // 使用延迟 require 以避免与 teammate.ts 的循环依赖
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils = require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired() ? 'plan' : 'default'

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // 别名、全名（如 --model 或环境变量），或 null（默认）
    mainLoopModelForSession: null,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replWireExplicit: false,
    replBridgeOutboundOnly: false,
    replWireConnected: false,
    replWireSessionActive: false,
    replWireReconnecting: false,
    replWireConnectUrl: undefined,
    replWireSessionUrl: undefined,
    replWireEnvironmentId: undefined,
    replWireSessionId: undefined,
    replWireError: undefined,
    replWireInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
  }
}
