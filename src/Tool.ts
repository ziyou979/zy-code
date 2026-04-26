import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from './types/llm.js'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// 从集中位置导入权限类型以打破导入循环
// 从集中位置导入 PermissionResult 以打破导入循环
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// 从集中位置导入工具进度类型以打破导入循环
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// 重新导出进度类型以保持向后兼容
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** 设置为 true 以清除本地 JSX 命令（例如从其 onDone 回调中） */
    clearLocalJSX?: boolean
  } | null,
) => void

// 从集中位置导入工具权限类型以打破导入循环
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// 重新导出以保持向后兼容
export type { ToolPermissionRulesBySource }

// 对导入的类型应用 DeepImmutable
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** 当为 true 时，权限提示会被自动拒绝（例如无法显示 UI 的后台 agent） */
  shouldAvoidPermissionPrompts?: boolean
  /** 当为 true 时，在显示权限对话框之前会等待自动化检查（分类器、hooks）完成（coordinator worker） */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** 存储进入模型发起的计划模式之前的权限模式，以便退出时恢复 */
  prePlanMode?: PermissionMode
}>

export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** 替代默认系统提示的自定义系统提示 */
    customSystemPrompt?: string
    /** 附加到主系统提示之后的额外系统提示 */
    appendSystemPrompt?: string
    /** 覆盖 querySource 以用于分析追踪 */
    querySource?: QuerySource
    /** 用于获取最新工具的可选回调（例如在查询过程中连接 MCP 服务器后） */
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * 始终共享的 setAppState，用于会话范围的基础设施（后台任务、会话 hooks）。
   * 与 setAppState 不同（setAppState 对异步 agent 是 no-op，见 createSubagentContext），
   * 这总是能到达根 store，因此任何嵌套深度的 agent 都可以注册/清理
   * 存活超过单个 turn 的基础设施。仅由 createSubagentContext 设置；
   * 主线程上下文回退到 setAppState。
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * 用于处理工具调用错误（-32042）触发的 URL 请求的可选处理器。
   * 在 print/SDK 模式下，这会委托给 structuredIO.handleElicitation。
   * 在 REPL 模式下，此为 undefined，使用基于队列的 UI 路径。
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  /** 向 REPL 消息列表追加一个仅 UI 的系统消息。在 normalizeMessagesForAPI 边界处会被剥离 — Exclude<> 使其成为类型强制的。 */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** 发送操作系统级别的通知（iTerm2、Kitty、Ghostty、bell 等） */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * 本会话中已作为 nested_memory 附件注入的 CLAUDE.md 路径。
   * 用于 memoryFilesToAttachments 去重 — readFileState 是一个 LRU 缓存，
   * 会在繁忙会话中淘汰条目，因此仅靠它的 .has() 检查可能导致同一个
   * CLAUDE.md 被重复注入数十次。
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** 本会话中通过 skill_discovery 暴露的技能名称。仅用于遥测（提供 was_discovered）。 */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** 仅在交互式（REPL）上下文中有效；SDK/QueryEngine 不设置此项。 */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // 仅对子 agent 设置；使用 getSessionId() 获取会话 ID。hooks 用此来区分子 agent 调用
  agentType?: string // 子 agent 类型名称。主线程的 --agent 类型，hooks 会回退到 getMainThreadAgentType()
  /** 当为 true 时，即使 hooks 自动批准，也必须调用 canUseTool。
   *  speculation 用它来覆盖文件路径重写。 */
  requireCanUseTool?: boolean
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** 用于向用户请求交互式提示的回调工厂。
   * 返回绑定到给定源名称的提示回调。
   * 仅在交互式（REPL）上下文中可用。 */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 当为 true 时，即使对于子 agent 也保留消息上的 toolUseResult。
   * 用于其转录可被用户查看的进程内队友。 */
  preserveToolUseResults?: boolean
  /** 异步子 agent 的本地拒绝追踪状态，其 setAppState 是
   *  no-op。没有这个，拒绝计数器永远不会累积，
   *  回退到提示的阈值也永远不会达到。可变的 —
   *  权限代码会就地更新它。 */
  localDenialTracking?: DenialTrackingState
  /**
   * 对话线程的工具结果预算内容替换状态。
   * 存在时，query.ts 会应用聚合的工具结果预算。
   * 主线程：REPL 一次性配置（永不重置 — 过时的 UUID key 是惰性的）。
   * 子 agent：createSubagentContext 默认克隆父级状态
   * （缓存共享 fork 需要相同的决策），或
   * resumeAgentBackground 传递从 sidechain 记录重建的状态。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 父级渲染的系统提示字节，在 turn 开始时冻结。
   * fork 子 agent 用它来共享父级的提示缓存 — 在 fork 生成时
   * 重新调用 getSystemPrompt() 可能会产生分歧（GrowthBook cold→warm）
   * 并导致缓存失效。见 forkSubagent.ts。
   */
  renderedSystemPrompt?: SystemPrompt
}

