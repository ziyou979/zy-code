import { isAPIError, type APIErrorLike } from '../types/llm.js'
import type { LLMMessageParam } from '../types/llm.js'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getModelBetas } from '../utils/betas.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getDefaultHaikuModel } from '../utils/model/model.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from './analytics/index.js'
import { logEvent } from './analytics/index.js'
import { getAPIMetadata } from './api/zy.js'
import { getLLMClient } from './api/client.js'
import { getAPIProvider, isOpenAIProvider } from '../utils/model/providers.js'
import { createOpenAIMessage } from './api/streamAdapter.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rateLimitMocking.js'

/**
 * 安全地获取 header 值，兼容 Headers 实例和普通对象
 * 百炼 API 返回的 headers 可能是普通对象而非 Headers 实例
 */
function getHeaderValue(
  headers: globalThis.Headers | Record<string, string>,
  key: string,
): string | null {
  if (typeof (headers as globalThis.Headers).get === 'function') {
    return (headers as globalThis.Headers).get(key)
  }
  return (headers as Record<string, string>)[key] ?? null
}

// Re-export message functions from centralized location
export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
} from './rateLimitMessages.js'

type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type { RateLimitType }

type EarlyWarningThreshold = {
  utilization: number // 0-1 scale: trigger warning when usage >= this
  timePct: number // 0-1 scale: trigger warning when time elapsed <= this
}

type EarlyWarningConfig = {
  rateLimitType: RateLimitType
  claimAbbrev: '5h' | '7d'
  windowSeconds: number
  thresholds: EarlyWarningThreshold[]
}

// Early warning configurations in priority order (checked first to last)
// Used as fallback when server doesn't send surpassed-threshold header
// Warns users when they're consuming quota faster than the time window allows
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]

// Maps claim abbreviations to rate limit types for header-based detection
const EARLY_WARNING_CLAIM_MAP: Record<string, RateLimitType> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
  overage: 'overage',
}

import { tSync } from '../i18n/index.js'

const RATE_LIMIT_DISPLAY_NAMES: Record<RateLimitType, string> = {
  five_hour: tSync('rateLimit.sessionLimit'),
  seven_day: tSync('rateLimit.weeklyLimit'),
  seven_day_opus: tSync('rateLimit.opusLimit'),
  seven_day_sonnet: tSync('rateLimit.sonnetLimit'),
  overage: 'extra usage limit',
}

export function getRateLimitDisplayName(type: RateLimitType): string {
  return RATE_LIMIT_DISPLAY_NAMES[type] || type
}

/**
 * Calculate what fraction of a time window has elapsed.
 * Used for time-relative early warning fallback.
 * @param resetsAt - Unix epoch timestamp in seconds when the limit resets
 * @param windowSeconds - Duration of the window in seconds
 * @returns fraction (0-1) of the window that has elapsed
 */
function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000
  const windowStart = resetsAt - windowSeconds
  const elapsed = nowSeconds - windowStart
  return Math.max(0, Math.min(1, elapsed / windowSeconds))
}

// Reason why overage is disabled/rejected
// These values come from the API's unified limiter
export type OverageDisabledReason =
  | 'overage_not_provisioned' // Overage is not provisioned for this org or seat tier
  | 'org_level_disabled' // Organization doesn't have overage enabled
  | 'org_level_disabled_until' // Organization overage temporarily disabled
  | 'out_of_credits' // Organization has insufficient credits
  | 'seat_tier_level_disabled' // Seat tier doesn't have overage enabled
  | 'member_level_disabled' // Account specifically has overage disabled
  | 'seat_tier_zero_credit_limit' // Seat tier has a zero credit limit
  | 'group_zero_credit_limit' // Resolved group limit has a zero credit limit
  | 'member_zero_credit_limit' // Account has a zero credit limit
  | 'org_service_level_disabled' // Org service specifically has overage disabled
  | 'org_service_zero_credit_limit' // Org service has a zero credit limit
  | 'no_limits_configured' // No overage limits configured for account
  | 'unknown' // Unknown reason, should not happen

export type ZyAILimits = {
  status: QuotaStatus
  // unifiedRateLimitFallbackAvailable is currently used to warn users that set
  // their model to Opus whenever they are about to run out of quota. It does
  // not change the actual model that is used.
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

// Exported for testing only
export let currentLimits: ZyAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

/**
 * Raw per-window utilization from response headers, tracked on every API
 * response (unlike currentLimits.utilization which is only set when a warning
 * threshold fires). Exposed to statusline scripts via getRawUtilization().
 */
type RawWindowUtilization = {
  utilization: number // 0-1 fraction
  resets_at: number // unix epoch seconds
}
type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}
let rawUtilization: RawUtilization = {}

export function getRawUtilization(): RawUtilization {
  return rawUtilization
}

function extractRawUtilization(headers: globalThis.Headers | Record<string, string>): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const util = getHeaderValue(
      headers,
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    const reset = getHeaderValue(headers, `anthropic-ratelimit-unified-${abbrev}-reset`)
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}

type StatusChangeListener = (limits: ZyAILimits) => void
export const statusListeners: Set<StatusChangeListener> = new Set()

