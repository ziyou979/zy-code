import { afterEach, expect, test } from 'bun:test'
import {
  formatModelTierProviderLabel,
  getModelTierSaveErrorMessage,
} from '../../src/components/ModelTierConfigDialog.js'
import { warmI18n } from '../../src/i18n/index.js'
import { getLanguage, setLanguage } from '../../src/i18n/languageStore.js'
import { ShadowedModelTierError } from '../../src/services/settings/modelTierSettings.js'

const original = getLanguage()
afterEach(async () => {
  setLanguage(original)
  await warmI18n()
})

test('命名连接显示中英文平台译名，未知平台不泄漏翻译键', async () => {
  for (const [language, label] of [
    ['zh-CN', '自定义'],
    ['en', 'Custom'],
  ] as const) {
    setLanguage(language)
    await warmI18n()
    expect(formatModelTierProviderLabel('amd', 'generic')).toBe(`amd (${label})`)
    expect(formatModelTierProviderLabel('generic', 'generic')).toBe(label)
    expect(formatModelTierProviderLabel('amd', 'amd')).toBe('amd')
  }
})

test('遮蔽错误中英文均给出键路径与替代操作，其他错误用通用提示', async () => {
  const err = new ShadowedModelTierError('advanced', 'ark')
  setLanguage('en')
  await warmI18n()
  expect(getModelTierSaveErrorMessage(err)).toContain('providers.ark.models.advanced')
  expect(getModelTierSaveErrorMessage(err)).toContain('Change Primary Model')
  expect(getModelTierSaveErrorMessage(new Error('x'))).toContain('settings.json')
  setLanguage('zh-CN')
  await warmI18n()
  expect(getModelTierSaveErrorMessage(err)).toContain('更换主选模型')
})
