import { describe, expect, test } from 'bun:test'
import { resolveLoginSetupState } from '../../src/components/loginSelection.js'

describe('登录菜单本地配置入口', () => {
  test('Vertex 不应成为登录首页的独立入口', () => {
    expect(resolveLoginSetupState('vertex')).toBeNull()
  })
  test('API 密钥进入密钥配置页', () => {
    expect(resolveLoginSetupState('apikey')).toBe('api_key_setup')
  })

  test('第三方平台进入云平台选择页', () => {
    expect(resolveLoginSetupState('platform')).toBe('platform_setup')
  })

  test('OAuth provider 不应被识别为本地配置入口', () => {
    expect(resolveLoginSetupState('oauth:anthropic')).toBeNull()
  })
})
