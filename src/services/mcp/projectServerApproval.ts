/**
 * 项目 MCP 服务器审批状态查询。
 *
 * 从 utils.ts 中提取以打破 config ↔ utils 循环。
 */
import { getIsNonInteractiveSession } from '../../bootstrap/runtime/runtimeContext.js'
import { isSettingSourceEnabled } from '../settings/constants.js'
import { hasSkipDangerousModePermissionPrompt, getInitialSettings } from '../settings/settings.js'
import { normalizeNameForMCP } from './normalization.js'

export function getProjectMcpServerStatus(serverName: string): 'approved' | 'rejected' | 'pending' {
  const settings = getInitialSettings()
  const normalizedName = normalizeNameForMCP(serverName)

  if (
    settings?.disabledMcpjsonServers?.some((name) => normalizeNameForMCP(name) === normalizedName)
  ) {
    return 'rejected'
  }

  if (
    settings?.enabledMcpjsonServers?.some((name) => normalizeNameForMCP(name) === normalizedName) ||
    settings?.enableAllProjectMcpServers
  ) {
    return 'approved'
  }

  if (hasSkipDangerousModePermissionPrompt() && isSettingSourceEnabled('projectSettings')) {
    return 'approved'
  }

  if (getIsNonInteractiveSession() && isSettingSourceEnabled('projectSettings')) {
    return 'approved'
  }

  return 'pending'
}
