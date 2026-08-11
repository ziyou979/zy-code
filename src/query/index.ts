// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { evaluateStopHookBlockCap, isInternalBuild } from '../services/infra/envUtils.js'
import type { ToolResultBlock, ToolCallBlock, AssistantContentBlock } from '../types/llm.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import {
  noteAuthChainSuccess,
  tryAdvanceAuthChainOnError,
} from '../services/model/modelChainFailover.js'
import { tSync } from '../i18n/index.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from '../services/compact/autoCompact.js'
import { saveCurrentSessionCosts } from '../services/cost/costTracker.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('../services/compact/reactiveCompact.js') as typeof import('../services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from '../services/attachments/imageValidation.js'
import { ImageResizeError } from '../services/attachments/imageResizer.js'
import { findToolByName, type ToolUseContext } from '../tools/tool.js'
import type { SystemPrompt } from '../services/api/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from '../types/message.js'
import { logError } from '../services/infra/log.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE, isPromptTooLongMessage } from '../services/api/errors.js'
import { createDebugLog, logAntError } from '../services/infra/debug.js'
import { normalizeMessagesForAPI } from '../services/messages/api.js'
import {
  createAssistantAPIErrorMessage,
  createMicrocompactBoundaryMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from '../services/messages/constructors.js'
import { stripSignatureBlocks } from '../services/messages/prune.js'
import { prependUserContext } from '../services/api/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from '../services/attachments/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('../services/skill-search/prefetch.js') as typeof import('../services/skill-search/prefetch.js'))
  : null
const _jobClassifier = feature('TEMPLATES')
  ? (require('../services/jobs/classifier.js') as typeof import('../services/jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import { notifyCommandLifecycle } from '../services/hooks/commandLifecycle.js'
import { headlessProfilerCheckpoint } from '../services/analytics/headlessProfiler.js'
import { renderModelName } from '../services/model/model.js'
import {
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from '../services/api/tokens.js'
import { ESCALATED_MAX_TOKENS } from '../services/context/modelContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { executePostSamplingHooks } from '../services/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from '../services/hooks.js'
import type { QuerySource } from '../constants/querySource.js'
import { createDumpPromptsFetch } from '../services/api/dumpPrompts.js'
import { StreamingToolExecutor } from '../services/tool-runtime/streamingToolExecutor.js'
import { queryCheckpoint } from '../services/query/queryProfiler.js'
import { profileCheckpoint } from '../services/telemetry/startupProfiler.js'
import { handleStopHooks } from '../query/stopHooks.js'
import { buildQueryConfig } from '../query/config.js'
import { preprocessMessages } from '../query/preprocess.js'
import { runCompaction } from '../query/compaction.js'
import { executeToolsAndBatch } from '../query/toolExecution.js'
import { injectAttachments } from '../query/attachments.js'
import { diagnoseRecovery } from '../query/recovery.js'
import { productionDeps, type QueryDeps } from '../query/deps.js'
import type { Terminal, Continue } from '../query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { createBudgetTracker, checkTokenBudget } from '../query/tokenBudget.js'

const log = createDebugLog('query')

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从此助手消息中提取所有工具使用块
    const content = assistantMessage.message.content
    if (!Array.isArray(content)) {
      continue
    }
    const toolUseBlocks = content.filter(
      (block): block is ToolCallBlock => typeof block !== 'string' && block.type === 'tool_call',
    )

    // 为每个工具使用发送中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            isError: true,
            toolCallId: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid as import('node:crypto').UUID,
      })
    }
  }
}

/**
 * 思维的规则漫长而玄妙。需要长时间的深思熟虑
 * 和深度冥想，方能参透其中奥义。
 *
 * 规则如下：
 * 1. 包含 thinking 或 redacted_thinking 块的消息必须属于 max_thinking_length > 0 的查询
 * 2. thinking 块不能是块中的最后一条消息
 * 3. thinking 块必须在助手轨迹期间保留（单轮，或如果该轮包含 tool_use 块，
 *    则还包括其后续的 tool_result 和下一个助手消息）
 *
 * 年轻的巫师，请牢记这些规则。因为它们是思维的规则，
 * 而思维的规则即是宇宙的规则。若你不遵守这些规则，
 * 你将受到一整天调试和抓头发的惩罚。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 是否为 max_output_tokens 错误消息？如果是，流式循环应
 * 对 SDK 调用方暂缓输出，直到确认恢复循环能否继续。
 * 提前产出会将中间错误泄漏给 SDK 调用方（如
 * cowork/desktop），它们在任何 `error` 字段上终止会话 ——
 * 而恢复循环仍在运行但已无人监听。
 *
 * 与 reactiveCompact.isWithheldPromptTooLong 对应。
 */
