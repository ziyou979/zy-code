import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  defaultTierId,
  extractCloudaicompanionProject,
  geminiOAuthProvider,
  refreshGeminiOAuthToken,
  type GeminiOAuthCredentials,
} from '../../../src/services/oauth/providers/geminiOauth.js'
import {
  getOAuthProvider,
  getOAuthProviders,
} from '../../../src/services/oauth/providers/registry.js'
import {
  getDefaultBaseUrl,
  getProviderEntry,
  getSupportedFormats,
} from '../../../src/services/model/providerRegistry.js'

describe('gemini OAuth', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = process.env.ZY_CODE_ENABLE_GEMINI_OAUTH

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) {
      delete process.env.ZY_CODE_ENABLE_GEMINI_OAUTH
    } else {
      process.env.ZY_CODE_ENABLE_GEMINI_OAUTH = originalEnv
    }
  })

  test('gemini-oauth 已注册到 OAuth 注册表（按 id 获取不受 flag 影响）', () => {
    const provider = getOAuthProvider('gemini-oauth')
    expect(provider).toBeDefined()
    expect(provider?.id).toBe('gemini-oauth')
    expect(provider?.apiProvider).toBe('gemini-oauth')
    expect(provider?.apiFormat).toBe('google')
    expect(provider?.usesCallbackServer).toBe(true)
  })

  test('flag 关闭时登录入口不暴露，env 可强制开启', () => {
    delete process.env.ZY_CODE_ENABLE_GEMINI_OAUTH
    expect(getOAuthProviders().some((p) => p.id === 'gemini-oauth')).toBe(false)

    process.env.ZY_CODE_ENABLE_GEMINI_OAUTH = '1'
    expect(getOAuthProviders().some((p) => p.id === 'gemini-oauth')).toBe(true)
  })

  test('PROVIDER_REGISTRY 包含 gemini-oauth 且默认走 Code Assist 端点', () => {
    const entry = getProviderEntry('gemini-oauth')
    expect(entry).toBeDefined()
    expect(getSupportedFormats(entry!)).toContain('google')
    expect(getDefaultBaseUrl(entry!, 'google')).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal',
    )
  })

  test('getApiKey 返回 access token', () => {
    expect(
      geminiOAuthProvider.getApiKey({
        access: 'at-1',
        refresh: 'rt-1',
        expires: Date.now() + 60_000,
      }),
    ).toBe('at-1')
  })

  test('refreshToken 成功时更新 access 并继承 project/email/tier 扩展字段', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://oauth2.googleapis.com/token')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      )

      const body = String(init?.body ?? '')
      expect(body).toContain('grant_type=refresh_token')
      expect(body).toContain('refresh_token=rt-old')

      return new Response(
        JSON.stringify({
          access_token: 'at-new',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const refreshed = (await refreshGeminiOAuthToken({
      access: 'at-old',
      refresh: 'rt-old',
      expires: Date.now() - 1000,
      project: 'my-project',
      email: 'user@example.com',
      tier: 'standard-tier',
    })) as GeminiOAuthCredentials

    expect(refreshed.access).toBe('at-new')
    // Google refresh 响应通常不返回新的 refresh_token，必须保留旧值
    expect(refreshed.refresh).toBe('rt-old')
    // 扩展字段丢失会导致推理请求 400
    expect(refreshed.project).toBe('my-project')
    expect(refreshed.email).toBe('user@example.com')
    expect(refreshed.tier).toBe('standard-tier')
    expect(refreshed.expires).toBeGreaterThan(Date.now())
  })

  test('refreshToken 响应携带新 refresh_token 时予以采用', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const refreshed = await refreshGeminiOAuthToken({
      access: 'at-old',
      refresh: 'rt-old',
      expires: Date.now() - 1000,
    })
    expect(refreshed.refresh).toBe('rt-new')
  })

  test('extractCloudaicompanionProject 按三字段顺序提取', () => {
    expect(extractCloudaicompanionProject({ cloudaicompanionProject: 'proj-1' })).toBe('proj-1')
    expect(extractCloudaicompanionProject({ projectId: 'proj-2' })).toBe('proj-2')
    expect(extractCloudaicompanionProject({ project: { id: 'proj-3' } })).toBe('proj-3')
    expect(extractCloudaicompanionProject({})).toBe('')
    expect(extractCloudaicompanionProject(null)).toBe('')
    // 空白字符串视为缺失，继续向后回退
    expect(extractCloudaicompanionProject({ cloudaicompanionProject: '  ', projectId: 'x' })).toBe(
      'x',
    )
  })

  test('defaultTierId 依次回退 allowedTiers.isDefault → currentTier → free-tier', () => {
    expect(
      defaultTierId({
        allowedTiers: [
          { id: 'legacy-tier', isDefault: false },
          { id: 'standard-tier', isDefault: true },
        ],
      }),
    ).toBe('standard-tier')
    expect(defaultTierId({ currentTier: { id: 'legacy-tier' } })).toBe('legacy-tier')
    expect(defaultTierId({})).toBe('free-tier')
    expect(defaultTierId(null)).toBe('free-tier')
  })
})

test('取消浏览器回调等待后释放端口并允许重新登录', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const pending = geminiOAuthProvider.login({
      signal: controller.signal,
      onAuth: () => {
        setTimeout(() => controller.abort(), 10)
      },
      onPrompt: () => new Promise(() => {}),
      onManualCodeInput: () => new Promise(() => {}),
      onDeviceCode: () => {},
      onSelect: async () => undefined,
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  }
})
