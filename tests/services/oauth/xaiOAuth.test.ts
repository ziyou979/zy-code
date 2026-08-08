import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  DEFAULT_XAI_API_BASE_URL,
  refreshXaiOAuthToken,
  validateXaiOAuthEndpoint,
  XAI_OAUTH_CLIENT_ID,
  xaiOAuthProvider,
} from '../../../src/services/oauth/providers/xai.js'
import {
  getOAuthProvider,
  getOAuthProviders,
} from '../../../src/services/oauth/providers/registry.js'
import { getProviderEntry } from '../../../src/services/model/providerRegistry.js'

describe('xai OAuth', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('xai-oauth 已注册到 OAuth 注册表', () => {
    const provider = getOAuthProvider('xai-oauth')
    expect(provider).toBeDefined()
    expect(provider?.id).toBe('xai-oauth')
    expect(provider?.apiProvider).toBe('xai')
    expect(provider?.apiFormat).toBe('openai-responses')
    expect(getOAuthProviders().some((p) => p.id === 'xai-oauth')).toBe(true)
  })

  test('PROVIDER_REGISTRY 包含 xai 且默认走 Responses 端点', () => {
    const entry = getProviderEntry('xai')
    expect(entry).toBeDefined()
    expect(entry?.supportedFormats).toContain('openai-responses')
    expect(entry?.defaultBaseUrls?.['openai-responses']).toBe(DEFAULT_XAI_API_BASE_URL)
    expect(entry?.defaultBaseUrls?.['openai-chat']).toBe(DEFAULT_XAI_API_BASE_URL)
    expect(entry?.baseUrlEnvVar).toBe('XAI_BASE_URL')
  })

  test('validateXaiOAuthEndpoint 接受 x.ai 与子域', () => {
    expect(validateXaiOAuthEndpoint('https://auth.x.ai/oauth2/token', 'token_endpoint')).toBe(
      'https://auth.x.ai/oauth2/token',
    )
    expect(validateXaiOAuthEndpoint('https://accounts.x.ai/token', 'token_endpoint')).toBe(
      'https://accounts.x.ai/token',
    )
    expect(validateXaiOAuthEndpoint('https://x.ai/oauth/token', 'token_endpoint')).toBe(
      'https://x.ai/oauth/token',
    )
  })

  test('validateXaiOAuthEndpoint 拒绝非 https 或非 x.ai 主机', () => {
    expect(() =>
      validateXaiOAuthEndpoint('http://auth.x.ai/oauth2/token', 'token_endpoint'),
    ).toThrow(/HTTPS/)
    expect(() =>
      validateXaiOAuthEndpoint('https://evil.example.com/token', 'token_endpoint'),
    ).toThrow(/not on x\.ai/)
  })

  test('getApiKey 返回 access token', () => {
    expect(
      xaiOAuthProvider.getApiKey({
        access: 'at-1',
        refresh: 'rt-1',
        expires: Date.now() + 60_000,
      }),
    ).toBe('at-1')
  })

  test('refreshToken 成功时更新 access 并保留 refresh', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://auth.x.ai/oauth2/token')
      expect(init?.method).toBe('POST')
      const body = String(init?.body ?? '')
      expect(body).toContain('grant_type=refresh_token')
      expect(body).toContain(`client_id=${encodeURIComponent(XAI_OAUTH_CLIENT_ID)}`)
      expect(body).toContain('refresh_token=rt-old')

      return new Response(
        JSON.stringify({
          access_token: 'at-new',
          refresh_token: 'rt-new',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const refreshed = await refreshXaiOAuthToken({
      access: 'at-old',
      refresh: 'rt-old',
      expires: Date.now() - 1000,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    })

    expect(refreshed.access).toBe('at-new')
    expect(refreshed.refresh).toBe('rt-new')
    expect(refreshed.expires).toBeGreaterThan(Date.now())
    expect(refreshed.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
  })

  test('refreshToken 在 HTTP 403 时提示档位限制而非要求重登', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'permission_denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await expect(
      refreshXaiOAuthToken({
        access: 'at',
        refresh: 'rt',
        expires: Date.now() - 1000,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      }),
    ).rejects.toThrow(/HTTP 403/)
  })

  test('refreshToken 拒绝把 refresh_token 发到非 x.ai 端点', async () => {
    let tokenPostCount = 0
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://evil.example.com/auth',
            token_endpoint: 'https://evil.example.com/token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      tokenPostCount += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    // 缓存的 endpoint 非法 → re-discovery 也非法 → 抛错，绝不向 attacker POST
    await expect(
      refreshXaiOAuthToken({
        access: 'at',
        refresh: 'rt-secret',
        expires: Date.now() - 1000,
        tokenEndpoint: 'https://evil.example.com/token',
      }),
    ).rejects.toThrow(/not on x\.ai/)

    expect(tokenPostCount).toBe(0)
  })
})
