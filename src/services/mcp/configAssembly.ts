import type { PluginError } from '../plugins/types.js'
import { dedupPluginMcpServers, mergeMcpConfigsByPriority } from './configMerge.js'
import type { McpServerConfig, ScopedMcpServerConfig } from './types.js'

type ProjectServerStatus = 'approved' | 'rejected' | 'pending'

export type McpConfigAssemblyInput = {
  pluginServers: Record<string, ScopedMcpServerConfig>
  dynamicServers: Record<string, ScopedMcpServerConfig>
  userServers: Record<string, ScopedMcpServerConfig>
  projectServers: Record<string, ScopedMcpServerConfig>
  localServers: Record<string, ScopedMcpServerConfig>
}

export type McpConfigAssemblyPolicy = {
  isDisabled: (name: string) => boolean
  isDenied: (name: string, config?: McpServerConfig) => boolean
  isAllowed: (name: string, config?: McpServerConfig) => boolean
  getProjectStatus: (name: string) => ProjectServerStatus
  log: (message: string) => void
}

type ServerPartition = {
  active: Record<string, ScopedMcpServerConfig>
  disabled: Record<string, ScopedMcpServerConfig>
}

function partitionServers(
  servers: Record<string, ScopedMcpServerConfig>,
  policy: McpConfigAssemblyPolicy,
): ServerPartition {
  const active: Record<string, ScopedMcpServerConfig> = {}
  const disabled: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, config] of Object.entries(servers)) {
    // 企业策略优先于本地启用状态，避免被禁用的违规配置重新出现在列表中。
    if (policy.isDenied(name, config) || !policy.isAllowed(name, config)) {
      continue
    }
    if (policy.isDisabled(name)) {
      disabled[name] = config
    } else {
      active[name] = config
    }
  }

  return { active, disabled }
}

function createSuppressionError(
  name: string,
  duplicateOf: string,
  log: (message: string) => void,
): PluginError | null {
  const parts = name.split(':')
  if (parts[0] !== 'plugin' || parts.length < 3) {
    log(`MCP server '${name}' suppressed by '${duplicateOf}'`)
    return null
  }

  return {
    type: 'mcp-server-suppressed-duplicate',
    source: name,
    plugin: parts[1]!,
    serverName: parts.slice(2).join(':'),
    duplicateOf,
  }
}

/**
 * 组装所有非 enterprise、非 zy.ai 的 MCP 配置。
 * IO、settings 和运行时状态由调用方解析后以依赖形式传入。
 */
export function assembleMcpConfigs(
  input: McpConfigAssemblyInput,
  policy: McpConfigAssemblyPolicy,
): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
} {
  const approvedProjectServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(input.projectServers)) {
    if (policy.getProjectStatus(name) === 'approved') {
      approvedProjectServers[name] = config
    }
  }

  const pluginPartition = partitionServers(input.pluginServers, policy)
  const dynamicPartition = partitionServers(input.dynamicServers, policy)
  const userPartition = partitionServers(input.userServers, policy)
  const projectPartition = partitionServers(approvedProjectServers, policy)
  const localPartition = partitionServers(input.localServers, policy)

  // dynamic 和手动 scope 的优先级均高于插件，因此作为插件去重目标。
  const { servers: dedupedPluginServers, suppressed } = dedupPluginMcpServers(
    pluginPartition.active,
    {
      ...dynamicPartition.active,
      ...userPartition.active,
      ...projectPartition.active,
      ...localPartition.active,
    },
    policy.log,
  )

  const errors = suppressed
    .map(({ name, duplicateOf }) => createSuppressionError(name, duplicateOf, policy.log))
    .filter((error): error is PluginError => error !== null)

  const activeServers = mergeMcpConfigsByPriority(
    { ...dedupedPluginServers, ...dynamicPartition.active },
    userPartition.active,
    projectPartition.active,
    localPartition.active,
  )

  // disabled 配置保留用于 UI 和重新启用，同时维持与 active 相同的 scope 优先级。
  const disabledServers = mergeMcpConfigsByPriority(
    { ...pluginPartition.disabled, ...dynamicPartition.disabled },
    userPartition.disabled,
    projectPartition.disabled,
    localPartition.disabled,
  )

  return {
    servers: { ...activeServers, ...disabledServers },
    errors,
  }
}

/**
 * 并行收集插件 MCP 配置，保留插件加载器写入同一错误集合的行为。
 */
export async function collectPluginMcpServers<T>(
  plugins: readonly T[],
  errors: PluginError[],
  load: (
    plugin: T,
    errors: PluginError[],
  ) => Promise<Record<string, ScopedMcpServerConfig> | undefined>,
): Promise<Record<string, ScopedMcpServerConfig>> {
  const results = await Promise.all(plugins.map((plugin) => load(plugin, errors)))
  const servers: Record<string, ScopedMcpServerConfig> = {}
  for (const result of results) {
    if (result) {
      Object.assign(servers, result)
    }
  }
  return servers
}
