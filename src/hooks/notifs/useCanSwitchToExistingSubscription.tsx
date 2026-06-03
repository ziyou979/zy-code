import { getOauthProfileFromApiKey } from 'src/services/oauth/getOauthProfile.js'
import { Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { useStartupNotification } from './useStartupNotification.js'

const MAX_SHOW_COUNT = 3

/**
 * Hook to check if the user has a subscription on Console but isn't logged into it.
 */
export function useCanSwitchToExistingSubscription() {
  // @ts-expect-error
  useStartupNotification(_temp2)
}

/**
 * Checks if the user has a subscription but is not currently logged into it.
 * This helps inform users they should run /login to access their subscription.
 */
async function _temp2() {
  if ((getGlobalConfig().subscriptionNoticeCount ?? 0) >= MAX_SHOW_COUNT) {
    return null
  }
  const subscriptionType = await getExistingZySubscription()
  if (subscriptionType === null) {
    return null
  }
  saveGlobalConfig(_temp)
  logEvent('zy_switch_to_subscription_notice_shown', {})
  return {
    key: 'switch-to-subscription',
    jsx: (
      <Text color="suggestion">
        Use your existing Zy {subscriptionType} plan with ZY Code
        <Text color="text" dimColor={true}>
          {' '}
          · /login to activate
        </Text>
      </Text>
    ),
    priority: 'low',
  }
}
function _temp(current: import('../../utils/config.js').GlobalConfig) {
  return {
    ...current,
    subscriptionNoticeCount: ((current as any).subscriptionNoticeCount ?? 0) + 1,
  }
}
async function getExistingZySubscription(): Promise<'Max' | 'Pro' | null> {
  const profile = await getOauthProfileFromApiKey()
  if (!profile) {
    return null
  }
  if ((profile as any).account.has_Zy_max) {
    return 'Max'
  }
  if ((profile as any).account.has_Zy_pro) {
    return 'Pro'
  }
  return null
}
