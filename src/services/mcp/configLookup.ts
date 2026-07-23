/**
 * MCP 配置查询：按名称查找生效配置、企业配置存在性检测。
 *
 * 从 config.ts 中提取，不包含修改操作。
 */
import memoize from 'lodash-es/memoize.js'
import type { ScopedMcpServerConfig } from './types.js'
import {
  getEnterpriseMcpFilePath as getEnterpriseMcpFilePathCore,
  getMcpConfigsByScope as getMcpConfigsByScopeCore,
  parseMcpConfigFromFilePath as parseMcpConfigFromFilePathCore,
} from './configRepository.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
import { getSettingsForSource } from '../settings/settings.js'

/**
 * 按名称查找生效的 MCP 服务器配置。
 * 优先级：enterprise > local > project > user。
 */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const { servers: enterpriseServers } = getMcpConfigsByScopeCore('enterprise')

  if (isRestrictedToPluginOnly('mcp')) {
    return enterpriseServers[name] ?? null
  }

  const { servers: userServers } = getMcpConfigsByScopeCore('user')
  const { servers: projectServers } = getMcpConfigsByScopeCore('project')
  const { servers: localServers } = getMcpConfigsByScopeCore('local')

  if (enterpriseServers[name]) return enterpriseServers[name]
  if (localServers[name]) return localServers[name]
  if (projectServers[name]) return projectServers[name]
  if (userServers[name]) return userServers[name]

  return null
}

/** 企业 MCP 配置文件是否存在（缓存结果）。 */
export let doesEnterpriseMcpConfigExist: () => boolean
doesEnterpriseMcpConfigExist = memoize((): boolean => {
  const { config } = parseMcpConfigFromFilePathCore({
    filePath: getEnterpriseMcpFilePathCore(),
    expandVars: true,
    scope: 'enterprise',
  })
  return config !== null
})

/**
 * 判断 MCP 允许列表策略是否应仅来自托管设置。
 * 启用后，allowedMcpServers 仅从 policySettings 读取。
 */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
}

/**
 * 检查配置中的所有 MCP 服务器是否允许在企业 MCP 配置下存在。
 * 当前仅允许 zy-vscode SDK 服务器。
 */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  return Object.values(configs).every((c) => c.type === 'sdk' && c.name === 'zy-vscode')
}
