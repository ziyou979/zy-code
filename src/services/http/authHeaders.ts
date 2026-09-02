/**
 * 辅助服务（policy-limits / remote-managed-settings / settings-sync / team-memory-sync
 * 等）共用的认证头构造。凭证由调用方解析后传入，本模块不触碰配置或存储，
 * 避免与任一调用方形成循环依赖。
 */
import { ANTHROPIC_VERSION } from '../../constants/api.js'
import { CCR_BYOC_BETA_HEADER } from '../../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'

export type AuthHeadersResult = {
  headers: Record<string, string>
  error?: string
}

export type BuildAuthHeadersOptions = {
  /** API key（x-api-key），优先级最高 */
  apiKey?: string
  /** OAuth access token（Bearer + anthropic-beta），次之 */
  oauthToken?: string
  /** 附加 User-Agent（team-memory-sync 需要） */
  userAgent?: string
  /** 是否附加 anthropic-beta 头，默认 true */
  includeBetaHeader?: boolean
  /** 无凭证时的错误文案，默认 'No authentication available' */
  errorMessage?: string
}

/**
 * 按 apiKey → oauthToken → error 的优先级构造认证头。
 * 与 settings-sync / team-memory-sync 原仅 OAuth 分支、policy-limits /
 * remote-managed-settings 原双分支的实现等价，统一为单一实现。
 */
export function buildAuthHeaders(options: BuildAuthHeadersOptions): AuthHeadersResult {
  if (options.apiKey) {
    return {
      headers: {
        'x-api-key': options.apiKey,
      },
    }
  }

  if (options.oauthToken) {
    return {
      headers: {
        Authorization: `Bearer ${options.oauthToken}`,
        ...(options.includeBetaHeader !== false ? { 'anthropic-beta': OAUTH_BETA_HEADER } : {}),
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      },
    }
  }

  return {
    headers: {},
    error: options.errorMessage ?? 'No authentication available',
  }
}

/**
 * bridge / teleport 等会话控制面共用的 OAuth 基础头（Bearer + JSON + anthropic-version）。
 * 各端点对 beta 头的要求不同，由调用方按需追加。
 */
export function buildOAuthApiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/**
 * /v1/sessions 控制面（bridge 会话创建/归档、teleport、remote-setup、历史拉取）
 * 共用的标准请求头：OAuth 基础头 + CCR BYOC beta + 组织 UUID。
 */
export function buildSessionApiHeaders(opts: {
  accessToken: string
  orgUUID: string
}): Record<string, string> {
  return {
    ...buildOAuthApiHeaders(opts.accessToken),
    'anthropic-beta': CCR_BYOC_BETA_HEADER,
    'x-organization-uuid': opts.orgUUID,
  }
}
