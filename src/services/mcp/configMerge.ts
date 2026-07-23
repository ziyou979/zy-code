import { jsonStringify } from '../../services/infra/slowOperations.js'
import type { McpServerConfig, McpStdioServerConfig, ScopedMcpServerConfig } from './types.js'

function getServerCommandArray(config: McpServerConfig): string[] | null {
  if (config.type !== undefined && config.type !== 'stdio') {
    return null
  }
  const stdioConfig = config as McpStdioServerConfig
  return [stdioConfig.command, ...(stdioConfig.args ?? [])]
}

function commandArraysMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function getServerUrl(config: McpServerConfig): string | null {
  return 'url' in config ? config.url : null
}

const CCR_PROXY_PATH_MARKERS = ['/v2/session_ingress/shttp/mcp/', '/v2/ccr-sessions/']

/**
 * If the URL is a CCR proxy URL, extract the original vendor URL from the
 * mcp_url query parameter. Otherwise return the URL unchanged.
 */
export function unwrapCcrProxyUrl(url: string): string {
  if (!CCR_PROXY_PATH_MARKERS.some((marker) => url.includes(marker))) {
    return url
  }
  try {
    const parsed = new URL(url)
    const original = parsed.searchParams.get('mcp_url')
    return original || url
  } catch {
    return url
  }
}

/**
 * Compute a dedup signature for an MCP server config.
 * Two configs with the same signature are considered "the same server" for
 * plugin deduplication. Ignores env (plugins always inject CLAUDE_PLUGIN_ROOT)
 * and headers (same URL = same server regardless of auth).
 * Returns null only for configs with neither command nor url (sdk type).
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  const command = getServerCommandArray(config)
  if (command) {
    return `stdio:${jsonStringify(command)}`
  }
  const url = getServerUrl(config)
  if (url) {
    return `url:${unwrapCcrProxyUrl(url)}`
  }
  return null
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
  log: (message: string) => void,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  const manualSignatures = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    const signature = getMcpServerSignature(config)
    if (signature && !manualSignatures.has(signature)) {
      manualSignatures.set(signature, name)
    }
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  const seenPluginSignatures = new Map<string, string>()
  for (const [name, config] of Object.entries(pluginServers)) {
    const signature = getMcpServerSignature(config)
    if (signature === null) {
      servers[name] = config
      continue
    }
    const manualDuplicate = manualSignatures.get(signature)
    if (manualDuplicate !== undefined) {
      log(
        `Suppressing plugin MCP server "${name}": duplicates manually-configured "${manualDuplicate}"`,
      )
      suppressed.push({ name, duplicateOf: manualDuplicate })
      continue
    }
    const pluginDuplicate = seenPluginSignatures.get(signature)
    if (pluginDuplicate !== undefined) {
      log(
        `Suppressing plugin MCP server "${name}": duplicates earlier plugin server "${pluginDuplicate}"`,
      )
      suppressed.push({ name, duplicateOf: pluginDuplicate })
      continue
    }
    seenPluginSignatures.set(signature, name)
    servers[name] = config
  }
  return { servers, suppressed }
}

/**
 * 按 scope 优先级合并 MCP 配置：plugin < user < project < local。
 * 同名 server 时较高优先级完全覆盖较低优先级（Object.assign 语义）。
 */
export function mergeMcpConfigsByPriority(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  userServers: Record<string, ScopedMcpServerConfig>,
  projectServers: Record<string, ScopedMcpServerConfig>,
  localServers: Record<string, ScopedMcpServerConfig>,
): Record<string, ScopedMcpServerConfig> {
  return Object.assign({}, pluginServers, userServers, projectServers, localServers)
}

/**
 * 合并 zy.ai 连接器与本地配置，zy.ai 具有最低优先级。
 * 调用前需先通过 dedupZyAIMcpServers 去重。
 */
export function mergeZyAIMcpConfigs(
  zyAiServers: Record<string, ScopedMcpServerConfig>,
  localServers: Record<string, ScopedMcpServerConfig>,
): Record<string, ScopedMcpServerConfig> {
  return Object.assign({}, zyAiServers, localServers)
}

/**
 * 企业 MCP 独占选择器。
 * 当企业配置文件存在时，只返回经过策略过滤的企业服务器，跳过所有其他来源。
 *
 * @param enterpriseServers  企业配置中解析出的服务器
 * @param isEnterprisePresent 企业配置文件是否存在
 * @param isAllowedByPolicy   allow/deny 策略判定函数
 * @returns 企业过滤后的服务器，或 null（企业不存在时）
 */
export function selectEnterpriseMcpServers(
  enterpriseServers: Record<string, ScopedMcpServerConfig>,
  isEnterprisePresent: boolean,
  isAllowedByPolicy: (name: string, config: McpServerConfig) => boolean,
): { servers: Record<string, ScopedMcpServerConfig> } | null {
  if (!isEnterprisePresent) {
    return null
  }
  const filtered: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, serverConfig] of Object.entries(enterpriseServers)) {
    if (!isAllowedByPolicy(name, serverConfig)) {
      continue
    }
    filtered[name] = serverConfig
  }
  return { servers: filtered }
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
  isServerDisabled: (name: string) => boolean,
  log: (message: string) => void,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  const manualSignatures = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    if (isServerDisabled(name)) {
      continue
    }
    const signature = getMcpServerSignature(config)
    if (signature && !manualSignatures.has(signature)) {
      manualSignatures.set(signature, name)
    }
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(zyAiServers)) {
    const signature = getMcpServerSignature(config)
    const manualDuplicate = signature !== null ? manualSignatures.get(signature) : undefined
    if (manualDuplicate !== undefined) {
      log(
        `Suppressing zy.ai connector "${name}": duplicates manually-configured "${manualDuplicate}"`,
      )
      suppressed.push({ name, duplicateOf: manualDuplicate })
      continue
    }
    servers[name] = config
  }
  return { servers, suppressed }
}
