import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  discoverAuthorizationServerMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization as sdkRefreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidGrantError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { MCP_CLIENT_METADATA_URL } from '../../../constants/oauth.js'
import { getSecureStorage } from '../../secure-storage/index.js'
import { clearKeychainCache } from '../../secure-storage/macOsKeychainHelpers.js'
import type { SecureStorageData } from '../../secure-storage/types.js'
import { openBrowser } from '../../../services/browser/browser.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import * as lockfile from '../../../services/file-persistence/lockfile.js'
import { logMCPDebug } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { logEvent } from '../../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../analytics/metadata.js'
import { buildRedirectUri } from '../oauthPort.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from '../types.js'
import { getLoggingSafeMcpBaseUrl } from '../utils.js'
import { performCrossAppAccess, XaaTokenExchangeError } from '../xaa.js'
import {
  clearIdpIdToken,
  discoverOidc,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  isXaaEnabled,
} from '../xaaIdpLogin.js'
import {
  MAX_LOCK_RETRIES,
  MCPRefreshFailureReason,
  createAuthFetch,
  fetchAuthServerMetadata,
  getServerKey,
  redactSensitiveUrlParams,
} from './oauthErrors.js'
import { getMcpClientConfig, getScopeFromMetadata } from './authProvider.js'
export class ZyAuthProvider implements OAuthClientProvider {
  private serverName: string
  private serverConfig: McpSSEServerConfig | McpHTTPServerConfig
  private redirectUri: string
  private handleRedirection: boolean
  private _codeVerifier?: string
  private _authorizationUrl?: string
  private _state?: string
  private _scopes?: string
  private _metadata?: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>
  private _refreshInProgress?: Promise<OAuthTokens | undefined>
  private _pendingStepUpScope?: string
  private onAuthorizationUrlCallback?: (url: string) => void
  private skipBrowserOpen: boolean

  constructor(
    serverName: string,
    serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
    redirectUri: string = buildRedirectUri(),
    handleRedirection = false,
    onAuthorizationUrl?: (url: string) => void,
    skipBrowserOpen?: boolean,
  ) {
    this.serverName = serverName
    this.serverConfig = serverConfig
    this.redirectUri = redirectUri
    this.handleRedirection = handleRedirection
    this.onAuthorizationUrlCallback = onAuthorizationUrl
    this.skipBrowserOpen = skipBrowserOpen ?? false
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get authorizationUrl(): string | undefined {
    return this._authorizationUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: `ZY Code (${this.serverName})`,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    }

    // Include scope from metadata if available
    const metadataScope = getScopeFromMetadata(this._metadata)
    if (metadataScope) {
      metadata.scope = metadataScope
      logMCPDebug(this.serverName, `Using scope from metadata: ${metadata.scope}`)
    }

    return metadata
  }

  /**
   * CIMD (SEP-991): URL-based client_id. When the auth server advertises
   * client_id_metadata_document_supported: true, the SDK uses this URL as the
   * client_id instead of performing Dynamic Client Registration.
   * Override via MCP_OAUTH_CLIENT_METADATA_URL env var (e.g. for testing, FedStart).
   */
  get clientMetadataUrl(): string | undefined {
    const override = process.env.MCP_OAUTH_CLIENT_METADATA_URL
    if (override) {
      logMCPDebug(this.serverName, `Using CIMD URL from env: ${override}`)
      return override
    }
    return MCP_CLIENT_METADATA_URL
  }

  setMetadata(metadata: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>): void {
    this._metadata = metadata
  }

  /**
   * Called by the fetch wrapper when a 403 insufficient_scope response is
   * detected. Setting this causes tokens() to omit refresh_token, forcing
   * the SDK's authInternal to skip its (useless) refresh path and fall through
   * to startAuthorization → redirectToAuthorization → step-up persistence.
   * RFC 6749 §6 forbids scope elevation via refresh, so refreshing would just
   * return the same-scoped token and the retry would 403 again.
   */
  markStepUpPending(scope: string): void {
    this._pendingStepUpScope = scope
    logMCPDebug(this.serverName, `Marked step-up pending: ${scope}`)
  }

