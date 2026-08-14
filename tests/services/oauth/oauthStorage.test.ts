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
  removeOAuthCredentials,
  saveOAuthCredentials,
} from '../../../src/services/oauth/oauthStorage.js'

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
