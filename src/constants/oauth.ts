/**
 * ZY Code OAuth 配置
 *
 * ZY Code 暂无登录限制，OAuth 配置保留最小骨架供模块引用。
 * 后续接入自建认证服务后再填充实际端点。
 */

export function fileSuffixForOauthConfig(): string {
  return ''
}

// 最小 OAuth scope（暂无实际登录流程）
export const ZY_CODE_INFERENCE_SCOPE = 'user:inference' as const
export const ZY_CODE_PROFILE_SCOPE = 'user:profile' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const
export const CONSOLE_OAUTH_SCOPES = [] as const
export const ZY_CODE_OAUTH_SCOPES = [] as const
export const ALL_OAUTH_SCOPES: readonly string[] = []

export type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  ZY_CODE_AUTHORIZE_URL: string
  ZY_CODE_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  ZY_CODE_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

// 自建 OAuth 服务尚未部署，保留域名避免遗留调用触达第三方。
const UNCONFIGURED_OAUTH_ORIGIN = 'https://oauth.example.invalid'

const PLACEHOLDER_CONFIG: OauthConfig = {
  BASE_API_URL: UNCONFIGURED_OAUTH_ORIGIN,
  CONSOLE_AUTHORIZE_URL: UNCONFIGURED_OAUTH_ORIGIN,
  ZY_CODE_AUTHORIZE_URL: UNCONFIGURED_OAUTH_ORIGIN,
  ZY_CODE_ORIGIN: UNCONFIGURED_OAUTH_ORIGIN,
  TOKEN_URL: UNCONFIGURED_OAUTH_ORIGIN,
  API_KEY_URL: UNCONFIGURED_OAUTH_ORIGIN,
  ROLES_URL: UNCONFIGURED_OAUTH_ORIGIN,
  CONSOLE_SUCCESS_URL: UNCONFIGURED_OAUTH_ORIGIN,
  ZY_CODE_SUCCESS_URL: UNCONFIGURED_OAUTH_ORIGIN,
  MANUAL_REDIRECT_URL: UNCONFIGURED_OAUTH_ORIGIN,
  CLIENT_ID: '',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: UNCONFIGURED_OAUTH_ORIGIN,
  MCP_PROXY_PATH: '',
}

export const MCP_CLIENT_METADATA_URL = UNCONFIGURED_OAUTH_ORIGIN + '/oauth/zy-code-client-metadata'

export function getOauthConfig(): OauthConfig {
  return PLACEHOLDER_CONFIG
}
