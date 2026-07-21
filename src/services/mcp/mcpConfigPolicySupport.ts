import { jsonStringify } from '../../services/infra/slowOperations.js'
import type { SettingsJson } from '../settings/types.js'
import {
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
} from '../settings/types.js'
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

function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexString = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexString}$`)
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  return urlPatternToRegex(pattern).test(url)
}

export function isMcpServerDenied(
  serverName: string,
  getDenylistSettings: () => SettingsJson,
  config?: McpServerConfig,
): boolean {
  const settings = getDenylistSettings()
  if (!settings.deniedMcpServers) {
    return false
  }

  for (const entry of settings.deniedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      return true
    }
  }

  if (config) {
    const serverCommand = getServerCommandArray(config)
    if (serverCommand) {
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerCommandEntry(entry) &&
          commandArraysMatch(entry.serverCommand, serverCommand)
        ) {
          return true
        }
      }
    }

    const serverUrl = getServerUrl(config)
    if (serverUrl) {
      for (const entry of settings.deniedMcpServers) {
        if (isMcpServerUrlEntry(entry) && urlMatchesPattern(serverUrl, entry.serverUrl)) {
          return true
        }
      }
    }
  }

  return false
}

export function isMcpServerAllowedByPolicy(
  serverName: string,
  getAllowlistSettings: () => SettingsJson,
  getDenylistSettings: () => SettingsJson,
  config?: McpServerConfig,
): boolean {
  if (isMcpServerDenied(serverName, getDenylistSettings, config)) {
    return false
  }

  const settings = getAllowlistSettings()
  if (!settings.allowedMcpServers) {
    return true
  }
  if (settings.allowedMcpServers.length === 0) {
    return false
  }

  const hasCommandEntries = settings.allowedMcpServers.some(isMcpServerCommandEntry)
  const hasUrlEntries = settings.allowedMcpServers.some(isMcpServerUrlEntry)

  if (config) {
    const serverCommand = getServerCommandArray(config)
    const serverUrl = getServerUrl(config)

    if (serverCommand) {
      if (hasCommandEntries) {
        return settings.allowedMcpServers.some(
          (entry) =>
            isMcpServerCommandEntry(entry) &&
            commandArraysMatch(entry.serverCommand, serverCommand),
        )
      }
      return settings.allowedMcpServers.some(
        (entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName,
      )
    }

    if (serverUrl) {
      if (hasUrlEntries) {
        return settings.allowedMcpServers.some(
          (entry) => isMcpServerUrlEntry(entry) && urlMatchesPattern(serverUrl, entry.serverUrl),
        )
      }
      return settings.allowedMcpServers.some(
        (entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName,
      )
    }
  }

  return settings.allowedMcpServers.some(
    (entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName,
  )
}

export function filterMcpServersByPolicy<T>(
  configs: Record<string, T>,
  isAllowedByPolicy: (name: string, config?: McpServerConfig) => boolean,
): {
  allowed: Record<string, T>
  blocked: string[]
} {
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    const candidate = config as McpServerConfig
    if (candidate.type === 'sdk' || isAllowedByPolicy(name, candidate)) {
      allowed[name] = config
    } else {
      blocked.push(name)
    }
  }
  return { allowed, blocked }
}
