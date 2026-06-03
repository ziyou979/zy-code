import { useEffect, useRef, useState } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { Text } from 'src/ink.js'
import { getRateLimitWarning, getUsingOverageText } from 'src/services/zyAiLimits.js'
import { useZyAiLimits } from 'src/services/zyAiLimitsHook.js'
import { hasZyAiBillingAccess } from 'src/utils/billing.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
export function useRateLimitWarningNotification(model: string) {
  const { addNotification } = useNotifications()
  const zyAiLimits = useZyAiLimits()
  const rateLimitWarning = getRateLimitWarning(zyAiLimits, model)
  const usingOverageText = getUsingOverageText(zyAiLimits)
  const shownWarningRef = useRef<string | null>(null)
  const hasBillingAccess = hasZyAiBillingAccess()
  const isTeamOrEnterprise = false
  const [hasShownOverageNotification, setHasShownOverageNotification] = useState(false)
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    if (
      zyAiLimits.isUsingOverage &&
      !hasShownOverageNotification &&
      (!isTeamOrEnterprise || hasBillingAccess)
    ) {
      addNotification({
        key: 'limit-reached',
        text: usingOverageText,
        priority: 'immediate',
      })
      setHasShownOverageNotification(true)
    } else {
      if (!zyAiLimits.isUsingOverage && hasShownOverageNotification) {
        setHasShownOverageNotification(false)
      }
    }
  }, [
    zyAiLimits.isUsingOverage,
    usingOverageText,
    hasShownOverageNotification,
    addNotification,
    hasBillingAccess,
  ])
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    if (rateLimitWarning && rateLimitWarning !== shownWarningRef.current) {
      shownWarningRef.current = rateLimitWarning
      addNotification({
        key: 'rate-limit-warning',
        jsx: (
          <Text>
            <Text color="warning">{rateLimitWarning}</Text>
          </Text>
        ),
        priority: 'high',
      })
    }
  }, [rateLimitWarning, addNotification])
}
