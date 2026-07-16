import { feature } from 'bun:bundle'
import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getPlatform } from 'src/services/shell/platform.js'
import { isClaudeInChromeMCPServer } from '../claude-in-chrome/common.js'
import type { PluginError } from '../plugins/types.js'
import { getPluginErrorMessage } from '../plugins/types.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../config/config.js'
import { createDebugLog } from '../../utils/debug.js'

const mcpLog = createDebugLog('mcp')

import { logError } from '../../utils/log.js'
import { getPluginMcpServers } from '../plugins/mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../plugins/pluginLoader.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
import { getInitialSettings, getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import type { ValidationError } from '../settings/validation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  dedupPluginMcpServers as dedupPluginMcpServersSupport,
  dedupZyAIMcpServers as dedupZyAIMcpServersSupport,
  filterMcpServersByPolicy as filterMcpServersByPolicySupport,
  getMcpServerSignature as getMcpServerSignatureSupport,
  isMcpServerAllowedByPolicy as isMcpServerAllowedByPolicySupport,
  isMcpServerDenied as isMcpServerDeniedSupport,
  unwrapCcrProxyUrl as unwrapCcrProxyUrlSupport,
} from './mcpConfigPolicySupport.js'
import {
  getEnterpriseMcpFilePath as getEnterpriseMcpFilePathSupport,
  getMcpConfigsByScope as getMcpConfigsByScopeSupport,
  getProjectMcpConfigsFromCwd as getProjectMcpConfigsFromCwdSupport,
  parseMcpConfig as parseMcpConfigSupport,
  parseMcpConfigFromFilePath as parseMcpConfigFromFilePathSupport,
  writeMcpjsonFile,
} from './mcpConfigStorageSupport.js'
import {
  type ConfigScope,
  type McpJsonConfig,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpStdioServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'
import { fetchZyAIMcpConfigsIfEligible } from './zyai.js'

/**
 * 获取托管 MCP 配置文件的路径
 */
export function getEnterpriseMcpFilePath(): string {
  return getEnterpriseMcpFilePathSupport()
}

/**
 * If the URL is a CCR proxy URL, extract the original vendor URL from the
 * mcp_url query parameter. Otherwise return the URL unchanged.
 */
export function unwrapCcrProxyUrl(url: string): string {
  return unwrapCcrProxyUrlSupport(url)
}

/**
 * Compute a dedup signature for an MCP server config.
 * Two configs with the same signature are considered "the same server" for
 * plugin deduplication. Ignores env (plugins always inject CLAUDE_PLUGIN_ROOT)
 * and headers (same URL = same server regardless of auth).
 * Returns null only for configs with neither command nor url (sdk type).
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  return getMcpServerSignatureSupport(config)
}

/**
 * Filter plugin MCP servers, dropping any whose signature matches a
 * manually-configured server or an earlier-loaded plugin server.
 * Manual wins over plugin; between plugins, first-loaded wins.
 *
 * Plugin servers are namespaced `plugin:name:server` so they never key-collide
 * with manual servers in the merge — this content-based check catches the case
 * where both actually launch the same underlying process/connection.
 */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  return dedupPluginMcpServersSupport(pluginServers, manualServers, (message) => mcpLog(message))
}

/**
 * Filter zy.ai connectors, dropping any whose signature matches an enabled
 * manually-configured server. Manual wins: a user who wrote .mcp.json or ran
 * `zy mcp add` expressed higher intent than a connector toggled in the web UI.
 *
 * Connector keys are `zy.ai <DisplayName>` so they never key-collide with
 * manual servers in the merge — this content-based check catches the case where
 * both point at the same underlying URL (e.g. `mcp__slack__*` and
 * `mcp__Zy_ai_Slack__*` both hitting mcp.slack.com, ~600 chars/turn wasted).
 *
 * Only enabled manual servers count as dedup targets — a disabled manual server
 * mustn't suppress its connector twin, or neither runs.
 */
export function dedupZyAIMcpServers(
  zyAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  return dedupZyAIMcpServersSupport(zyAiServers, manualServers, isMcpServerDisabled, (message) =>
    mcpLog(message),
  )
}

