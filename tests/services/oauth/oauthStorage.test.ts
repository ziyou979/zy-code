import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllOAuthCredentials,
  clearOAuthCredentialsCache,
  getActiveOAuthProvider,
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

  test('saveOAuthCredentials 写入 auth.json 的 oauth 块', () => {
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
      oauth?: {
        activeProvider?: string
        credentials?: Record<string, { access?: string; tokenEndpoint?: string }>
      }
    }
    expect(raw.dashscope?.apiKey).toBe('keep')
    expect(raw.oauth?.activeProvider).toBe('xai-oauth')
    expect(raw.oauth?.credentials?.['xai-oauth']?.access).toBe('at')
    expect(raw.oauth?.credentials?.['xai-oauth']?.tokenEndpoint).toBe(
      'https://auth.x.ai/oauth2/token',
    )
  })

  test('removeOAuthCredentials 切换 activeProvider', () => {
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
    expect(getActiveOAuthProvider()).toBe('anthropic')

    removeOAuthCredentials('anthropic')
    expect(getOAuthCredentials('anthropic')).toBeNull()
    expect(getActiveOAuthProvider()).toBe('xai-oauth')
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
    expect((raw.generic as { apiKey: string }).apiKey).toBe('g')
  })
})
