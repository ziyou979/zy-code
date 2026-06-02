import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { getMainLoopModel } from '../../services/model/model.js'
import { SHELL_TOOL_NAMES } from '../../shell-eval/shared/shellToolUtils.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import { clearCompactWarningSuppression, suppressCompactWarning } from './compactWarningState.js'
import { getTimeBasedMCConfig, type TimeBasedMCConfig } from './timeBasedMCConfig.js'

// 从 utils/toolResultStorage.ts 内联——导入该文件会拉入
// sessionStorage → utils/messages → services/api/errors，经 promptCacheBreakDetection
// 回到本文件形成循环依赖。通过测试断言与源头相等来捕获漂移。
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

const IMAGE_MAX_TOKEN_SIZE = 2000

// 仅压缩以下工具
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// --- 缓存式微压缩状态（仅内部构建，受 feature('CACHED_MICROCOMPACT') 门控）---

// 懒加载缓存 MC 模块和状态，避免在外部构建中导入。
// 导入和状态位于 feature() 检查内，用于死代码消除。
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits: import('./cachedMicrocompact.js').CacheEditsBlock | null = null

async function getCachedMCModule(): Promise<typeof import('./cachedMicrocompact.js')> {
  if (!cachedMCModule) {
    cachedMCModule = await import('./cachedMicrocompact.js')
  }
  return cachedMCModule
}

function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error('cachedMCState not initialized — getCachedMCModule() must be called first')
  }
  return cachedMCState
}

/**
 * 获取待包含在下次 API 请求中的新待处理缓存编辑。
 * 无新待处理编辑时返回 null。
 * 清除待处理状态（调用方必须在插入后执行 pin）。
 */
export function consumePendingCacheEdits():
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

/**
 * 获取所有已 pin 的缓存编辑，这些编辑必须在其原始位置重新发送以命中缓存。
 */
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return (cachedMCState as any).pinnedEdits
}

/**
 * 将新的 cache_edits 块 pin 到特定的用户消息位置。
 * 在插入新编辑后调用，使其在后续请求中被重新发送。
 */
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock,
): void {
  if (cachedMCState) {
    ;(cachedMCState as any).pinnedEdits.push({ userMessageIndex, block })
  }
}

/**
 * 将所有已注册工具标记为已发送至 API。
 * 在成功的 API 响应后调用。
 */
export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

