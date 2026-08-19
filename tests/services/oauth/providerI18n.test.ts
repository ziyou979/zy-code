import { describe, expect, test } from 'bun:test'
import { enSession } from '../../../src/i18n/locales/en/session.js'
import { zhSession } from '../../../src/i18n/locales/zh-CN/session.js'

describe('OAuth provider i18n', () => {
  test('Grok 登录进度具有对称的中英文资源', () => {
    expect(enSession['oauth.xai.discoveringEndpoints']).toBe('Discovering xAI OAuth endpoints…')
    expect(zhSession['oauth.xai.discoveringEndpoints']).toBe('正在发现 xAI OAuth 端点…')
    expect(zhSession['oauth.xai.requestingDeviceCode']).toBe('正在申请设备码…')
    expect(zhSession['oauth.deviceCodeWaiting']).toBe('等待设备授权...')
  })

  test('Codex 登录方式具有对称的中英文资源', () => {
    expect(enSession['oauth.openaiCodex.selectLoginMethod']).toBe(
      'Select OpenAI Codex login method:',
    )
    expect(zhSession['oauth.openaiCodex.selectLoginMethod']).toBe('选择 OpenAI Codex 登录方式：')
    expect(zhSession['oauth.openaiCodex.browserLogin']).toBe('浏览器登录（默认）')
    expect(zhSession['oauth.openaiCodex.deviceCodeLogin']).toBe('设备码登录（无浏览器环境）')
  })
})
