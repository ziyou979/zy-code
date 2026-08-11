import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTH_OAUTH_KEY,
  getAuthConfigApiKeyFromConfig,
  getAuthConfigApiKeyHelperFromConfig,
  getAuthConfigApiFormat,
  getAuthConfigBaseUrl,
  getAuthOAuthStore,
  getAuthOAuthStoreFromConfig,
  loadAuthConfigFromPath,
  parseAuthConfig,
  saveAuthOAuthStore,
  updateAuthConfigRaw,
} from '../../../src/services/auth/authConfig.js'

describe('authConfig', () => {
  let configDir: string
  let prevConfigDir: string | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-auth-config-'))
    prevConfigDir = process.env.ZY_CONFIG_DIR
    process.env.ZY_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = prevConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('按 provider 读取 auth.json 中的 apiKey', () => {
    const config = parseAuthConfig({
      'opencode-go': { apiKey: 'provider-key' },
    })

    expect(getAuthConfigApiKeyFromConfig(config, 'opencode-go')).toBe('provider-key')
    expect(getAuthConfigApiKeyFromConfig(config, 'dashscope')).toBeUndefined()
  })

  test('按 provider 读取 auth.json 中的 apiKeyHelper', () => {
    const config = parseAuthConfig({
      dashscope: { apiKeyHelper: 'get-dashscope-key' },
    })

    expect(getAuthConfigApiKeyHelperFromConfig(config, 'dashscope')).toBe('get-dashscope-key')
    expect(getAuthConfigApiKeyHelperFromConfig(config, 'opencode-go')).toBeUndefined()
  })

  test('命名连接可集中保存底层 provider、地址、协议与密钥', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'generic-work': {
          provider: 'generic',
          baseUrl: 'https://llm.example.com/v1',
          apiFormat: 'openai-chat',
          apiKey: 'work-key',
        },
      }),
    )

    expect(
      getAuthConfigApiKeyFromConfig(
        loadAuthConfigFromPath(join(configDir, 'auth.json')),
        'generic-work',
      ),
    ).toBe('work-key')
    expect(getAuthConfigBaseUrl('generic-work')).toBe('https://llm.example.com/v1')
    expect(getAuthConfigApiFormat('generic-work')).toBe('openai-chat')
  })

  test('可从指定路径加载 auth.json', () => {
    const path = join(configDir, 'auth.json')
    writeFileSync(
      path,
      JSON.stringify({
        generic: { apiKey: 'generic-key' },
      }),
    )

    expect(getAuthConfigApiKeyFromConfig(loadAuthConfigFromPath(path), 'generic')).toBe(
      'generic-key',
    )
  })

  test('不接受 providers 包装层旧格式', () => {
    expect(
      parseAuthConfig({
        providers: {
          generic: { apiKey: 'generic-key' },
        },
      }),
    ).toBeNull()
  })

  test('解析含 oauth 块的 auth.json，且不把 oauth 当 apiKey provider', () => {
    const config = parseAuthConfig({
      dashscope: { apiKey: 'sk-ds' },
      oauth: {
        activeProvider: 'xai-oauth',
        credentials: {
          'xai-oauth': {
            access: 'at',
            refresh: 'rt',
            expires: 1_700_000_000_000,
            tokenEndpoint: 'https://auth.x.ai/oauth2/token',
          },
        },
      },
    })

    expect(config).not.toBeNull()
    expect(getAuthConfigApiKeyFromConfig(config, 'dashscope')).toBe('sk-ds')
    expect(getAuthConfigApiKeyFromConfig(config, AUTH_OAUTH_KEY)).toBeUndefined()

    const oauth = getAuthOAuthStoreFromConfig(config)
    expect(oauth.activeProvider).toBe('xai-oauth')
    expect(oauth.credentials['xai-oauth']?.access).toBe('at')
    expect(oauth.credentials['xai-oauth']?.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
  })

  test('oauth 块损坏时整文件解析失败', () => {
    expect(
      parseAuthConfig({
        oauth: {
          activeProvider: 'xai-oauth',
          credentials: {
            'xai-oauth': { access: 'at' }, // 缺 refresh/expires
          },
        },
      }),
    ).toBeNull()
  })

  test('saveAuthOAuthStore 合并写入且保留现有 apiKey', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({ dashscope: { apiKey: 'keep-me' } }, null, 2),
    )

    const result = saveAuthOAuthStore({
      activeProvider: 'xai-oauth',
      credentials: {
        'xai-oauth': {
          access: 'at-1',
          refresh: 'rt-1',
          expires: Date.now() + 60_000,
        },
      },
    })
    expect(result.success).toBe(true)

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as {
      dashscope?: { apiKey?: string }
      oauth?: {
        activeProvider?: string
        credentials?: Record<string, { access?: string }>
      }
    }
    expect(raw.dashscope?.apiKey).toBe('keep-me')
    expect(raw.oauth?.activeProvider).toBe('xai-oauth')
    expect(raw.oauth?.credentials?.['xai-oauth']?.access).toBe('at-1')

    const store = getAuthOAuthStore()
    expect(store.activeProvider).toBe('xai-oauth')
    expect(store.credentials['xai-oauth']?.access).toBe('at-1')
  })

  test('清空 oauth 时删除 oauth 键但保留 provider 条目', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        generic: { apiKey: 'g' },
        oauth: {
          activeProvider: 'xai-oauth',
          credentials: {
            'xai-oauth': { access: 'a', refresh: 'r', expires: 1 },
          },
        },
      }),
    )

    expect(saveAuthOAuthStore({ activeProvider: null, credentials: {} }).success).toBe(true)
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.oauth).toBeUndefined()
    expect((raw.generic as { apiKey: string }).apiKey).toBe('g')
  })

  test('updateAuthConfigRaw 可原子更新任意字段', () => {
    const result = updateAuthConfigRaw((current) => {
      current.xai = { apiKey: 'xai-key' }
    })
    expect(result.success).toBe(true)
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as {
      xai?: { apiKey?: string }
    }
    expect(raw.xai?.apiKey).toBe('xai-key')
  })
})
