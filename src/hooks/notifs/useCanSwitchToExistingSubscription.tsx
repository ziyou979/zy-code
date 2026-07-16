import { Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { useStartupNotification } from './useStartupNotification.js'

const MAX_SHOW_COUNT = 3

/**
 * Hook to check if the user has a subscription on Console but isn't logged into it.
 *
 * 多 Provider OAuth 模式下不再通过 zy.ai profile API 检查订阅状态。
 */
export function useCanSwitchToExistingSubscription() {
  // @ts-expect-error
  useStartupNotification(_temp2)
}

async function _temp2() {
  if ((getGlobalConfig().subscriptionNoticeCount ?? 0) >= MAX_SHOW_COUNT) {
    return null
  }
  // 多 Provider OAuth 模式下无法检查 zy.ai 订阅状态
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
function _temp(current: import('../../services/config/config.js').GlobalConfig) {
  return {
    ...current,
    subscriptionNoticeCount: ((current as { subscriptionNoticeCount?: number }).subscriptionNoticeCount ?? 0) + 1,
  }
}
async function getExistingZySubscription(): Promise<'Max' | 'Pro' | null> {
  // 多 Provider OAuth 模式下不支持检查 zy.ai 订阅状态
  return null
}
