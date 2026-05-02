import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getLocalMaxInputTokens } from '../../utils/settings/localModelCapabilities.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/zy.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// 压缩期间为输出保留这么多令牌
// 基于 p99.99 的压缩摘要输出为 17,387 令牌。
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// 返回上下文窗口大小减去模型的最大输出令牌数
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model)

  const autoCompactWindow = process.env.ZY_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // 每轮唯一 ID
  turnId: string
  // 连续自动压缩失败次数。成功时重置。
  // 用作断路器，在上下文不可恢复地超过
  // 限制时停止重试（例如 prompt_too_long）。
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// 在这么多连续失败后停止尝试自动压缩。
// BQ 2026-03-10：1,279 个会话有 50+ 连续失败（最多 3,272）
// 在单个会话中，全球每天浪费约 250K API 调用。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// maxInputTokens 是 API 硬性输入上限，自动压缩需在此之前触发。
// 留出安全余量应对：
// 1. 配置偏差：用户配置的 maxInputTokens 可能与 API 实际限制有差距
// 2. Token 估算误差：客户端估算与 API 实际计数不完全一致
// 默认 90%：若 maxInputTokens=240K，触发点约 216K，距 224K 的 API 限制有 8K 余量。
const MAX_INPUT_AUTOCOMPACT_RATIO = 0.9

export function getAutoCompactThreshold(model: string): number {
  // 第一重保障：基于 contextWindow，留出 buffer 避免压缩过程本身超限
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const contextBasedThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // 第二重保障：基于 maxInputTokens（API 硬性输入上限），留出安全余量
  const maxInputTokens = getLocalMaxInputTokens(model)
  const inputBasedThreshold =
    maxInputTokens >= 100_000 ? Math.floor(maxInputTokens * MAX_INPUT_AUTOCOMPACT_RATIO) : Infinity

  // 两重保障取更严格的（更早触发的）
  let autocompactThreshold = Math.min(contextBasedThreshold, inputBasedThreshold)

  // 便于测试自动压缩的覆盖
  const envPercent = process.env.AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100))
      autocompactThreshold = Math.min(autocompactThreshold, percentageThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100))

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold = isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  // blockingLimit：两重保障取更严格的。
  // 1. contextWindow - 3K（保留手动压缩空间）
  // 2. maxInputTokens（API 硬性输入上限）
  const contextBasedLimit = getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS
  const maxInputTokens = getLocalMaxInputTokens(model)
  const inputBasedLimit = maxInputTokens >= 100_000 ? maxInputTokens : Infinity
  const defaultBlockingLimit = Math.min(contextBasedLimit, inputBasedLimit)

  // Allow override for testing
  const blockingLimitOverride = process.env.ZY_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride ? parseInt(blockingLimitOverride, 10) : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0 ? parsedOverride : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // 允许禁用仅自动压缩（保持手动 /compact 工作）
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // 检查用户是否在其设置中禁用了自动压缩
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip 移除消息但存活的助手的用法仍然反映
  // 压缩前的上下文，所以 tokenCountWithEstimation 看不到节省。
  // 减去 snip 已经计算的粗略增量。
  snipTokensFreed = 0,
): Promise<boolean> {
  // 递归守卫。session_memory 和 compact 是分叉代理，会导致死锁。
  if ((querySource as any) === 'session_memory' || (querySource as any) === 'compact') {
    return false
  }
  // marble_origami 是 ctx-agent — 如果它的上下文爆炸并且
  // 自动压缩触发，runPostCompactCleanup 调用 resetContextCollapse()
  // 这会破坏主线程的提交日志（跨分叉共享的模块级状态）。
  // 放在 feature() 内以便该字符串从外部构建中 DCE
  // （在 excluded-strings.txt 中）。
  if (feature('CONTEXT_COLLAPSE')) {
    if ((querySource as any) === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // 仅响应式模式：抑制主动自动压缩，让响应式压缩捕获
  // API 的 prompt-too-long。feature() 包装器保持标志字符串
  // 不进入外部构建（REACTIVE_COMPACT 是 ant 专用）。
  // 注意：此处返回 false 也意味着 autoCompactIfNeeded 永远不会到达
  // 查询循环中的 trySessionMemoryCompaction — /compact 调用站点
  // 仍然首先尝试会话内存。如果响应式模式毕业则重新审视。
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('zy_cobalt_raccoon', false)) {
      return false
    }
  }

  // 上下文折叠模式：相同的抑制。折叠 IS 上下文
  // 管理系统 — 90% 提交 / 95% 阻塞生成的流拥有
  // 余量问题。自动压缩在有效 13k 时触发
  // （有效的约 93%），正好位于折叠的提交开始（90%）
  // 和阻塞（95%）之间，所以它会与折叠竞争并通常获胜，
  // 摧毁折叠即将保存的细粒度上下文。在这里门控而不是
  // 在 isAutoCompactEnabled() 中保持 reactiveCompact 作为 413
  // 回退（它直接咨询 isAutoCompactEnabled）并让
  // sessionMemory + 手动 /compact 工作。
  //
  // 咨询 isContextCollapseEnabled（而非原始门），以便
  // CLAUDE_CONTEXT_COLLAPSE 环境变量覆盖也在此处得到尊重。
  // require() 在块内打破初始化时的循环（此文件导出
  // getEffectiveContextWindowSize，折叠的 index 导入它）。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, model)

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 断路器：在 N 次连续失败后停止重试。
  // 没有这个，上下文不可恢复地超过限制的会话
  // 会在每轮用注定失败的压缩尝试轰炸 API。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(messages, model, querySource, snipTokensFreed)

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 实验：首先尝试会话内存压缩
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // 重置 lastSummarizedMessageId，因为会话内存压缩会修剪消息
    // 并且在 REPL 替换消息后旧的消息 UUID 将不再存在
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // 重置缓存读取基线，以便压缩后的下降不被标记为
    // 中断。compactConversation 在内部执行此操作；SM 压缩不执行。
    // BQ 2026-03-01：缺少此项使 20% 的 zy_prompt_cache_break 事件
    // 成为误报（systemPromptChanged=true, timeSinceLastAssistantMsg=-1）。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction((querySource ?? 'compact') as any, toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // 为自动压缩抑制用户问题
      undefined, // 自动压缩无自定义指令
      true, // isAutoCompact
      recompactionInfo,
    )

    // 重置 lastSummarizedMessageId，因为传统压缩会替换所有消息
    // 并且旧的消息 UUID 将不再存在于新的消息数组中
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // 成功时重置失败计数
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // 增加连续失败计数以供断路器使用。
    // 调用者通过 autoCompactTracking 传递此值，以便
    // 下次查询循环迭代可以跳过无效的重试尝试。
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