// 辅助函数：计算工具结果 token 数
function calculateToolResultTokens(block: ToolResultBlock): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // TextBlock | ImageBlock | DocumentBlock 数组
  return block.content.reduce((sum, item) => {
    if ((item as any).type === 'text') {
      return sum + roughTokenCountEstimation((item as any).text)
    } else if ((item as any).type === 'image' || (item as any).type === 'document') {
      // 图片/文档无论格式约为 2000 token
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

/**
 * 通过提取文本内容估算消息的 token 数。
 * 在没有准确 API 计数时用于粗略 token 估算。
 * 估算结果乘以 4/3 以保守计算。
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        // 与 roughTokenCountEstimationForBlock 一致：仅统计 thinking 文本，
        // 不含 JSON 包装器或 signature（signature 是元数据，非模型 token 化内容）。
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_call') {
        // 与 roughTokenCountEstimationForBlock 一致：统计 name + input，
        // 不含 JSON 包装器或 id 字段。
        totalTokens += roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}))
      } else {
        // server_tool_use、web_search_tool_result 等
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  // 估算结果乘以 4/3 以保守计算
  return Math.ceil(totalTokens * (4 / 3))
}

export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  // 上一次 API 响应的累计 cache_deleted_input_tokens 基线，
  // 用于计算每次操作的增量（API 值为粘性/累计值）
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}

/**
 * 遍历消息并按遇到顺序收集工具名在 COMPACTABLE_TOOLS 中的 tool_use ID。
 * 两种微压缩路径共享此函数。
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_call' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// 使用前缀匹配，因为 promptCategory.ts 在非默认输出样式激活时会将 querySource
// 设为 'repl_main_thread:outputStyle:<style>'。
// 裸 'repl_main_thread' 仅用于默认样式。
// query.ts:350/1451 使用相同的 startsWith 模式；之前 cached-MC 的
// `=== 'repl_main_thread'` 检查是一个潜伏 bug——使用非默认输出样式的
// 用户会被静默排除在 cached MC 之外。
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // 在新的微压缩尝试开始时清除抑制标志
  clearCompactWarningSuppression()

  // 基于时间的触发器最先运行并可短路。若距离最后一条 assistant 消息的间隔
  // 超过阈值，则服务端缓存已过期，完整前缀无论如何都会被重写——
  // 因此在请求前清除旧工具结果，缩小重写内容。
  // 此路径触发时跳过 Cached MC（缓存编辑）：编辑假设缓存是热的，而我们刚确认它是冷的。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // 仅在主线程运行 cached MC，防止分叉智能体（session_memory、prompt_suggestion 等）
  // 将其 tool_results 注册到全局 cachedMCState 中，
  // 否则主线程会尝试删除其自身对话中不存在的工具。
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      (mod as any).isCachedMicrocompactEnabled() &&
      (mod as any).isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // 旧版微压缩路径已移除——zy_cache_plum_violet 始终为 true。
  // 对于 cached microcompact 不可用的场景（外部构建、非内部用户、
  // 不支持的模型、子智能体），此处不执行压缩；
  // 由 autocompact 处理上下文压力。
  return { messages }
}

/**
 * 缓存式微压缩路径——使用缓存编辑 API 移除工具结果，
 * 同时不破坏已缓存的前缀。
 *
 * 与常规微压缩的关键区别：
 * - 不修改本地消息内容（cache_reference 和 cache_edits 在 API 层添加）
 * - 使用 GrowthBook 配置中基于计数的触发/保留阈值
 * - 优先于常规微压缩（无磁盘持久化）
 * - 追踪工具结果并为 API 层排队缓存编辑
 */
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = (mod as any).getCachedMCConfig()

  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  // 第二遍：按用户消息分组注册工具结果
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const groupIds: string[] = []
      for (const block of message.message.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.toolCallId) &&
          !(state as any).registeredTools.has(block.toolCallId)
        ) {
          ;(mod as any).registerToolResult(state, block.toolCallId)
          groupIds.push(block.toolCallId)
        }
      }
      ;(mod as any).registerToolMessage(state, groupIds)
    }
  }

  const toolsToDelete = (mod as any).getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // 为 API 层创建并排队 cache_edits 块
    const cacheEdits = (mod as any).createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    logForDebugging(
      `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
    )

    // 记录事件
    logEvent('zy_cached_microcompact', {
      toolsDeleted: toolsToDelete.length,
      deletedToolIds: toolsToDelete.join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      activeToolCount: (state as any).toolOrder.length - (state as any).deletedRefs.size,
      triggerType: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      threshold: config.triggerThreshold,
      keepRecent: config.keepRecent,
    })

    // 压缩成功后抑制警告
    suppressCompactWarning()

    // 通知缓存中断检测器：缓存读取将合理下降
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // 传递实际的 querySource——isMainThreadSource 现在使用前缀匹配，
      // 输出样式变体会进入此处，而 getTrackingKey 以完整源字符串为键，
      // 非 'repl_main_thread' 前缀。
      notifyCacheDeletion((querySource ?? 'repl_main_thread') as any)
    }

    // 返回未修改的消息——cache_reference 和 cache_edits 在 API 层添加
    // 边界消息延迟到 API 响应之后，以便使用 API 返回的实际
    // cache_deleted_input_tokens，而非客户端估算值
    // 捕获最后一条 assistant 消息的累计 cache_deleted_input_tokens 基线，
    // 以便在 API 调用后计算每次操作的增量
    const lastAsst = messages.findLast((m) => m.type === 'assistant')
    const baseline =
      lastAsst?.type === 'assistant'
        ? ((lastAsst.message.usage as unknown as Record<string, number | undefined>)
            ?.cache_deleted_input_tokens ?? 0)
        : 0

    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  // 无需压缩，返回未修改的消息
  return { messages }
}

/**
 * 基于时间的微压缩：当距离最后一条主循环 assistant 消息的间隔超过配置阈值时，
 * 清除除最近 N 个可压缩工具结果外的所有内容。
 *
 * 触发器不触发时返回 null（禁用、来源不匹配、间隔低于阈值、无可清除项）
 * ——调用方将落入其他路径。
 *
 * 与 cached MC 不同，此路径直接修改消息内容。缓存是冷的，
 * 无需通过 cache_edits 保留缓存前缀。
 */
/**
 * 检查基于时间的触发器是否应对此请求触发。
 *
 * 触发时返回测量的间隔（距最后一条 assistant 消息的分钟数），
 * 不触发时返回 null（禁用、来源不匹配、低于阈值、无前置 assistant、
 * 时间戳不可解析）。
 *
 * 独立提取，使其他预请求路径（如 snip force-apply）可以查询同一谓词，
 * 而无需耦合到工具结果清除动作。
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // 要求显式的主线程 querySource。isMainThreadSource 将 undefined 视为主线程
  // （为了 cached-MC 向后兼容），但部分调用方（/context、/compact、analyzeContext）
  // 在仅分析目的下调用 microcompactMessages 时不传 source——它们不应触发。
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast((m) => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // 最小值为 1：slice(-0) 返回完整数组（矛盾地保留了全部），
  // 且清除所有结果会使模型没有工作上下文。
  // 两种退化情况都不合理——始终至少保留最后一个。
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result: Message[] = messages.map((message) => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let touched = false
    const newContent = message.message.content.map((block) => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.toolCallId) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) {
      return message
    }
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  logEvent('zy_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, cleared ${clearSet.size} tool results (~${tokensSaved} tokens), kept last ${keepSet.size}`,
  )

  suppressCompactWarning()
  // Cached-MC 状态（模块级）保存了前几轮注册的工具 ID。
  // 我们刚刚清除了部分工具内容，并通过修改 prompt 内容使服务端缓存失效。
  // 若 cached-MC 在下一轮以过时状态运行，它会尝试 cache_edit 服务端
  // 已不存在的工具。重置它。
  resetMicrocompactState()
  // 我们刚修改了 prompt 内容——下次响应的缓存读取会偏低，但这是我们造成的，
  // 不是中断。通知检测器预期下降。
  // 使用 notifyCacheDeletion（而非 notifyCompaction），因为它已在此导入，
  // 且实现相同的误报抑制——向 import 添加第二个符号会被循环依赖检查标记。
  // 传递实际的 querySource：getTrackingKey 返回完整源字符串
  //（如 'repl_main_thread:outputStyle:custom'），而非仅前缀。
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(querySource)
  }

  return { messages: result }
}
