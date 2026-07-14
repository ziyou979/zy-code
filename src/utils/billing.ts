import { getApiKey, getAuthTokenSource } from '../services/auth/auth.js'
import { getGlobalConfig } from '../services/config/config.js'
import { isEnvTruthy, isInternalBuild } from './envUtils.js'

export function hasConsoleBillingAccess(): boolean {
  // Check if cost reporting is disabled via environment变量
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  // 外部构建始终显示费用（API key 用户需要看到自己的花费）
  if (!isInternalBuild()) {
    const authSource = getAuthTokenSource()
    const hasApiKey = getApiKey() !== null
    // 只要有认证就显示费用
    return authSource.hasToken || hasApiKey
  }

  // 内部构建：检查 OAuth 角色
  const isSubscriber = false
  if (isSubscriber) {
    return false
  }

  const authSource = getAuthTokenSource()
  const hasApiKey = getApiKey() !== null

  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole
  const workspaceRole = config.oauthAccount?.workspaceRole

  if (!orgRole || !workspaceRole) {
    return false
  }

  return (
    ['admin', 'billing'].includes(orgRole) ||
    ['workspace_admin', 'workspace_billing'].includes(workspaceRole)
  )
}

// Mock billing access for /mock-limits testing (set by mockRateLimits.ts)
let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

export function hasZyAiBillingAccess(): boolean {
  // Check for mock billing access first (for /mock-limits testing)
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }

  return false
}
