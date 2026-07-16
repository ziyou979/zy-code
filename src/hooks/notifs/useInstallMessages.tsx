import type { Notification } from '../../context/notifications.js'
import { checkInstall } from 'src/services/native-installer/index.js'
import { useStartupNotification } from './useStartupNotification.js'
export function useInstallMessages() {
  useStartupNotification(_temp2)
}
async function _temp2(): Promise<Notification[]> {
  const messages = await checkInstall()
  return messages.map(_temp as (m: typeof messages[number], i: number) => Notification)
}
function _temp(
  message: { type: string; message: string; userActionRequired?: boolean },
  index: number,
) {
  let priority: 'high' | 'medium' | 'low' = 'low'
  if (message.type === 'error' || message.userActionRequired) {
    priority = 'high'
  } else {
    if (message.type === 'path' || message.type === 'alias') {
      priority = 'medium'
    }
  }
  return {
    key: `install-message-${index}-${message.type}`,
    text: message.message,
    priority,
    color: message.type === 'error' ? 'error' : 'warning',
  }
}
