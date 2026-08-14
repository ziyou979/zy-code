/**
 * 由托管设置（policySettings）支持的插件策略检查。
 *
 * 保持为仅导入 settings 的叶子模块，以避免循环依赖：marketplaceHelpers.ts
 * 会导入 marketplaceManager.ts，后者会间接触达插件子系统的大部分模块。
 */

import { getSettingsForSource } from '../settings/settings.js'

/**
 * 检查插件是否被组织策略（managed-settings.json）强制禁用。
 * 用户无法在任何 scope 安装或启用被策略阻止的插件。此函数是安装入口、
 * 启用操作和 UI 过滤器判断策略阻止状态的唯一真实来源。
 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
