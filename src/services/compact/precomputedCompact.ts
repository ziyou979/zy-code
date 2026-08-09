/**
 * Precomputed compact MVP：阈值前后台预摘要，触顶时 zero-LLM swap。
 *
 * 门控：ZY_CODE_PRECOMPUTED_COMPACT=1（默认关；无 prompt cache 的 provider 收益可能为负）。
 * 安全：consume 必须校验 prefix leaf uuid；不一致则 discard，绝不错用摘要。
 *
 * 接线：shouldAutoCompact≈false 但接近阈值时 maybeArm；autoCompactIfNeeded 触顶先 consume。
 */
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../agent/forkedAgent.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { logForDebugging } from '../infra/debug.js'
import { isEnvTruthy } from '../infra/envUtils.js'
import { compactConversation, type CompactionResult } from './compact.js'

export type PrecomputedStatus = 'computing' | 'ready'

export type PrecomputedState = {
  status: PrecomputedStatus
  sessionKey: string
  /** arm 时消息列表末条 uuid，consume 时必须仍是 prefix 锚点 */
  prefixLeafUuid: string
  /** 简单指纹：leaf + length，防 silent 替换 */
  prefixFingerprint: string
  model: string
  createdAt: number
  result?: CompactionResult
  abortController: AbortController
}

const cache = new Map<string, PrecomputedState>()

const DEFAULT_TTL_MS = 5 * 60_000

export function isPrecomputedCompactEnabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_PRECOMPUTED_COMPACT)
}

/** arm 阈值 = autoCompactThreshold * 该比例（默认 0.8） */
export function getPrecomputedArmRatio(): number {
  const raw = process.env.ZY_CODE_PRECOMPUTED_ARM_RATIO
  if (raw) {
    const n = parseFloat(raw)
    if (!Number.isNaN(n) && n > 0.5 && n < 1) {
      return n
    }
  }
  return 0.8
}

export function shouldArmPrecomputed(tokenCount: number, autoCompactThreshold: number): boolean {
  if (!isPrecomputedCompactEnabled() || autoCompactThreshold <= 0) {
    return false
  }
  const armAt = Math.floor(autoCompactThreshold * getPrecomputedArmRatio())
  return tokenCount >= armAt && tokenCount < autoCompactThreshold
}

export function makePrefixFingerprint(messages: readonly Message[]): {
  leafUuid: string
  fingerprint: string
} | null {
  if (messages.length === 0) {
    return null
  }
  const leaf = messages[messages.length - 1]
  if (!leaf?.uuid) {
    return null
  }
  return {
    leafUuid: leaf.uuid,
    fingerprint: `${leaf.uuid}:${messages.length}`,
  }
}

/**
 * 当前消息是否仍以 arm 时的 prefix 为前缀（MVP：末条 uuid + length 指纹一致）。
 * arm 后若有任何新消息，length 变化 → discard（v2 可改为 messagesSince 合并）。
 */
export function messagesAlignWithPrefix(
  state: Pick<PrecomputedState, 'prefixLeafUuid' | 'prefixFingerprint'>,
  currentMessages: readonly Message[],
): boolean {
  const cur = makePrefixFingerprint(currentMessages)
  if (!cur) {
    return false
  }
  return cur.leafUuid === state.prefixLeafUuid && cur.fingerprint === state.prefixFingerprint
}

export function getPrecomputedState(sessionKey: string): PrecomputedState | undefined {
  return cache.get(sessionKey)
}