// 从集中位置重新导出 ToolProgressData
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      msg.data?.type !== 'hook_progress',
  )
}

export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier 仅对非并发安全的工具有效
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP 协议元数据（structuredContent、_meta），用于透传给 SDK 消费者 */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// 可输出字符串键对象的任意 schema 类型
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * 检查工具是否匹配给定名称（主名称或别名）。
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * 从工具列表中按名称或别名查找工具。
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * 工具重命名时用于向后兼容的可选别名。
   * 除了主名称外，工具还可以通过这些名称中的任意一个来查找。
   */
  aliases?: string[]
  /**
   * 用于 ToolSearch 关键词匹配的单行能力描述短语。
   * 工具被延迟加载时，帮助模型通过关键词搜索找到它。
   * 3-10 个单词，不带结尾句号。
   * 优先使用工具名称中未出现的术语（例如 NotebookEdit 使用 'jupyter'）。
   */
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  // MCP 工具可以直接以 JSON Schema 格式指定输入 schema
  // 而不是从 Zod schema 转换
  readonly inputJSONSchema?: ToolInputJSONSchema
  // TungstenTool 未定义此项，故为可选。TODO: Make it required.
  // 完成后，我们也可以让它更加类型安全。
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  /** 默认为 false。仅在工具执行不可逆操作（删除、覆盖、发送）时设置。 */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * 当用户在此工具运行期间提交新消息时应发生什么。
   *
   * - `'cancel'` — 停止工具并丢弃其结果
   * - `'block'`  — 继续运行；新消息等待
   *
   * 未实现时默认为 `'block'`。
   */
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * 返回此工具使用是否为搜索或读取操作的信息，
   * 此类操作应在 UI 中折叠为精简显示。例如包括
   * 文件搜索（Grep、Glob）、文件读取（Read）以及 bash 命令如 find、
   * grep、wc 等。
   *
   * 返回一个对象，表示操作是否为搜索或读取操作：
   * - `isSearch: true` 表示搜索操作（grep、find、glob 模式）
   * - `isRead: true` 表示读取操作（cat、head、tail、file read）
   * - `isList: true` 表示目录列表操作（ls、tree、du）
   * - 如果操作不应被折叠，都可以为 false
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * 当为 true 时，此工具会被延迟加载（以 defer_loading: true 发送），
   * 调用前需要先使用 ToolSearch。
   */
  readonly shouldDefer?: boolean
  /**
   * 当为 true 时，此工具永远不会延迟加载 — 即使启用了 ToolSearch，
   * 其完整 schema 也会出现在初始提示中。对于 MCP 工具，通过
   * `_meta['anthropic/alwaysLoad']` 设置。用于模型必须在第 1 轮
   * 看到且无需 ToolSearch 往返的工具。
   */
  readonly alwaysLoad?: boolean
  /**
   * 对于 MCP 工具：从 MCP 服务器接收的服务器和工具名称（未规范化）。
   * 无论 `name` 是否带前缀（mcp__server__tool）
   * 或不带前缀（CLAUDE_AGENT_SDK_MCP_NO_PREFIX 模式），所有 MCP 工具都存在。
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  /**
   * 工具结果在持久化到磁盘之前的最大字符数。
   * 超过时，结果会保存到文件中，ZY 会收到带文件路径的预览
   * 而非完整内容。
   *
   * 对于输出绝不能持久化的工具设置为 Infinity（例如 Read，
   * 持久化会产生 Read→file→Read 循环，且工具已通过自身限制自我约束）。
   */
  maxResultSizeChars: number
  /**
   * 当为 true 时，为此工具启用严格模式，使 API
   * 更严格地遵守工具指令和参数 schema。
   * 仅在 zy_strict_tools 启用时生效。
   */
  readonly strict?: boolean

  /**
   * 在观察者（SDK 流、转录、canUseTool、PreToolUse/PostToolUse hooks）
   * 看到之前，在 tool_use 输入的副本上调用。就地修改以添加
   * 遗留/派生字段。必须是幂等的。原始 API 绑定的输入
   * 永远不会被修改（保留提示缓存）。当 hook/权限返回新的
   * updatedInput 时不会重新应用 — 它们拥有自己的形状。
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * 确定此工具是否允许在当前上下文中以该输入运行。
   * 它会告知模型工具使用失败的原因，不会直接显示任何 UI。
   * @param input 工具输入
   * @param context 工具使用上下文
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 确定是否需要请求用户权限。仅在 validateInput() 通过后调用。
   * 通用权限逻辑在 permissions.ts 中。此方法包含工具特定的逻辑。
   * @param input 工具输入
   * @param context 工具使用上下文
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // 对文件路径进行操作的工具的可选方法
  getPath?(input: z.infer<Input>): string

  /**
   * 为 hook `if` 条件准备匹配器（权限规则模式如
   * "Bash(git *)" 中的 "git *"）。每个 hook-input 对调用一次；
   * 任何耗时的解析都在这里完成。返回一个闭包，
   * 对每个 hook 模式调用。如果未实现，仅工具名称级匹配有效。
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * 透明包装器（如 REPL）将所有渲染委托给其进度处理器，
   * 为每个内部工具调用发出原生样式的块。
   * 包装器本身不显示任何内容。
   */
  isTransparentWrapper?(): boolean
  /**
   * 返回此工具使用的简短字符串摘要，用于精简视图显示。
   * @param input 工具输入
   * @returns 简短字符串摘要，或 null 表示不显示
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * 返回人类可读的现在进行时活动描述，用于 spinner 显示。
   * 例如："Reading src/foo.ts"、"Running bun test"、"Searching for pattern"
   * @param input 工具输入
   * @returns 活动描述字符串，或 null 以回退到工具名称
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * 返回此工具使用的精简表示，用于自动模式安全分类器。
   * 例如：Bash 的 `ls -la`，Edit 的 `/tmp/x: new content`。
   * 返回 '' 以在分类器转录中跳过此工具
   * （例如无安全相关性的工具）。可以返回对象以避免
   * 调用者 JSON 包装时重复编码。
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * 可选。省略时，工具结果不渲染任何内容（与返回 null 相同）。
   * 对结果在其他地方展示的工具省略此项（例如 TodoWrite
   * 更新 todo 面板，而非转录）。
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      isBriefOnly?: boolean
      /** 原始 tool_use 输入，当可用时。对引用所请求内容的精简结果
       * 摘要很有用（例如 "Sent to #foo"）。 */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * renderToolResultMessage 在转录模式（verbose=true, isTranscriptMode=true）
   * 下显示内容的扁平化文本。用于转录搜索索引：索引统计此字符串中的
   * 出现次数，高亮覆盖扫描实际屏幕缓冲区。要使 count ≡ highlight，
   * 这必须返回最终可见的文本 — 而非 mapToolResultToToolResultBlockParam
   * 中面向模型的序列化（它添加了系统提醒、持久化输出包装器）。
   *
   * 可以忽略 Chrome（统计不足没关系）。"Found 3 files in 12ms"
   * 不值得索引。幽灵文本不行 — 此处声明但未渲染的文本
   * 是 count≠highlight bug。
   *
   * 可选：省略 → transcriptSearch.ts 中的字段名启发式。
   * test/utils/transcriptSearch.renderFidelity.test.tsx 捕获的漂移
   * 会渲染样本输出并标记已索引但未渲染（幽灵）或
   * 已渲染但未索引（统计不足警告）的文本。
   */
  extractSearchText?(out: Output): string
  /**
   * 渲染工具使用消息。注意 `input` 是部分的，因为我们
   * 会尽快渲染消息，可能在工具参数完全流式传入之前。
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * 当此输出的非精简渲染被截断时返回 true
   * （即点击展开会显示更多内容）。控制全屏中的
   * 点击展开行为 — 只有 verbose 实际显示更多内容的消息
   * 才有悬停/点击提示。未设置表示永不截断。
   */
  isResultTruncated?(output: Output): boolean
  /**
   * 渲染可选的标签，显示在工具使用消息之后。
   * 用于额外的元数据如超时、模型、恢复 ID 等。
   * 返回 null 表示不显示任何内容。
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * 可选。省略时，工具运行期间不显示进度 UI。
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * 可选。省略时，回退到 <FallbackToolUseRejectedMessage />。
   * 仅为需要自定义拒绝 UI 的工具定义此项（例如显示
   * 被拒绝 diff 的文件编辑工具）。
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * 可选。省略时，回退到 <FallbackToolUseErrorMessage />。
   * 仅为需要自定义错误 UI 的工具定义此项（例如显示
   * "File not found" 而非原始错误的搜索工具）。
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * 将此工具的多个并行实例作为一组渲染。
   * @returns 要渲染的 React 节点，或 null 以回退到单独渲染
   */
  /**
   * 将多个工具使用作为一组渲染（仅非精简模式）。
   * 在精简模式下，各个工具使用在其原始位置渲染。
   * @returns 要渲染的 React 节点，或 null 以回退到单独渲染
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}

/**
 * 工具集合。使用此类型代替 `Tool[]`，以便更容易
 * 追踪工具集在代码库中的组装、传递和过滤位置。
 */
