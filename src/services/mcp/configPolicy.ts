import type { SettingsJson } from '../settings/types.js'
import {
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
} from '../settings/types.js'
import type { McpServerConfig, McpStdioServerConfig } from './types.js'
import { shouldAllowManagedMcpServersOnly } from './configLookup.js'
import { getInitialSettings, getSettingsForSource } from '../settings/settings.js'

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

// ===========================================================================
//  Settings-aware 策略适配器 — 将 configLookup + settings 注入 core policy
// ===========================================================================

export type McpConfigPolicyAdapter = {
  isMcpServerDenied: (serverName: string, config?: McpServerConfig) => boolean
  isMcpServerAllowedByPolicy: (serverName: string, config?: McpServerConfig) => boolean
}

/** 从 settings 解析 allowlist 配置 */
function getMcpAllowlistSettings(): SettingsJson {
  if (shouldAllowManagedMcpServersOnly()) {
    return getSettingsForSource('policySettings') ?? ({} as SettingsJson)
  }
  return getInitialSettings()
}

/** 从 settings 解析 denylist 配置 */
function getMcpDenylistSettings(): SettingsJson {
  return getInitialSettings()
}

/**
 * 完整的 MCP 策略适配器实例。
 * 将核心 policy 函数与当前 settings 绑定，供总装和 CRUD 模块共用。
 */
export const mcpPolicyAdapter: McpConfigPolicyAdapter = {
  isMcpServerDenied(serverName: string, config?: McpServerConfig): boolean {
    return isMcpServerDenied(serverName, getMcpDenylistSettings, config)
  },
  isMcpServerAllowedByPolicy(serverName: string, config?: McpServerConfig): boolean {
    return isMcpServerAllowedByPolicy(
      serverName,
      getMcpAllowlistSettings,
      getMcpDenylistSettings,
      config,
    )
  },
}
