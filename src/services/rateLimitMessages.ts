/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 */

import { tSync } from '../i18n/index.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../utils/auth.js'
import { hasZyAiBillingAccess } from '../utils/billing.js'
import { isInternalBuild } from '../utils/envUtils.js'
import { formatResetTime } from '../utils/format.js'
import type { ZyAILimits } from './zyAiLimits.js'

const FEEDBACK_CHANNEL_ANT = '#briarpatch-cc'

/**
 * Get the translated name for a rate limit type
 */
function getLimitNameTranslation(rateLimitType: string, _model: string): string {
  if (rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise = subscriptionType === 'pro' || subscriptionType === 'enterprise'
    return isProOrEnterprise ? tSync('rateLimit.weeklyLimit') : tSync('rateLimit.standardLimit')
  }
  if (rateLimitType === 'seven_day_opus') {
    return tSync('rateLimit.advancedLimit')
  }
  if (rateLimitType === 'seven_day') {
    return tSync('rateLimit.weeklyLimit')
  }
  if (rateLimitType === 'five_hour') {
    return tSync('rateLimit.sessionLimit')
  }
  return tSync('rateLimit.usageLimit')
}

/**
 * All possible rate limit error message prefixes
 * Export this to avoid fragile string matching in UI components
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/**
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(limits: ZyAILimits, model: string): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  if (limits.isUsingOverage) {
    // Show warning if approaching overage spending limit
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: tSync('rateLimit.extraUsageSpendingLimit'),
        severity: 'warning',
      }
    }
    return null
  }

  // ERROR STATES - when limits are rejected
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // WARNING STATES - when approaching limits with early warning
  if (limits.status === 'allowed_warning') {
    // Only show warnings when utilization is above threshold (70%)
    // This prevents false warnings after week reset when API may send
    // allowed_warning with stale data at low usage levels
    const WARNING_THRESHOLD = 0.7
    if (limits.utilization !== undefined && limits.utilization < WARNING_THRESHOLD) {
      return null
    }

    // Don't warn non-billing Team/Enterprise users about approaching plan limits
    // if overages are enabled - they'll seamlessly roll into overage
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
      (subscriptionType as any) === 'team' || (subscriptionType as any) === 'enterprise'
    const hasExtraUsageEnabled = getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (isTeamOrEnterprise && hasExtraUsageEnabled && !hasZyAiBillingAccess()) {
      return null
    }

    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // No message needed
  return null
}

/**
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(limits: ZyAILimits, model: string): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return error messages, not warnings
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * Get warning message for UI footer
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(limits: ZyAILimits, model: string): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return warnings for the footer - errors are shown in AssistantTextMessages
  if (message && message.severity === 'warning') {
    return message.message
  }

  // Don't show errors in the footer
  return null
}

function getLimitReachedText(limits: ZyAILimits, model: string): string {
  const resetsAt = limits.resetsAt
  const resetTime = resetsAt ? formatResetTime(resetsAt, true) : undefined
  const overageResetTime = limits.overageResetsAt
    ? formatResetTime(limits.overageResetsAt, true)
    : undefined
  const resetMessage = resetTime ? tSync('rateLimit.resetsAt', { time: resetTime }) : ''

  // if BOTH subscription (checked before this method) and overage are exhausted
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    let overageResetMessage = ''
    if (resetsAt && limits.overageResetsAt) {
      // Both timestamps present - use the earlier one
      if (resetsAt < limits.overageResetsAt) {
        overageResetMessage = ` · ${tSync('rateLimit.resetsAt', { time: resetTime! })}`
      } else {
        overageResetMessage = ` · ${tSync('rateLimit.resetsAt', { time: overageResetTime! })}`
      }
    } else if (resetTime) {
      overageResetMessage = ` · ${tSync('rateLimit.resetsAt', { time: resetTime })}`
    } else if (overageResetTime) {
      overageResetMessage = ` · ${tSync('rateLimit.resetsAt', { time: overageResetTime })}`
    }

    if (limits.overageDisabledReason === 'out_of_credits') {
      return tSync('rateLimit.outOfExtraUsage') + overageResetMessage
    }

    return formatLimitReachedText('limit', overageResetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_sonnet') {
    const limit = getLimitNameTranslation(limits.rateLimitType, model)
    return formatLimitReachedText(limit, resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText(tSync('rateLimit.advancedLimit'), resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText(tSync('rateLimit.weeklyLimit'), resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    return formatLimitReachedText(tSync('rateLimit.sessionLimit'), resetMessage, model)
  }

  return formatLimitReachedText(tSync('rateLimit.usageLimit'), resetMessage, model)
}

function getEarlyWarningText(limits: ZyAILimits): string | null {
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = tSync('rateLimit.weeklyLimit')
      break
    case 'five_hour':
      limitName = tSync('rateLimit.sessionLimit')
      break
    case 'seven_day_opus':
      limitName = tSync('rateLimit.advancedLimit')
      break
    case 'seven_day_sonnet':
      limitName = getLimitNameTranslation(limits.rateLimitType, '')
      break
    case 'overage':
      limitName = tSync('rateLimit.usageLimit')
      break
    case undefined:
      return null
  }

  // utilization and resetsAt should be defined since early warning is calculated with them
  const used = limits.utilization ? Math.floor(limits.utilization * 100) : undefined
  const resetTime = limits.resetsAt ? formatResetTime(limits.resetsAt, true) : undefined

  // Get upsell command based on subscription type and limit type
  const upsell = getWarningUpsellText(limits.rateLimitType)

  if (used && resetTime) {
    const base = tSync('rateLimit.usedPercentWithReset', {
      limit: limitName,
      pct: used,
      resetTime: tSync('rateLimit.resetsAt', { time: resetTime }),
    })
    return upsell ? `${base} · ${upsell}` : base
  }

  if (used) {
    const base = tSync('rateLimit.usedPercent', { limit: limitName, pct: used })
    return upsell ? `${base} · ${upsell}` : base
  }

  if (limits.rateLimitType === 'overage') {
    // For the "Approaching <x>" verbiage, "extra usage limit" makes more sense than "extra usage"
    limitName += ' limit'
  }

  if (resetTime) {
    const base = tSync('rateLimit.approachingWithReset', {
      limit: limitName,
      resetTime: tSync('rateLimit.resetsAt', { time: resetTime }),
    })
    return upsell ? `${base} · ${upsell}` : base
  }

  const base = tSync('rateLimit.approaching', { limit: limitName })
  return upsell ? `${base} · ${upsell}` : base
}

/**
 * Get the upsell command text for warning messages based on subscription and limit type.
 * Returns null if no upsell should be shown.
 * Only used for warnings because actual rate limit hits will see an interactive menu of options.
 */