export type Tools = readonly Tool[]

/**
 * `buildTool` 提供默认值的方法。`ToolDef` 可以省略这些；
 * 生成的 `Tool` 始终包含它们。
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * `buildTool` 接受的工具定义。与 `Tool` 形状相同，但
 * 可默认的方法为可选 — `buildTool` 会填充它们，使调用者
 * 始终看到完整的 `Tool`。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 类型级展开，镜像 `{ ...TOOL_DEFAULTS, ...def }`。对于每个
 * 可默认 key：如果 D 提供（必填），D 的类型胜出；如果 D 省略
 * 或可选（从约束中的 Partial<> 继承），默认值填充。
 * 所有其他 key 原样来自 D — 精确保留参数数量、
 * 可选性和字面量类型，与 `satisfies Tool` 相同。
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从部分定义构建完整的 `Tool`，为常用存根方法填充安全默认值。
 * 所有工具导出都应通过此函数，以便默认值集中管理，
 * 调用者无需 `?.() ?? default`。
 *
 * 默认值（关键处采用 fail-closed）：
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false`（假设不安全）
 * - `isReadOnly` → `false`（假设写入）
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }`（委托给通用权限系统）
 * - `toAutoClassifierInput` → `''`（跳过分类器 — 安全相关工具必须覆盖）
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// 默认值类型是 TOOL_DEFAULTS 的实际形状（可选参数使
// 0 参数和全参数调用点都能通过类型检查 — 存根参数数量不同且
// 测试依赖于此），而非接口的严格签名。
type ToolDefaults = typeof TOOL_DEFAULTS

// D 从调用点推断具体的对象字面量类型。
// 约束为方法参数提供上下文类型；约束位置的 `any` 是结构性的，
// 永远不会泄漏到返回类型中。
// BuiltTool<D> 在类型层面镜像运行时 `{...TOOL_DEFAULTS, ...def}`。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // 运行时的展开很简单；`as` 桥接了
  // structural-any 约束和精确的 BuiltTool<D> 返回类型之间的差距。
  // 类型语义已通过全部 60+ 工具的 0 错误类型检查得到证明。
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
