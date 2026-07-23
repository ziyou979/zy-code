/**
 * MCP 服务器启用/禁用状态管理。
 *
 * 从 config.ts 中提取，负责服务器级别的启用/禁用切换，
 * 包括默认禁用行为（如 computer-use MCP server）。
 */
import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../config/config.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const DEFAULT_DISABLED_BUILTIN = feature('CHICAGO_MCP')
  ? (require('../computer-use/common.js') as typeof import('../computer-use/common.js'))
      .COMPUTER_USE_MCP_SERVER_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isDefaultDisabledBuiltin(name: string): boolean {
  return DEFAULT_DISABLED_BUILTIN !== null && name === DEFAULT_DISABLED_BUILTIN
}

function toggleMembership(list: string[], name: string, shouldContain: boolean): string[] {
  const contains = list.includes(name)
  if (contains === shouldContain) {
    return list
  }
  return shouldContain ? [...list, name] : list.filter((s) => s !== name)
}

export function isMcpServerDisabled(name: string): boolean {
  const projectConfig = getCurrentProjectConfig()
  if (isDefaultDisabledBuiltin(name)) {
    const enabledServers = projectConfig.enabledMcpServers || []
    return !enabledServers.includes(name)
  }
  const disabledServers = projectConfig.disabledMcpServers || []
  return disabledServers.includes(name)
}

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
