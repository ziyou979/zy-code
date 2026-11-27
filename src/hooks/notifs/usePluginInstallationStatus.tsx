import { useEffect } from 'react'
import { tSync } from '../../i18n/index.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink/index.js'
import { useAppState } from '../../state/AppState.js'
import { logForDebugging } from '../../services/infra/debug.js'
export function usePluginInstallationStatus() {
  const { addNotification } = useNotifications()
  const installationStatus = useAppState((s) => s.plugins.installationStatus)
  let config
  if (!installationStatus) {
    config = {
      totalFailed: 0,
      failedMarketplacesCount: 0,
      failedPluginsCount: 0,
    }
  } else {
    const failedMarketplaces = installationStatus.marketplaces.filter((m) => m.status === 'failed')
    const failedPlugins = installationStatus.plugins.filter((p) => p.status === 'failed')
    config = {
      totalFailed: failedMarketplaces.length + failedPlugins.length,
      failedMarketplacesCount: failedMarketplaces.length,
      failedPluginsCount: failedPlugins.length,
    }
  }
  const { totalFailed, failedMarketplacesCount, failedPluginsCount } = config
  useEffect(() => {
    if (!installationStatus) {
      logForDebugging('No installation status to monitor')
      return
    }
    if (totalFailed === 0) {
      return
    }
    logForDebugging(
      `Plugin installation status: ${failedMarketplacesCount} failed marketplaces, ${failedPluginsCount} failed plugins`,
    )
    if (totalFailed === 0) {
      return
    }
    logForDebugging(`Adding notification for ${totalFailed} failed installations`)
    addNotification({
      key: 'plugin-install-failed',
      jsx: (
        <>
          <Text color="error">
            {tSync(totalFailed === 1 ? 'notif.pluginsFailed_one' : 'notif.pluginsFailed_other', {
              count: totalFailed,
            })}
          </Text>
          <Text dimColor={true}> · {tSync('notif.pluginForDetails')}</Text>
        </>
      ),
      priority: 'medium',
    })
  }, [
    addNotification,
    totalFailed,
    failedMarketplacesCount,
    failedPluginsCount,
    installationStatus,
  ])
}
