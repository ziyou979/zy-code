import { useEffect, useState } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSettingsWithAllErrors } from '../../services/settings/allErrors.js'
import { useSettingsChange } from '../useSettingsChange.js'

const SETTINGS_ERRORS_NOTIFICATION_KEY = 'settings-errors'
export function useSettingsErrors() {
  const { addNotification, removeNotification } = useNotifications()
  const [settingsErrors, setErrors] = useState(() => {
    const { errors } = getSettingsWithAllErrors()
    return errors
  })
  const handleSettingsChange = () => {
    const { errors: currentErrors } = getSettingsWithAllErrors()
    setErrors(currentErrors)
  }
  useSettingsChange(handleSettingsChange)
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    if (settingsErrors.length > 0) {
      const message = `Found ${settingsErrors.length} settings ${settingsErrors.length === 1 ? 'issue' : 'issues'} · /doctor for details`
      addNotification({
        key: SETTINGS_ERRORS_NOTIFICATION_KEY,
        text: message,
        color: 'warning',
        priority: 'high',
        timeoutMs: 60000,
      })
    } else {
      removeNotification(SETTINGS_ERRORS_NOTIFICATION_KEY)
    }
  }, [settingsErrors, addNotification, removeNotification])
  return settingsErrors
}
