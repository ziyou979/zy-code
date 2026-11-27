/**
 * ZY Code OAuth 配置
 *
 * ZY Code 不连接任何官方账号后端；此处仅保留仍被引用的最小常量：
 * - fileSuffixForOauthConfig / OAUTH_FILE_SUFFIX：本地凭据存储命名后缀
 * - ZY_CODE_INFERENCE_SCOPE：本地 token scope 判断
 * 不再包含任何可被拼接成网络请求的 URL。
 */

export function fileSuffixForOauthConfig(): string {
  return ''
}

export const ZY_CODE_INFERENCE_SCOPE = 'user:inference' as const

export type OauthConfig = {
  OAUTH_FILE_SUFFIX: string
}

const LOCAL_CONFIG: OauthConfig = {
  OAUTH_FILE_SUFFIX: '',
}

export function getOauthConfig(): OauthConfig {
  return LOCAL_CONFIG
}
