import { getSettingsForSource } from '../settings/settings.js'

/**
 * 受组织策略（policySettings.enabledPlugins）锁定的插件名称。
 *
 * 托管设置未声明插件条目时返回 null；这是未启用策略时的常见情况。
 */
export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // 仅保护 plugin@marketplace 的布尔条目（true 或 false），
    // 不保护旧版 owner/repo 数组形式。
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  return names.size > 0 ? names : null
}
