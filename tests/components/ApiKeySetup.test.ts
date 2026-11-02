import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLanguage } from '../../src/i18n/languageStore.js'
import {
  getPlatforms,
  getPlatformSortKey,
  saveApiKeyConnection,
} from '../../src/components/ApiKeySetup.js'
import { API_FORMATS } from '../../src/services/model/apiFormat.js'

describe('ApiKeySetup', () => {
  let configDir: string
  let prevConfigDir: string | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'zy-api-key-setup-'))
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
    setLanguage('en')
  })

  test('平台排序在中文环境下按拼音及英文字母 A-Z 统一排序', () => {
    setLanguage('zh-CN')
    const platforms = getPlatforms()
    const sortKeys = platforms.map((p) => getPlatformSortKey(p.id, p.label))

    // 验证相对顺序：A 开头的 Anthropic 必须在 B 开头的百度千帆之前
    const anthropicIndex = platforms.findIndex((p) => p.id === 'anthropic')
    const qianfanIndex = platforms.findIndex((p) => p.id === 'qianfan')
    const deepseekIndex = platforms.findIndex((p) => p.id === 'deepseek')
    const openaiIndex = platforms.findIndex((p) => p.id === 'openai')
    const zhipuIndex = platforms.findIndex((p) => p.id === 'zhipu')

    expect(anthropicIndex).toBeLessThan(qianfanIndex)
    expect(qianfanIndex).toBeLessThan(deepseekIndex)
    expect(deepseekIndex).toBeLessThan(openaiIndex)
    expect(openaiIndex).toBeLessThan(zhipuIndex)

    // 验证通用节点改名为“自定义”，在中文环境下按拼音 Zidingyi 排序
    const genericPlatform = platforms.find((p) => p.id === 'generic')
    expect(genericPlatform?.label).toBe('自定义')
    expect(getPlatformSortKey('generic', genericPlatform!.label)).toBe('Zidingyi Custom')
    const genericIndex = platforms.findIndex((p) => p.id === 'generic')
    expect(openaiIndex).toBeLessThan(genericIndex)

    // 验证整个列表严格按字母序升序
    for (let i = 0; i < sortKeys.length - 1; i++) {
      expect(
        sortKeys[i]!.localeCompare(sortKeys[i + 1]!, 'en', { sensitivity: 'base' }),
      ).toBeLessThanOrEqual(0)
    }
  })

  test('平台排序在英文环境下按英文名称字母序排列', () => {
    setLanguage('en')
    const platforms = getPlatforms()
    const labels = platforms.map((p) => p.label)

    for (let i = 0; i < labels.length - 1; i++) {
      expect(
        labels[i]!.localeCompare(labels[i + 1]!, 'en', { sensitivity: 'base' }),
      ).toBeLessThanOrEqual(0)
    }

    // 英文环境下 generic 平台显示为 Custom
    const genericPlatform = platforms.find((p) => p.id === 'generic')
    expect(genericPlatform?.label).toBe('Custom')
  })

  test('saveApiKeyConnection 保存完整 API Key 到 auth.json 而不被截断', () => {
    const fullApiKey = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const provider = saveApiKeyConnection({
      platformId: 'generic',
      apiKey: fullApiKey,
      customBaseUrl: 'https://api.example.com/v1',
      customApiFormat: 'openai-chat',
    })

    expect(provider).toBe('generic')
    const saved = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))
    expect(saved.generic.apiKey).toBe(fullApiKey)
    expect(saved.generic.apiKey.length).toBe(fullApiKey.length)
  })

  test('saveApiKeyConnection 支持所有 4 种协议格式', () => {
    for (const format of API_FORMATS) {
      saveApiKeyConnection({
        platformId: 'generic',
        apiKey: 'test-key',
        customBaseUrl: 'https://api.example.com/v1',
        customApiFormat: format,
      })

      const saved = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))
      expect(saved.generic.apiFormat).toBe(format)
    }
  })

  test('重新配置自定义或本地接口时留空密钥会清除旧密钥，并保留其他连接', () => {
    saveApiKeyConnection({ platformId: 'openai', apiKey: 'fixture-unrelated-key' })
    for (const platformId of ['generic', 'local']) {
      saveApiKeyConnection({
        platformId,
        apiKey: 'fixture-old-endpoint-key',
        customBaseUrl: 'https://old.example.invalid/v1',
        customApiFormat: 'openai-chat',
      })
      const provider = saveApiKeyConnection({
        platformId,
        apiKey: '   ',
        customBaseUrl: 'http://localhost:11434/v1',
        customApiFormat: 'openai-chat',
      })
      const saved = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8'))
      expect(saved[provider].apiKey).toBeUndefined()
      expect(saved[provider].baseUrl).toBe('http://localhost:11434/v1')
      expect(saved.openai.apiKey).toBe('fixture-unrelated-key')
    }
  })
})