function getWarningUpsellText(rateLimitType: ZyAILimits['rateLimitType']): string | null {
  const subscriptionType = getSubscriptionType()
  const hasExtraUsageEnabled = getOauthAccountInfo()?.hasExtraUsageEnabled === true

  // 5-hour session limit warning
  if (rateLimitType === 'five_hour') {
    // Teams/Enterprise with overages disabled: prompt to request extra usage
    // Only show if overage provisioning is allowed for this org type (e.g., not AWS marketplace)
    // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
    if ((subscriptionType as any) === 'team' || (subscriptionType as any) === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return tSync('rateLimit.upsell.requestAdmin')
      }
      // Teams/Enterprise with overages enabled or unsupported billing type don't need upsell
      return null
    }

    // Pro/Max users: prompt to upgrade
    // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
    if ((subscriptionType as any) === 'pro' || (subscriptionType as any) === 'max') {
      return tSync('rateLimit.upsell.upgrade')
    }
  }

  // Overage warning (approaching spending limit)
  if (rateLimitType === 'overage') {
    // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
    if ((subscriptionType as any) === 'team' || (subscriptionType as any) === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return tSync('rateLimit.upsell.requestAdmin')
      }
    }
  }

  // Weekly limit warnings don't show upsell per spec
  return null
}

/**
 * Get notification text for overage mode transitions
 * Used for transient notifications when entering overage mode
 */
export function getUsingOverageText(limits: ZyAILimits): string {
  const resetTime = limits.resetsAt ? formatResetTime(limits.resetsAt, true) : ''

  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = tSync('rateLimit.sessionLimit')
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = tSync('rateLimit.weeklyLimit')
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = tSync('rateLimit.advancedLimit')
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    limitName = getLimitNameTranslation(limits.rateLimitType, '')
  }

  if (!limitName) {
    return tSync('rateLimit.nowUsingExtraUsage')
  }

  const resetMessage = resetTime
    ? ` · 你的 ${limitName} ${tSync('rateLimit.resetsAt', { time: resetTime })}`
    : ''
  return tSync('rateLimit.nowUsingExtraUsage') + resetMessage
}

function formatLimitReachedText(limit: string, resetMessage: string, _model: string): string {
  // Enhanced messaging for Ant users
  if (isInternalBuild()) {
    return (
      tSync('rateLimit.hit', { limit }) +
      resetMessage +
      `. 如果对此限额有反馈，请发布到 ${FEEDBACK_CHANNEL_ANT}。你可以使用 /reset-limits 重置限额`
    )
  }

  return tSync('rateLimit.hit', { limit }) + resetMessage
}
