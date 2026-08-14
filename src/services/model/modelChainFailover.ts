/**
 * 多 auth 候选链的失效切换逻辑（与 withRetry 同模型重试正交）。
 *
 * withRetry 在同一候选上耗尽后抛出 CannotRetryError；
 * 本模块判定是否应推进 sticky 并返回下一候选。
 */

import { getInitialSettings } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { isAPIError } from '../../types/llm.js'
import { errorMessage } from '../../utils/errors.js'
import { CannotRetryError } from '../api/withRetry.js'
import {
  advanceModelCandidate,
  getAuthProfileForModelFromSettings,
  getModelCandidatesForTier,
  getProviderForModelFromSettings,
  isModelFailoverEnabled,
  type ResolvedModelReference,
} from './model.js'
import { getModelFailoverConfig, type ModelChainFailoverReason } from './modelChainState.js'
import { getAPIProvider } from './providers.js'

/** 同一候选连续「整轮 withRetry 耗尽」次数 */
const consecutiveExhaustionCounts = new Map<string, number>()

function countKey(tier: string, index: number): string {
  return `${tier}:${index}`
}

export function clearAuthChainFailureCounts(): void {
  consecutiveExhaustionCounts.clear()
}

function unwrapError(error: unknown): unknown {
  if (error instanceof CannotRetryError) {
    return error.originalError
  }
  return error
}

/**
 * 判断错误是否属于「可切换 auth」类（认证 / 限流耗尽 / 配额）。
 * 529/5xx 不在此列。
 */
export function classifyAuthChainSwitchableError(error: unknown): ModelChainFailoverReason | null {
  // 候选切换只发生在同一模型的重试策略明确耗尽之后。普通业务错误、
  // 本地校验错误或偶发单次错误不得仅凭文案触发跨 provider 切换。
  if (!(error instanceof CannotRetryError)) {
    return null
  }
  const e = unwrapError(error)

  if (isAPIError(e)) {
    if (e.status === 401 || e.status === 403) {
      return 'auth_failed'
    }
    if (e.status === 429) {
      return 'rate_limit_exhausted'
    }
    if (e.status === 402) {
      return 'quota_exhausted'
    }
  }

  const msg = errorMessage(e).toLowerCase()
  if (
    msg.includes('insufficient_quota') ||
    msg.includes('quota exceeded') ||
    msg.includes('billing') ||
    msg.includes('payment required') ||
    msg.includes('credit balance')
  ) {
    return 'quota_exhausted'
  }
  if (msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate_limit_exhausted'
  }
  if (
    msg.includes('invalid api key') ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('permission_denied') ||
    msg.includes('not authorized')
  ) {
    return 'auth_failed'
  }

  return null
}

/** 从 settings 解析当前主循环档位名 */
export function getActiveModelTier(settings?: SettingsJson | null): string {
  const s = settings ?? getOptionalSettings()
  return s?.mainLoopModel ?? 'standard'
}

function getOptionalSettings(): SettingsJson | undefined {
  try {
    return getInitialSettings()
  } catch {
    return undefined
  }
}

/**
 * 在当前模型整轮失败后尝试推进候选链。
 * 成功时返回下一候选；否则 null。
 */
export function tryAdvanceAuthChainOnError(
  currentModel: string,
  error: unknown,
  settings: SettingsJson | null | undefined = getOptionalSettings(),
): {
  from: ResolvedModelReference
  next: ResolvedModelReference
  reason: ModelChainFailoverReason
  fromIndex: number
  toIndex: number
  tier: string
} | null {
  const resolvedSettings = settings ?? undefined
  if (!isModelFailoverEnabled(resolvedSettings)) {
    return null
  }

  const reason = classifyAuthChainSwitchableError(error)
  if (!reason) {
    return null
  }

  const tier = getActiveModelTier(resolvedSettings)
  const fallbackProvider = getAPIProvider()
  const activeProvider = getProviderForModelFromSettings(
    resolvedSettings,
    currentModel,
    fallbackProvider,
  )
  const activeAuthProfile = getAuthProfileForModelFromSettings(
    resolvedSettings,
    currentModel,
    activeProvider,
  )
  const candidates = getModelCandidatesForTier(tier, resolvedSettings, activeProvider)
  if (candidates.length < 2) {
    return null
  }

  // provider/model 必须同时吻合。无法定位时禁止猜测索引，否则可能无异常跳链。
  const fromIndex = candidates.findIndex(
    (candidate) =>
      candidate.model === currentModel &&
      candidate.provider === activeProvider &&
      (activeAuthProfile === undefined || candidate.authProfile === activeAuthProfile),
  )
  if (fromIndex < 0) {
    return null
  }
  const from = candidates[fromIndex]!

  const key = countKey(tier, fromIndex)
  const prev = consecutiveExhaustionCounts.get(key) ?? 0
  const nextCount = prev + 1
  consecutiveExhaustionCounts.set(key, nextCount)

  const { maxConsecutiveFailures } = getModelFailoverConfig(resolvedSettings)
  if (nextCount < maxConsecutiveFailures) {
    return null
  }

  const next = advanceModelCandidate(tier, fromIndex, reason, resolvedSettings, activeProvider)
  if (!next) {
    return null
  }

  // 推进成功：清零旧计数，新候选从 0 计
  consecutiveExhaustionCounts.delete(key)
  consecutiveExhaustionCounts.set(countKey(tier, next.candidateIndex ?? fromIndex + 1), 0)

  return {
    from,
    next,
    reason,
    fromIndex,
    toIndex: next.candidateIndex ?? fromIndex + 1,
    tier,
  }
}

/** 请求成功时清除该模型相关失败计数 */
export function noteAuthChainSuccess(currentModel: string, settings?: SettingsJson | null): void {
  const s = settings ?? getOptionalSettings()
  const tier = getActiveModelTier(s)
  const candidates = getModelCandidatesForTier(tier, s, getAPIProvider())
  const index = candidates.findIndex((c) => c.model === currentModel)
  if (index >= 0) {
    consecutiveExhaustionCounts.delete(countKey(tier, index))
  }
}
