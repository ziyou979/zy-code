/**
 * 远程托管设置的资格检查。
 *
 * 缓存状态本身位于 syncCacheState.ts（叶子节点，无 auth 导入）。
 * 此文件保留 isRemoteManagedSettingsEligible — 唯一需要 auth.ts 的函数 —
 * 以及 resetSyncCache 包装器，用于同时清除叶子节点状态和本地资格镜像。
 */

import { ZY_CODE_INFERENCE_SCOPE } from '../../constants/oauth.js'
import { getAPIProvider, isAnthropicBaseUrl } from '../../services/model/providers.js'
import { getApiKeyWithSource, getZyAIOAuthTokens } from '../auth/auth.js'

import { resetSyncCache as resetLeafCache, setEligibility } from './syncCacheState.js'

let cached: boolean | undefined

export function resetSyncCache(): void {
  cached = undefined
  resetLeafCache()
}

/**
 * Check if the current user is eligible for remote managed settings
 *
 * Eligibility:
 * - Console users (API key): All eligible (must have actual key, not just apiKeyHelper)
 * - OAuth users with known subscriptionType: Only Enterprise/C4E and Team
 * - OAuth users with subscriptionType === null (externally-injected tokens via
 *   ZY_CODE_OAUTH_TOKEN / FD, or keychain tokens missing metadata): Eligible —
 *   the API returns empty settings for ineligible orgs, so the cost of a false
 *   positive is one round-trip
 *
 * This is a pre-check to determine if we should query the API.
 * The API will return empty settings for users without managed settings.
 *
 * IMPORTANT: This function must NOT call getSettings() or any function that calls
 * getSettings() to avoid circular dependencies during settings loading.
 */
export function isRemoteManagedSettingsEligible(): boolean {
  if (cached !== undefined) {
    return cached
  }

  // 3p provider users should not hit the settings endpoint
  if (getAPIProvider() !== 'anthropic') {
    return (cached = setEligibility(false))
  }

  // Custom base URL users should not hit the settings endpoint
  if (!isAnthropicBaseUrl()) {
    return (cached = setEligibility(false))
  }

  // Cowork 在具有自己权限模型的 VM 中运行；服务器托管设置
  // （为 CLI/CCD 设计）不适用那里，并且每个界面的设置还不存在。
  // 基于 MDM/文件的托管设置仍然适用 — 这些需要物理部署和不同的 IT 意图。
  if (process.env.ZY_CODE_ENTRYPOINT === 'local-agent') {
    return (cached = setEligibility(false))
  }

  // 首先检查 OAuth：大多数 Zy.ai 用户在 keychain 中没有 API 密钥。
  // API 密钥检查会生成 `security find-generic-password`（约 20-50ms），
  // 对于仅 OAuth 的用户返回 null。先检查 OAuth 可以在常见情况下
  // 短路该子进程。
  const tokens = getZyAIOAuthTokens()

  // 外部注入的令牌（CCD 通过 ZY_CODE_OAUTH_TOKEN，CCR 通过
  // ZY_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR，Agent SDK，CI）不携带
  // subscriptionType 元数据 — getZyAIOAuthTokens() 使用
  // subscriptionType: null 构建它们。令牌本身是有效的；让 API 决定。
  // fetchRemoteManagedSettings 优雅地处理 204/404（返回 {}），并且
  // settings.ts 在远程为空时回退到 MDM/文件，因此不符合资格的
  // 组织只需一次往返，其他不变。
  if (tokens?.accessToken && tokens.subscriptionType === null) {
    return (cached = setEligibility(true))
  }

  if (
    tokens?.accessToken &&
    tokens.scopes?.includes(ZY_CODE_INFERENCE_SCOPE) &&
    (tokens.subscriptionType === 'enterprise' || tokens.subscriptionType === 'team')
  ) {
    return (cached = setEligibility(true))
  }

  // 控制台用户（API 密钥）如果有实际密钥则符合资格
  // 跳过 apiKeyHelper 以避免与 getSettings() 的循环依赖
  // 用 try-catch 包装，因为 getApiKeyWithSource 在 CI/测试环境中
  // 没有 API 密钥时会抛出异常
  try {
    const { key: apiKey } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return (cached = setEligibility(true))
    }
  } catch {
    // 无 API 密钥可用（例如 CI/测试环境）
  }

  return (cached = setEligibility(false))
}
