import { describe, expect, test } from 'bun:test'
import { resolveLoginSetupState } from '../../src/components/loginSelection.js'

describe('登录菜单本地配置入口', () => {
  test('API 密钥进入密钥配置页', () => {
    expect(resolveLoginSetupState('apikey')).toBe('api_key_setup')
  })

  test('第三方平台进入平台说明页', () => {
    expect(resolveLoginSetupState('platform')).toBe('platform_setup')
  })

  test('OAuth provider 不应被识别为本地配置入口', () => {
    expect(resolveLoginSetupState('oauth:anthropic')).toBeNull()
  })
})
