import { tSync } from '../i18n/index.js'
import { Text } from '../ink/index.js'
import {
  isChromeExtensionInstalled,
  shouldEnableClaudeInChrome,
} from '../services/claude-in-chrome/setup.js'
import { isRunningOnHomespace } from '../services/infra/envUtils.js'
import { useStartupNotification } from './notifs/useStartupNotification.js'

function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) {
    return true
  }
  if (process.argv.includes('--no-chrome')) {
    return false
  }
  return undefined
}
export function useChromeExtensionNotification() {
  useStartupNotification(_temp)
}
async function _temp() {
  const chromeFlag = getChromeFlag()
  if (!shouldEnableClaudeInChrome(chromeFlag)) {
    return null
  }
  // Chrome 扩展通知需要订阅，此处不适用
  const installed = await isChromeExtensionInstalled()
  if (!installed && !isRunningOnHomespace()) {
    return {
      key: 'chrome-extension-not-detected',
      jsx: <Text color="warning">{tSync('notif.chromeNotDetected')}</Text>,
      priority: 'immediate' as const,
      timeoutMs: 3000,
    }
  }
  if (chromeFlag === undefined) {
    return {
      key: 'claude-in-chrome-default-enabled',
      text: tSync('notif.chromeEnabled'),
      priority: 'low' as const,
    }
  }
  return null
}
