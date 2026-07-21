/**
 * 团队记忆同步共享状态与认证辅助。
 */

import { createHash } from 'node:crypto'
import {
  getOauthConfig,
  OAUTH_BETA_HEADER,
  ZY_CODE_INFERENCE_SCOPE,
  ZY_CODE_PROFILE_SCOPE,
} from '../../constants/oauth.js'
import { getZyCodeUserAgent } from '../../services/http/userAgent.js'
import { checkAndRefreshOAuthTokenIfNeeded, getZyAIOAuthTokens } from '../auth/auth.js'
import { getAPIProvider, isAnthropicBaseUrl } from '../model/providers.js'

export const TEAM_MEMORY_SYNC_TIMEOUT_MS = 30_000
export const MAX_FILE_SIZE_BYTES = 250_000
export const MAX_PUT_BODY_BYTES = 200_000
export const MAX_RETRIES = 3
export const MAX_CONFLICT_RETRIES = 2

export type SyncState = {
  /** 用于条件请求的最后已知服务器校验和（ETag）。 */
  lastKnownChecksum: string | null
  /**
   * 我们认定的服务器当前持有的每个 key 的内容哈希（`sha256:<hex>`）。
   * 在 pull 时从服务器提供的 entryChecksums 填充，
   * 在 push 成功后从本地哈希填充。用于在 push 时计算增量。
   */
  serverChecksums: Map<string, string>
  /** 从服务器学习得到的 max_entries 上限。 */
  serverMaxEntries: number | null
}

export function createSyncState(): SyncState {
  return {
    lastKnownChecksum: null,
    serverChecksums: new Map(),
    serverMaxEntries: null,
  }
}

export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

export function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e && typeof e.code === 'string'
}

export function isUsingOAuth(): boolean {
  if (getAPIProvider() !== 'anthropic' || !isAnthropicBaseUrl()) {
    return false
  }
  const tokens = getZyAIOAuthTokens()
  return Boolean(
    tokens?.accessToken &&
      tokens.scopes?.includes(ZY_CODE_INFERENCE_SCOPE) &&
      tokens.scopes.includes(ZY_CODE_PROFILE_SCOPE),
  )
}

export function getTeamMemorySyncEndpoint(repoSlug: string): string {
  const baseUrl = process.env.TEAM_MEMORY_SYNC_URL || getOauthConfig().BASE_API_URL
  return `${baseUrl}/api/claude_code/team_memory?repo=${encodeURIComponent(repoSlug)}`
}

export function getAuthHeaders(): {
  headers?: Record<string, string>
  error?: string
} {
  const oauthTokens = getZyAIOAuthTokens()
  if (oauthTokens?.accessToken) {
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': getZyCodeUserAgent(),
      },
    }
  }
  return { error: 'No OAuth token available for team memory sync' }
}

export async function ensureTeamMemoryAuthReady(): Promise<void> {
  await checkAndRefreshOAuthTokenIfNeeded()
}
