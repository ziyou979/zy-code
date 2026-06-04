import { checkInstall } from 'src/services/nativeInstaller/index.js'
import { useStartupNotification } from './useStartupNotification.js'
export function useInstallMessages() {
  // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
  useStartupNotification(_temp2 as any)
}
async function _temp2() {
  const messages = await checkInstall()
  return messages.map(_temp)
}
function _temp(
  message: { type: string; message: string; userActionRequired?: boolean },
  index: number,
) {
  let priority = 'low'
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
