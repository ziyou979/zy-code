import { describe, expect, it, vi, beforeEach } from 'bun:test'
import { isUsingOAuthTokens } from '../../../src/services/auth/auth.js'
import { isUsingOAuthForService } from '../../../src/services/auth/auth.js'

const INFERENCE = 'user:inference'
const PROFILE = 'user:profile'

describe('isUsingOAuthTokens - scope 判断纯函数', () => {
  it('null token 返回 false', () => {
    expect(isUsingOAuthTokens(null)).toBe(false)
  })

  it('无 accessToken 返回 false', () => {
    expect(isUsingOAuthTokens({ accessToken: '', scopes: [INFERENCE] })).toBe(false)
  })

  it('只有 inference scope 且无额外要求 → true', () => {
    expect(isUsingOAuthTokens({ accessToken: 'tok', scopes: [INFERENCE] })).toBe(true)
  })

  it('要求 profile 时，缺 profile scope → false', () => {
    expect(isUsingOAuthTokens({ accessToken: 'tok', scopes: [INFERENCE] }, [PROFILE])).toBe(false)
  })

  it('要求 profile 时，同时具备 inference + profile → true', () => {
    expect(
      isUsingOAuthTokens({ accessToken: 'tok', scopes: [INFERENCE, PROFILE] }, [PROFILE]),
    ).toBe(true)
  })

  it('多额外 scope 缺任一 → false', () => {
    expect(
      isUsingOAuthTokens({ accessToken: 'tok', scopes: [INFERENCE, PROFILE] }, [
        PROFILE,
        'user:extra',
      ]),
    ).toBe(false)
  })

  it('scopes 缺省时 false', () => {
    expect(isUsingOAuthTokens({ accessToken: 'tok' } as never)).toBe(false)
  })
})

// isUsingOAuthForService 依赖 modelRequestContext / baseUrlResolution / getZyAIOAuthTokens，
// 通过 mock 依赖链验证 provider/endpoint 门槛。
const mockResolveModelRequestContext = vi.fn()
const mockIsAnthropicOfficialEndpoint = vi.fn()

vi.mock('../../../src/services/model/modelRequestContext.js', () => ({
  resolveModelRequestContext: mockResolveModelRequestContext,
}))

vi.mock('../../../src/services/api/baseUrlResolution.js', () => ({
  isAnthropicOfficialEndpoint: mockIsAnthropicOfficialEndpoint,
}))

vi.mock('../../../src/services/auth/authFileDescriptor.js', () => ({
  getOAuthTokenFromFileDescriptor: () => null,
  getApiKeyFromFileDescriptor: () => null,
}))

describe('isUsingOAuthForService - provider/endpoint 门槛', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 默认：非 anthropic 或非官方端点 → false（不读 token）
    mockResolveModelRequestContext.mockReturnValue({ provider: 'openai' })
    mockIsAnthropicOfficialEndpoint.mockReturnValue(true)
  })

  it('非 anthropic provider → false', () => {
    mockResolveModelRequestContext.mockReturnValue({ provider: 'openai' })
    expect(isUsingOAuthForService()).toBe(false)
  })

  it('非官方端点 → false', () => {
    mockResolveModelRequestContext.mockReturnValue({ provider: 'anthropic' })
    mockIsAnthropicOfficialEndpoint.mockReturnValue(false)
    expect(isUsingOAuthForService()).toBe(false)
  })

  it('anthropic + 官方端点但无 token → false', () => {
    mockResolveModelRequestContext.mockReturnValue({ provider: 'anthropic' })
    mockIsAnthropicOfficialEndpoint.mockReturnValue(true)
    // getZyAIOAuthTokens 在测试环境无连接配置 → null
    expect(isUsingOAuthForService()).toBe(false)
  })
})
