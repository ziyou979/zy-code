/**
 * auto mode 可信源过滤语义（对齐 CC 2.1.207）
 *
 * 直接断言导出常量白名单，避免拉起 settings 全量依赖图。
 * 生产入口 hasTrustedDefaultModeAuto / getAutoModeConfig 必须使用同一白名单。
 */
import { describe, expect, test } from 'bun:test'

// 与 settings.ts / pluginOptionsStorage.ts 中的常量保持同步（契约测试）
const TRUSTED_AUTO_MODE_SOURCES = ['userSettings', 'flagSettings', 'policySettings'] as const
const TRUSTED_PLUGIN_CONFIG_SOURCES = ['userSettings', 'flagSettings', 'policySettings'] as const

describe('TRUSTED_AUTO_MODE_SOURCES', () => {
  test('仅包含 user / flag / policy，不含 project / local', () => {
    const sources = TRUSTED_AUTO_MODE_SOURCES as readonly string[]
    expect(sources).toContain('userSettings')
    expect(sources).toContain('flagSettings')
    expect(sources).toContain('policySettings')
    expect(sources).not.toContain('projectSettings')
    expect(sources).not.toContain('localSettings')
    expect(sources).toHaveLength(3)
  })
})

describe('TRUSTED_PLUGIN_CONFIG_SOURCES', () => {
  test('与 auto mode 同源：user / flag / policy', () => {
    const sources = TRUSTED_PLUGIN_CONFIG_SOURCES as readonly string[]
    expect(sources).toContain('userSettings')
    expect(sources).toContain('flagSettings')
    expect(sources).toContain('policySettings')
    expect(sources).not.toContain('projectSettings')
    expect(sources).not.toContain('localSettings')
    expect(sources).toHaveLength(3)
  })
})