/**
 * Get the settings to use for MCP server allowlist policy.
 * When allowManagedMcpServersOnly is set in policySettings, only managed settings
 * control which servers are allowed. Otherwise, returns merged settings.
 */
function getMcpAllowlistSettings(): SettingsJson {
  if (shouldAllowManagedMcpServersOnly()) {
    return getSettingsForSource('policySettings') ?? {}
  }
  return getInitialSettings()
}

/**
 * Get the settings to use for MCP server denylist policy.
 * Denylists always merge from all sources — users can always deny servers
 * for themselves, even when allowManagedMcpServersOnly is set.
 */
function getMcpDenylistSettings(): SettingsJson {
  return getInitialSettings()
}

/**
 * Check if an MCP server is denied by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if denied, false if not on denylist
 */
function isMcpServerDenied(serverName: string, config?: McpServerConfig): boolean {
  return isMcpServerDeniedSupport(serverName, getMcpDenylistSettings, config)
}

/**
 * Check if an MCP server is allowed by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if allowed, false if blocked by policy
 */
function isMcpServerAllowedByPolicy(serverName: string, config?: McpServerConfig): boolean {
  return isMcpServerAllowedByPolicySupport(
    serverName,
    getMcpAllowlistSettings,
    getMcpDenylistSettings,
    config,
  )
}

/**
 * Filter a record of MCP server configs by managed policy (allowedMcpServers /
 * deniedMcpServers). Servers blocked by policy are dropped and their names
 * returned so callers can warn the user.
 *
 * Intended for user-controlled config entry points that bypass the policy filter
 * in getZyCodeMcpConfigs(): --mcp-config (main.tsx) and the mcp_set_servers
 * control message (print.ts, SDK V2 Query.setMcpServers()).
 *
 * SDK-type servers are exempt — they are SDK-managed transport placeholders,
 * not CLI-managed connections. The CLI never spawns a process or opens a
 * network connection for them; tool calls route back to the SDK via
 * mcp_tool_call. URL/command-based allowlist entries are meaningless for them
 * (no url, no command), and gating by name would silently drop them during
 * installPluginsAndApplyMcpInBackground's sdkMcpConfigs carry-forward.
 *
 * The generic has no type constraint because the two callsites use different
 * config type families: main.tsx uses ScopedMcpServerConfig (service type,
 * args: string[] required), print.ts uses McpServerConfigForProcessTransport
 * (SDK wire type, args?: string[] optional). Both are structurally compatible
 * with what isMcpServerAllowedByPolicy actually reads (type/url/command/args)
 * — the policy check only reads, never requires any field to be present.
 * The `as McpServerConfig` widening is safe for that reason; the downstream
 * checks tolerate missing/undefined fields: `config` is optional, and
 * `getServerCommandArray` defaults `args` to `[]` via `?? []`.
 */
export function filterMcpServersByPolicy<T>(configs: Record<string, T>): {
  allowed: Record<string, T>
  blocked: string[]
} {
  return filterMcpServersByPolicySupport(configs, isMcpServerAllowedByPolicy)
}

/**
 * Add a new MCP server configuration
 * @param name The name of the server
 * @param config The server configuration
 * @param scope The configuration scope
 * @throws Error if name is invalid or server already exists, or if the config is invalid
 */
