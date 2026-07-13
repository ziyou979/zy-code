import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAuthConfigApiKeyFromConfig,
  getAuthConfigApiKeyHelperFromConfig,
  loadAuthConfigFromPath,
  parseAuthConfig,
} from '../../../src/services/auth/authConfig.js'

describe('authConfig', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-auth-config-'))
  })

  afterEach(() => {
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
})
