import { useEffect, useState } from 'react'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { useNotifications } from '../../context/notifications.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { onPluginsAutoUpdated } from '../../services/plugins/pluginAutoupdate.js'

/**
 * 插件自动更新后显示通知，并提示用户运行 /reload-plugins 应用更新。
 */
export function usePluginAutoupdateNotification() {
  const { addNotification } = useNotifications()
  const [updatedPlugins, setUpdatedPlugins] = useState<string[]>([])
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    const unsubscribe = onPluginsAutoUpdated((plugins) => {
      logForDebugging(`Plugin autoupdate notification: ${plugins.length} plugin(s) updated`)
      setUpdatedPlugins(plugins)
    })
    return unsubscribe
  }, [])
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    if (updatedPlugins.length === 0) {
      return
    }
    const pluginNames = updatedPlugins.map((id) => {
      const atIndex = id.indexOf('@')
      return atIndex > 0 ? id.substring(0, atIndex) : id
    })
    const displayNames =
      pluginNames.length <= 2 ? pluginNames.join(' and ') : `${pluginNames.length} plugins`
    addNotification({
      key: 'plugin-autoupdate-restart',
      jsx: (
        <>
          <Text color="success">
            {tSync(
              pluginNames.length === 1
                ? 'notif.pluginUpdatedSingular'
                : 'notif.pluginUpdatedPlural',
              { names: displayNames },
            )}
          </Text>
          <Text dimColor={true}>{tSync('notif.reloadPlugins')}</Text>
        </>
      ),
      priority: 'low',
      timeoutMs: 10000,
    })
    logForDebugging(`Showing plugin autoupdate notification for: ${pluginNames.join(', ')}`)
  }, [updatedPlugins, addNotification])
}