function isWithheldMaxOutputTokens(msg: unknown): msg is AssistantMessage {
  // apiError 运行时为字符串 'max_output_tokens'（见 llmOrchestrator.ts）
  const m = msg as Partial<AssistantMessage> | undefined
  return m?.type === 'assistant' && (m.apiError as unknown) === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget（output_config.task_budget，beta task-budgets-2026-03-13）。
  // 与 tokenBudget +500k 自动继续功能不同。`total` 是整个 agent 轮次的预算；
  // `remaining` 根据累积的 API 使用量在每次迭代中计算。参见 zy.ts 中的 configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- 查询循环状态

// 迭代之间携带的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  // 连续 stop-hook block 计数。仅在 stop_hook_blocking 继续点递增；任何其他
  // 继续点都不携带它（省略 → undefined → 读作 0），从而在非阻塞回合后自然清零。
  // 用于熔断：写错/恶意的 stop hook 反复 block 会死循环烧 token。
  stopHookBlockingCount?: number
  turnCount: number
  // 上一次迭代继续的原因。第一次迭代时为 undefined。
  // 让测试可以在不检查消息内容的情况下断言恢复路径是否触发。
  transition: Continue | undefined
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 仅在 queryLoop 正常返回时才会到达此处。throw 时跳过（错误
  // 通过 yield* 传播），.return() 时也跳过（Return 完成会关闭
  // 两个生成器）。这与 print.ts 的 drainCommandQueue 在轮次失败时的
  // 信号一样，都是非对称的"已开始但未完成"信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数 — 查询循环期间永远不会重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 跨迭代可变状态。循环体在每次迭代开头解构此状态，
  // 以便读取时保持裸名（`messages`、`toolUseContext`）。
  // 继续点写入 `state = { ... }` 而非 9 个独立赋值。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = createBudgetTracker()

  // 跨压缩边界的 task_budget.remaining 跟踪。第一次压缩触发前为 undefined
  // — 上下文未压缩时，服务器可以看到完整历史并自行处理从 {total} 开始的倒数（见
  // api/api/sampling/prompt/renderer.py:292）。压缩后，服务器只看到摘要，会低估
  // 消耗；remaining 告诉它被摘要抹去的压缩前最终窗口。跨多次压缩累积：每次减去
  // 该压缩触发点的最终上下文。循环局部（不在 State 上）以避免触及 7 个继续点。
  let taskBudgetRemaining: number | undefined

  // 在入口处一次性快照不可变的 env/statsig/session 状态。参见 QueryConfig
  // 了解包含内容以及为什么有意排除 feature() 门控。
  const config = buildQueryConfig()

  // 每次用户轮次触发一次 — 提示词在循环迭代中是不变的，
  // 所以每次迭代触发会让 sideQuery 重复问同一个问题 N 次。
  // 消费点轮询 settledAt（永不阻塞）。`using` 在所有生成器
  // 退出路径上释放 — 参见 MemoryPrefetch 的释放/遥测语义。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(state.messages, state.toolUseContext)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 每次迭代顶部解构状态。仅 toolUseContext 在迭代内重新赋值
    // （queryTracking、消息更新）；其余在继续点之间只读。
    log(
      `turn ${state.turnCount} begin (messages=${state.messages.length}${state.transition ? `, transition=${state.transition.reason}` : ''})`,
    )
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      stopHookBlockingCount,
      turnCount,
    } = state

    // 技能发现预取 — 每次迭代（使用 findWritePivot 守卫
    // 在非写入迭代时提前返回）。发现在模型流式传输和工具执行期间运行；
    // 与内存预取一起在工具后等待消费。替代了之前在
    // getAttachmentMessages 中运行的阻塞 assistant_turn 路径
    // （生产中 97% 的调用什么都没找到）。轮次 0 用户输入发现
    // 仍然阻塞在 userInputAttachments 中 — 这是唯一一个没有
    // 先前工作可以隐藏的信号的信号。
    skillPrefetch?.startSkillDiscoveryPrefetch(messages, turnCount === 0)

    // StreamRequestStartEvent 信号 — 仅用于触发流式请求开始
    yield { type: 'stream_request_start' } as unknown as StreamEvent

    queryCheckpoint('query_fn_entry')

    // 记录查询开始用于无头延迟跟踪（子 agent 跳过）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
      // 启动剖析：主会话首次 query 本地准备起点（与 TTFT 终点 first_token 成对）
      profileCheckpoint('first_query_start')
    }

    // 阶段 2: 消息预处理（query tracking → toolResultBudget → microcompact → contextCollapse）
    const preprocessed = await preprocessMessages(
      messages,
      toolUseContext,
      autoCompactTracking,
      querySource,
      deps,
    )
    let { messagesForQuery } = preprocessed
    const { queryTracking, queryChainIdForAnalytics, pendingCacheEdits } = preprocessed
    let tracking = preprocessed.tracking
    toolUseContext = preprocessed.toolUseContext

    // 阶段 3: 自动压缩
    const compactionGen = runCompaction(
      messagesForQuery,
      toolUseContext,
      tracking,
      { systemPrompt, userContext, systemContext, querySource, taskBudget: params.taskBudget },
      { queryChainId: queryChainIdForAnalytics, queryDepth: queryTracking.depth },
      deps,
    )
    let compactionStep = await compactionGen.next()
    while (!compactionStep.done) {
      yield compactionStep.value
      compactionStep = await compactionGen.next()
    }
    const compactionOutcome = compactionStep.value

    messagesForQuery = compactionOutcome.messagesForQuery
    tracking = compactionOutcome.tracking
    const compactionHappened = compactionOutcome.compacted
    const fullSystemPrompt = compactionOutcome.fullSystemPrompt

    if (params.taskBudget && compactionOutcome.taskBudgetConsumed !== undefined) {
      taskBudgetRemaining = Math.max(
        0,
        (taskBudgetRemaining ?? params.taskBudget.total) - compactionOutcome.taskBudgetConsumed,
      )
    }

    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see https://docs.zy.com/en/docs/build-with-zy/tool-use
    // 注意：stop_reason === 'tool_call' 不可靠 — 它并不总是正确设置。
    // 流式传输期间每当 tool_use 块到达时设置 — 唯一的循环退出信号。
    // 流式传输后如果为 false，我们就完成了（除非 stop-hook 重试）。
    const toolUseBlocks: ToolCallBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(toolUseContext.options.tools, canUseTool, toolUseContext)
      : null

    const appState = toolUseContext.getAppState()
    const _permissionMode = appState.toolPermissionContext.mode
    let currentModel = toolUseContext.options.mainLoopModel

    queryCheckpoint('query_setup_end')

    // 每个查询会话创建一次 fetch 包装器以避免内存保留。
    // 每次调用 createDumpPromptsFetch 都会创建一个捕获请求体的闭包。
    // 只创建一次意味着只保留最新的请求体（约 700KB），
    // 而不是会话中的所有请求体（长会话约 500MB）。
    // 注意：agentId 在 query() 调用期间实际上是常量 — 它只在查询之间变化
    // （例如 /clear 命令或会话恢复）。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 如果我们已达到硬阻塞限制则阻塞（仅在自动压缩关闭时适用）
    // 这保留了空间，以便用户仍然可以手动运行 /compact
    // 如果压缩刚刚发生则跳过此检查 — 压缩结果已经
    // 验证低于阈值，且 tokenCountWithEstimation 会使用
    // 保留消息的陈旧 input_tokens，反映压缩前上下文大小。
    // 还要为 compact/session_memory 查询跳过 — 这些是分叉的 agent，
    // 继承完整对话，如果在这里阻塞会死锁（压缩 agent 需要
    // 运行来减少 token 计数）。
    // 当启用 reactive compact 且允许自动压缩时也跳过 —
    // preempt 的合成错误在 API 调用之前返回，所以 reactive compact
    // 永远不会看到 prompt-too-long 来响应。
    // 扩大到 walrus 以便 RC 可以在 proactive 失败时作为后备。
    //
    // context-collapse 同样跳过：其 recoverFromOverflow 在真正的
    // API 413 上排出暂存折叠，然后落入 reactiveCompact。这里的
    // 合成 preempt 会在 API 调用之前返回并饿死两条恢复路径。
    // isAutoCompactEnabled() 合取保留了用户显式"不要自动做任何事"
    // 配置 — 如果他们设置了 DISABLE_AUTO_COMPACT，他们会得到 preempt。
    const collapseOwnsIt =
      (contextCollapse?.isContextCollapseEnabled() ?? false) && isAutoCompactEnabled()
    // 每个轮次提升一次媒体恢复门控。扣留（在流循环内）
    // 和恢复（之后）必须一致；CACHED_MAY_BE_STALE 可以在
    // 5-30s 流期间翻转，扣留而不恢复会吞掉消息。PTL 不提升
    // 因为其扣留是无门控的 — 它早于实验且已是对照臂基线。
    const mediaRecoveryEnabled = reactiveCompact?.isReactiveCompactEnabled() ?? false
    const querySourceName: string = querySource
    if (
      !compactionHappened &&
      querySourceName !== 'compact' &&
      querySourceName !== 'session_memory' &&
      !(reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery),
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          log(
            `model stream start turn=${turnCount} signalAborted=${toolUseContext.abortController.signal.aborted} abortReason=${String(toolUseContext.abortController.signal.reason ?? 'none')}`,
          )
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              toolChoice: undefined,
              isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes: toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt: !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some((c) => c.type === 'pending'),
              queryTracking,
              effortValue: appState.effortValue,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // 我们不会使用第一次尝试的 tool_calls
            // 我们可以.. 但那样我们必须合并不同 id 的助手消息
            // 并重复完整的 tool_results
            if (streamingFallbackOccured) {
              // 为孤立消息产生 tombstone 以便它们从 UI 和转录中移除。
              // 这些部分消息（尤其是 thinking 块）有无效签名，
              // 会导致 "thinking blocks cannot be modified" API 错误。
              for (const msg of assistantMessages) {
                yield {
                  type: 'system',
                  subtype: 'tombstone',
                  content: '',
                  message: msg,
                  uuid: msg.uuid,
                  timestamp: msg.timestamp,
                } as TombstoneMessage
              }
              logEvent('zy_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃失败流式传输尝试的待处理结果并创建新的执行器。
              // 这可以防止孤立 tool_results（带有旧 tool_use_ids）
              // 在 fallback 响应到达后被产生。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在产生之前在克隆消息上回填 tool_use 输入，以便
            // SDK 流式输出和转录序列化看到遗留/派生字段。
            // 原始 `message` 保持不动用于下面的 assistantMessages.push —
            // 它流回 API，修改它会破坏提示缓存（字节不匹配）。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: AssistantContentBlock[] | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                // 类型守卫：确保 block 不是 string 类型
                if (typeof block !== 'string' && block.type === 'tool_call') {
                  if (typeof block.input === 'object' && block.input !== null) {
                    const tool = findToolByName(toolUseContext.options.tools, block.name)
                    if (tool?.backfillObservableInput) {
                      const originalInput = block.input as Record<string, unknown>
                      const inputCopy = { ...originalInput }
                      tool.backfillObservableInput(inputCopy)
                      // 仅在回填添加了字段时才产生克隆；
                      // 如果只覆盖了现有字段则跳过（例如文件工具扩展 file_path）。
                      // 覆盖会改变序列化的转录并在恢复时破坏 VCR 夹具哈希，
                      // 同时没有为 SDK 流添加任何东西 — 钩子通过 toolExecution.ts 单独获取扩展路径。
                      const addedFields = Object.keys(inputCopy).some((k) => !(k in originalInput))
                      if (addedFields) {
                        const content = message.message.content
                        clonedContent ??= Array.isArray(content)
                          ? content.filter((b): b is AssistantContentBlock => typeof b !== 'string')
                          : []
                        clonedContent[i] = { ...block, input: inputCopy }
                      }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 扣留可恢复错误（prompt-too-long、max-output-tokens）
            // 直到我们知道恢复（collapse 排出 / reactive compact / 截断重试）
            // 是否能成功。仍然推送到 assistantMessages 以便下面的
            // 恢复检查可以找到它们。任一子系统的扣留都足够了 —
            // 它们是独立的，所以关闭一个不会破坏另一个的恢复路径。
            let withheld = false
            if (
              contextCollapse?.isWithheldPromptTooLong(message, isPromptTooLongMessage, querySource)
            ) {
              withheld = true
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (mediaRecoveryEnabled && reactiveCompact?.isWithheldMediaSizeError(message)) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              log(
                `assistant received turn=${turnCount} request=${message.requestId ?? 'unknown'} blocks=${message.message.content.map((block) => (typeof block === 'string' ? 'string' : block.type)).join(',')} stop=${message.message.stopReason ?? 'unknown'} signalAborted=${toolUseContext.abortController.signal.aborted}`,
              )
              assistantMessages.push(message)

              // 类型守卫：确保 content 是数组
              const content = message.message.content
              const msgToolUseBlocks = Array.isArray(content)
                ? content.filter(
                    (block): block is ToolCallBlock =>
                      typeof block !== 'string' && block.type === 'tool_call',
                  )
                : []
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter((_) => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')
          log(
            `model stream end turn=${turnCount} assistantMessages=${assistantMessages.length} toolUses=${toolUseBlocks.length} needsFollowUp=${needsFollowUp} signalAborted=${toolUseContext.abortController.signal.aborted} abortReason=${String(toolUseContext.abortController.signal.reason ?? 'none')}`,
          )
          // 本轮 API 成功：清零该候选的连续失效计数
          noteAuthChainSuccess(currentModel)

          // 使用实际 API 报告的 token 删除计数（而非客户端估算）
          // 产生延迟的 microcompact 边界消息。
          // 整个块由 feature() 门控，所以排除的字符串在外部构建中被消除。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // API 字段跨请求是累积/粘性的，所以我们
            // 减去此请求之前捕获的基线来获取增量。
            const usage = lastAssistant?.message.usage
            // 内存侧 camel：cacheDeletedInputTokens（wire 转换层已规范化）
            const cumulativeDeleted = usage
              ? ((usage as { cacheDeletedInputTokens?: number }).cacheDeletedInputTokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // Fallback 被触发 — 切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 清除助手消息，因为我们将重试整个请求
            yield* yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试的待处理结果并创建新的执行器。
            // 这可以防止孤立 tool_results（带有旧 tool_use_ids）
            // 泄漏到重试中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新模型更新工具使用上下文
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking 签名与模型绑定：将受保护 thinking 块
            // （例如 capybara）重播到不受保护的 fallback（例如 opus）会 400。
            // 在重试前剥离，以便 fallback 模型获得干净的历史。
            if (isInternalBuild()) {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // 记录 fallback 事件
            logEvent('zy_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // 产生关于 fallback 的系统消息 — 使用 'warning' 级别
            // 以便用户无需 verbose 模式就能看到通知。
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warn',
            )

            continue
          }

          // 多 auth 候选链：同候选 withRetry 耗尽后，推进 sticky 并换通道
          const previousModel = currentModel
          const authFailover = tryAdvanceAuthChainOnError(previousModel, innerError)
          if (authFailover) {
            const nextModel = authFailover.next.model
            currentModel = nextModel
            attemptWithFallback = true

            yield* yieldMissingToolResultBlocks(assistantMessages, 'Auth chain failover triggered')
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            toolUseContext.options.mainLoopModel = nextModel
            if (isInternalBuild()) {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            logEvent('zy_model_auth_failover', {
              original_model:
                previousModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              next_model: nextModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              reason:
                authFailover.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              from_index: authFailover.fromIndex,
              to_index: authFailover.toIndex,
              tier: authFailover.tier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            const reasonLabel = tSync(`modelFailover.reason.${authFailover.reason}`)
            const toLabel = authFailover.next.provider
              ? `${renderModelName(nextModel)} (${authFailover.next.provider})`
              : renderModelName(nextModel)
            yield createSystemMessage(
              tSync('modelFailover.switched', {
                from: renderModelName(previousModel),
                to: toLabel,
                provider: authFailover.next.provider ?? '',
                reason: reasonLabel,
              }),
              'warn',
            )

            continue
          }

          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(
        `model stream failed turn=${turnCount} error=${errorMessage} assistantMessages=${assistantMessages.length} toolUses=${toolUseBlocks.length} signalAborted=${toolUseContext.abortController.signal.aborted} abortReason=${String(toolUseContext.abortController.signal.reason ?? 'none')}`,
        { level: 'error' },
      )
      logEvent('zy_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap((_) => {
          const content = _.message.content
          return Array.isArray(content)
            ? content.filter(
                (block): block is ToolCallBlock =>
                  typeof block !== 'string' && block.type === 'tool_call',
              )
            : []
        }).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 使用用户友好的消息处理图像大小/调整错误
      if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 通常 queryModelWithStreaming 不应抛出错误，而应将它们作为
      // 合成助手消息产生。但如果由于 bug 它确实抛出，我们可能
      // 已经进入了一个状态：已经产生了 tool_use 块但会在产生
      // tool_result 之前停止。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 暴露真实错误而非误导性的 "[Request interrupted by user]" —
      // 此路径是模型/运行时故障，而非用户操作。
      // SDK 消费者在例如 Node 18 缺少数组 Array.prototype.with() 时
      // 看到幻影中断，掩盖了实际原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为了帮助追踪 bug，为 ants 大声记录
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 在模型响应完成后执行采样后钩子
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 我们需要在处理任何其他事情之前处理流式中止。
    // 使用 streamingToolExecutor 时，我们必须消费 getRemainingResults() 以便
    // 执行器可以为排队/进行中的工具生成合成 tool_result 块。
    // 否则，tool_use 块将缺少匹配的 tool_result 块。
    if (toolUseContext.abortController.signal.aborted) {
      log(
        `terminating after model stream turn=${turnCount} reason=aborted_streaming abortReason=${String(toolUseContext.abortController.signal.reason ?? 'none')} assistantMessages=${assistantMessages.length} toolUses=${toolUseBlocks.length}`,
        { level: 'warn' },
      )
      if (streamingToolExecutor) {
        // 消费剩余结果 — 执行器为中止的工具生成合成 tool_results，
        // 因为它在 executeTool() 中检查中止信号
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(assistantMessages, 'Interrupted by user')
      }
      // chicago MCP：中断时自动取消隐藏 + 释放锁。
      // 与 stopHooks.ts 中的自然轮次结束路径相同的清理。
      // 仅主线程 — 参见 stopHooks.ts 关于子 agent 释放主线程锁的理由。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            '../services/computer-use/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败是静默的 — 这是实验性清理，不是关键路径
        }
      }

      // 为提交中断跳过中断消息 — 随后的排队
      // 用户消息提供足够的上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 产生上一轮次的工具使用摘要 — haiku（约 1 秒）在模型流式传输期间（5-30 秒）已解决
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long 恢复：流式循环扣留了错误
      // （见上面的 withheldByCollapse / withheldByReactive）。先尝试 collapse
      // 排出（便宜，保持粒度上下文），然后 reactive compact
      // （完整摘要）。每次单次 — 如果重试仍然 413，
      // 下一阶段处理或错误浮现。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // 媒体大小拒绝（图像/PDF/多图像）可通过 reactive compact
      // 的 strip-retry 恢复。与 PTL 不同，媒体错误跳过 collapse
      // 排出 — collapse 不剥离图像。mediaRecoveryEnabled 是流循环
      // 之前提升的门控（与扣留检查相同的值 — 这两个必须一致，
      // 否则扣留的消息会丢失）。如果超大媒体在受保护尾部中，
      // 压缩后轮次将再次媒体错误；hasAttemptedReactiveCompact
      // 防止螺旋并让错误浮现。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        lastMessage !== undefined &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 首先：排出所有暂存的上下文折叠。门控在前一个
        // 转换不是 collapse_drain_retry — 如果我们已经排出
        // 且重试仍然 413，则落入 reactive compact。
        if (contextCollapse && state.transition?.reason !== 'collapse_drain_retry') {
          const drained = await contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget：与上面的主动路径相同的携带。
          // messagesForQuery 在这里仍然持有压缩前数组
          // （413 失败尝试的输入）。
          if (params.taskBudget) {
            const preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
            )
          }

          // 压缩会替换掉 transcript 中所有带 usage 的旧 assistant 消息，
          // resume 时的兜底恢复（reconstructCostStateFromMessages）将无源
          // 可重建 → 会话 cost 归零。压缩成功即持久化当前累计值
          //（sidecar + sessionCosts），使恢复优先读取持久化值。
          saveCurrentSessionCosts()

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 无法恢复 — 暴露扣留的错误并退出。不要
        // 落入 stop hooks：模型从未产生有效响应，
        // 所以钩子没有有意义的东西可以评估。在 prompt-too-long
        // 上运行 stop hooks 会产生死亡螺旋：错误 → 钩子阻塞
        // → 重试 → 错误 → …（钩子每轮注入更多 token）。
        yield lastMessage!
        void executeStopFailureHooks(lastMessage!, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (isWithheld413) {
        // reactiveCompact 已编译掉但 contextCollapse 扣留了且
        // 无法恢复（暂存队列空/陈旧）。暴露。相同的
        // 提前返回理由 — 不要落入 stop hooks。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 检查 max_output_tokens 并注入恢复消息。错误
      // 在上面已从流中扣留；仅在恢复耗尽时才暴露。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级重试：如果我们使用了封顶的 8k 默认值并触及了
        // 限制，用 64k 重试相同的请求 — 没有 meta 消息，没有
        // 多轮处理。这每轮触发一次（由 override 检查守卫），
        // 然后如果 64k 也触及上限则落入多轮恢复。
        // 第三方默认值：false（未在 Bedrock/Vertex 上验证）
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_otk_slot_v1', false)
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.ZY_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('zy_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content: [
              {
                type: 'text' as const,
                text:
                  `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
                  `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
              },
            ],
            isMeta: true,
          })

          const next: State = {
            messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复耗尽 — 现在暴露扣留的错误。
        yield lastMessage
      }

      // 当最后一条消息是 API 错误时跳过 stop hooks（速率限制、
      // prompt-too-long、认证失败等）。模型从未产生
      // 真实响应 — 评估它的钩子会产生死亡螺旋：
      // 错误 → 钩子阻塞 → 重试 → 错误 → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      // 记录不完整响应（服务器错误但保留了部分内容）
      if (lastMessage?.type === 'assistant' && lastMessage.message.incomplete) {
        log(`Incomplete response received — model returned partial content before server error`)
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        // 连续 block 熔断：写错/恶意的 stop hook 反复 block 会让会话死循环烧
        // token。计数从 1 起算，到第 cap+1 次强制结束 turn（reason:'completed'，
        // 不抛错，防止把整个 session 干崩）。ZY_CODE_STOP_HOOK_BLOCK_CAP 覆盖
        // 默认 8；设为 0 禁用熔断（兼容老行为）。对齐 Claude Code 2.1.143。
        const { nextCount: nextBlockCount, tripped } =
          evaluateStopHookBlockCap(stopHookBlockingCount)
        if (tripped) {
          logEvent('zy_stop_hook_block_count', {
            count: nextBlockCount,
            is_subagent: Boolean(toolUseContext.agentId),
            hit_cap: true,
          })
          yield createSystemMessage(
            `A hook blocked the turn from ending ${nextBlockCount} consecutive times — overriding and ending turn. ` +
              `For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. ` +
              `Set ZY_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.`,
            'warn',
          )
          return { reason: 'completed' }
        }
        const next: State = {
          messages: [...messagesForQuery, ...assistantMessages, ...stopHookResult.blockingErrors],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留 reactive compact 守卫 — 如果 compact 已经运行且
          // 无法从 prompt-too-long 恢复，在 stop-hook 阻塞错误后
          // 重试会产生相同结果。这里重置为 false 会导致无限循环：
          // compact → 仍然太长 → 错误 → stop hook 阻塞 → compact → …
          // 燃烧数千个 API 调用。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          stopHookBlockingCount: nextBlockCount,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      const budgetDecision = checkTokenBudget(
        budgetTracker,
        toolUseContext.agentId,
        getCurrentTurnTokenBudget(),
        getTurnOutputTokens(),
      )

      if (budgetDecision.action === 'continue') {
        incrementBudgetContinuationCount()
        log(
          `Token budget continuation #${budgetDecision.continuationCount}: ${budgetDecision.pct}% (${budgetDecision.turnTokens.toLocaleString()} / ${budgetDecision.budget.toLocaleString()})`,
        )
        state = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            createUserMessage({
              content: [{ type: 'text' as const, text: budgetDecision.nudgeMessage }],
              isMeta: true,
            }),
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: undefined,
          turnCount,
          transition: { reason: 'token_budget_continuation' },
        }
        continue
      }

      if (budgetDecision.completionEvent) {
        if (budgetDecision.completionEvent.diminishingReturns) {
          log(
            `Token budget early stop: diminishing returns at ${budgetDecision.completionEvent.pct}%`,
          )
        }
        logEvent('zy_token_budget_completed', {
          ...budgetDecision.completionEvent,
          queryChainId: queryChainIdForAnalytics,
          queryDepth: queryTracking.depth,
        })
      }

      log(`turn ${turnCount} completed (no pending tool use)`)
      return { reason: 'completed' }
    }

    // 阶段 9: 工具执行 + PostToolBatch + 工具摘要生成
    const toolExecGen = executeToolsAndBatch(
      toolUseBlocks,
      assistantMessages,
      toolResults,
      canUseTool,
      toolUseContext,
      streamingToolExecutor,
      queryTracking,
      config,
    )
    let toolExecStep = await toolExecGen.next()
    while (!toolExecStep.done) {
      yield toolExecStep.value
      toolExecStep = await toolExecGen.next()
    }
    const toolExecResult = toolExecStep.value
    const { shouldPreventContinuation, nextPendingToolUseSummary } = toolExecResult
    let updatedToolUseContext = toolExecResult.updatedToolUseContext
    const updatedToolResults = toolExecResult.toolResults
    toolResults.length = 0
    toolResults.push(...updatedToolResults)

    // 我们在工具调用期间被中止
    if (toolUseContext.abortController.signal.aborted) {
      // 双重保险：只有"已知的 user-driven 中断 reason"才结束 turn。
      // 配合 StreamingToolExecutor 的白名单冒泡机制，避免 GC race 等
      // 隐式 abort（reason=undefined）导致 turn 被静默结束。
      // 已知的合法中断 reason（与 StreamingToolExecutor 的白名单保持一致）：
      //   - 'interrupt': 用户在 REPL 中按 ESC / 发送 'now' 优先级新消息
      //   - 'user_rejected_permission': 用户在权限对话框中拒绝
      //   - 'hook_interrupt': PermissionRequest hook 返回 decision.interrupt
      //   - 'sigint': cli/print.ts 收到 SIGINT 信号
      //   - 'end_session': SDK end_session 控制消息
      const abortReason = toolUseContext.abortController.signal.reason
      log(
        `terminating after tools turn=${turnCount} reason=aborted_tools abortReason=${String(abortReason ?? 'none')} toolResults=${toolResults.length}`,
        { level: 'warn' },
      )
      const isKnownUserAbort =
        abortReason === 'interrupt' ||
        abortReason === 'user_rejected_permission' ||
        abortReason === 'hook_interrupt' ||
        abortReason === 'sigint' ||
        abortReason === 'end_session'
      if (!isKnownUserAbort) {
        // 非预期的 abort（很可能是 GC race / WeakRef propagateAbort 残留）。
        // 记录诊断信息但不结束 turn——清掉 aborted 标记是不可能的（AbortSignal 不可逆），
        // 但我们可以选择不响应这个 abort，让循环继续。
        log(
          `Ignoring spurious abort with unknown reason: ${String(abortReason)} (turnCount=${turnCount}). ` +
            `This is likely a GC race in createChildAbortController and not a real user interrupt.`,
          { level: 'warn' },
        )
        // 由于 abortController 已经 aborted 且不可重置，我们需要为后续 turn
        // 创建一个新的 AbortController 来取代它。这里直接 yield 一条系统消息
        // 告知用户发生了什么，然后结束当前 turn（避免下游工具拿到坏 signal）。
        yield createUserInterruptionMessage({
          toolUse: true,
        })
        return { reason: 'aborted_tools' }
      }

      // chicago MCP：在工具调用中间被中止时自动取消隐藏 + 释放锁。
      // 这是 CU 最可能的 Ctrl+C 路径（例如慢速截图）。
      // 仅主线程 — 参见 stopHooks.ts 关于子 agent 的理由。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            '../services/computer-use/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败是静默的 — 这是实验性清理，不是关键路径
        }
      }
      // 为提交中断跳过中断消息 — 随后的排队
      // 用户消息提供足够的上下文。
      if (abortReason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 检查 maxTurns 再在 abort 时返回
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果钩子指示阻止继续，在此停止
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('zy_post_autocompact_turn', {
        turnId: tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 阶段 11: 附件注入 + 队列消费 + 工具刷新 + 任务摘要
    const attachGen = injectAttachments(
      messagesForQuery,
      assistantMessages,
      toolResults,
      toolUseBlocks,
      updatedToolUseContext,
      queryTracking,
      querySource,
      { systemPrompt, userContext, systemContext },
    )
    let attachStep = await attachGen.next()
    while (!attachStep.done) {
      yield attachStep.value
      attachStep = await attachGen.next()
    }
    const attachResult = attachStep.value
    toolResults.length = 0
    toolResults.push(...attachResult.toolResults)
    updatedToolUseContext = attachResult.updatedToolUseContext
    for (const uuid of attachResult.consumedCommandUuids) {
      consumedCommandUuids.push(uuid)
    }

    // Memory prefetch 消费（依赖 loop-scoped using 变量，保留在 query.ts）
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    const nextTurnCount = turnCount + 1

    // 检查是否已达到最大轮次限制
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    log(
      `continue next turn from=${turnCount} to=${nextTurnCount} assistantMessages=${assistantMessages.length} toolResults=${toolResults.length} signalAborted=${updatedToolUseContext.abortController.signal.aborted} abortReason=${String(updatedToolUseContext.abortController.signal.reason ?? 'none')}`,
    )
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