  async state(): Promise<string> {
    // Generate state if not already generated for this instance
    if (!this._state) {
      this._state = randomBytes(32).toString('base64url')
      logMCPDebug(this.serverName, 'Generated new OAuth state')
    }
    return this._state
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const storage = getSecureStorage()
    const data = storage.read()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    // Check session credentials first (from DCR or previous auth)
    const storedInfo = data?.mcpOAuth?.[serverKey]
    if (storedInfo?.clientId) {
      logMCPDebug(this.serverName, `Found client info`)
      return {
        client_id: storedInfo.clientId,
        client_secret: storedInfo.clientSecret,
      }
    }

    // Fallback: pre-configured client ID from server config
    const configClientId = this.serverConfig.oauth?.clientId
    if (configClientId) {
      const clientConfig = data?.mcpOAuthClientConfig?.[serverKey]
      logMCPDebug(this.serverName, `Using pre-configured client ID`)
      return {
        client_id: configClientId,
        client_secret: clientConfig?.clientSecret,
      }
    }

    // If we don't have stored client info, return undefined to trigger registration
    logMCPDebug(this.serverName, `No client info found`)
    return undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          clientId: clientInformation.client_id,
          clientSecret: clientInformation.client_secret,
          // Provide default values for required fields if not present
          accessToken: existingData.mcpOAuth?.[serverKey]?.accessToken || '',
          expiresAt: existingData.mcpOAuth?.[serverKey]?.expiresAt || 0,
        },
      },
    }

    storage.update(updatedData)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Cross-process token changes (another CC instance refreshed or invalidated)
    // are picked up via the keychain cache TTL (see macOsKeychainStorage.ts).
    // In-process writes already invalidate the cache via storage.update().
    // We do NOT clearKeychainCache() here — tokens() is called by the MCP SDK's
    // _commonHeaders on every request, and forcing a cache miss would trigger
    // a blocking spawnSync(`security find-generic-password`) 30-40x/sec.
    // See CPU profile: spawnSync was 7.2% of total CPU after PR #19436.
    const storage = getSecureStorage()
    const data = await storage.readAsync()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const tokenData = data?.mcpOAuth?.[serverKey]

    // XAA: a cached id_token plays the same UX role as a refresh_token — run
    // the silent exchange to get a fresh access_token without a browser. The
    // id_token does expire (we re-acquire via `xaa login` when it does); the
    // point is that while it's valid, re-auth is zero-interaction.
    //
    // Only fire when we don't have a refresh_token. If the AS returned one,
    // the normal refresh path (below) is cheaper — 1 request vs the 4-request
    // XAA chain. If that refresh is revoked, refreshAuthorization() clears it
    // (invalidateCredentials('tokens')), and the next tokens() falls through
    // to here.
    //
    // Fires on:
    //   - never authed (!tokenData)                 → first connect, auto-auth
    //   - SDK partial write {accessToken:''}        → stale from past session
    //   - expired/expiring, no refresh_token        → proactive XAA re-auth
    //
    // No special-casing of {accessToken:'', expiresAt:0}. Yes, SDK auth()
    // writes that mid-flow (saveClientInformation defaults). But with this
    // 在此自动认证分支中，*首次* tokens() 调用 — auth() 写入
    // 任何内容之前 — 触发 xaaRefresh。如果 id_token 已缓存，SDK 在那里
    // 短路，永远不会到达写入。如果 id_token 未缓存，xaaRefresh
    // 在约 1 次 keychain 读取内返回 undefined，auth() 继续，写入
    // 标记，再次调用 tokens()，xaaRefresh 再次相同地失败。
    // 无害的冗余，不是浪费的交换。而对 `!==''` 的守卫会在
    // *之前* 的会话在 keychain 中留下该标记时永久破坏自动认证 —
    // 用 xaa.dev 见过的真实 bug。
    //
    // xaaRefresh() 在 id_token 未缓存时（或 settings.xaaIdp 消失时）
    // 内部短路到 undefined — 我们走到现有的需要认证路径 —
    // 用户运行 `xaa login`。
    //
    if (
      isXaaEnabled() &&
      this.serverConfig.oauth?.xaa &&
      !tokenData?.refreshToken &&
      (!tokenData?.accessToken || (tokenData.expiresAt - Date.now()) / 1000 <= 300)
    ) {
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          tokenData
            ? `XAA: access_token expiring, attempting silent exchange`
            : `XAA: no access_token yet, attempting silent exchange`,
        )
        this._refreshInProgress = this.xaaRefresh().finally(() => {
          this._refreshInProgress = undefined
        })
      }
      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) {
          return refreshed
        }
      } catch (e) {
        logMCPDebug(this.serverName, `XAA silent exchange failed: ${errorMessage(e)}`)
      }
      // 继续走。要么 id_token 未缓存（xaaRefresh 返回
      // undefined），要么交换出错。下面的普通路径处理这两种情况：
      // !tokenData → undefined → 401 → 需要认证；过期 → undefined → 相同。
    }

    if (!tokenData) {
      logMCPDebug(this.serverName, `No token data found`)
      return undefined
    }

    // 检查 token 是否过期
    const expiresIn = (tokenData.expiresAt - Date.now()) / 1000

    // Step-up 检查：如果检测到 403 insufficient_scope 且当前
    // token 没有请求的 scope，在下方省略 refresh_token，使
    // SDK 跳过刷新并走 PKCE 流程。
    const currentScopes = tokenData.scope?.split(' ') ?? []
    const needsStepUp = this._pendingStepUpScope?.split(' ').some((s) => !currentScopes.includes(s))
    if (needsStepUp) {
      logMCPDebug(
        this.serverName,
        `Step-up pending (${this._pendingStepUpScope}), omitting refresh_token`,
      )
    }

    // 如果 token 过期且没有 refresh token，返回 undefined
    if (expiresIn <= 0 && !tokenData.refreshToken) {
      logMCPDebug(this.serverName, `Token expired without refresh token`)
      return undefined
    }

    // 如果 token 过期或即将过期（5 分钟内）且有 refresh token，主动刷新。
    // 这是 UX 改进 — 避免失败请求加 token 刷新的延迟。
    // 虽然 MCP 服务器应对过期 token 返回 401（触发 SDK 级刷新），
    // 但在过期前主动刷新提供更平滑的用户体验。
    // step-up 待处理时跳过 — 刷新无法提升 scope（RFC 6749 §6）。
    if (expiresIn <= 300 && tokenData.refreshToken && !needsStepUp) {
      // 复用现有的刷新进行中中的 promise，防止并发刷新
      if (!this._refreshInProgress) {
        logMCPDebug(
          this.serverName,
          `Token expires in ${Math.floor(expiresIn)}s, attempting proactive refresh`,
        )
        this._refreshInProgress = this.refreshAuthorization(tokenData.refreshToken).finally(() => {
          this._refreshInProgress = undefined
        })
      } else {
        logMCPDebug(this.serverName, `Token refresh already in progress, reusing existing promise`)
      }

      try {
        const refreshed = await this._refreshInProgress
        if (refreshed) {
          logMCPDebug(this.serverName, `Token refreshed successfully`)
          return refreshed
        }
        logMCPDebug(this.serverName, `Token refresh failed, returning current tokens`)
      } catch (error) {
        logMCPDebug(this.serverName, `Token refresh error: ${errorMessage(error)}`)
      }
    }

    // 返回当前 token（如果刷新失败或暂时不需要，可能已过期）
    const tokens = {
      access_token: tokenData.accessToken,
      refresh_token: needsStepUp ? undefined : tokenData.refreshToken,
      expires_in: expiresIn,
      scope: tokenData.scope,
      token_type: 'Bearer',
    }

    logMCPDebug(this.serverName, `Returning tokens`)
    logMCPDebug(this.serverName, `Token length: ${tokens.access_token?.length}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)
    logMCPDebug(this.serverName, `Expires in: ${Math.floor(expiresIn)}s`)

    return tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._pendingStepUpScope = undefined
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(this.serverName, `Saving tokens`)
    logMCPDebug(this.serverName, `Token expires in: ${tokens.expires_in}`)
    logMCPDebug(this.serverName, `Has refresh token: ${!!tokens.refresh_token}`)

    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          scope: tokens.scope,
        },
      },
    }

    storage.update(updatedData)
  }

  /**
   * XAA silent refresh: cached id_token → Layer-2 exchange → new access_token.
   * No browser.
   *
   * Returns undefined if the id_token is gone from cache — caller treats this
   * as needs-interactive-reauth (transport will 401, CC surfaces it).
   *
   * On exchange failure, clears the id_token cache so the next interactive
   * auth does a fresh IdP login (the cached id_token is likely stale/revoked).
   *
   * TODO(xaa-ga): add cross-process lockfile before GA. `_refreshInProgress`
   * only dedupes within one process — two CC instances with expiring tokens
   * both fire the full 4-request XAA chain and race on storage.update().
   * Unlike inc-4829 the id_token is not single-use so both access_tokens
   * stay valid (wasted round-trips + keychain write race, not brickage),
   * but this is the shape AGENTS.md flags under "Token/auth caching across
   * process boundaries". Mirror refreshAuthorization()'s lockfile pattern.
   */
  private async xaaRefresh(): Promise<OAuthTokens | undefined> {
    const idp = getXaaIdpSettings()
    if (!idp) {
      return undefined // 配置在会话中被移除
    }

    const idToken = getCachedIdpIdToken(idp.issuer)
    if (!idToken) {
      logMCPDebug(this.serverName, 'XAA: id_token not cached, needs interactive re-auth')
      return undefined
    }

    const clientId = this.serverConfig.oauth?.clientId
    const clientConfig = getMcpClientConfig(this.serverName, this.serverConfig)
    if (!clientId || !clientConfig?.clientSecret) {
      logMCPDebug(
        this.serverName,
        'XAA: missing clientId or clientSecret in config — skipping silent refresh',
      )
      return undefined // 如果 `mcp add` 正确不应该发生
    }

    const idpClientSecret = getIdpClientSecret(idp.issuer)

    // 发现 IdP token 端点。可以缓存（fetchCache.ts 已
    // 缓存 /.well-known/ 请求），但 OIDC 元数据便宜且幂等。
    // xaaRefresh 是静默 tokens() 路径 — 软失败到 undefined，
    // 使调用者走需要认证路径而非在连接中间抛出。
    let oidc
    try {
      oidc = await discoverOidc(idp.issuer)
    } catch (e) {
      logMCPDebug(
        this.serverName,
        `XAA: OIDC discovery failed in silent refresh: ${errorMessage(e)}`,
      )
      return undefined
    }

    try {
      const tokens = await performCrossAppAccess(
        this.serverConfig.url,
        {
          clientId,
          clientSecret: clientConfig.clientSecret,
          idpClientId: idp.clientId,
          idpClientSecret,
          idpIdToken: idToken,
          idpTokenEndpoint: oidc.token_endpoint,
        },
        this.serverName,
      )
      // 直接写入（非 saveTokens）使 clientId + clientSecret 进入
      // 存储，即使这是 serverKey 的首次写入。saveTokens
      // 只展开现有数据；如果之前没有 performMCPXaaAuth 运行，
      // revokeServerTokens 稍后会读到 tokenData.clientId 为 undefined
      // 并发送缺少 client_id 的 RFC 7009 请求，严格 AS 会拒绝。
      const storage = getSecureStorage()
      const existingData = storage.read() || {}
      const serverKey = getServerKey(this.serverName, this.serverConfig)
      const prev = existingData.mcpOAuth?.[serverKey]
      storage.update({
        ...existingData,
        mcpOAuth: {
          ...existingData.mcpOAuth,
          [serverKey]: {
            ...prev,
            serverName: this.serverName,
            serverUrl: this.serverConfig.url,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? prev?.refreshToken,
            expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
            scope: tokens.scope,
            clientId,
            clientSecret: clientConfig.clientSecret,
            discoveryState: {
              authorizationServerUrl: tokens.authorizationServerUrl,
            },
          },
        },
      })
      return {
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        refresh_token: tokens.refresh_token,
      }
    } catch (e) {
      if (e instanceof XaaTokenExchangeError && e.shouldClearIdToken) {
        clearIdpIdToken(idp.issuer)
        logMCPDebug(this.serverName, 'XAA: cleared id_token after exchange failure')
      }
      throw e
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // 存储授权 URL
    this._authorizationUrl = authorizationUrl.toString()

    // 从授权 URL 中提取并存储 scope 供稍后 token 交换使用
    const scopes = authorizationUrl.searchParams.get('scope')
    logMCPDebug(
      this.serverName,
      `Authorization URL: ${redactSensitiveUrlParams(authorizationUrl.toString())}`,
    )
    logMCPDebug(this.serverName, `Scopes in URL: ${scopes || 'NOT FOUND'}`)

    if (scopes) {
      this._scopes = scopes
      logMCPDebug(this.serverName, `Captured scopes from authorization URL: ${scopes}`)
    } else {
      // 如果 URL 中没有 scope，尝试从元数据获取
      const metadataScope = getScopeFromMetadata(this._metadata)
      if (metadataScope) {
        this._scopes = metadataScope
        logMCPDebug(this.serverName, `Using scopes from metadata: ${metadataScope}`)
      } else {
        logMCPDebug(this.serverName, `No scopes available from URL or metadata`)
      }
    }

    // 持久化 scope 用于 step-up 认证：仅当传输附加的提供者
    //（handleRedirection=false）收到 step-up 401 时。SDK 调用 auth()
    // 然后调用 redirectToAuthorization 传入新 scope。我们持久化它
    // 使下次 performMCPOAuthFlow 可以使用它而无需额外探测请求。
    // 用 !handleRedirection 守卫以避免在普通认证流程中持久化
    //（scope 可能来自元数据 scopes_supported 而非 401）。
    if (this._scopes && !this.handleRedirection) {
      const storage = getSecureStorage()
      const existingData = storage.read() || {}
      const serverKey = getServerKey(this.serverName, this.serverConfig)
      const existing = existingData.mcpOAuth?.[serverKey]
      if (existing) {
        existing.stepUpScope = this._scopes
        storage.update(existingData)
        logMCPDebug(this.serverName, `Persisted step-up scope: ${this._scopes}`)
      }
    }

    if (!this.handleRedirection) {
      logMCPDebug(this.serverName, `Redirection handling is disabled, skipping redirect`)
      return
    }

    // 出于安全原因验证 URL scheme
    const urlString = authorizationUrl.toString()
    if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
      throw new Error('Invalid authorization URL: must use http:// or https:// scheme')
    }

    logMCPDebug(this.serverName, `Redirecting to authorization URL`)
    const redactedUrl = redactSensitiveUrlParams(urlString)
    logMCPDebug(this.serverName, `Authorization URL: ${redactedUrl}`)

    // 在打开浏览器之前通知 UI 授权 URL，
    // 以便浏览器打开失败时用户可以将 URL 作为后备方案查看
    if (this.onAuthorizationUrlCallback) {
      this.onAuthorizationUrlCallback(urlString)
    }

    if (!this.skipBrowserOpen) {
      logMCPDebug(this.serverName, `Opening authorization URL: ${redactedUrl}`)

      const success = await openBrowser(urlString)
      if (!success) {
        logMCPDebug(this.serverName, `Browser didn't open automatically. URL is shown in UI.`)
      }
    } else {
      logMCPDebug(
        this.serverName,
        `Skipping browser open (skipBrowserOpen=true). URL: ${redactedUrl}`,
      )
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    logMCPDebug(this.serverName, `Saving code verifier`)
    this._codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      logMCPDebug(this.serverName, `No code verifier saved`)
      throw new Error('No code verifier saved')
    }
    logMCPDebug(this.serverName, `Returning code verifier`)
    return this._codeVerifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read()
    if (!existingData?.mcpOAuth) {
      return
    }

    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const tokenData = existingData.mcpOAuth[serverKey]
    if (!tokenData) {
      return
    }

    switch (scope) {
      case 'all':
        delete existingData.mcpOAuth[serverKey]
        break
      case 'client':
        tokenData.clientId = undefined
        tokenData.clientSecret = undefined
        break
      case 'tokens':
        tokenData.accessToken = ''
        tokenData.refreshToken = undefined
        tokenData.expiresAt = 0
        break
      case 'verifier':
        this._codeVerifier = undefined
        return
      case 'discovery':
        tokenData.discoveryState = undefined
        tokenData.stepUpScope = undefined
        break
    }

    storage.update(existingData)
    logMCPDebug(this.serverName, `Invalidated credentials (scope: ${scope})`)
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const storage = getSecureStorage()
    const existingData = storage.read() || {}
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    logMCPDebug(
      this.serverName,
      `Saving discovery state (authServer: ${state.authorizationServerUrl})`,
    )

    // 仅持久化 URL，而非完整的元数据 blob。
    // authorizationServerMetadata 每个 MCP 服务器约 1.5-2KB（
    // IdP 支持的每个 grant type、PKCE 方法、端点）。在 macOS 上
    // keychain 写入通过 `security -i` 进行，有 4096 字节 stdin
    // 行限制 — 十六进制编码后约 2013 字节 JSON 总计。两个
    // OAuth MCP 服务器持久化完整元数据会溢出它，损坏
    // 凭证存储（#30337）。SDK 在下次认证时用
    // 一次 HTTP GET 重新获取缺失的元数据 — 见 node_modules/.../auth.js
    // `cachedState.authorizationServerMetadata ?? await discover...`。
    const updatedData: SecureStorageData = {
      ...existingData,
      mcpOAuth: {
        ...existingData.mcpOAuth,
        [serverKey]: {
          ...existingData.mcpOAuth?.[serverKey],
          serverName: this.serverName,
          serverUrl: this.serverConfig.url,
          accessToken: existingData.mcpOAuth?.[serverKey]?.accessToken || '',
          expiresAt: existingData.mcpOAuth?.[serverKey]?.expiresAt || 0,
          discoveryState: {
            authorizationServerUrl: state.authorizationServerUrl,
            resourceMetadataUrl: state.resourceMetadataUrl,
          },
        },
      },
    }

    storage.update(updatedData)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const storage = getSecureStorage()
    const data = storage.read()
    const serverKey = getServerKey(this.serverName, this.serverConfig)

    const cached = data?.mcpOAuth?.[serverKey]?.discoveryState
    if (cached?.authorizationServerUrl) {
      logMCPDebug(
        this.serverName,
        `Returning cached discovery state (authServer: ${cached.authorizationServerUrl})`,
      )

      return {
        authorizationServerUrl: cached.authorizationServerUrl,
        resourceMetadataUrl: cached.resourceMetadataUrl,
        resourceMetadata: cached.resourceMetadata as OAuthDiscoveryState['resourceMetadata'],
        authorizationServerMetadata:
          cached.authorizationServerMetadata as OAuthDiscoveryState['authorizationServerMetadata'],
      }
    }

    // 检查配置提示以获取直接元数据 URL
    const metadataUrl = this.serverConfig.oauth?.authServerMetadataUrl
    if (metadataUrl) {
      logMCPDebug(this.serverName, `Fetching metadata from configured URL: ${metadataUrl}`)
      try {
        const metadata = await fetchAuthServerMetadata(
          this.serverName,
          this.serverConfig.url,
          metadataUrl,
        )
        if (metadata) {
          return {
            authorizationServerUrl: metadata.issuer,
            authorizationServerMetadata:
              metadata as OAuthDiscoveryState['authorizationServerMetadata'],
          }
        }
      } catch (error) {
        logMCPDebug(
          this.serverName,
          `Failed to fetch from configured metadata URL: ${errorMessage(error)}`,
        )
      }
    }

    return undefined
  }

  async refreshAuthorization(refreshToken: string): Promise<OAuthTokens | undefined> {
    const serverKey = getServerKey(this.serverName, this.serverConfig)
    const ZyDir = getZyConfigHomeDir()
    await mkdir(ZyDir, { recursive: true })
    const sanitizedKey = serverKey.replace(/[^a-zA-Z0-9]/g, '_')
    const lockfilePath = join(ZyDir, `mcp-refresh-${sanitizedKey}.lock`)

    let release: (() => Promise<void>) | undefined
    for (let retry = 0; retry < MAX_LOCK_RETRIES; retry++) {
      try {
        logMCPDebug(this.serverName, `Acquiring refresh lock (attempt ${retry + 1})`)
        release = await lockfile.lock(lockfilePath, {
          realpath: false,
          onCompromised: () => {
            logMCPDebug(this.serverName, `Refresh lock was compromised`)
          },
        })
        logMCPDebug(this.serverName, `Acquired refresh lock`)
        break
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code === 'ELOCKED') {
          logMCPDebug(
            this.serverName,
            `Refresh lock held by another process, waiting (attempt ${retry + 1}/${MAX_LOCK_RETRIES})`,
          )
          await sleep(1000 + Math.random() * 1000)
          continue
        }
        logMCPDebug(
          this.serverName,
          `Failed to acquire refresh lock: ${code}, proceeding without lock`,
        )
        break
      }
    }
    if (!release) {
      logMCPDebug(
        this.serverName,
        `Could not acquire refresh lock after ${MAX_LOCK_RETRIES} retries, proceeding without lock`,
      )
    }

    try {
      // 获取锁后重新读取 token — 另一个进程可能已刷新
      clearKeychainCache()
      const storage = getSecureStorage()
      const data = storage.read()
      const tokenData = data?.mcpOAuth?.[serverKey]
      if (tokenData) {
        const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
        if (expiresIn > 300) {
          logMCPDebug(
            this.serverName,
            `Another process already refreshed tokens (expires in ${Math.floor(expiresIn)}s)`,
          )
          return {
            access_token: tokenData.accessToken,
            refresh_token: tokenData.refreshToken,
            expires_in: expiresIn,
            scope: tokenData.scope,
            token_type: 'Bearer',
          }
        }
        // 使用存储中最新的 refresh token
        if (tokenData.refreshToken) {
          refreshToken = tokenData.refreshToken
        }
      }
      return await this._doRefresh(refreshToken)
    } finally {
      if (release) {
        try {
          await release()
          logMCPDebug(this.serverName, `Released refresh lock`)
        } catch {
          logMCPDebug(this.serverName, `Failed to release refresh lock`)
        }
      }
    }
  }

  private async _doRefresh(refreshToken: string): Promise<OAuthTokens | undefined> {
    const MAX_ATTEMPTS = 3

    const mcpServerBaseUrl = getLoggingSafeMcpBaseUrl(this.serverConfig)
    const emitRefreshEvent = (
      outcome: 'success' | 'failure',
      reason?: MCPRefreshFailureReason,
    ): void => {
      logEvent(
        outcome === 'success' ? 'zy_mcp_oauth_refresh_success' : 'zy_mcp_oauth_refresh_failure',
        {
          transportType: this.serverConfig
            .type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...(mcpServerBaseUrl
            ? {
                mcpServerBaseUrl:
                  mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
          ...(reason
            ? {
                reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }
            : {}),
        },
      )
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logMCPDebug(this.serverName, `Starting token refresh`)
        const authFetch = createAuthFetch()

        // 如果初始 OAuth 流程中有缓存的元数据则复用，
        // 因为元数据（token 端点 URL 等）对每个认证服务器是静态的。
        // 优先级：
        // 1. 内存缓存（同会话刷新）
        // 2. 初始认证中持久化的 discovery state（跨会话）—
        //    避免每次刷新重新运行 RFC 9728 发现。
        // 3. 通过 fetchAuthServerMetadata 完整 RFC 9728 → RFC 8414 重新发现。
        let metadata = this._metadata
        if (!metadata) {
          const cached = await this.discoveryState()
          if (cached?.authorizationServerMetadata) {
            logMCPDebug(this.serverName, `Using persisted auth server metadata for refresh`)
            metadata = cached.authorizationServerMetadata
          } else if (cached?.authorizationServerUrl) {
            logMCPDebug(
              this.serverName,
              `Re-discovering metadata from persisted auth server URL: ${cached.authorizationServerUrl}`,
            )
            metadata = await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, {
              fetchFn: authFetch,
            })
          }
        }
        if (!metadata) {
          metadata = await fetchAuthServerMetadata(
            this.serverName,
            this.serverConfig.url,
            this.serverConfig.oauth?.authServerMetadataUrl,
            authFetch,
          )
        }
        if (!metadata) {
          logMCPDebug(this.serverName, `Failed to discover OAuth metadata`)
          emitRefreshEvent('failure', 'metadata_discovery_failed')
          return undefined
        }
        // 缓存供将来刷新使用
        this._metadata = metadata

        const clientInfo = await this.clientInformation()
        if (!clientInfo) {
          logMCPDebug(this.serverName, `No client information available`)
          emitRefreshEvent('failure', 'no_client_info')
          return undefined
        }

        const newTokens = await sdkRefreshAuthorization(new URL(this.serverConfig.url), {
          metadata,
          clientInformation: clientInfo,
          refreshToken,
          resource: new URL(this.serverConfig.url),
          fetchFn: authFetch,
        })

        if (newTokens) {
          logMCPDebug(this.serverName, `Token refresh successful`)
          await this.saveTokens(newTokens)
          emitRefreshEvent('success')
          return newTokens
        }

        logMCPDebug(this.serverName, `Token refresh returned no tokens`)
        emitRefreshEvent('failure', 'no_tokens_returned')
        return undefined
      } catch (error) {
        // Invalid grant 意味着 refresh token 本身无效/已撤销/过期。
        // 但另一个进程可能已成功刷新 — 先检查。
        if (error instanceof InvalidGrantError) {
          logMCPDebug(this.serverName, `Token refresh failed with invalid_grant: ${error.message}`)
          clearKeychainCache()
          const storage = getSecureStorage()
          const data = storage.read()
          const serverKey = getServerKey(this.serverName, this.serverConfig)
          const tokenData = data?.mcpOAuth?.[serverKey]
          if (tokenData) {
            const expiresIn = (tokenData.expiresAt - Date.now()) / 1000
            if (expiresIn > 300) {
              logMCPDebug(this.serverName, `Another process refreshed tokens, using those`)
              // 不作为成功发出：此进程未执行
              // 刷新，且获胜的进程已发出自己的
              // 成功事件。在此发出会重复计数。
              return {
                access_token: tokenData.accessToken,
                refresh_token: tokenData.refreshToken,
                expires_in: expiresIn,
                scope: tokenData.scope,
                token_type: 'Bearer',
              }
            }
          }
          logMCPDebug(this.serverName, `No valid tokens in storage, clearing stored tokens`)
          await this.invalidateCredentials('tokens')
          emitRefreshEvent('failure', 'invalid_grant')
          return undefined
        }

        // 超时或临时服务器错误时重试
        const isTimeoutError =
          error instanceof Error && /timeout|timed out|etimedout|econnreset/i.test(error.message)
        const isTransientServerError =
          error instanceof ServerError ||
          error instanceof TemporarilyUnavailableError ||
          error instanceof TooManyRequestsError
        const isRetryable = isTimeoutError || isTransientServerError

        if (!isRetryable || attempt >= MAX_ATTEMPTS) {
          logMCPDebug(this.serverName, `Token refresh failed: ${errorMessage(error)}`)
          emitRefreshEvent(
            'failure',
            isRetryable ? 'transient_retries_exhausted' : 'request_failed',
          )
          return undefined
        }

        const delayMs = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s
        logMCPDebug(
          this.serverName,
          `Token refresh failed, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
        )
        await sleep(delayMs)
      }
    }

    return undefined
  }
}
