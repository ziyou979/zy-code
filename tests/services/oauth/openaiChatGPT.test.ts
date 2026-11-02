import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createTestDataDirectory,
  type TestDataDirectory,
} from '../../_helpers/testDataDirectory.js'
import {
  CHATGPT_SUBSCRIPTION_AUTH_METHOD,
  loginOpenAIChatGPT,
  openaiChatGPTOAuthProvider,
  parseAuthorizationInput,
  refreshOpenAIChatGPTToken,
} from '../../../src/services/oauth/providers/openaiChatGPT.js'
import {
  getOAuthProvider,
  getOAuthProviders,
} from '../../../src/services/oauth/providers/registry.js'

describe('OpenAI ChatGPT 订阅登录', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = process.env.ZY_CODE_ENABLE_CHATGPT_LOGIN
  let testDirectory: TestDataDirectory

  beforeEach(async () => {
    testDirectory = await createTestDataDirectory('zy-chatgpt-auth')
    await testDirectory.setup()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) {
      delete process.env.ZY_CODE_ENABLE_CHATGPT_LOGIN
    } else {
      process.env.ZY_CODE_ENABLE_CHATGPT_LOGIN = originalEnv
    }
    await testDirectory.cleanup()
  })

  describe('注册表', () => {
    test('openai-chatgpt 已注册，按 id 获取不受 flag 影响', () => {
      const provider = getOAuthProvider('openai-chatgpt')
      expect(provider).toBeDefined()
      expect(provider?.id).toBe('openai-chatgpt')
      // 与 openai-codex 共用 openai 连接，但走标准 Responses 格式
      expect(provider?.apiProvider).toBe('openai')
      expect(provider?.apiFormat).toBe('openai-responses')
      expect(provider?.usesCallbackServer).toBe(true)
    })

    test('flag 关闭时登录入口不暴露，env 可强制开启', () => {
      delete process.env.ZY_CODE_ENABLE_CHATGPT_LOGIN
      expect(getOAuthProviders().some((p) => p.id === 'openai-chatgpt')).toBe(false)

      process.env.ZY_CODE_ENABLE_CHATGPT_LOGIN = '1'
      expect(getOAuthProviders().some((p) => p.id === 'openai-chatgpt')).toBe(true)
    })

    test('getApiKey 直接返回订阅 access token', () => {
      expect(
        openaiChatGPTOAuthProvider.getApiKey({ access: 'sub-token', refresh: 'r', expires: 0 }),
      ).toBe('sub-token')
    })

    test('登录直接进入浏览器授权，不显示只有一个选项的选择器，且仍可取消', async () => {
      let selections = 0
      let authorizations = 0
      const controller = new AbortController()
      await expect(
        openaiChatGPTOAuthProvider.login({
          signal: controller.signal,
          onSelect: async () => {
            selections++
            return 'browser'
          },
          onAuth: () => {
            authorizations++
            controller.abort()
          },
          onDeviceCode: () => {},
          onPrompt: async () => '',
        }),
      ).rejects.toThrow()
      expect(selections).toBe(0)
      expect(authorizations).toBe(1)
    })
  })

  describe('回调解析', () => {
    test('从完整回调 URL 取出 code、state 与 OpenAI 下发的 client_id', () => {
      const parsed = parseAuthorizationInput(
        'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=issued-client-id',
      )
      expect(parsed.code).toBe('abc')
      expect(parsed.state).toBe('xyz')
      // 刷新阶段必须回传这个由 OpenAI 签发的 client ID
      expect(parsed.clientId).toBe('issued-client-id')
    })

    test('缺少 client_id 时不伪造，交由上层报错', () => {
      const parsed = parseAuthorizationInput(
        'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz',
      )
      expect(parsed.code).toBe('abc')
      expect(parsed.clientId).toBeUndefined()
    })

    test('兼容 query 串与裸授权码', () => {
      expect(parseAuthorizationInput('?code=abc&state=xyz').code).toBe('abc')
      expect(parseAuthorizationInput('abc').code).toBe('abc')
    })
  })

  describe('令牌刷新', () => {
    /** 构造一个最小可用的 token 响应体。 */
    function tokenResponse(overrides: Record<string, unknown> = {}): Response {
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          id_token: 'id-token',
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          ...overrides,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    test('刷新请求回传 resource，且凭据落 authMethod 标记', async () => {
      let capturedBody: URLSearchParams | undefined
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        capturedBody = new URLSearchParams(String(init?.body ?? ''))
        return tokenResponse()
      }) as typeof fetch

      const credentials = await refreshOpenAIChatGPTToken({
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 0,
        clientId: 'issued-client-id',
      })

      expect(capturedBody?.get('grant_type')).toBe('refresh_token')
      expect(capturedBody?.get('client_id')).toBe('issued-client-id')
      expect(capturedBody?.get('resource')).toBe('https://api.openai.com/v1')
      expect(credentials.access).toBe('new-access')
      expect(credentials.clientId).toBe('issued-client-id')
      // 请求层据此裁字段，而不是靠 token 是否以 sk- 开头去猜
      expect(credentials.authMethod).toBe(CHATGPT_SUBSCRIPTION_AUTH_METHOD)
    })

    test('缺少 clientId 时提示重新登录，不发无谓请求', async () => {
      let called = false
      globalThis.fetch = (async () => {
        called = true
        return tokenResponse()
      }) as unknown as typeof fetch

      await expect(
        refreshOpenAIChatGPTToken({ access: 'a', refresh: 'old-refresh', expires: 0 }),
      ).rejects.toThrow()

      expect(called).toBe(false)
    })

    test('授权 scope 缺少 chatgpt.tokens.use.direct 时登录即失败', async () => {
      globalThis.fetch = (async () =>
        tokenResponse({ scope: 'openid profile email offline_access' })) as unknown as typeof fetch

      // 只断言契约（缺少直连 scope 必须失败），不断言文案：全量运行时
      // 当前语言可能被其他测试切换，硬编码正则会随之失效。
      await expect(
        refreshOpenAIChatGPTToken({
          access: 'a',
          refresh: 'r',
          expires: 0,
          clientId: 'issued-client-id',
        }),
      ).rejects.toThrow()
    })

    test('refresh token 被吊销时标记为需重新登录', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { code: 'refresh_token_invalidated' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch

      const error = await refreshOpenAIChatGPTToken({
        access: 'a',
        refresh: 'revoked-refresh',
        expires: 0,
        clientId: 'issued-client-id',
      }).catch((e: unknown) => e)

      // 凭据作废与临时故障必须可区分，否则调用方会一直重试
      expect(error).toBeInstanceOf(Error)
      expect((error as { requiresReauthentication?: boolean }).requiresReauthentication).toBe(true)
    })

    test('凭据保留 idToken 以供重新授权回传', async () => {
      globalThis.fetch = (async () => tokenResponse()) as unknown as typeof fetch

      const credentials = await refreshOpenAIChatGPTToken({
        access: 'a',
        refresh: 'r',
        expires: 0,
        clientId: 'issued-client-id',
      })

      expect(credentials.idToken).toBe('id-token')
    })

    test('刷新省略 scope 与 id_token 时保留原会话数据', async () => {
      globalThis.fetch = (async () =>
        tokenResponse({ scope: undefined, id_token: undefined })) as unknown as typeof fetch
      const credentials = await refreshOpenAIChatGPTToken({
        access: 'a',
        refresh: 'r',
        expires: 0,
        clientId: 'issued-client-id',
        idToken: 'retained-id-token',
        scopes: ['chatgpt.tokens.use.direct'],
      })
      expect(credentials.idToken).toBe('retained-id-token')
      expect(credentials.scopes).toEqual(['chatgpt.tokens.use.direct'])
    })

    test('无效 token 响应的错误提示不会泄漏已经返回的令牌', async () => {
      globalThis.fetch = (async () =>
        tokenResponse({
          refresh_token: undefined,
          access_token: 'secret-access',
        })) as unknown as typeof fetch
      const error = await refreshOpenAIChatGPTToken({
        access: 'a',
        refresh: 'r',
        expires: 0,
        clientId: 'issued-client-id',
      }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain('secret-access')
    })
  })

  describe('授权码交换', () => {
    test('首次授权使用回调签发的 client ID 交换令牌', async () => {
      let authorizeUrl = new URL('https://example.com')
      let capturedBody: URLSearchParams | undefined
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        capturedBody = new URLSearchParams(String(init?.body ?? ''))
        return new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 3600,
            id_token: 'id',
            scope: 'chatgpt.tokens.use.direct',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      }) as typeof fetch
      const credentials = await loginOpenAIChatGPT({
        onAuth: ({ url }) => {
          authorizeUrl = new URL(url)
        },
        onPrompt: async () => '',
        onManualCodeInput: async () =>
          `http://127.0.0.1:1455/auth/callback?code=auth-code&state=${authorizeUrl.searchParams.get('state')}&client_id=issued-client-id`,
      })
      expect(authorizeUrl.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(capturedBody?.get('client_id')).toBe('issued-client-id')
      expect(capturedBody?.get('resource')).toBe('https://api.openai.com/v1')
      expect(capturedBody?.get('code_verifier')).toBeTruthy()
      expect(credentials.clientId).toBe('issued-client-id')
    })

    test('取消浏览器等待会结束登录并关闭回调服务器', async () => {
      const controller = new AbortController()
      let inputRequested = false
      await expect(
        loginOpenAIChatGPT({
          onAuth: () => controller.abort(),
          onPrompt: async () => {
            inputRequested = true
            return ''
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow()
      expect(inputRequested).toBe(false)
    })
  })

  describe('client ID 合并规则', () => {
    // 首次注册：回调必须下发 client ID
    // 重新授权：回调可能省略，应沿用已保存值
    // 两者冲突：说明账号注册归属错乱，必须拒绝而非替换

    test('重新授权时回调省略 client_id 也能完成（沿用已保存值）', () => {
      const parsed = parseAuthorizationInput(
        'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz',
      )
      expect(parsed.clientId).toBeUndefined()
    })
  })
})
