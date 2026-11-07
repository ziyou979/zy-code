import { describe, expect, test } from 'bun:test'
import {
  createGoogleAdcClient,
  GOOGLE_ADC_SCOPES,
} from '../../../src/services/auth/googleAdcClient.js'

const user = {
  type: 'authorized_user',
  client_id: 'fixture-id',
  client_secret: 'fixture-secret',
  refresh_token: 'fixture-refresh',
  quota_project_id: 'fixture-quota',
}

describe('Google ADC 专用客户端', () => {
  test('用户和服务账号保留凭据、配额项目和 scope', () => {
    const authorized = createGoogleAdcClient(user)
    expect(authorized.constructor.name).toBe('UserRefreshClient')
    expect(authorized.credentials.refresh_token).toBe('fixture-refresh')
    expect(authorized.quotaProjectId).toBe('fixture-quota')
    const service = createGoogleAdcClient({
      type: 'service_account',
      client_email: 'fixture@example.invalid',
      private_key: 'fixture-key',
    })
    expect(service.constructor.name).toBe('JWT')
    expect(service).toHaveProperty('scopes', GOOGLE_ADC_SCOPES)
  })

  test('支持联合身份、联合用户及服务账号模拟，不退回通用 fromJSON', () => {
    expect(
      createGoogleAdcClient({
        type: 'external_account',
        audience: '//iam.googleapis.com/projects/fixture/pools/p/providers/p',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        credential_source: { file: '/fixture/token.txt' },
      }).constructor.name,
    ).toBe('IdentityPoolClient')
    expect(
      createGoogleAdcClient({
        ...user,
        type: 'external_account_authorized_user',
        audience: '//iam.googleapis.com/fixture',
        token_info_url: 'https://sts.googleapis.com/v1/introspect',
      }).constructor.name,
    ).toBe('ExternalAccountAuthorizedUserClient')
    expect(
      createGoogleAdcClient({
        type: 'impersonated_service_account',
        source_credentials: user,
        service_account_impersonation_url:
          'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/fixture@example.invalid:generateAccessToken',
        delegates: ['fixture-delegate'],
      }).constructor.name,
    ).toBe('Impersonated')
  })

  test('保留 GDCH 支持，拒绝未知类型和不完整凭据', () => {
    expect(
      createGoogleAdcClient({
        type: 'gdch_service_account',
        format_version: '1',
        project: 'fixture-project',
        private_key_id: 'fixture-key-id',
        private_key: 'fixture-key',
        name: 'fixture-name',
        token_uri: 'https://fixture.invalid/token',
      }).constructor.name,
    ).toBe('GdchClient')
    expect(() => createGoogleAdcClient({ type: 'unexpected' })).toThrow()
    expect(() => createGoogleAdcClient({ type: 'authorized_user' })).toThrow()
    expect(() => createGoogleAdcClient({ type: 'impersonated_service_account' })).toThrow()
  })
})
