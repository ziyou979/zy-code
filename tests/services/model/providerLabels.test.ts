import { describe, expect, test } from 'bun:test'
import { enOnboarding } from '../../../src/i18n/locales/en/onboarding.js'
import { zhOnboarding } from '../../../src/i18n/locales/zh-CN/onboarding.js'
import { PROVIDER_REGISTRY } from '../../../src/services/model/providerRegistry.js'

describe('Provider 展示文案', () => {
  for (const [locale, resource] of Object.entries({ en: enOnboarding, 'zh-CN': zhOnboarding })) {
    test(`${locale} 中每个平台的名称和描述都有翻译`, () => {
      // 两种语言同时缺 key 时，locale 对称性检查无法发现，必须对照真实注册表。
      for (const provider of PROVIDER_REGISTRY) {
        for (const suffix of ['', 'Desc']) {
          const key = `onboarding.platform.${provider.id}${suffix}`
          expect(resource[key], key).toBeString()
          expect(resource[key]?.trim(), key).not.toBe('')
        }
      }
    })
  }

  test('仅支持 OAuth 的 Gemini 订阅不应进入 API 密钥配置', () => {
    expect(
      PROVIDER_REGISTRY.find((provider) => provider.id === 'gemini-oauth')?.showInOnboarding,
    ).toBe(false)
  })
})
