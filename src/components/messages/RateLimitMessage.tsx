import React, { useEffect, useState } from 'react'
import { extraUsage } from 'src/commands/extra-usage/index.js'
import { Box, Text } from 'src/ink.js'
import { useZyAiLimits } from 'src/services/zyAiLimitsHook.js'
import { shouldProcessMockLimits } from 'src/services/rateLimitMocking.js' // Used for /mock-limits command
import { getRateLimitTier, getSubscriptionType, isZyAISubscriber } from 'src/utils/auth.js'
import { hasZyAiBillingAccess } from 'src/utils/billing.js'
import { MessageResponse } from '../MessageResponse.js'
import { tSync } from '../../i18n/index.js'
type UpsellParams = {
  shouldShowUpsell: boolean
  isMax20x: boolean
  isExtraUsageCommandEnabled: boolean
  shouldAutoOpenRateLimitOptionsMenu: boolean
  isTeamOrEnterprise: boolean
  hasBillingAccess: boolean
}
export function getUpsellMessage({
  shouldShowUpsell,
  isMax20x,
  isExtraUsageCommandEnabled,
  shouldAutoOpenRateLimitOptionsMenu,
  isTeamOrEnterprise,
  hasBillingAccess,
}: UpsellParams): string | null {
  if (!shouldShowUpsell) return null
  if (isMax20x) {
    if (isExtraUsageCommandEnabled) {
      return tSync('rateLimit.upsell.extraUsage')
    }
    return tSync('rateLimit.upsell.login')
  }
  if (shouldAutoOpenRateLimitOptionsMenu) {
    return tSync('rateLimit.upsell.openingOptions')
  }
  if (!isTeamOrEnterprise && !isExtraUsageCommandEnabled) {
    return tSync('rateLimit.upsell.upgrade')
  }
  if (isTeamOrEnterprise) {
    if (!isExtraUsageCommandEnabled) return null
    if (hasBillingAccess) {
      return tSync('rateLimit.upsell.extraUsage')
    }
    return tSync('rateLimit.upsell.requestAdmin')
  }
  return tSync('rateLimit.upsell.upgradeOrExtra')
}
type RateLimitMessageProps = {
  text: string
  onOpenRateLimitOptions?: () => void
}
export function RateLimitMessage({ text, onOpenRateLimitOptions }: RateLimitMessageProps) {
  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()
  const isTeamOrEnterprise =
    (subscriptionType as any) === 'team' || subscriptionType === 'enterprise'
  const isMax20x = rateLimitTier === 'default_Zy_max_20x'
  const shouldShowUpsell = shouldProcessMockLimits() || isZyAISubscriber()
  const canSeeRateLimitOptionsUpsell = shouldShowUpsell && !isMax20x
  const [hasOpenedInteractiveMenu, setHasOpenedInteractiveMenu] = useState(false)
  const zyAiLimits = useZyAiLimits()
  const isCurrentlyRateLimited =
    zyAiLimits.status === 'rejected' &&
    zyAiLimits.resetsAt !== undefined &&
    !zyAiLimits.isUsingOverage
  const shouldAutoOpenRateLimitOptionsMenu =
    canSeeRateLimitOptionsUpsell &&
    !hasOpenedInteractiveMenu &&
    isCurrentlyRateLimited &&
    onOpenRateLimitOptions
  useEffect(() => {
    if (shouldAutoOpenRateLimitOptionsMenu) {
      setHasOpenedInteractiveMenu(true)
      onOpenRateLimitOptions()
    }
  }, [shouldAutoOpenRateLimitOptionsMenu, onOpenRateLimitOptions])
  let upsell
  const message = getUpsellMessage({
    shouldShowUpsell,
    isMax20x,
    isExtraUsageCommandEnabled: extraUsage.isEnabled(),
    shouldAutoOpenRateLimitOptionsMenu: !!shouldAutoOpenRateLimitOptionsMenu,
    isTeamOrEnterprise,
    hasBillingAccess: hasZyAiBillingAccess(),
  })
  if (!message) {
    upsell = null
  } else {
    upsell = <Text dimColor={true}>{message}</Text>
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {<Text color="error">{text}</Text>}
        {hasOpenedInteractiveMenu ? null : upsell}
      </Box>
    </MessageResponse>
  )
}
