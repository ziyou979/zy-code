import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { getSessionId, isSessionPersistenceDisabled } from 'src/bootstrap/state.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import { accumulateUsage, updateUsage } from 'src/services/api/usageTracker.js'
import type {
  PermissionMode,
  WireCompactBoundaryMessage,
  WireMessage,
  WirePermissionDenial,
  WireStatus,
  WireUserMessageReplay,
} from 'src/types/index.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from './constants/xml.js'
import { getModelUsage, getTotalAPIDuration, getTotalCost } from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import { getMainLoopModel, parseUserSpecifiedModel } from './services/model/model.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './services/processUserInput/processUserInput.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { toUUID } from './types/ids.js'
import type { UserContentBlock } from './types/llm.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { Attachment } from './utils/attachments.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import { cloneFileStateCache, type FileStateCache } from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import {
  countToolCalls,
  pruneCompletedTurnArtifacts,
  SYNTHETIC_MESSAGES,
} from './utils/messages.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import { flushSessionStorage, recordTranscript } from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js'

// 延迟加载：MessageSelector.tsx 会引入 React/ink；仅在查询时进行消息过滤才需要
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector = (): typeof import('src/components/MessageSelector.js') =>
  require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import { buildSystemInitMessage, sdkCompatToolName } from './utils/messages/systemInit.js'
import { getScratchpadDir, isScratchpadEnabled } from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 死代码消除：coordinator 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** 处理由 MCP 工具 -32042 错误触发的 URL 诱导请求。 */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: WireStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
}