export function emitStatusChange(limits: ZyAILimits) {
  currentLimits = limits
  statusListeners.forEach(listener => listener(limits))
  const hoursTillReset = Math.round(
    (limits.resetsAt ? limits.resetsAt - Date.now() / 1000 : 0) / (60 * 60),
  )

  logEvent('zy_Zyai_limits_status_changed', {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    unifiedRateLimitFallbackAvailable: limits.unifiedRateLimitFallbackAvailable,
    hoursTillReset,
  })
}

async function makeTestQuery() {
  const model = getDefaultHaikuModel()
  const messages: LLMMessageParam[] = [{ role: 'user', content: 'quota' }]
  const apiProvider = getAPIProvider()

  // OpenAI 专用路径
  if (isOpenAIProvider(apiProvider)) {
    const response = await createOpenAIMessage({
      model,
      max_tokens: 1,
      messages,
    })
    // 模拟 .asResponse() 返回
    return new Response(null, {
      headers: { 'x-request-id': response.id ?? '' },
    })
  }

  const anthropic = await getLLMClient({
    maxRetries: 0,
    model,
    source: 'quota_check',
  })
  const betas = getModelBetas(model)

  // biome-ignore lint/plugin: quota check needs raw response access via asResponse()
  const createMessageFn = anthropic.beta.messages.create.bind(anthropic.beta.messages)

  return createMessageFn({
    model,
    max_tokens: 1,
    messages,
    metadata: getAPIMetadata(),
    ...(betas.length > 0 ? { betas } : {}),
  }).asResponse()
}

export async function checkQuotaStatus(): Promise<void> {
  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  // Check if we should process rate limits (real subscriber or mock testing)
  if (!shouldProcessRateLimits(false)) {
    return
  }

  // In non-interactive mode (-p), the real query follows immediately and
  // extractQuotaStatusFromHeaders() will update limits from its response
  // headers (zy.ts), so skip this pre-check API call.
  if (getIsNonInteractiveSession()) {
    return
  }

  try {
    // Make a minimal request to check quota
    const raw = await makeTestQuery()

    // Update limits based on the response
    extractQuotaStatusFromHeaders(raw.headers)
  } catch (error) {
    if (isAPIError(error)) {
      extractQuotaStatusFromError(error)
    }
  }
}

/**
 * Check if early warning should be triggered based on surpassed-threshold header.
 * Returns ZyAILimits if a threshold was surpassed, null otherwise.
 */
function getHeaderBasedEarlyWarning(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ZyAILimits | null {
  // Check each claim type for surpassed threshold header
  for (const [claimAbbrev, rateLimitType] of Object.entries(
    EARLY_WARNING_CLAIM_MAP,
  )) {
    const surpassedThreshold = headers.get(
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    )

    // If threshold header is present, user has crossed a warning threshold
    if (surpassedThreshold !== null) {
      const utilizationHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      )
      const resetHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      )

      const utilization = utilizationHeader
        ? Number(utilizationHeader)
        : undefined
      const resetsAt = resetHeader ? Number(resetHeader) : undefined

      return {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: rateLimitType as RateLimitType,
        utilization,
        unifiedRateLimitFallbackAvailable,
        isUsingOverage: false,
        surpassedThreshold: Number(surpassedThreshold),
      }
    }
  }

  return null
}

/**
 * Check if time-relative early warning should be triggered for a rate limit type.
 * Fallback when server doesn't send surpassed-threshold header.
 * Returns ZyAILimits if thresholds are exceeded, null otherwise.
 */
function getTimeRelativeEarlyWarning(
  headers: globalThis.Headers,
  config: EarlyWarningConfig,
  unifiedRateLimitFallbackAvailable: boolean,
): ZyAILimits | null {
  const { rateLimitType, claimAbbrev, windowSeconds, thresholds } = config

  const utilizationHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
  )
  const resetHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
  )

  if (utilizationHeader === null || resetHeader === null) {
    return null
  }

  const utilization = Number(utilizationHeader)
  const resetsAt = Number(resetHeader)
  const timeProgress = computeTimeProgress(resetsAt, windowSeconds)

  // Check if any threshold is exceeded: high usage early in the window
  const shouldWarn = thresholds.some(
    t => utilization >= t.utilization && timeProgress <= t.timePct,
  )

  if (!shouldWarn) {
    return null
  }

  return {
    status: 'allowed_warning',
    resetsAt,
    rateLimitType,
    utilization,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: false,
  }
}

/**
 * Get early warning limits using header-based detection with time-relative fallback.
 * 1. First checks for surpassed-threshold header (new server-side approach)
 * 2. Falls back to time-relative thresholds (client-side calculation)
 */