export function discardPrecomputed(sessionKey: string, reason: string): void {
  const prev = cache.get(sessionKey)
  if (!prev) {
    return
  }
  prev.abortController.abort()
  cache.delete(sessionKey)
  logEvent('zy_precomputed_compact_discarded', {
    reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  logForDebugging(`precomputedCompact discard session=${sessionKey} reason=${reason}`)
}

export function clearAllPrecomputed(): void {
  for (const key of cache.keys()) {
    discardPrecomputed(key, 'clear_all')
  }
}

/**
 * 登记 computing 占位；真正 fork 由调用方启动，完成后 call markPrecomputedReady。
 * 若已有 ready/computing，先 discard 旧的。
 */
export function beginPrecomputedArm(params: {
  sessionKey: string
  messages: readonly Message[]
  model: string
}): PrecomputedState | null {
  if (!isPrecomputedCompactEnabled()) {
    return null
  }
  const fp = makePrefixFingerprint(params.messages)
  if (!fp) {
    return null
  }

  discardPrecomputed(params.sessionKey, 're-arm')

  const state: PrecomputedState = {
    status: 'computing',
    sessionKey: params.sessionKey,
    prefixLeafUuid: fp.leafUuid,
    prefixFingerprint: fp.fingerprint,
    model: params.model,
    createdAt: Date.now(),
    abortController: new AbortController(),
  }
  cache.set(params.sessionKey, state)
  logEvent('zy_precomputed_compact_arm', {
    messageCount: params.messages.length,
  })
  return state
}

export function markPrecomputedReady(
  sessionKey: string,
  result: CompactionResult,
  ttlMs = DEFAULT_TTL_MS,
): boolean {
  const state = cache.get(sessionKey)
  if (!state || state.status !== 'computing') {
    return false
  }
  if (state.abortController.signal.aborted) {
    cache.delete(sessionKey)
    return false
  }
  // TTL 仅记录 createdAt；consume 时检查
  state.result = result
  state.status = 'ready'
  state.createdAt = Date.now()
  void ttlMs
  logEvent('zy_precomputed_compact_ready', {})
  return true
}

/**
 * 后台预摘要：登记 computing 后 fire-and-forget compactConversation。
 * 不 await；失败 discard；成功 markReady。同一 session 已有 ready/computing 则跳过。
 */
export function maybeArmPrecomputedCompact(params: {
  sessionKey: string
  messages: Message[]
  model: string
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  tokenCount: number
  autoCompactThreshold: number
}): void {
  if (!shouldArmPrecomputed(params.tokenCount, params.autoCompactThreshold)) {
    return
  }
  const existing = cache.get(params.sessionKey)
  if (existing) {
    // 已有 ready 且 prefix 仍对齐 → 保留；computing 进行中 → 不重入
    if (existing.status === 'computing') {
      return
    }
    if (
      existing.status === 'ready' &&
      existing.model === params.model &&
      messagesAlignWithPrefix(existing, params.messages)
    ) {
      return
    }
  }

  const state = beginPrecomputedArm({
    sessionKey: params.sessionKey,
    messages: params.messages,
    model: params.model,
  })
  if (!state) {
    return
  }

  const sessionKey = params.sessionKey
  const signal = state.abortController.signal
  const messagesSnapshot = params.messages.slice()
  const toolUseContext = params.toolUseContext
  const cacheSafeParams = params.cacheSafeParams

  void (async () => {
    try {
      if (signal.aborted) {
        return
      }
      // 后台预摘要：抑制用户向问题；isAutoCompact 语义用于 hook trigger
      const result = await compactConversation(
        messagesSnapshot,
        {
          ...toolUseContext,
          abortController: state.abortController,
        },
        {
          ...cacheSafeParams,
          forkContextMessages: messagesSnapshot,
        },
        true,
        undefined,
        true,
        {
          isRecompactionInChain: false,
          turnsSincePreviousCompact: -1,
          autoCompactThreshold: params.autoCompactThreshold,
          querySource: params.querySource ?? 'compact',
        },
      )
      if (signal.aborted) {
        return
      }
      // 再校验一次 cache 仍指向本 state
      if (cache.get(sessionKey) !== state) {
        return
      }
      markPrecomputedReady(sessionKey, result)
    } catch (error) {
      if (!signal.aborted) {
        discardPrecomputed(sessionKey, 'arm_failed')
        logForDebugging(
          `precomputedCompact arm failed: ${error instanceof Error ? error.message : String(error)}`,
          { level: 'warn' },
        )
      }
    }
  })()
}

/**
 * 触顶时尝试消费。成功则返回 CompactionResult 并从 cache 移除；失败返回 null。
 */
export function consumePrecomputed(
  sessionKey: string,
  currentMessages: readonly Message[],
  model: string,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): CompactionResult | null {
  const state = cache.get(sessionKey)
  if (!state) {
    return null
  }
  if (state.status !== 'ready' || !state.result) {
    return null
  }
  if (state.model !== model) {
    discardPrecomputed(sessionKey, 'model_mismatch')
    return null
  }
  if (now - state.createdAt > ttlMs) {
    discardPrecomputed(sessionKey, 'ttl')
    return null
  }
  if (!messagesAlignWithPrefix(state, currentMessages)) {
    discardPrecomputed(sessionKey, 'prefix_mismatch')
    return null
  }

  const result = state.result
  cache.delete(sessionKey)
  logEvent('zy_precomputed_compact_consumed', {})
  logForDebugging(`precomputedCompact consumed session=${sessionKey}`)
  return result
}
