/**
 * autoCompact v2 — fork of v1 autoCompact.ts with the P0 series from
 * docs/zy-code-compact-optimization-plan.md layered in. v1 stays untouched;
 * this file runs when ZY_COMPACT_V2 (env var) is truthy.
 *
 * Status: skeleton + P0.3 Rapid Refill Breaker landed.
 * P0.1 / P0.2 / P0.4 will be added in later iterations and validated against
 * v1 via scripts/compact-real.ts.
 */

import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import type { QuerySource } from '../../../constants/querySource.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../../utils/errors.js'
import type { CacheSafeParams } from '../../../utils/forkedAgent.js'
import { logError } from '../../../utils/log.js'
import { notifyCompaction } from '../../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../../SessionMemory/sessionMemoryUtils.js'
import {
  type AutoCompactTrackingState,
  getAutoCompactThreshold,
  shouldAutoCompact,
} from '../autoCompact.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from '../compact.js'
import { runPostCompactCleanup } from '../postCompactCleanup.js'
import { trySessionMemoryCompaction } from '../sessionMemoryCompact.js'

// 在这么多连续失败后停止尝试自动压缩。
// 与 v1 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES 保持一致；这里独立常量是为了
// 让 v2 后续若想调阈值不污染 v1。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// P0.3 Rapid Refill Breaker — 阈值与 CC 二进制 v2.x 对齐：
//   $x8 = 3   一次 rapid 的定义：压缩后 ≤ 3 轮内又满
//   hD6 = 3   连续 3 次 rapid → 触发熔断
// 与单次大文件读取区分：单次 rapid 不熔断。
export const RAPID_REFILL_TURNS = 3
export const MAX_RAPID_REFILLS = 3

/**
 * 模块内 rapid-refill 计数器，按 agentId 分桶。v2 自己持有，不污染 v1 的
 * AutoCompactTrackingState 类型（保证 deps.ts 切换时 query.ts 零改动）。
 * 熔断后会自动清零；非 rapid 触发也会清零，确保单次大文件不会污染下次。
 */
const rapidRefillCountByAgent = new Map<string, number>()

/** 测试 / 调试用：手动清空 v2 的 rapid-refill 计数器。 */
export function _resetRapidRefillState(): void {
  rapidRefillCountByAgent.clear()
}

export type AutoCompactResultV2 = {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  /** v2 独有：rapid-refill 熔断触发时为 true，告知调用方上下文反复填满。 */
  rapidRefillBreakerTripped?: boolean
}

export async function autoCompactIfNeededV2(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
): Promise<AutoCompactResultV2> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 失败熔断（与 v1 同步语义）
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(messages, model, querySource)

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  // ────────────────────────────────────────────────────────────────────────
  // P0.3 Rapid Refill Breaker
  // 触发条件：上一次成功 compact 之后 ≤ RAPID_REFILL_TURNS 轮内又达到压缩阈值，
  // 且连续 ≥ MAX_RAPID_REFILLS 次。
  // tracking.turnCounter 由 query.ts 维护：成功压缩后置 0，每轮 +1，
  // 所以它天然就是 "turns since last compact"。
  // ────────────────────────────────────────────────────────────────────────
  const agentKey = toolUseContext.agentId ?? 'default'
  const isRapidRefill =
    tracking?.compacted === true &&
    (tracking.turnCounter ?? Number.POSITIVE_INFINITY) <= RAPID_REFILL_TURNS
  const currentRapidCount = rapidRefillCountByAgent.get(agentKey) ?? 0

  if (isRapidRefill) {
    const nextCount = currentRapidCount + 1
    if (nextCount >= MAX_RAPID_REFILLS) {
      // 熔断 — 清零计数避免下次直接熔断，调用方需提示用户 /clear 或拆分大文件
      rapidRefillCountByAgent.delete(agentKey)
      logForDebugging(
        `autocompact v2: rapid-refill breaker tripped — ${nextCount} rapid compacts within ${RAPID_REFILL_TURNS} turns each (agent=${agentKey})`,
        { level: 'warn' },
      )
      return { wasCompacted: false, rapidRefillBreakerTripped: true }
    }
    rapidRefillCountByAgent.set(agentKey, nextCount)
  } else {
    // 非 rapid → 清零，单次大文件读取不应累积计数
    if (currentRapidCount > 0) {
      rapidRefillCountByAgent.delete(agentKey)
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 与 v1 同语义：先试 SessionMemory，命中即返回
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
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
      true,
      undefined,
      true,
      recompactionInfo,
    )

    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact v2: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