export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
): Promise<void> {
  if (name.match(/[^a-zA-Z0-9_-]/)) {
    throw new Error(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }

  // 阻止保留的服务器名称 "claude-in-chrome"
  if (isClaudeInChromeMCPServer(name)) {
    throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
  }

  if (feature('CHICAGO_MCP')) {
    const { isComputerUseMCPServer } = await import('../computer-use/common.js')
    if (isComputerUseMCPServer(name)) {
      throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
    }
  }

  // 当存在企业 MCP 配置时阻止添加服务器（它具有独占控制）
  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers`,
    )
  }

  // 先验证配置（基于命令的策略检查需要）
  const result = McpServerConfigSchema().safeParse(config)
  if (!result.success) {
    const formattedErrors = result.error.issues
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join(', ')
    throw new Error(`Invalid configuration: ${formattedErrors}`)
  }
  const validatedConfig = result.data

  // 检查拒绝列表（含配置用于基于命令的检查）
  if (isMcpServerDenied(name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`,
    )
  }

  // 检查允许列表（含配置用于基于命令的检查）
  if (!isMcpServerAllowedByPolicy(name, validatedConfig)) {
    throw new Error(`Cannot add MCP server "${name}": not allowed by enterprise policy`)
  }

  // 检查服务器是否已存在于目标作用域中
  switch (scope) {
    case 'project': {
      const { servers } = getProjectMcpConfigsFromCwd()
      if (servers[name]) {
        throw new Error(`MCP server ${name} already exists in .mcp.json`)
      }
      break
    }
    case 'user': {
      const globalConfig = getGlobalConfig()
      if (globalConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in user config`)
      }
      break
    }
    case 'local': {
      const projectConfig = getCurrentProjectConfig()
      if (projectConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in local config`)
      }
      break
    }
    case 'dynamic':
      throw new Error('Cannot add MCP server to scope: dynamic')
    case 'enterprise':
      throw new Error('Cannot add MCP server to scope: enterprise')
    case 'zyai':
      throw new Error('Cannot add MCP server to scope: zyai')
  }

  // 根据作用域添加
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(existingServers)) {
        const { scope: _, ...configWithoutScope } = serverConfig
        mcpServers[serverName] = configWithoutScope
      }
      mcpServers[name] = validatedConfig
      const mcpConfig = { mcpServers }

      // 写回 .mcp.json
      try {
        await writeMcpjsonFile(mcpConfig)
      } catch (error) {
        throw new Error(`Failed to write to .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      saveGlobalConfig((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }

    case 'local': {
      saveCurrentProjectConfig((current) => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }

    default:
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
}

/**
 * Remove an MCP server configuration
 * @param name The name of the server to remove
 * @param scope The configuration scope
 * @throws Error if server not found in specified scope
 */
export async function removeMcpConfig(name: string, scope: ConfigScope): Promise<void> {
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      if (!existingServers[name]) {
        throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
      }

      // 写回 .mcp.json 时剥离作用域信息
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(existingServers)) {
        if (serverName !== name) {
          const { scope: _, ...configWithoutScope } = serverConfig
          mcpServers[serverName] = configWithoutScope
        }
      }
      const mcpConfig = { mcpServers }
      try {
        await writeMcpjsonFile(mcpConfig)
      } catch (error) {
        throw new Error(`Failed to remove from .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      const config = getGlobalConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No user-scoped MCP server found with name: ${name}`)
      }
      saveGlobalConfig((current) => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      break
    }

    case 'local': {
      // 更新前先检查服务器是否存在
      const config = getCurrentProjectConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No project-local MCP server found with name: ${name}`)
      }
      saveCurrentProjectConfig((current) => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      break
    }

    default:
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
}

/**
 * Get MCP configs from current directory only (no parent traversal).
 * Used by addMcpConfig and removeMcpConfig to modify the local .mcp.json file.
 * Exported for testing purposes.
 *
 * @returns Servers with scope information and any validation errors from current directory's .mcp.json
 */
export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  return getProjectMcpConfigsFromCwdSupport()
}

/**
 * Get all MCP configurations from a specific scope
 * @param scope The configuration scope
 * @returns Servers with scope information and any validation errors
 */
export function getMcpConfigsByScope(scope: 'project' | 'user' | 'local' | 'enterprise'): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  return getMcpConfigsByScopeSupport(scope)
}

/**
 * Get an MCP server configuration by name
 * @param name The name of the server
 * @returns The server configuration with scope, or undefined if not found
 */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')

  // 当 MCP 锁定为仅插件时，仅企业服务器可通过
  // 名称访问。用户/项目/本地服务器被阻止 — 与 getZyCodeMcpConfigs() 相同。
  if (isRestrictedToPluginOnly('mcp')) {
    return enterpriseServers[name] ?? null
  }

  const { servers: userServers } = getMcpConfigsByScope('user')
  const { servers: projectServers } = getMcpConfigsByScope('project')
  const { servers: localServers } = getMcpConfigsByScope('local')

  if (enterpriseServers[name]) {
    return enterpriseServers[name]
  }
  if (localServers[name]) {
    return localServers[name]
  }
  if (projectServers[name]) {
    return projectServers[name]
  }
  if (userServers[name]) {
    return userServers[name]
  }

  return null
}

