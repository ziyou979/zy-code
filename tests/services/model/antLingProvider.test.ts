import { describe, expect, test } from 'bun:test'
import { convertThinkingForOpenAI } from '../../../src/services/api/conversions/openai.js'
import { getProviderDisplayName } from '../../../src/services/branding/logoUtils.js'
import {
  getDefaultBaseUrl,
  getOnboardingProviderIds,
  getProviderEntry,
} from '../../../src/services/model/providerRegistry.js'
import { SettingsSchema } from '../../../src/services/settings/types.js'

describe('ant-ling provider', () => {
  test('独立接入入口支持配置解析及两个协议的默认地址', () => {
    expect(getOnboardingProviderIds()).toContain('ant-ling')
    expect(SettingsSchema().parse({ provider: 'ant-ling' }).provider).toBe('ant-ling')
    const entry = getProviderEntry('ant-ling')!
    expect(entry.formatEndpoints[0].format).toBe('openai-chat')
    expect(getDefaultBaseUrl(entry, 'openai-chat')).toBe('https://api.ant-ling.com/v1')
    expect(getDefaultBaseUrl(entry, 'anthropic')).toBe('https://api.ant-ling.com/anthropic')
    expect(entry.apiKeyLabel).toBe('Ant Ling API Key')
    expect(entry.baseUrlEnvVar).toBe('ANT_LING_BASE_URL')
  })

  test('Provider 展示名称正确', () => {
    expect(['蚂蚁百灵', 'Ant Ling']).toContain(getProviderDisplayName('ant-ling'))
  })

  test('Ring 深度推理模型使用专用 reasoning 参数映射', () => {
    expect(
      convertThinkingForOpenAI(
        { type: 'enabled', budgetTokens: 1024 },
        'Ring-2.6-1T',
        'ant-ling',
        'high',
      ),
    ).toEqual({ reasoning: { effort: 'high' } })

    expect(
      convertThinkingForOpenAI(
        { type: 'enabled', budgetTokens: 1024 },
        'Ring-2.6-1T',
        'ant-ling',
        'xhigh',
      ),
    ).toEqual({ reasoning: { effort: 'xhigh' } })

    expect(
      convertThinkingForOpenAI(
        { type: 'enabled', budgetTokens: 1024 },
        'Ring-2.6-1T',
        'ant-ling',
        'medium',
      ),
    ).toEqual({ reasoning: { effort: 'high' } })

    expect(convertThinkingForOpenAI({ type: 'disabled' }, 'Ring-2.6-1T', 'ant-ling')).toEqual({})
  })

  test('Ling 通用模型使用标准 thinking 结构', () => {
    expect(
      convertThinkingForOpenAI(
        { type: 'enabled', budgetTokens: 1024 },
        'Ling-3.0-flash',
        'ant-ling',
      ),
    ).toEqual({ thinking: { type: 'enabled' } })

    expect(
      convertThinkingForOpenAI(
        { type: 'enabled', budgetTokens: 1024 },
        'Ling-3.0-flash',
        'ant-ling',
        'high',
      ),
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })

    expect(convertThinkingForOpenAI({ type: 'disabled' }, 'Ling-3.0-flash', 'ant-ling')).toEqual({
      thinking: { type: 'disabled' },
    })
  })
})