/**
 * QueryEngine 管理对话的查询生命周期和会话状态。
 * 它将 ask() 中的核心逻辑提取为一个独立类，可同时用于 headless/SDK 路径
 * 和（未来阶段）REPL。
 *
 * 每个对话对应一个 QueryEngine。每次 submitMessage() 调用在同一对话中开始
 * 一个新的 turn。状态（messages、file cache、usage 等）在 turn 之间持久化。
 */
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: WirePermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // Turn 级别的技能发现跟踪（用于 was_discovered 字段）。
  // 需要在 submitMessage 内的两次 processUserInputContext 重建之间持久化，
  // 但在每次 submitMessage 开始时清除，以避免 SDK 模式下跨多个 turn 的无限增长。
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  async *submitMessage(
    prompt: string | UserContentBlock[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<WireMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    // 与 discoveredSkillNames 对齐：每个 turn 入口清空，避免长会话单调增长。
    // 这两个 Set 仅用于 turn 内的去重计数（was_discovered 字段、嵌套 memory 加载），
    // 跨 turn 持有没有语义价值，但会持续累积路径字符串。
    this.discoveredSkillNames.clear()
    this.loadedNestedMemoryPaths.clear()
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    // 包装 canUseTool 以跟踪权限拒绝情况
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 跟踪拒绝情况以供 SDK 报告使用
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault(initialMainLoopModel) !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 提前窄化类型，使 TS 在以下条件判断中正确追踪类型
    const customPrompt = typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 当 SDK 调用者提供了自定义 system prompt 且设置了
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，注入 memory 机制 prompt。
    // 该环境变量是一个显式的 opt-in 信号——调用者已连接了
    // memory 目录，需要 Zy 了解如何使用它（应调用哪些
    // Write/Edit 工具、MEMORY.md 文件名、加载语义等）。
    // 调用者可以通过 appendSystemPrompt 添加自己的策略文本。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride() ? await loadMemoryPrompt() : null

    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 注册结构化输出强制执行的函数钩子
    const hasStructuredOutputTool = tools.some((t) =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // 变更消息数组的斜杠命令会调用 setMessages(fn)。
      // 在交互模式下这会写回 AppState；在打印模式下我们写回 mutableMessages，
      // 使查询循环的后续部分（:389 的 push、:392 的 snapshot）能看到结果。
      // 下方第二个 processUserInputContext（斜杠命令处理之后）保留了该 no-op——
      // 此后没有其他代码会调用 setMessages。
      setMessages: (fn) => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => {
        setAppState((prev) => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) {
            return prev
          }
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (updater: (prev: AttributionState) => AttributionState) => {
        setAppState((prev) => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) {
            return prev
          }
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // 处理孤立权限（每个 engine 生命周期内仅执行一次）
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 推送新消息，包括用户输入和任何附件
    this.mutableMessages.push(...messagesFromUserInput)

    // 更新参数以反映处理斜杠命令后的变更
    const messages = [...this.mutableMessages]

    // 在进入查询循环之前，将用户消息持久化到 transcript。
    // 下方的 for-await 仅在 ask() 产生 assistant/user/compact_boundary
    // 消息时才调用 recordTranscript——而这需要等到 API 响应返回后才会发生。
    // 如果进程在此之前被终止（例如用户在发送后几秒内点击 Stop），
    // transcript 将只包含队列操作条目；getLastSessionLog 会过滤掉这些，
    // 返回 null，导致 --resume 失败并提示 "No conversation found"。
    // 现在写入可以在用户消息被接受时就使 transcript 可恢复，
    // 即使 API 响应从未到达也是如此。
    //
    // --bare / 简单模式：fire-and-forget。脚本化调用不会在 kill 后 --resume。
    // await 在 SSD 上约 4ms，磁盘竞争时约 30ms——是模块加载后最大的可控
    // 关键路径开销。Transcript 仍然会被写入（用于事后调试），只是不阻塞。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // 过滤掉在 transcript 之后需要确认的消息
    const replayableMessages = messagesFromUserInput.filter(
      (msg) =>
        (msg.type === 'user' &&
          !msg.isMeta && // Skip synthetic caveat messages
          !msg.toolUseResult && // Skip tool results (they'll be acked from query)
          messageSelector().selectableUserMessagesFilter(msg)) || // Skip non-user-authored messages (task notifications, etc.)
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // Always ack compact boundaries
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入处理结果更新 ToolPermissionContext（如需要）
    setAppState((prev) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 在处理 prompt 后重新创建，以获取更新后的消息和 model（来自斜杠命令）
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // 仅使用缓存：headless/SDK/CCR 启动时不能因网络请求而阻塞
    // 需要引用跟踪的插件。CCR 通过 ZY_CODE_SYNC_PLUGIN_INSTALL
    // （headlessPluginInstall）或 ZY_CODE_PLUGIN_SEED_DIR 在此运行前填充缓存；
    // 需要最新源码的 SDK 调用者可以调用 /reload-plugins。
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext.mode as PermissionMode, // TODO: avoid the cast
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
    })

    // 记录 system 消息产生的时机，用于 headless 延迟追踪
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      // 返回本地斜杠命令的结果。
      // 使用 messagesFromUserInput（而非 replayableMessages）获取命令输出，
      // 因为 selectableUserMessagesFilter 会排除 local-command-stdout 标签。
      for (const msg of messagesFromUserInput) {
        if (msg.type === 'user') {
          const textBlock = msg.message.content.find((b: { type: string }) => b.type === 'text') as
            | { type: 'text'; text: string }
            | undefined
          const textContent = textBlock?.text ?? ''
          if (
            textContent.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            textContent.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary
          ) {
            yield {
              type: 'user',
              message: {
                ...msg.message,
                content: msg.message.content.map((b: any) =>
                  b.type === 'text' ? { ...b, text: stripAnsi(b.text) } : b,
                ),
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: msg.uuid,
              timestamp: msg.timestamp,
              isReplay: !msg.isCompactSummary,
              isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
            } as WireUserMessageReplay
          }
        }

        // 本地命令输出——作为合成的 assistant 消息产生，使 RC 将其渲染为
        // assistant 样式文本而非用户气泡。以 assistant 类型（而非专用的
        // WireLocalCommandOutputMessage 系统子类型）发出，以便移动端客户端
        // 和会话入口能够解析。
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, toUUID(msg.uuid))
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as WireCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      // 内存优化：transcript 已落盘，丢弃历史 turn 的 UI-only 消息
      this.pruneArtifactsBeforeResult()

      yield {
        type: 'result',
        subtype: 'success',
        isError: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach((message) => {
          void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
            setAppState((prev) => ({
              ...prev,
              fileHistory: updater(prev.fileHistory),
            }))
          }, toUUID(message.uuid))
        })
    }

    // 跟踪当前消息的 usage（在每个 message_start 时重置）
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // 跟踪 StructuredOutput 工具调用产生的结构化输出
    let structuredOutputFromTool: unknown
    // 跟踪 assistant 消息的最后一个 stop_reason
    let lastStopReason: string | null = null
    // 基于引用的水位标记，使 error_during_execution 的 errors[] 为当前 turn 范围。
    // 基于长度的索引会在 100 条环形缓冲区 shift() 时失效——索引会滑动。
    // 如果该条目被旋转出去，lastIndexOf 返回 -1，我们会包含所有内容（安全回退）。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // 在本次查询前快照计数，用于基于增量的重试限制
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 记录 assistant、user 和 compact boundary 消息
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // 在写入 compact boundary 之前，先将仅存在于内存中的消息
        // 刷新到 preservedSegment 尾部。附件和进度现在已内联记录
        // （见下方各自的 switch 分支），但这次刷新对 preservedSegment
        // 尾部遍历仍然必要。如果 SDK 子进程在此之间重启（zy-desktop
        // 在 turn 之间 kill），tailUuid 会指向一个从未写入的消息——
        // applyPreservedSegmentRelinks 的 tail→head 遍历失败——直接返回
        // 而不进行裁剪——恢复时会加载完整的压缩前历史。
        if (persistSession && message.type === 'system' && message.subtype === 'compact_boundary') {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex((m) => m.uuid === tailUuid)
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message)
        if (persistSession) {
          // assistant 消息使用 fire-and-forget。zy.ts 每个 content block
          // 产生一条 assistant 消息，然后在 message_delta 时修改最后一条的
          // message.usage/stop_reason——这依赖于写入队列的 100ms 延迟
          // jsonStringify。在此 await 会阻塞 ask() 的 generator，导致
          // message_delta 在所有 block 消费完毕前无法运行；而排空定时器
          // （从 block 1 开始）会先到期。交互式 CC 不会遇到这个问题，
          // 因为 useLogMessages.ts 使用了 fire-and-forget。
          // enqueueWrite 保持顺序，因此这里的 fire-and-forget 是安全的。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 在首次 transcript 记录后确认初始用户消息
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as WireUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      switch (message.type) {
        case 'assistant': {
          // 如果已设置则捕获 stopReason（合成消息）。对于流式响应，
          // 在 content_block_stop 时该值为 null；真实值会在下方通过
          // message_delta 到达（见 zy.ts 的 message_delta 处理器）。
          if (message.message.stopReason != null) {
            lastStopReason = message.message.stopReason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        }
        case 'progress':
          this.mutableMessages.push(message)
          // 内联记录，使下次 ask() 调用中的去重循环能看到它已被记录。
          // 如果不这样做，延迟的 progress 会与 mutableMessages 中已记录的
          // tool_results 交错，导致去重遍历将 startingParentUuid 定位在
          // 错误的消息上——分叉链并在恢复时孤立对话。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'stream_event': {
          const streamMsg = message
          if (
            streamMsg.event.type === 'message_start' ||
            streamMsg.event.type === 'response_start'
          ) {
            // 重置新消息的当前 usage
            currentMessageUsage = EMPTY_USAGE
            const startMsg = streamMsg.event.message as
              | { usage?: import('./types/llm.js').DeltaUsage }
              | undefined
            if (startMsg?.usage) {
              currentMessageUsage = updateUsage(currentMessageUsage, startMsg.usage)
            }
          }
          if (
            streamMsg.event.type === 'message_delta' ||
            streamMsg.event.type === 'response_delta'
          ) {
            const evt = streamMsg.event as unknown as import('./types/llm.js').ResponseDeltaEvent
            // response_delta 的 usage 是标准格式（camelCase）
            const deltaUsage: import('./types/llm.js').DeltaUsage | undefined = evt.usage
              ? {
                  inputTokens: evt.usage.inputTokens,
                  outputTokens: evt.usage.outputTokens ?? 0,
                  extras: evt.usage.extras,
                }
              : undefined
            currentMessageUsage = updateUsage(currentMessageUsage, deltaUsage)
            // 从 message_delta/response_delta 捕获 stopReason。assistant 消息在
            // content_block_stop/chunk_stop 时产生，stopReason=null；真实值仅在此处到达
            //（见 zy.ts 的处理器）。没有这一步，
            // result.stopReason 将始终为 null。
            const evtStopReason = evt.stopReason
            if (evtStopReason != null) {
              lastStopReason = evtStopReason
            }
          }
          if (streamMsg.event.type === 'message_stop' || streamMsg.event.type === 'response_stop') {
            // 将当前消息的 usage 累积到总计中
            this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: streamMsg.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        }
        case 'attachment': {
          this.mutableMessages.push(message)
          // 记录内联（与上方 progress 相同的原因）
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // Message 联合里 AttachmentMessage 用默认泛型 { type: string }，payload 字段不可见；
          // 收窄到 attachments.ts 的 Attachment 联合后即可按 type 判别访问具体字段。
          const attachment = message.attachment as Attachment
          // 从 StructuredOutput 工具调用中提取结构化输出
          if (attachment.type === 'structured_output') {
            structuredOutputFromTool = attachment.data
          }
          // 处理来自 query.ts 的 max turns reached 信号
          else if (attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            // 内存优化：丢弃历史 turn 的 UI-only 消息
            this.pruneArtifactsBeforeResult()
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              isError: true,
              num_turns: attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              uuid: randomUUID(),
              errors: [`Reached maximum number of turns (${attachment.maxTurns})`],
            }
            return
          }
          // 将 queued_command 附件作为 SDK 用户消息回放产生
          else if (replayUserMessages && attachment.type === 'queued_command') {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as WireUserMessageReplay
          }
          break
        }
        case 'stream_request_start':
          // 不产生 stream request start 消息
          break
        case 'system': {
          this.mutableMessages.push(message)
          // 向 SDK 产生 compact boundary 消息。message 收窄为 SystemMessage | TombstoneMessage，
          // 按 subtype 进一步判别到具体子类型即可访问对应字段。
          if (message.subtype === 'compact_boundary' && message.compactMetadata) {
            // 释放压缩前的消息以供 GC。边界刚刚被推送，所以它是最后一个元素。
            // query.ts 内部已使用 getMessagesAfterCompactBoundary()，因此
            // 后续只需要边界之后的消息。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error?.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // 在 headless 模式下不产生其他 system 消息
          break
        }
        case 'tool_use_summary': {
          // 向 SDK 产生 tool use summary 消息
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
        }
      }

      // 检查是否超出 USD 预算
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        // 内存优化：丢弃历史 turn 的 UI-only 消息
        this.pruneArtifactsBeforeResult()
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          isError: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查结构化输出重试次数是否超限（仅在 user 消息时）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5', 10)
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          // 内存优化：丢弃历史 turn 的 UI-only 消息
          this.pruneArtifactsBeforeResult()
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            isError: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            uuid: randomUUID(),
            errors: [`Failed to provide valid structured output after ${maxRetries} attempts`],
          }
          return
        }
      }
    }

    // Stop 钩子在 assistant 响应之后产生 progress/attachment 消息
    //（通过 query.ts 中的 yield* handleStopHooks）。由于 #23537 将它们
    // 内联推入 `messages`，last(messages) 可能是 progress/attachment
    // 而非 assistant——这会使下方的 textResult 提取返回 ''，-p 模式
    // 输出空行。白名单限定 assistant|user：isResultSuccessful 处理两者
    //（带有完整 tool_result 块的 user 是有效的成功终态）。
    const result = messages.findLast((m) => m.type === 'assistant' || m.type === 'user')
    // 为 error_during_execution 诊断捕获值——isResultSuccessful 是类型谓词
    //（message is Message），因此在 false 分支内 `result` 被窄化为 never，
    // 这些访问无法通过类型检查。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant' ? (result.message.content.at(-1)?.type ?? 'none') : 'n/a'

    // 在产生 result 之前刷新缓冲的 transcript 写入。
    // 桌面应用在收到 result 消息后会立即 kill CLI 进程，
    // 因此任何未刷新的写入都会丢失。
    if (persistSession) {
      if (
        isEnvTruthy(process.env.ZY_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.ZY_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      // 内存优化：丢弃历史 turn 的 UI-only 消息
      this.pruneArtifactsBeforeResult()
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        isError: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        uuid: randomUUID(),
        // 诊断前缀：这些是 isResultSuccessful() 检查的内容——如果
        // result 类型不是 assistant-with-text/thinking 或 user-with-tool_result，
        // 且 stop_reason 不是 end_turn，这就是触发原因。
        // errors[] 通过 watermark 限定为当前 turn 范围；之前它会转储
        // 整个进程的 logError 缓冲区（ripgrep 超时、ENOENT 等）。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark ? all.lastIndexOf(errorLogWatermark) + 1 : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map((_) => _.error),
          ]
        })(),
      }
      return
    }

    // 根据消息类型提取文本结果
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = result.message.content.at(-1)
      if (lastContent?.type === 'text' && !SYNTHETIC_MESSAGES.has(lastContent.text)) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    // 内存优化：丢弃历史 turn 的 UI-only 消息
    this.pruneArtifactsBeforeResult()

    yield {
      type: 'result',
      subtype: 'success',
      isError: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool as Record<string, unknown> | undefined,
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    this.abortController.abort()
  }

  /**
   * 内存优化：在 turn 结束前清理 mutableMessages 中已完成 turn 的 UI-only 消息。
   *
   * 安全说明：
   * - 仅丢弃 progress / stream_event / 控制信号 / UI-only attachment
   * - 这些消息不进入 LLM 请求（验证：构建链路只读 user/assistant/system/attachment，
   *   且 buildPostCompactMessages 不保留 progress）
   * - 已通过 recordTranscript 写入磁盘，transcript view 仍可看到完整历史
   * - 保留最近一个 turn 的全部消息，避免影响 UI 动画收尾
   *
   * 在每个 result yield 之前调用，保证：
   * 1. transcript 已经在 messages 流中独立持久化（QueryEngine 的 progress/attachment 分支
   *    都已 recordTranscript）
   * 2. 此时 turn 已完成，UI 不再依赖 mutableMessages 里的 progress 渲染
   */
  private pruneArtifactsBeforeResult(): void {
    const before = this.mutableMessages.length
    const result = pruneCompletedTurnArtifacts(this.mutableMessages)
    if (result.droppedCount === 0 && result.shrunkCount === 0) {
      return
    }
    this.mutableMessages = result.messages
    // 仅在调试模式打印，避免污染普通输出
    if (isEnvTruthy(process.env.ZY_CODE_PROFILE_STARTUP)) {
      // eslint-disable-next-line no-console
      console.error(
        `[QueryEngine] Pruned ${result.droppedCount} UI-only messages (` +
          `${before} → ${this.mutableMessages.length}, ` +
          `freed ~${Math.round(result.freedBytes / 1024)}KB)`,
      )
    }
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * 向 Zy API 发送单个提示并返回响应。
 * 假设 zy 以非交互方式使用——不会向用户请求权限或进一步输入。
 *
 * 围绕 QueryEngine 的便捷包装器，适用于一次性使用。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<UserContentBlock>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: WireStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<WireMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