/**
 * Get ZY Code MCP configurations (excludes zy.ai servers from the
 * returned set — they're fetched separately and merged by callers).
 * This is fast: only local file reads; no awaited network calls on the
 * critical path. The optional extraDedupTargets promise (e.g. the in-flight
 * zy.ai connector fetch) is awaited only after loadAllPluginsCacheOnly() completes,
 * so the two overlap rather than serialize.
 * @returns ZY Code server configurations with appropriate scopes
 */
export async function getZyCodeMcpConfigs(
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
  extraDedupTargets: Promise<Record<string, ScopedMcpServerConfig>> = Promise.resolve({}),
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')

  // 如果存在企业 mcp 配置，不使用任何其他配置；这对所有 MCP 服务器具有独占控制
  //（企业客户通常不希望用户能够添加自己的 MCP 服务器）。
  if (doesEnterpriseMcpConfigExist()) {
    // 对企业服务器应用策略过滤
    const filtered: Record<string, ScopedMcpServerConfig> = {}

    for (const [name, serverConfig] of Object.entries(enterpriseServers)) {
      if (!isMcpServerAllowedByPolicy(name, serverConfig)) {
        continue
      }
      filtered[name] = serverConfig
    }

    return { servers: filtered, errors: [] }
  }

  // 加载其他作用域 — 除非托管策略将 MCP 锁定为仅插件。
  // 与上面的企业独占块不同，这会保留插件服务器。
  const mcpLocked = isRestrictedToPluginOnly('mcp')
  const noServers: { servers: Record<string, ScopedMcpServerConfig> } = {
    servers: {},
  }
  const { servers: userServers } = mcpLocked ? noServers : getMcpConfigsByScope('user')
  const { servers: projectServers } = mcpLocked ? noServers : getMcpConfigsByScope('project')
  const { servers: localServers } = mcpLocked ? noServers : getMcpConfigsByScope('local')

  // 加载插件 MCP 服务器
  const pluginMcpServers: Record<string, ScopedMcpServerConfig> = {}

  const pluginResult = await loadAllPluginsCacheOnly()

  // 收集服务器加载期间的 MCP 特定错误
  const mcpErrors: PluginError[] = []

  // 记录任何插件加载错误 — 生产中绝不静默失败
  if (pluginResult.errors.length > 0) {
    for (const error of pluginResult.errors) {
      // 仅当确实是 MCP 相关时才记录为 MCP 错误
      // 否则仅记录为调试，因为插件可能没有 MCP 服务器
      if (
        error.type === 'mcp-config-invalid' ||
        error.type === 'mcpb-download-failed' ||
        error.type === 'mcpb-extract-failed' ||
        error.type === 'mcpb-invalid-manifest'
      ) {
        const errorMessage = `Plugin MCP loading error - ${error.type}: ${getPluginErrorMessage(error)}`
        logError(new Error(errorMessage))
      } else {
        // 插件不存在或不可用 — 这很常见，不一定是错误
        // 插件系统会在可能时处理安装
        const errorType = error.type
        mcpLog(`Plugin not available for MCP: ${error.source} - error type: ${errorType}`)
      }
    }
  }

  // 并行处理已启用插件的 MCP 服务器
  const pluginServerResults = await Promise.all(
    // biome-ignore lint/suspicious/noExplicitAny: MCP 协议动态类型处理
    pluginResult.enabled.map((plugin: any) => getPluginMcpServers(plugin, mcpErrors)),
  )
  for (const servers of pluginServerResults) {
    if (servers) {
      Object.assign(pluginMcpServers, servers)
    }
  }

  // 将服务器加载的任何 MCP 特定错误添加到插件错误中
  if (mcpErrors.length > 0) {
    for (const error of mcpErrors) {
      const errorMessage = `Plugin MCP server error - ${error.type}: ${getPluginErrorMessage(error)}`
      logError(new Error(errorMessage))
    }
  }

  // 过滤项目服务器以仅包含已批准的
  const approvedProjectServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(projectServers)) {
    if (getProjectMcpServerStatus(name) === 'approved') {
      approvedProjectServers[name] = config
    }
  }

  // 对插件服务器与手动配置的服务器进行去重（以及彼此之间）。
  // 插件服务器键使用命名空间 `plugin:x:y`，因此它们永远不会与
  // 下面的合并中的手动键冲突 — 基于内容的过滤器捕获
  // 两者都会启动相同底层进程/连接的情况。
  // 仅实际会连接的服务器才是有效的去重目标 —
  // 禁用的手动服务器不应压制插件服务器，否则两者都不运行
  //（手动在连接时按名称跳过；插件在此被移除）。
  const extraTargets = await extraDedupTargets
  const enabledManualServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries({
    ...userServers,
    ...approvedProjectServers,
    ...localServers,
    ...dynamicServers,
    ...extraTargets,
  })) {
    if (!isMcpServerDisabled(name) && isMcpServerAllowedByPolicy(name, config)) {
      enabledManualServers[name] = config
    }
  }
  // 分离被禁用/被策略阻止的插件服务器，使它们不会在
  // 与已启用的重复项竞争时赢得"首个插件胜出" — 与上面相同的不变量。
  // 它们在对之后合并回去，因此它们仍出现在 /mcp 中
  //（此函数末尾的策略过滤会丢弃被阻止的）。
  const enabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  const disabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(pluginMcpServers)) {
    if (isMcpServerDisabled(name) || !isMcpServerAllowedByPolicy(name, config)) {
      disabledPluginServers[name] = config
    } else {
      enabledPluginServers[name] = config
    }
  }
  const { servers: dedupedPluginServers, suppressed } = dedupPluginMcpServers(
    enabledPluginServers,
    enabledManualServers,
  )
  Object.assign(dedupedPluginServers, disabledPluginServers)
  // 在 /plugin UI 中显示压制。推入上述 logError 循环之后，
  // 因此这些不会进入错误日志 — 它们是信息性的，而非错误。
  for (const { name, duplicateOf } of suppressed) {
    // 名称是 "plugin:${pluginName}:${serverName}"，来自 addPluginScopeToServers
    const parts = name.split(':')
    if (parts[0] !== 'plugin' || parts.length < 3) {
      continue
    }
    mcpErrors.push({
      type: 'mcp-server-suppressed-duplicate',
      source: name,
      plugin: parts[1]!,
      serverName: parts.slice(2).join(':'),
      duplicateOf,
    })
  }

  // 按优先级顺序合并：plugin < user < project < local
  const configs = Object.assign(
    {},
    dedupedPluginServers,
    userServers,
    approvedProjectServers,
    localServers,
  )

  // 对合并后的配置应用策略过滤
  const filtered: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, serverConfig] of Object.entries(configs)) {
    if (!isMcpServerAllowedByPolicy(name, serverConfig as McpServerConfig)) {
      continue
    }
    filtered[name] = serverConfig as ScopedMcpServerConfig
  }

  return { servers: filtered, errors: mcpErrors }
}

