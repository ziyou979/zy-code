import { gracefulShutdownSync } from '../../bootstrap/lifecycle/gracefulShutdown.js'
import {
  DANGEROUS_SHELL_SETTINGS,
  SAFE_ENV_VARS,
} from '../../services/environment/managedEnvConstants.js'
import type { SettingsJson } from '../settings/types.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'

type DangerousShellSetting = (typeof DANGEROUS_SHELL_SETTINGS)[number]

export type DangerousSettings = {
  shellSettings: Partial<Record<DangerousShellSetting, string>>
  envVars: Record<string, string>
  hasHooks: boolean
  hooks?: unknown
}

export type SecurityCheckResult =
  | 'approved'
  | 'rejected'
  | 'no_check_needed'
  | 'deferred_non_interactive'

/** 从远程设置中提取必须由用户确认的高风险项。 */
export function extractDangerousSettings(
  settings: SettingsJson | null | undefined,
): DangerousSettings {
  if (!settings) {
    return { shellSettings: {}, envVars: {}, hasHooks: false }
  }

  const shellSettings: Partial<Record<DangerousShellSetting, string>> = {}
  for (const key of DANGEROUS_SHELL_SETTINGS) {
    const value = settings[key]
    if (typeof value === 'string' && value.length > 0) {
      shellSettings[key] = value
    }
  }

  const envVars: Record<string, string> = {}
  if (settings.env && typeof settings.env === 'object') {
    for (const [key, value] of Object.entries(settings.env)) {
      if (typeof value === 'string' && value.length > 0 && !SAFE_ENV_VARS.has(key.toUpperCase())) {
        envVars[key] = value
      }
    }
  }

  const hasHooks =
    settings.hooks !== undefined &&
    settings.hooks !== null &&
    typeof settings.hooks === 'object' &&
    Object.keys(settings.hooks).length > 0

  return {
    shellSettings,
    envVars,
    hasHooks,
    hooks: hasHooks ? settings.hooks : undefined,
  }
}

export function hasDangerousSettings(dangerous: DangerousSettings): boolean {
  return (
    Object.keys(dangerous.shellSettings).length > 0 ||
    Object.keys(dangerous.envVars).length > 0 ||
    dangerous.hasHooks
  )
}

/** 判断危险设置是否新增或发生变化。 */
export function hasDangerousSettingsChanged(
  oldSettings: SettingsJson | null | undefined,
  newSettings: SettingsJson | null | undefined,
): boolean {
  const oldDangerous = extractDangerousSettings(oldSettings)
  const newDangerous = extractDangerousSettings(newSettings)
  if (!hasDangerousSettings(newDangerous)) {
    return false
  }
  if (!hasDangerousSettings(oldDangerous)) {
    return true
  }

  return (
    jsonStringify({
      shellSettings: oldDangerous.shellSettings,
      envVars: oldDangerous.envVars,
      hooks: oldDangerous.hooks,
    }) !==
    jsonStringify({
      shellSettings: newDangerous.shellSettings,
      envVars: newDangerous.envVars,
      hooks: newDangerous.hooks,
    })
  )
}

export function needsManagedSettingsSecurityCheck(
  cachedSettings: SettingsJson | null,
  newSettings: SettingsJson | null,
): boolean {
  return (
    !!newSettings &&
    hasDangerousSettings(extractDangerousSettings(newSettings)) &&
    hasDangerousSettingsChanged(cachedSettings, newSettings)
  )
}

/** 被拒绝时保持原有退出语义；其余结果允许继续应用。 */
export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)
    return false
  }
  return true
}

export function shouldPersistManagedSettingsAfterSecurityCheck(
  result: SecurityCheckResult,
): boolean {
  return result === 'approved' || result === 'no_check_needed'
}
