import { useEffect, useState } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import { getSettingsWithAllErrors } from '../../utils/settings/allErrors.js';
import { useSettingsChange } from '../useSettingsChange.js';
const SETTINGS_ERRORS_NOTIFICATION_KEY = 'settings-errors';
export function useSettingsErrors() {
  const {
    addNotification,
    removeNotification
  } = useNotifications();
  const [errors_0, setErrors] = useState(() => {
    const {
      errors
    } = getSettingsWithAllErrors();
    return errors;
  });
  const handleSettingsChange = () => {
    const {
      errors: errors_1
    } = getSettingsWithAllErrors();
    setErrors(errors_1);
  };
  useSettingsChange(handleSettingsChange);
  useEffect(() => {
    if (getIsRemoteMode()) {
      return;
    }
    if (errors_0.length > 0) {
      const message = `Found ${errors_0.length} settings ${errors_0.length === 1 ? "issue" : "issues"} · /doctor for details`;
      addNotification({
        key: SETTINGS_ERRORS_NOTIFICATION_KEY,
        text: message,
        color: "warning",
        priority: "high",
        timeoutMs: 60000
      });
    } else {
      removeNotification(SETTINGS_ERRORS_NOTIFICATION_KEY);
    }
  }, [errors_0, addNotification, removeNotification]);
  return errors_0;
}
