import { describe, expect, test } from 'bun:test'
import { getProviderForModelFromSettings } from '../../../src/services/model/model.js'
import type { SettingsJson } from '../../../src/utils/settings/types.js'

describe('model provider routing', () => {
  test('顶层 models 可为不同 tier 绑定不同 provider', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      mainLoopModel: 'standard',
      models: {
        standard: { provider: 'dashscope', model: 'qwen3.6-plus' },
        advanced: { provider: 'opencode-go', model: 'opencode-go/kimi-k2.7-code' },
      },
    }

    expect(getProviderForModelFromSettings(settings, 'standard', 'generic')).toBe('dashscope')
    expect(getProviderForModelFromSettings(settings, 'qwen3.6-plus', 'generic')).toBe('dashscope')
    expect(getProviderForModelFromSettings(settings, 'advanced', 'generic')).toBe('opencode-go')
    expect(getProviderForModelFromSettings(settings, 'opencode-go/kimi-k2.7-code', 'generic')).toBe(
      'opencode-go',
    )
  })

  test('provider scoped models 的字符串值隐式使用所属 provider', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      providers: {
        dashscope: {
          models: {
            compact: 'qwen3.5-flash',
          },
        },
      },
    }

    expect(getProviderForModelFromSettings(settings, 'compact', 'generic')).toBe('dashscope')
    expect(getProviderForModelFromSettings(settings, 'qwen3.5-flash', 'generic')).toBe('dashscope')
  })

  test('customModels 可通过 provider 字段绑定 provider', () => {
    const settings: SettingsJson = {
      provider: 'generic',
      customModels: [
        {
          alias: 'go-kimi',
          provider: 'opencode-go',
          model: 'opencode-go/kimi-k2.7-code',
        },
      ],
    }

    expect(getProviderForModelFromSettings(settings, 'go-kimi', 'generic')).toBe('opencode-go')
    expect(getProviderForModelFromSettings(settings, 'opencode-go/kimi-k2.7-code', 'generic')).toBe(
      'opencode-go',
    )
  })
})
