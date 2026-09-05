import { describe, expect, it } from 'bun:test'
import { buildAuthHeaders } from '../../../src/services/http/authHeaders.js'

describe('buildAuthHeaders - 凭证优先级', () => {
  it('仅 apiKey → x-api-key', () => {
    expect(buildAuthHeaders({ apiKey: 'sk-ant-abc' })).toEqual({
      headers: { 'x-api-key': 'sk-ant-abc' },
    })
  })

  it('仅 oauthToken → Bearer + anthropic-beta', () => {
    expect(buildAuthHeaders({ oauthToken: 'tok-123' })).toEqual({
      headers: {
        Authorization: 'Bearer tok-123',
        'anthropic-beta': expect.any(String),
      },
    })
  })

  it('apiKey 优先于 oauthToken', () => {
    const result = buildAuthHeaders({ apiKey: 'sk-1', oauthToken: 'tok-1' })
    expect(result.headers).toEqual({ 'x-api-key': 'sk-1' })
  })

  it('两者都没有 → error 与空 headers', () => {
    expect(buildAuthHeaders({})).toEqual({
      headers: {},
      error: 'No authentication available',
    })
  })

  it('自定义 errorMessage 覆盖默认文案', () => {
    expect(buildAuthHeaders({ errorMessage: 'No OAuth token available' }).error).toBe(
      'No OAuth token available',
    )
  })
})

describe('buildAuthHeaders - 附加选项', () => {
  it('userAgent 附加到 OAuth 分支', () => {
    const result = buildAuthHeaders({ oauthToken: 'tok-1', userAgent: 'zy-cli/1.0' })
    expect(result.headers['User-Agent']).toBe('zy-cli/1.0')
  })

  it('includeBetaHeader=false 时 OAuth 分支不含 anthropic-beta', () => {
    const result = buildAuthHeaders({ oauthToken: 'tok-1', includeBetaHeader: false })
    expect(result.headers['anthropic-beta']).toBeUndefined()
  })

  it('userAgent 不影响 apiKey 分支', () => {
    const result = buildAuthHeaders({ apiKey: 'sk-1', userAgent: 'zy-cli/1.0' })
    expect(result.headers['User-Agent']).toBeUndefined()
  })
})
