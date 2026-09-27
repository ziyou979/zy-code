import { describe, expect, test } from 'bun:test'
import { convertThinkingForOpenAI } from '../../../src/services/api/conversions/openai.js'
import {
  getDefaultBaseUrl,
  getOnboardingProviderIds,
  getProviderEntry,
} from '../../../src/services/model/providerRegistry.js'
import { SettingsSchema } from '../../../src/services/settings/types.js'

describe('stepfun provider', () => {
  test('独立接入入口支持配置解析及两个协议的默认地址', () => {
    expect(getOnboardingProviderIds()).toContain('stepfun')
    expect(SettingsSchema().parse({ provider: 'stepfun' }).provider).toBe('stepfun')
    const entry = getProviderEntry('stepfun')!
    expect(entry.formatEndpoints[0].format).toBe('openai-chat')
    expect(getDefaultBaseUrl(entry, 'openai-chat')).toBe('https://api.stepfun.com/v1')
    expect(getDefaultBaseUrl(entry, 'anthropic')).toBe('https://api.stepfun.com')
  })

  test('推理请求只发送阶跃支持的强度参数', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(
        convertThinkingForOpenAI(
          { type: 'enabled', budgetTokens: 1024 },
          'step-3.7-flash',
          'stepfun',
          effort,
        ),
      ).toEqual({ reasoning_effort: effort })
    }
  })

  test('默认强度与内部禁用不发送未知思考开关或档位', () => {
    for (const effort of [undefined, 'on', 'off']) {
      expect(
        convertThinkingForOpenAI(
          { type: 'enabled', budgetTokens: 1024 },
          'step-5-preview',
          'stepfun',
          effort,
        ),
      ).toEqual({})
    }
    expect(convertThinkingForOpenAI({ type: 'disabled' }, 'step-5-preview', 'stepfun')).toEqual({})
  })
})
