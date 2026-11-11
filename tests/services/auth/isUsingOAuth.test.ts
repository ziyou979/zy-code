import { describe, expect, it } from 'bun:test'
import { isUsingOAuthTokens } from '../../../src/services/auth/auth.js'

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
