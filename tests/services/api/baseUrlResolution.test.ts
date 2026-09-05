import { describe, expect, test } from 'bun:test'
import {
  isOfficialAnthropicApiBaseUrl,
  resolveFormatAwareBaseUrl,
} from '../../../src/services/api/baseUrlResolution.js'
import type { ProviderEntry } from '../../../src/services/model/providerRegistry.js'

describe('resolveFormatAwareBaseUrl', () => {
  // 模拟 openrouter 的双格式端点声明
  const openRouterEntry = {
    formatEndpoints: [
      { format: 'anthropic', baseUrl: 'https://openrouter.ai/api' },
      { format: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' },
    ],
  } as ProviderEntry

  test('模型把 Anthropic 连接切到 OpenAI Chat 时同步切换默认端点', () => {
    expect(
      resolveFormatAwareBaseUrl({
        configuredBaseUrl: 'https://openrouter.ai/api',
        configuredFormat: 'anthropic',
        targetFormat: 'openai-chat',
        entry: openRouterEntry,
      }),
    ).toBe('https://openrouter.ai/api/v1')
  })

  test('内置默认 URL 尾部斜杠不影响协议切换识别', () => {
    expect(
      resolveFormatAwareBaseUrl({
        configuredBaseUrl: 'https://openrouter.ai/api/',
        configuredFormat: 'anthropic',
        targetFormat: 'openai-chat',
        entry: openRouterEntry,
      }),
    ).toBe('https://openrouter.ai/api/v1')
  })

  test('用户自定义 URL 在协议切换后保持不变', () => {
    expect(
      resolveFormatAwareBaseUrl({
        configuredBaseUrl: 'https://gateway.example.com/openrouter',
        configuredFormat: 'anthropic',
        targetFormat: 'openai-chat',
        entry: openRouterEntry,
      }),
    ).toBe('https://gateway.example.com/openrouter')
  })

  test('连接协议未变化时保持已配置 URL', () => {
    expect(
      resolveFormatAwareBaseUrl({
        configuredBaseUrl: 'https://openrouter.ai/api',
        configuredFormat: 'anthropic',
        targetFormat: 'anthropic',
        entry: openRouterEntry,
      }),
    ).toBe('https://openrouter.ai/api')
  })
})

describe('isOfficialAnthropicApiBaseUrl', () => {
  test('SDK 默认端点与 Anthropic 官方端点被识别为官方', () => {
    expect(isOfficialAnthropicApiBaseUrl(undefined)).toBe(true)
    expect(isOfficialAnthropicApiBaseUrl('https://api.anthropic.com/v1/messages')).toBe(true)
  })

  test('第三方兼容端点和伪造子域名不会被识别为官方', () => {
    expect(isOfficialAnthropicApiBaseUrl('https://openrouter.ai/api')).toBe(false)
    expect(isOfficialAnthropicApiBaseUrl('https://api.anthropic.com.example.com/v1')).toBe(false)
  })

  test('无效 URL 不会被识别为官方', () => {
    expect(isOfficialAnthropicApiBaseUrl('not-a-url')).toBe(false)
  })
})