/**
 * Get all MCP configurations across all scopes, including zy.ai servers.
 * This may be slow due to network calls - use getZyCodeMcpConfigs() for fast startup.
 * @returns All server configurations with appropriate scopes
 */
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  // 在企业模式下，不加载 zy.ai 服务器（企业具有独占控制）
  if (doesEnterpriseMcpConfigExist()) {
    return getZyCodeMcpConfigs()
  }

  // 在 getZyCodeMcpConfigs 之前启动 zy.ai 获取，使其重叠
  // 与内部的 loadAllPluginsCacheOnly()。已备忘录化 — 下面等待的调用是缓存命中。
  const zyaiPromise = fetchZyAIMcpConfigsIfEligible()
  const { servers: ZyCodeServers, errors } = await getZyCodeMcpConfigs({}, zyaiPromise)
  const { allowed: zyaiMcpServers } = filterMcpServersByPolicy(await zyaiPromise)

  // 抑制与已启用的手动服务器重复的 zy.ai 连接器。
  // 键永远不会冲突（`slack` 与 `zy.ai Slack`），所以下面的合并
  // 无法捕获 — 需要通过 URL 签名进行基于内容的去重。
  const { servers: dedupedZyAI } = dedupZyAIMcpServers(zyaiMcpServers, ZyCodeServers)

  // 合并时 zy.ai 具有最低优先级
  const servers = Object.assign({}, dedupedZyAI, ZyCodeServers)

  return { servers, errors }
}

