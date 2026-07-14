import type { DangerousSettings } from '../../services/remote-managed-settings/securityPolicy.js'

export {
  extractDangerousSettings,
  hasDangerousSettings,
  hasDangerousSettingsChanged,
} from '../../services/remote-managed-settings/securityPolicy.js'

/** 将危险设置名称格式化为对话框可展示的列表，不暴露具体值。 */
export function formatDangerousSettingsList(dangerous: DangerousSettings): string[] {
  const items = [...Object.keys(dangerous.shellSettings), ...Object.keys(dangerous.envVars)]
  if (dangerous.hasHooks) {
    items.push('hooks')
  }
  return items
}
