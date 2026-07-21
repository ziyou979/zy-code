/**
 * Shared bridge auth/URL resolution. Consolidates the ant-only
 * CLAUDE_BRIDGE_* dev overrides that were previously copy-pasted across
 * a dozen files — inboundAttachments, BriefTool/upload, bridgeMain,
 * initReplBridge, remoteBridgeCore, daemon workers, /rename,
 * /remote-control.
 *
 * Two layers: *Override() returns the ant-only env var (or undefined);
 * the non-Override versions fall through to the real OAuth store/config.
 * Callers that compose with a different auth source (e.g. daemon workers
 * using IPC auth) use the Override getters directly.
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getZyAIOAuthTokens } from '../services/auth/auth.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
/** Ant-only dev override: CLAUDE_BRIDGE_OAUTH_TOKEN, else undefined. */
export function getWireTokenOverride(): string | undefined {
  return (isInternalBuild() && process.env.CLAUDE_BRIDGE_OAUTH_TOKEN) || undefined
}

/** Ant-only dev override: CLAUDE_BRIDGE_BASE_URL, else undefined. */
export function getWireBaseUrlOverride(): string | undefined {
  return (isInternalBuild() && process.env.CLAUDE_BRIDGE_BASE_URL) || undefined
}

/**
 * Access token for bridge API calls: dev override first, then the OAuth
 * keychain. Undefined means "not logged in".
 */
export function getWireAccessToken(): string | undefined {
  return getWireTokenOverride() ?? getZyAIOAuthTokens()?.accessToken
}

/**
 * Base URL for bridge API calls: dev override first, then the production
 * OAuth config. Always returns a URL.
 */
export function getWireBaseUrl(): string {
  return getWireBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}
