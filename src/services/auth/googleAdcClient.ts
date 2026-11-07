import {
  type AuthClient,
  ExternalAccountAuthorizedUserClient,
  ExternalAccountClient,
  type ExternalAccountClientOptions,
  GdchClient,
  Impersonated,
  JWT,
  UserRefreshClient,
} from 'google-auth-library'
import { z } from 'zod/v4'

export const GOOGLE_ADC_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
const transport = { transporterOptions: { timeout: 20000, retry: false } }
const credentialSchema = z.object({ type: z.string() }).passthrough()

/** 按已声明的凭据类型构造客户端，避免通用文件加载接口的弃用告警；保留 ADC 的联合身份与模拟身份支持。 */
export function createGoogleAdcClient(value: unknown): AuthClient {
  const data = credentialSchema.parse(value)
  switch (data.type) {
    case 'authorized_user': {
      const client = new UserRefreshClient(transport)
      client.fromJSON(data)
      return client
    }
    case 'service_account': {
      const client = new JWT({ ...transport, scopes: GOOGLE_ADC_SCOPES })
      client.fromJSON(data)
      return client
    }
    case 'external_account': {
      // 专用工厂负责校验不同 credential_source 并选择 AWS、身份池或可执行凭据客户端。
      const client = ExternalAccountClient.fromJSON({
        ...data,
        ...transport,
      } as ExternalAccountClientOptions)
      if (!client) throw new Error('Invalid external account credentials')
      client.scopes = GOOGLE_ADC_SCOPES
      return client
    }
    case 'external_account_authorized_user': {
      const credentials = z
        .object({
          type: z.literal('external_account_authorized_user'),
          audience: z.string(),
          client_id: z.string(),
          client_secret: z.string(),
          refresh_token: z.string(),
          token_info_url: z.string(),
        })
        .passthrough()
        .parse(data)
      return new ExternalAccountAuthorizedUserClient({ ...credentials, ...transport })
    }
    case 'impersonated_service_account': {
      const credentials = z
        .object({
          service_account_impersonation_url: z.string().max(256),
          source_credentials: z.unknown(),
          delegates: z.array(z.string()).optional(),
        })
        .parse(data)
      const targetPrincipal = /([^/]+):(generateAccessToken|generateIdToken)$/.exec(
        credentials.service_account_impersonation_url,
      )?.[1]
      if (!targetPrincipal) throw new Error('Invalid impersonated service account')
      return new Impersonated({
        ...data,
        ...transport,
        sourceClient: createGoogleAdcClient(credentials.source_credentials),
        targetPrincipal,
        targetScopes: GOOGLE_ADC_SCOPES,
        delegates: credentials.delegates,
      })
    }
    case 'gdch_service_account': {
      const credentials = z
        .object({
          type: z.literal('gdch_service_account'),
          format_version: z.string(),
          project: z.string(),
          private_key_id: z.string(),
          private_key: z.string(),
          name: z.string(),
          token_uri: z.string(),
          ca_cert_path: z.string().optional(),
        })
        .parse(data)
      const client = new GdchClient(transport)
      client.fromJSON(credentials)
      return client
    }
    default:
      throw new Error('Unsupported ADC credential type')
  }
}
