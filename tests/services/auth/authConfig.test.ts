import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKey } from '../../../src/services/auth/auth.js'
import {
  AUTH_OAUTH_KEY,
  getAuthConfigApiKeyFromConfig,
  getAuthConfigApiKeyHelperFromConfig,
  getAuthConfigApiFormat,
  getAuthConfigBaseUrl,
  getOrCreateAuthHostId,
  getAuthOAuthStore,
  getAuthOAuthStoreFromConfig,
  getAuthOAuthConnectionsFromConfig,
  loadAuthConfigFromPath,
  parseAuthConfig,
  setAuthConfigOAuth,
  setAuthConfigConnection,
  getConfiguredConnectionIds,
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

  test('ADC 连接在选择器中可见并清理旧凭证和端点，其他连接保持不变', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        vertex: {
          apiKey: 'fixture-expired-token',
          apiKeyHelper: 'fixture-helper',
          baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1',
          modelsUrl: 'https://fixture.invalid/models',
          oauth: { access: 'fixture-access', refresh: 'fixture-refresh', expires: 1 },
        },
        'other-api': { apiKey: 'fixture-other-key' },
      }),
    )
    expect(
      setAuthConfigConnection('vertex', {
        provider: 'vertex',
        apiFormat: 'google',
        credentialType: 'google-adc',
        vertex: { project: 'fixture-project', location: 'global' },
      }).success,
    ).toBe(true)
    const saved = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))
    expect(saved.vertex).toEqual({
      provider: 'vertex',
      apiFormat: 'google',
      credentialType: 'google-adc',
      vertex: { project: 'fixture-project', location: 'global' },
    })
    expect(saved['other-api'].apiKey).toBe('fixture-other-key')
    expect(getConfiguredConnectionIds()).toContain('vertex')
    expect(setAuthConfigConnection('vertex', { apiKey: 'fixture-new-key' }).success).toBe(true)
    const apiKeyConfig = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))
    expect(apiKeyConfig.vertex.credentialType).toBeUndefined()
    expect(apiKeyConfig.vertex.vertex).toBeUndefined()
  })

  test('ChatGPT 主机标识不会使其他连接的认证配置失效', () => {
    const config = parseAuthConfig({
      deviceId: 'ae77b758-d1b3-4221-bca9-e6bcb160d730',
      dashscope: { apiKey: 'keep-key' },
      openai: {
        oauth: { provider: 'openai-codex', access: 'keep-token', refresh: 'r', expires: 1 },
      },
    })

    expect(config).not.toBeNull()
    expect(getAuthConfigApiKeyFromConfig(config, 'dashscope')).toBe('keep-key')
    expect(getAuthOAuthConnectionsFromConfig(config)).toHaveLength(1)
    expect(getAuthOAuthStoreFromConfig(config).credentials['openai-codex']?.access).toBe(
      'keep-token',
    )
    expect(getAuthConfigApiKeyFromConfig(config, 'deviceId')).toBeUndefined()
  })

  test('主机标识创建后保持稳定且保留 API key', () => {
    writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ generic: { apiKey: 'keep-key' } }))
    const hostId = getOrCreateAuthHostId()
    expect(getOrCreateAuthHostId()).toBe(hostId)
    expect(getApiKey('generic')).toBe('keep-key')
    expect(
      getAuthConfigApiKeyFromConfig(
        loadAuthConfigFromPath(join(configDir, 'auth.json')),
        'generic',
      ),
    ).toBe('keep-key')
    expect(
      getAuthOAuthConnectionsFromConfig(loadAuthConfigFromPath(join(configDir, 'auth.json'))),
    ).toHaveLength(0)
  })

  test('OpenAI 连接保留旧 OAuth 时显式 API key 不被分派到订阅后端', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        openai: {
          oauth: { provider: 'openai-codex', access: 'old-token', refresh: 'r', expires: 1 },
        },
      }),
    )
    // 全量测试有其他文件 mock model/providers；隔离进程验证真实工厂和凭据优先级。
    // eval 作为 argv 传递，不经过 shell 解释。
    const clientUrl = new URL('../../../src/services/api/client.js', import.meta.url).href
    const authUrl = new URL('../../../src/services/auth/authConfig.js', import.meta.url).href
    const source = `
      const { getLLMAdapter } = await import(${JSON.stringify(clientUrl)});
      const { setAuthConfigApiKey } = await import(${JSON.stringify(authUrl)});
      const oauth = getLLMAdapter({ model: 'gpt-5.3-codex' }).name;
      setAuthConfigApiKey('openai', 'explicit-key');
      const apiKey = getLLMAdapter({ model: 'gpt-5.3-codex' }).name;
      console.log(JSON.stringify({ oauth, apiKey }));
    `
    const child = spawnSync(process.execPath, ['--eval', source], {
      env: { ...process.env, ZY_CONFIG_DIR: configDir },
      encoding: 'utf-8',
      timeout: 10_000,
    })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout.trim())).toEqual({
      oauth: 'openai-codex-responses',
      apiKey: 'openai-responses',
    })
  })

  test('更换认证目录不会复用进程中其他用户的主机标识', () => {
    const first = getOrCreateAuthHostId()
    const otherDir = join(configDir, 'other')
    process.env.ZY_CONFIG_DIR = otherDir
    const second = getOrCreateAuthHostId()
    expect(second).not.toBe(first)
    process.env.ZY_CONFIG_DIR = configDir
    expect(getOrCreateAuthHostId()).toBe(first)
  })

  test('主机标识无法落盘时阻止注册临时身份', () => {
    const blockedPath = join(configDir, 'blocked')
    writeFileSync(blockedPath, 'file blocks directory creation')
    process.env.ZY_CONFIG_DIR = blockedPath
    expect(() => getOrCreateAuthHostId()).toThrow()
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

  test('连接内 oauth 可解析并保留扩展字段', () => {
    const config = parseAuthConfig({
      xai: {
        oauth: {
          provider: 'xai-oauth',
          access: 'at',
          refresh: 'rt',
          expires: 1_700_000_000_000,
          tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        },
      },
    })
    const [connection] = getAuthOAuthConnectionsFromConfig(config)
    expect(connection?.connectionId).toBe('xai')
    expect(connection?.providerId).toBe('xai-oauth')
    expect(connection?.credentials.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
  })

  test('setAuthConfigOAuth 合并写入连接且保留现有 apiKey', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({ dashscope: { apiKey: 'keep-me' } }, null, 2),
    )

    const result = setAuthConfigOAuth('xai', 'xai-oauth', {
      access: 'at-1',
      refresh: 'rt-1',
      expires: Date.now() + 60_000,
    })
    expect(result.success).toBe(true)

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as {
      dashscope?: { apiKey?: string }
      xai?: { oauth?: { provider?: string; access?: string } }
    }
    expect(raw.dashscope?.apiKey).toBe('keep-me')
    expect(raw.xai?.oauth?.provider).toBe('xai-oauth')
    expect(raw.xai?.oauth?.access).toBe('at-1')

    const store = getAuthOAuthStore()
    expect(store.activeProvider).toBe('xai-oauth')
    expect(store.credentials['xai-oauth']?.access).toBe('at-1')
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
