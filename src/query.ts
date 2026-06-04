// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { evaluateStopHookBlockCap, isInternalBuild } from './utils/envUtils.js'
import type {
  ToolResultBlock,
  ToolCallBlock,
  AssistantContentBlock,
  TextBlock,
} from './types/llm.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE, isPromptTooLongMessage } from './services/api/errors.js'
import { createDebugLog, logAntError } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const _jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { renderModelName } from './services/model/model.js'
import { finalContextTokensFromLastResponse, tokenCountWithEstimation } from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getSessionId,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { executePostToolBatchHooks } from './utils/hooks/executors/tool.js'
import { hasHookForEvent } from './utils/hooks/matcher.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

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
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

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
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    const pendingSkillPrefetch = (skillPrefetch as any)?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    // StreamRequestStartEvent 信号 — 仅用于触发流式请求开始
    yield { type: 'stream_request_start' } as unknown as StreamEvent

    queryCheckpoint('query_fn_entry')

    // 记录查询开始用于无头延迟跟踪（子 agent 跳过）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增查询链跟踪
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 对聚合工具结果大小强制执行每条消息预算。在
    // microcompact 之前运行 — 缓存 MC 纯粹按 tool_use_id 运行（从不检查
    // 内容），所以内容替换对它不可见，两者可以干净地组合。
    // 当 contentReplacementState 为 undefined 时（功能关闭）无操作。
    // 仅为恢复时回读记录的 querySource 持久化：agentId
    // 路由到侧链文件（AgentTool 恢复）或会话文件（/resume）。
    // 临时的 runForkedAgent 调用者（agent_summary 等）不持久化。
    const persistReplacements =
      querySource.startsWith('agent:') || querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? (records) =>
            void recordContentReplacement(records, toolUseContext.agentId).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter((t) => !Number.isFinite(t.maxResultSizeChars))
          .map((t) => t.name),
      ),
    )

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对于缓存 microcompact（缓存编辑），将边界消息延迟到
    // API 响应之后，以便我们可以使用实际的 cache_deleted_input_tokens。
    // 由 feature() 门控，所以该字符串在外部构建中被消除。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投射折叠的上下文视图并提交更多折叠。
    // 在 autocompact 之前运行，以便如果折叠让我们低于
    // autocompact 阈值，autocompact 是无操作，我们保持粒度
    // 上下文而不是单个摘要。
    //
    // 不产生任何内容 — 折叠视图是对 REPL 完整历史的
    // 读取时投影。摘要消息存在于折叠存储中，而不是 REPL 数组中。
    // 这就是折叠跨轮次持久的原因：projectView() 在每次入口时
    // 重放提交日志。在轮次内，视图通过 continue 点的
    // state.messages 向前流动（query.ts:1192），下一次 projectView()
    // 无操作是因为归档消息已从输入中消失。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      const collapseResult = await (contextCollapse as any).applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      messagesForQuery = (collapseResult as any).messages
    }

    const fullSystemPrompt = asSystemPrompt(appendSystemContext(systemPrompt, systemContext))

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      log(
        `autocompact triggered: ${preCompactTokenCount} -> ${postCompactTokenCount} tokens (true=${truePostCompactTokenCount})`,
      )
      logEvent('zy_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.inputTokens,
        compactionOutputTokens: compactionUsage?.outputTokens,
        compactionCacheReadTokens: compactionUsage?.cacheReadInputTokens ?? 0,
        compactionCacheCreationTokens: compactionUsage?.cacheCreationInputTokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.inputTokens +
            (compactionUsage.cacheCreationInputTokens ?? 0) +
            (compactionUsage.cacheReadInputTokens ?? 0) +
            compactionUsage.outputTokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget：在 messagesForQuery 被下面的 postCompactMessages 替换之前
      // 捕获压缩前最终上下文窗口。
      // iterations[-1] 是权威的最终窗口（服务器工具循环后）；见 #304930。
      if (params.taskBudget) {
        const preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次压缩都重置，以便 turnCounter/turnId 反映最近的压缩。
      // recompactionInfo（autoCompact.ts:190）已在调用前捕获了
      // turnsSincePreviousCompact/previousCompactTurnId 的旧值，所以
      // 此重置不会丢失它们。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 使用压缩后消息继续当前查询调用
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact 失败 — 传播失败计数以便断路器
      // 可以在下次迭代时停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    //TODO: 设置期间无需设置 toolUseContext.messages，因为它会在这里更新
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
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) && isAutoCompactEnabled()
    }
    // 每个轮次提升一次媒体恢复门控。扣留（在流循环内）
    // 和恢复（之后）必须一致；CACHED_MAY_BE_STALE 可以在
    // 5-30s 流期间翻转，扣留而不恢复会吞掉消息。PTL 不提升
    // 因为其扣留是无门控的 — 它早于实验且已是对照臂基线。
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    const mediaRecoveryEnabled = (reactiveCompact as any)?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      (querySource as any) !== 'compact' &&
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      (querySource as any) !== 'session_memory' &&
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      !((reactiveCompact as any)?.isReactiveCompactEnabled() && isAutoCompactEnabled()) &&
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
              advisorModel: appState.advisorModel,
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
            //
            // feature() 仅适用于 if/三元条件（bun:bundle tree-shaking 约束），
            // 所以 collapse 检查是嵌套的而不是组合的。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                (contextCollapse as any)?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
            if ((reactiveCompact as any)?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
              (reactiveCompact as any)?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
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

          // 使用实际 API 报告的 token 删除计数（而非客户端估算）
          // 产生延迟的 microcompact 边界消息。
          // 整个块由 feature() 门控，所以排除的字符串在外部构建中被消除。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // API 字段跨请求是累积/粘性的，所以我们
            // 减去此请求之前捕获的基线来获取增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>).cache_deleted_input_tokens ?? 0)
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
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage = error instanceof Error ? error.message : String(error)
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
          const { cleanupComputerUseAfterTurn } = await import('./services/computerUse/cleanup.js')
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
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        mediaRecoveryEnabled && (reactiveCompact as any)?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 首先：排出所有暂存的上下文折叠。门控在前一个
        // 转换不是 collapse_drain_retry — 如果我们已经排出
        // 且重试仍然 413，则落入 reactive compact。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
          const drained = (contextCollapse as any).recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
          if ((drained as any).committed > 0) {
            const next: State = {
              // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
              messages: (drained as any).messages,
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
                // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
                committed: (drained as any).committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        const compacted = await (reactiveCompact as any).tryReactiveCompact({
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
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
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

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          log(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: [{ type: 'text' as const, text: decision.nudgeMessage }],
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

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            log(`Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`)
          }
          logEvent('zy_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      log(`turn ${turnCount} completed (no pending tool use)`)
      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')

    if (streamingToolExecutor) {
      logEvent('zy_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('zy_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools).filter(
            (_) => _.type === 'user',
          ),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // PostToolBatch：一轮工具全部完成后触发一次（各工具 PostToolUse 之后），避免并行
    // 工具调用的 N+1 hook 抖动。先 hasHookForEvent 短路，未配置时近零开销。
    if (
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      hasHookForEvent(
        'PostToolBatch',
        updatedToolUseContext.getAppState(),
        updatedToolUseContext.agentId ?? getSessionId(),
      )
    ) {
      const batchToolUses = toolUseBlocks.map((block) => {
        const resultMsg = toolResults.find(
          (r) =>
            r.type === 'user' &&
            Array.isArray(r.message.content) &&
            r.message.content.some((c) => c.type === 'tool_result' && c.toolCallId === block.id),
        )
        const resultBlock =
          resultMsg?.type === 'user' && Array.isArray(resultMsg.message.content)
            ? resultMsg.message.content.find(
                (c): c is ToolResultBlock => c.type === 'tool_result' && c.toolCallId === block.id,
              )
            : undefined
        return {
          tool_name: block.name,
          tool_use_id: block.id,
          status: (resultBlock?.isError ? 'error' : 'success') as 'success' | 'error',
        }
      })
      for await (const update of executePostToolBatchHooks(batchToolUses, updatedToolUseContext)) {
        yield update.message
        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }
        toolResults.push(
          ...normalizeMessagesForAPI([update.message], updatedToolUseContext.options.tools).filter(
            (_) => _.type === 'user',
          ),
        )
      }
    }

    // 在工具调用完成后生成工具使用摘要 — 传递给下一次递归调用
    let nextPendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // 子 agent 不显示在移动 UI 中 — 跳过 Haiku 调用
    ) {
      // 提取最后的助手文本块用于上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const content = lastAssistantMessage.message.content
        const textBlocks = Array.isArray(content)
          ? content.filter(
              (block): block is TextBlock => typeof block !== 'string' && block.type === 'text',
            )
          : []
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集工具信息用于摘要生成
      const toolUseIds = toolUseBlocks.map((block) => block.id)
      const toolInfoForSummary = toolUseBlocks.map((block) => {
        // 查找对应的工具结果
        const toolResult = toolResults.find(
          (result) =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              (content) => content.type === 'tool_result' && content.toolCallId === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' && Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlock => c.type === 'tool_result' && c.toolCallId === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output: resultContent && 'content' in resultContent ? resultContent.content : null,
        }
      })

      // 启动摘要生成而不阻塞下一个 API 调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then((summary) => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

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
          const { cleanupComputerUseAfterTurn } = await import('./services/computerUse/cleanup.js')
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

    // 在工具调用完成后小心地执行此操作，因为 API
    // 会在我们交错 tool_result 消息和普通用户消息时报错。

    //  instrumentation：跟踪附件前的消息计数
    logEvent('zy_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理附件前获取排队命令快照。
    // 这些将作为附件发送，以便 Zy 可以在当前轮次中响应它们。
    //
    // 排出待处理通知。LocalShellTask 完成是 'next'
    // （当 MONITOR_TOOL 开启时）并在没有 Sleep 的情况下排出。
    // 其他任务类型（agent/workflow/framework）仍然默认为 'later' —
    // Sleep 刷新覆盖这些。如果所有任务类型都移到 'next'，
    // 这个分支可以去掉。
    //
    // 斜杠命令被排除在轮次中排出之外 — 它们必须在轮次结束后
    // 通过 processSlashCommand（通过 useQueueProcessor）处理，
    // 而不是作为文本发送给模型。Bash 模式命令已经被
    // getQueuedCommandAttachments 中的 INLINE_NOTIFICATION_MODES 排除。
    //
    // Agent 范围：队列是进程全局单例，由协调器和
    // 所有进程内子 agent 共享。每个循环只排出
    // 发给它的内容 — 主线程排出 agentId===undefined，
    // 子 agent 排出它们自己的 agentId。用户提示（mode:'prompt'）
    // 仍然只去主线程；子 agent 永远不会看到提示流。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolCallBlock.name has no aliases
    const sleepRan = toolUseBlocks.some((b) => b.name === SLEEP_TOOL_NAME)
    const isMainThread = querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(sleepRan ? 'later' : 'next').filter(
      (cmd) => {
        if (isSlashCommand(cmd)) {
          return false
        }
        if (isMainThread) {
          return cmd.agentId === undefined
        }
        // 子 agent 只排出发给它们的任务通知 — 永远不要
        // 用户提示，即使有人在上面盖了 agentId。
        return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
      },
    )

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 内存预取消费：仅在已解决且未在
    // 更早的迭代中消费时。如果尚未解决，跳过（零等待）
    // 并在下次迭代重试 — 预取在轮次结束前有
    // 多次循环迭代的机会。readFileState（跨迭代累积）
    // 过滤掉模型已经 Read/Wrote/Edited 的内存 —
    // 包括在更早的迭代中，这是每次迭代的
    // toolUseBlocks 数组会错过的。
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

    // 注入预取的技能发现。collectSkillDiscoveryPrefetch 发出
    // hidden_by_main_turn — true 当预取在此点之前解决时
    // （应该 >98%，AKI@250ms / Haiku@573ms 对比 2-30s 的轮次时长）。
    if (skillPrefetch && pendingSkillPrefetch) {
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      const skillAttachments = await (skillPrefetch as any).collectSkillDiscoveryPrefetch(
        pendingSkillPrefetch,
      )
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 只移除实际作为附件消费的命令。
    // 提示和任务通知命令在上面被转换为附件。
    const consumedCommands = queuedCommandsSnapshot.filter(
      (cmd) => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // instrumentation：跟踪文件更改附件
    const fileChangeAttachmentCount = count(
      toolResults,
      (tr) => tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('zy_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在轮次之间刷新工具，以便新连接的 MCP 服务器可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每次我们有工具结果且即将递归时，就是一个轮次
    const nextTurnCount = turnCount + 1

    // `zy ps` 的定期任务摘要 — 在轮次中触发，以便
    // 长时间运行的 agent 仍然刷新它正在处理的内容。仅门控
    // 于 !agentId，所以每个顶级对话（REPL、SDK、HFI、
    // remote）都生成摘要；子 agent/分叉不生成。
    if (feature('BG_SESSIONS')) {
      if (!toolUseContext.agentId && taskSummaryModule!.shouldGenerateTaskSummary()) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [...messagesForQuery, ...assistantMessages, ...toolResults],
        })
      }
    }

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