function getEarlyWarningFromHeaders(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ZyAILimits | null {
  // Try header-based detection first (preferred when API sends the header)
  const headerBasedWarning = getHeaderBasedEarlyWarning(
    headers,
    unifiedRateLimitFallbackAvailable,
  )
  if (headerBasedWarning) {
    return headerBasedWarning
  }

  // Fallback: Use time-relative thresholds (client-side calculation)
  // This catches users burning quota faster than sustainable
  for (const config of EARLY_WARNING_CONFIGS) {
    const timeRelativeWarning = getTimeRelativeEarlyWarning(
      headers,
      config,
      unifiedRateLimitFallbackAvailable,
    )
    if (timeRelativeWarning) {
      return timeRelativeWarning
    }
  }

  return null
}

function computeNewLimitsFromHeaders(
  headers: globalThis.Headers | Record<string, string>,
): ZyAILimits {
  const status =
    (getHeaderValue(headers, 'anthropic-ratelimit-unified-status') as QuotaStatus) ||
    'allowed'
  const resetsAtHeader = getHeaderValue(headers, 'anthropic-ratelimit-unified-reset')
  const resetsAt = resetsAtHeader ? Number(resetsAtHeader) : undefined
  const unifiedRateLimitFallbackAvailable =
    getHeaderValue(headers, 'anthropic-ratelimit-unified-fallback') === 'available'

  // Headers for rate limit type and overage support
  const rateLimitType = getHeaderValue(
    headers,
    'anthropic-ratelimit-unified-representative-claim',
  ) as RateLimitType | null
  const overageStatus = getHeaderValue(
    headers,
    'anthropic-ratelimit-unified-overage-status',
  ) as QuotaStatus | null
  const overageResetsAtHeader = getHeaderValue(
    headers,
    'anthropic-ratelimit-unified-overage-reset',
  )
  const overageResetsAt = overageResetsAtHeader
    ? Number(overageResetsAtHeader)
    : undefined

  // Reason why overage is disabled (spending cap or wallet empty)
  const overageDisabledReason = getHeaderValue(
    headers,
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ) as OverageDisabledReason | null

  // Determine if we're using overage (standard limits rejected but overage allowed)
  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  // Check for early warning based on surpassed-threshold header
  // If status is allowed/allowed_warning and we find a surpassed threshold, show warning
  let finalStatus: QuotaStatus = status
  if (status === 'allowed' || status === 'allowed_warning') {
    const earlyWarning = getEarlyWarningFromHeaders(
      headers as any,
      unifiedRateLimitFallbackAvailable,
    )
    if (earlyWarning) {
      return earlyWarning
    }
    // No early warning threshold surpassed
    finalStatus = 'allowed'
  }

  return {
    status: finalStatus,
    resetsAt,
    unifiedRateLimitFallbackAvailable,
    ...(rateLimitType && { rateLimitType }),
    ...(overageStatus && { overageStatus }),
    ...(overageResetsAt && { overageResetsAt }),
    ...(overageDisabledReason && { overageDisabledReason }),
    isUsingOverage,
  }
}

/**
 * Cache the extra usage disabled reason from API headers.
 */
function cacheExtraUsageDisabledReason(headers: globalThis.Headers | Record<string, string>): void {
  // A null reason means extra usage is enabled (no disabled reason header)
  const reason =
    getHeaderValue(headers, 'anthropic-ratelimit-unified-overage-disabled-reason') ?? null
  const cached = getGlobalConfig().cachedExtraUsageDisabledReason
  if (cached !== reason) {
    saveGlobalConfig(current => ({
      ...current,
      cachedExtraUsageDisabledReason: reason,
    }))
  }
}

export function extractQuotaStatusFromHeaders(
  headers: globalThis.Headers,
): void {
  // Check if we need to process rate limits
  if (!shouldProcessRateLimits(false)) {
    // If we have any rate limit state, clear it
    rawUtilization = {}
    if (currentLimits.status !== 'allowed' || currentLimits.resetsAt) {
      const defaultLimits: ZyAILimits = {
        status: 'allowed',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }
      emitStatusChange(defaultLimits)
    }
    return
  }

  // Process headers (applies mocks from /mock-limits command if active)
  const headersToUse = processRateLimitHeaders(headers)
  rawUtilization = extractRawUtilization(headersToUse)
  const newLimits = computeNewLimitsFromHeaders(headersToUse)

  // Cache extra usage status (persists across sessions)
  cacheExtraUsageDisabledReason(headersToUse)

  if (!isEqual(currentLimits, newLimits)) {
    emitStatusChange(newLimits)
  }
}

export function extractQuotaStatusFromError(error: APIErrorLike): void {
  if (
    !shouldProcessRateLimits(false) ||
    error.status !== 429
  ) {
    return
  }

  try {
    let newLimits = { ...currentLimits }
    if (error.headers) {
      // Process headers (applies mocks from /mock-limits command if active)
      const headersToUse = processRateLimitHeaders(error.headers as globalThis.Headers | Record<string, string>)
      rawUtilization = extractRawUtilization(headersToUse)
      newLimits = computeNewLimitsFromHeaders(headersToUse)

      // Cache extra usage status (persists across sessions)
      cacheExtraUsageDisabledReason(headersToUse)
    }
    // For errors, always set status to rejected even if headers are not present.
    newLimits.status = 'rejected'

    if (!isEqual(currentLimits, newLimits)) {
      emitStatusChange(newLimits)
    }
  } catch (e) {
    logError(e as Error)
  }
}
