import { Text } from '../ink/index.js'
import { logForDebugging } from '../services/infra/debug.js'
import { checkAndInstallOfficialMarketplace } from '../services/plugins/officialMarketplaceStartupCheck.js'
import { useStartupNotification } from './notifs/useStartupNotification.js'

/**
 * Hook that handles official marketplace auto-installation and shows
 * notifications for success/failure in the bottom right of the REPL.
 */
export function useOfficialMarketplaceNotification() {
  useStartupNotification(_temp)
}
async function _temp() {
  const result = await checkAndInstallOfficialMarketplace()
  const notifs: import('../context/notifications.js').Notification[] = []
  if (result.configSaveFailed) {
    logForDebugging('Showing marketplace config save failure notification')
    notifs.push({
      key: 'marketplace-config-save-failed',
      jsx: (
        <Text color="error">
          Failed to save marketplace retry info · Check ~/.zy.json permissions
        </Text>
      ),
      priority: 'immediate',
      timeoutMs: 10000,
    })
  }
  if (result.installed) {
    logForDebugging('Showing marketplace installation success notification')
    notifs.push({
      key: 'marketplace-installed',
      jsx: (
        <Text color="success">✓ ZY marketplace installed · /plugin to see available plugins</Text>
      ),
      priority: 'immediate',
      timeoutMs: 7000,
    })
  } else {
    if (result.skipped && result.reason === 'unknown') {
      logForDebugging('Showing marketplace installation failure notification')
      notifs.push({
        key: 'marketplace-install-failed',
        jsx: (
          <Text color="warning">Failed to install ZY marketplace · Will retry on next startup</Text>
        ),
        priority: 'immediate',
        timeoutMs: 8000,
      })
    }
  }
  return notifs
}
