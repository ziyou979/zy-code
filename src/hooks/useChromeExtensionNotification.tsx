import { tSync } from '../i18n/index.js'
import { Text } from '../ink.js'
import {
  isChromeExtensionInstalled,
  shouldEnableClaudeInChrome,
} from '../services/claude-in-chrome/setup.js'
import { isRunningOnHomespace } from '../utils/envUtils.js'
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
  // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
  useStartupNotification(_temp as any)
}
async function _temp() {
  const chromeFlag = getChromeFlag()
  if (!shouldEnableClaudeInChrome(chromeFlag)) {
    return null
  }
  // Chrome extension notification requires subscription (not applicable)
  const installed = await isChromeExtensionInstalled()
  if (!installed && !isRunningOnHomespace()) {
    return {
      key: 'chrome-extension-not-detected',
      jsx: <Text color="warning">{tSync('notif.chromeNotDetected')}</Text>,
      priority: 'immediate',
      timeoutMs: 3000,
    }
  }
  if (chromeFlag === undefined) {
    return {
      key: 'claude-in-chrome-default-enabled',
      text: tSync('notif.chromeEnabled'),
      priority: 'low',
    }
  }
  return null
}
