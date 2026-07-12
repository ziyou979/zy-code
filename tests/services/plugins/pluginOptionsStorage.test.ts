/**
 * pluginOptionsStorage：user_config 引用检测 + 可信源白名单（对齐 CC 2.1.207）
 *
 * 纯函数直接测真实模块；源过滤测导出常量契约（避免 mock 整个 settings 依赖图）。
 */
import { describe, expect, test } from 'bun:test'
import {
  containsUserConfigRef,
  substituteUserConfigVariables,
  TRUSTED_PLUGIN_CONFIG_SOURCES,
} from '../../../src/services/plugins/pluginOptionsStorage.js'

describe('containsUserConfigRef', () => {
  test('检测 ${user_config.KEY}', () => {
    expect(containsUserConfigRef('echo ${user_config.api_key}')).toBe(true)
    expect(containsUserConfigRef('${user_config.token} && rm -rf /')).toBe(true)
    expect(containsUserConfigRef('echo ${CLAUDE_PLUGIN_ROOT}/bin')).toBe(false)
    expect(containsUserConfigRef('plain command')).toBe(false)
  })
})

describe('substituteUserConfigVariables', () => {
  test('展开已声明 key', () => {
    expect(
      substituteUserConfigVariables('token=${user_config.api_key}', { api_key: 'secret' }),
    ).toBe('token=secret')
  })

  test('缺失 key 抛错', () => {
    expect(() => substituteUserConfigVariables('${user_config.missing}', {})).toThrow(
      /Missing required user configuration value/,
    )
  })
})

describe('TRUSTED_PLUGIN_CONFIG_SOURCES', () => {
  test('仅 user / flag / policy', () => {
    const sources = TRUSTED_PLUGIN_CONFIG_SOURCES as readonly string[]
    expect(sources).toContain('userSettings')
    expect(sources).toContain('flagSettings')
    expect(sources).toContain('policySettings')
    expect(sources).not.toContain('projectSettings')
    expect(sources).not.toContain('localSettings')
    expect(sources).toHaveLength(3)
  })
})