/**
 * Parse and validate an MCP configuration object
 * @param params Parsing parameters
 * @returns Validated configuration with any errors
 */
export function parseMcpConfig(params: {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  return parseMcpConfigSupport(params)
}

/**
 * Parse and validate an MCP configuration from a file path
 * @param params Parsing parameters
 * @returns Validated configuration with any errors
 */
export function parseMcpConfigFromFilePath(params: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  return parseMcpConfigFromFilePathSupport(params)
}

export let doesEnterpriseMcpConfigExist: () => boolean
doesEnterpriseMcpConfigExist = memoize((): boolean => {
  const { config } = parseMcpConfigFromFilePath({
    filePath: getEnterpriseMcpFilePath(),
    expandVars: true,
    scope: 'enterprise',
  })
  return config !== null
})

/**
 * Check if MCP allowlist policy should only come from managed settings.
 * This is true when policySettings has allowManagedMcpServersOnly: true.
 * When enabled, allowedMcpServers is read exclusively from managed settings.
 * Users can still add their own MCP servers and deny servers via deniedMcpServers.
 */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
}

/**
 * Check if all MCP servers in a config are allowed with enterprise MCP config.
 */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  // 注意：虽然所有 SDK MCP 服务器从安全角度都应该是安全的，但我们仍在讨论
  // 最佳方式。同时，我们暂时将其限制为 zy-vscode，以便
  // 为启用了企业 MCP 配置的某些企业客户修复 VSCode 扩展。
  // https://anthropic.slack.com/archives/C093UA0KLD7/p1764975463670109
  return Object.values(configs).every((c) => c.type === 'sdk' && c.name === 'zy-vscode')
}

/**
 * Built-in MCP server that defaults to disabled. Unlike user-configured servers
 * (opt-out via disabledMcpServers), this requires explicit opt-in via
 * enabledMcpServers. Shows up in /mcp as disabled until the user enables it.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const DEFAULT_DISABLED_BUILTIN = feature('CHICAGO_MCP')
  ? (require('../computer-use/common.js') as typeof import('../computer-use/common.js'))
      .COMPUTER_USE_MCP_SERVER_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isDefaultDisabledBuiltin(name: string): boolean {
  return DEFAULT_DISABLED_BUILTIN !== null && name === DEFAULT_DISABLED_BUILTIN
}

/**
 * Check if an MCP server is disabled
 * @param name The name of the server
 * @returns true if the server is disabled
 */
export function isMcpServerDisabled(name: string): boolean {
  const projectConfig = getCurrentProjectConfig()
  if (isDefaultDisabledBuiltin(name)) {
    const enabledServers = projectConfig.enabledMcpServers || []
    return !enabledServers.includes(name)
  }
  const disabledServers = projectConfig.disabledMcpServers || []
  return disabledServers.includes(name)
}

function toggleMembership(list: string[], name: string, shouldContain: boolean): string[] {
  const contains = list.includes(name)
  if (contains === shouldContain) {
    return list
  }
  return shouldContain ? [...list, name] : list.filter((s) => s !== name)
}

/**
 * Enable or disable an MCP server
 * @param name The name of the server
 * @param enabled Whether the server should be enabled
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  const isBuiltinStateChange =
    isDefaultDisabledBuiltin(name) && isMcpServerDisabled(name) === enabled

  saveCurrentProjectConfig((current) => {
    if (isDefaultDisabledBuiltin(name)) {
      const prev = current.enabledMcpServers || []
      const next = toggleMembership(prev, name, enabled)
      if (next === prev) {
        return current
      }
      return { ...current, enabledMcpServers: next }
    }

    const prev = current.disabledMcpServers || []
    const next = toggleMembership(prev, name, !enabled)
    if (next === prev) {
      return current
    }
    return { ...current, disabledMcpServers: next }
  })

  if (isBuiltinStateChange) {
    logEvent('zy_builtin_mcp_toggle', {
      serverName: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      enabled,
    })
  }
}
