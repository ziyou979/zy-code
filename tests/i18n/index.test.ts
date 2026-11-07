import { afterEach, describe, expect, test } from 'bun:test'
import { tSync, warmI18n } from '../../src/i18n/index.js'
import { getLanguage, setLanguage } from '../../src/i18n/languageStore.js'

const originalLanguage = getLanguage()
afterEach(async () => {
  setLanguage(originalLanguage)
  await warmI18n()
})

describe('i18n', () => {
  test('预热另一种语言后立即切回时，同步缓存仍与语言标签一致', async () => {
    const key = 'onboarding.platform.generic'
    setLanguage('zh-CN')
    expect(tSync(key)).toBe('自定义')
    setLanguage('en')
    await warmI18n()
    expect(tSync(key)).toBe('Custom')
    setLanguage('zh-CN')
    expect(tSync(key)).toBe('自定义')
  })
})
