import type { Notification } from '../../context/notifications.js'
import { isInBundledMode } from 'src/utils/bundledMode.js'
import { getCurrentInstallationType } from 'src/services/doctor/doctorDiagnostic.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { tSync } from '../../i18n/index.js'
import { useStartupNotification } from './useStartupNotification.js'
export function useNpmDeprecationNotification() {
  useStartupNotification(_temp as () => Notification | Promise<Notification>)
}
async function _temp(): Promise<Notification | null> {
  if (isInBundledMode() || isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    return null
  }
  const installationType = await getCurrentInstallationType()
  if (installationType === 'development') {
    return null
  }
  return {
    timeoutMs: 15000,
    key: 'npm-deprecation-warning',
    text: tSync('notif.npmDeprecation'),
    color: 'warning',
    priority: 'high' as const,
  } as Notification
}
