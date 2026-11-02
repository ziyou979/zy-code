import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllOAuthCredentials,
  clearOAuthCredentialsCache,
  getActiveOAuthProvider,
  getOAuthApiKeySyncForConnection,
  getOAuthCredentials,
  getOAuthProviderIdForConnection,
  refreshOAuthTokenForConnection,
  removeOAuthCredentials,
  saveOAuthCredentials,
} from '../../../src/services/oauth/oauthStorage.js'
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
} from '../../../src/services/oauth/providers/registry.js'
import type { OAuthCredentials } from '../../../src/services/oauth/providers/types.js'

const RACE_PROVIDER_IDS = ['race-a', 'race-b']

/** 注册刷新行为可控的测试 provider，记录每次收到的 refresh token。 */
function registerRaceProvider(
  id: string,
  refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>,
): string[] {
  const attempted: string[] = []
  registerOAuthProvider({
    id,
    name: id,
    apiProvider: 'generic',
    defaultConnectionId: id,
    login: async () => ({ access: '', refresh: '', expires: 0 }),
    refreshToken: async (credentials) => {
      attempted.push(credentials.refresh)
      return refreshToken(credentials)
    },
    getApiKey: (credentials) => credentials.access,
  })
  return attempted
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function invalidatedError(): Error {
  return Object.assign(new Error('refresh_token_reused'), { requiresReauthentication: true })
}

describe('oauthStorage (auth.json)', () => {
  let configDir: string
  let prevConfigDir: string | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-oauth-storage-'))
    prevConfigDir = process.env.ZY_CONFIG_DIR
    process.env.ZY_CONFIG_DIR = configDir
    clearOAuthCredentialsCache()
  })

  afterEach(() => {
    unregisterOAuthProvider('invalidating-test')
    for (const id of RACE_PROVIDER_IDS) {
      unregisterOAuthProvider(id)
    }
    clearOAuthCredentialsCache()
    if (prevConfigDir === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = prevConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('saveOAuthCredentials 写入 API provider 同名连接', () => {
    // 先放一个 apiKey，确认不会被冲掉
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({ dashscope: { apiKey: 'keep' } }, null, 2),
    )

    const result = saveOAuthCredentials('xai-oauth', {
      access: 'at',
      refresh: 'rt',
      expires: Date.now() + 120_000,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    })
    expect(result.success).toBe(true)
    expect(result.connectionId).toBe('xai')

    expect(getActiveOAuthProvider()).toBe('xai-oauth')
    expect(getOAuthCredentials('xai-oauth')?.access).toBe('at')

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as {
      dashscope?: { apiKey?: string }
      xai?: {
        oauth?: { provider?: string; access?: string; tokenEndpoint?: string }
      }
    }
    expect(raw.dashscope?.apiKey).toBe('keep')
    expect(raw.xai?.oauth?.provider).toBe('xai-oauth')
    expect(raw.xai?.oauth?.access).toBe('at')
    expect(raw.xai?.oauth?.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
  })

  test('removeOAuthCredentials 仅删除指定连接', () => {
    saveOAuthCredentials('xai-oauth', {
      access: 'a1',
      refresh: 'r1',
      expires: Date.now() + 60_000,
    })
    saveOAuthCredentials('anthropic', {
      access: 'a2',
      refresh: 'r2',
      expires: Date.now() + 60_000,
    })
    removeOAuthCredentials('anthropic')
    expect(getOAuthCredentials('anthropic')).toBeNull()
    expect(getActiveOAuthProvider()).toBe('xai-oauth')
  })

  test('OpenAI 与 GitHub Copilot OAuth 可同时保存为独立连接', () => {
    saveOAuthCredentials('openai-codex', {
      access: 'openai-access',
      refresh: 'openai-refresh',
      expires: Date.now() + 60_000,
    })
    saveOAuthCredentials('github-copilot', {
      access: 'copilot-access',
      refresh: 'copilot-refresh',
      expires: Date.now() + 60_000,
    })

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as {
      openai?: { oauth?: { provider?: string; access?: string } }
      'github-copilot'?: { oauth?: { provider?: string; access?: string } }
    }
    expect(raw.openai?.oauth?.provider).toBe('openai-codex')
    expect(raw.openai?.oauth?.access).toBe('openai-access')
    expect(raw['github-copilot']?.oauth?.provider).toBe('github-copilot')
    expect(raw['github-copilot']?.oauth?.access).toBe('copilot-access')
    expect(getOAuthApiKeySyncForConnection('openai')).toBe('openai-access')
    expect(getOAuthApiKeySyncForConnection('github-copilot')).toBe('copilot-access')
  })

  test('ChatGPT 订阅与 Codex、API key 保持独立且不会串用认证', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'openai-api': { provider: 'openai', apiKey: 'keep-key' },
      }),
    )
    saveOAuthCredentials('openai-codex', { access: 'codex-token', refresh: 'r', expires: 1 })
    saveOAuthCredentials('openai-chatgpt', { access: 'chatgpt-token', refresh: 'r', expires: 1 })
    expect(getOAuthApiKeySyncForConnection('openai')).toBe('codex-token')
    expect(getOAuthApiKeySyncForConnection('openai-chatgpt')).toBe('chatgpt-token')
    expect(getOAuthProviderIdForConnection('openai-api')).toBeNull()
    expect(getOAuthApiKeySyncForConnection('openai-api')).toBeNull()
    expect(getOAuthProviderIdForConnection('openai-chatgpt')).toBe('openai-chatgpt')
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8'))
    expect(raw['openai-api'].apiKey).toBe('keep-key')
    expect(raw['openai-chatgpt']).toMatchObject({
      provider: 'openai',
      apiFormat: 'openai-responses',
    })
    removeOAuthCredentials('openai-chatgpt')
    expect(getOAuthApiKeySyncForConnection('openai')).toBe('codex-token')
  })

  test('仅登录 ChatGPT 时不会接管默认 openai API key 连接', () => {
    const result = saveOAuthCredentials('openai-chatgpt', {
      access: 'chatgpt-token',
      refresh: 'r',
      expires: 1,
    })
    expect(result.connectionId).toBe('openai-chatgpt')
    expect(getOAuthProviderIdForConnection('openai')).toBeNull()
    expect(getOAuthApiKeySyncForConnection('openai')).toBeNull()
  })

  test('重新登录返回实际复用的命名连接 ID', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'chatgpt-work': {
          provider: 'openai',
          apiFormat: 'openai-responses',
          oauth: {
            provider: 'openai-chatgpt',
            access: 'old-token',
            refresh: 'old-refresh',
            expires: 1,
          },
        },
      }),
    )
    clearOAuthCredentialsCache()
    const result = saveOAuthCredentials('openai-chatgpt', {
      access: 'new-token',
      refresh: 'new-refresh',
      expires: Date.now() + 60_000,
    })
    expect(result).toMatchObject({ success: true, connectionId: 'chatgpt-work' })
    expect(getOAuthApiKeySyncForConnection('chatgpt-work')).toBe('new-token')
  })

  test('登录入口关闭时仍能识别没有 provider 字段的既有 OAuth 连接', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        'gemini-oauth': {
          oauth: {
            access: 'legacy-token',
            refresh: 'legacy-refresh',
            expires: Date.now() + 60_000,
          },
        },
      }),
    )
    clearOAuthCredentialsCache()
    expect(getOAuthProviderIdForConnection('gemini-oauth')).toBe('gemini-oauth')
    expect(getOAuthApiKeySyncForConnection('gemini-oauth')).toBe('legacy-token')
  })

  test('刷新凭据被判定失效时删除该连接的 OAuth，避免重复发送 refresh token', async () => {
    registerOAuthProvider({
      id: 'invalidating-test',
      name: 'Invalidating test',
      apiProvider: 'generic',
      defaultConnectionId: 'invalidating-test',
      login: async () => ({ access: '', refresh: '', expires: 0 }),
      refreshToken: async () => {
        throw Object.assign(new Error('refresh token invalid'), {
          requiresReauthentication: true,
        })
      },
      getApiKey: (credentials) => credentials.access,
    })
    saveOAuthCredentials('invalidating-test', {
      access: 'expired-access',
      refresh: 'invalid-refresh',
      expires: 1,
    })

    expect(await refreshOAuthTokenForConnection('invalidating-test')).toBe(false)
    expect(getOAuthProviderIdForConnection('invalidating-test')).toBeNull()
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8'))
    expect(raw['invalidating-test']?.oauth).toBeUndefined()
  })

  test('同一连接的并发刷新合并为一次请求，完成后允许再次刷新', async () => {
    const gate = deferred()
    const attempted = registerRaceProvider('race-a', async (credentials) => {
      await gate.promise
      return {
        access: `access-after-${credentials.refresh}`,
        refresh: `${credentials.refresh}-next`,
        expires: Date.now() + 3_600_000,
      }
    })
    saveOAuthCredentials('race-a', { access: 'old-access', refresh: 'r1', expires: 1 })

    const first = refreshOAuthTokenForConnection('race-a')
    const second = refreshOAuthTokenForConnection('race-a')
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(attempted).toEqual(['r1'])
    expect(getOAuthApiKeySyncForConnection('race-a')).toBe('access-after-r1')

    // 成功后进行中状态已清理，下一次刷新使用轮换后的 refresh token
    expect(await refreshOAuthTokenForConnection('race-a')).toBe(true)
    expect(attempted).toEqual(['r1', 'r1-next'])
  })

  test('过期的 refresh_token_reused 失败不会删除外部已保存的新凭据', async () => {
    const gate = deferred()
    registerRaceProvider('race-a', async () => {
      await gate.promise
      throw invalidatedError()
    })
    saveOAuthCredentials('race-a', { access: 'old-access', refresh: 'r1', expires: 1 })

    const pending = refreshOAuthTokenForConnection('race-a')
    // 另一个进程或调用方在本次刷新失败前已经轮换并保存了新凭据
    saveOAuthCredentials(
      'race-a',
      { access: 'rotated-access', refresh: 'r2', expires: Date.now() + 3_600_000 },
      'race-a',
    )
    gate.resolve()

    expect(await pending).toBe(true)
    expect(getOAuthProviderIdForConnection('race-a')).toBe('race-a')
    expect(getOAuthApiKeySyncForConnection('race-a')).toBe('rotated-access')
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8'))
    expect(raw['race-a'].oauth).toMatchObject({ access: 'rotated-access', refresh: 'r2' })
  })

  test('不同连接的刷新互不合并、互不影响', async () => {
    const gate = deferred()
    const attemptedA = registerRaceProvider('race-a', async () => {
      await gate.promise
      return { access: 'a-new', refresh: 'ra2', expires: Date.now() + 3_600_000 }
    })
    const attemptedB = registerRaceProvider('race-b', async () => {
      await gate.promise
      throw invalidatedError()
    })
    saveOAuthCredentials('race-a', { access: 'a-old', refresh: 'ra1', expires: 1 })
    saveOAuthCredentials('race-b', { access: 'b-old', refresh: 'rb1', expires: 1 })

    const a = refreshOAuthTokenForConnection('race-a')
    const b = refreshOAuthTokenForConnection('race-b')
    gate.resolve()
    expect(await Promise.all([a, b])).toEqual([true, false])
    expect(attemptedA).toEqual(['ra1'])
    expect(attemptedB).toEqual(['rb1'])
    expect(getOAuthApiKeySyncForConnection('race-a')).toBe('a-new')
    expect(getOAuthProviderIdForConnection('race-b')).toBeNull()
  })

  test('并发刷新遇到真正失效的 token 只请求一次并删除该连接', async () => {
    const gate = deferred()
    const attempted = registerRaceProvider('race-a', async () => {
      await gate.promise
      throw invalidatedError()
    })
    saveOAuthCredentials('race-a', { access: 'old-access', refresh: 'r1', expires: 1 })

    const first = refreshOAuthTokenForConnection('race-a')
    const second = refreshOAuthTokenForConnection('race-a')
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([false, false])
    expect(attempted).toEqual(['r1'])
    expect(getOAuthProviderIdForConnection('race-a')).toBeNull()
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8'))
    expect(raw['race-a']?.oauth).toBeUndefined()
  })

  test('普通刷新失败保留凭据并清理进行中状态', async () => {
    let calls = 0
    registerRaceProvider('race-a', async () => {
      calls += 1
      throw new Error('network down')
    })
    saveOAuthCredentials('race-a', { access: 'old-access', refresh: 'r1', expires: 1 })

    expect(await refreshOAuthTokenForConnection('race-a')).toBe(false)
    expect(await refreshOAuthTokenForConnection('race-a')).toBe(false)
    expect(calls).toBe(2)
    expect(getOAuthApiKeySyncForConnection('race-a')).toBe('old-access')
  })

  test('保存订阅不会把已有命名 OAuth 迁移到 API key 连接', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        openai: { apiKey: 'keep-key' },
        'codex-work': {
          provider: 'openai',
          oauth: {
            provider: 'openai-codex',
            access: 'work-token',
            refresh: 'r',
            expires: 1,
          },
        },
      }),
    )
    saveOAuthCredentials('openai-chatgpt', { access: 'chatgpt-token', refresh: 'r', expires: 1 })
    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8'))
    expect(raw.openai).toEqual({ apiKey: 'keep-key' })
    expect(raw['codex-work'].oauth.access).toBe('work-token')
    expect(getOAuthProviderIdForConnection('openai')).toBeNull()
  })

  test('旧版全局 oauth 在下次写入时迁移', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        oauth: {
          activeProvider: 'xai-oauth',
          credentials: {
            'xai-oauth': { access: 'old-a', refresh: 'old-r', expires: Date.now() + 60_000 },
          },
        },
      }),
    )

    saveOAuthCredentials('openai-codex', {
      access: 'new-a',
      refresh: 'new-r',
      expires: Date.now() + 60_000,
    })

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.oauth).toBeUndefined()
    expect((raw.xai as { oauth?: { access?: string } }).oauth?.access).toBe('old-a')
    expect((raw.openai as { oauth?: { access?: string } }).oauth?.access).toBe('new-a')
  })

  test('clearAllOAuthCredentials 删除 oauth 键', () => {
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({ generic: { apiKey: 'g' } }, null, 2),
    )
    saveOAuthCredentials('xai-oauth', {
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60_000,
    })

    clearAllOAuthCredentials()
    clearOAuthCredentialsCache()

    expect(getActiveOAuthProvider()).toBeNull()
    expect(getOAuthCredentials('xai-oauth')).toBeNull()

    const raw = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(raw.oauth).toBeUndefined()
    expect((raw.xai as { oauth?: unknown } | undefined)?.oauth).toBeUndefined()
    expect((raw.generic as { apiKey: string }).apiKey).toBe('g')
  })
})
