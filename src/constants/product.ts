export const PRODUCT_URL = 'https://zy.com/zy-code'

// ZY Code Remote session URL
export const ZY_AI_BASE_URL = 'https://zy.ai'
// TODO: 自建 staging 环境后替换此 URL（原 ant.dev staging URL 已移除）
export const ZY_AI_STAGING_BASE_URL = ''
export const ZY_AI_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * 根据 session ID 格式和 ingress URL 判断远程 session 是否处于 staging 环境。
 */
export function isRemoteSessionStaging(sessionId?: string, ingressUrl?: string): boolean {
  return sessionId?.includes('_staging_') === true || ingressUrl?.includes('staging') === true
}

/**
 * 根据 session ID 格式（如 `session_local_...`）和 ingress URL，
 * 判断远程 session 是否处于本地开发环境。
 */
export function isRemoteSessionLocal(sessionId?: string, ingressUrl?: string): boolean {
  return sessionId?.includes('_local_') === true || ingressUrl?.includes('localhost') === true
}

/**
 * 根据环境获取 Zy AI 的 base URL。
 */
export function getZyAiBaseUrl(sessionId?: string, ingressUrl?: string): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return ZY_AI_LOCAL_BASE_URL
  }
  // TODO: 自建 staging 环境后恢复此逻辑
  // if (isRemoteSessionStaging(sessionId, ingressUrl)) {
  //   return ZY_AI_STAGING_BASE_URL
  // }
  return ZY_AI_BASE_URL
}

/**
 * 获取远程 session 的完整 URL。
 *
 * 保留原始 session ID，供仍会展示既有远程会话链接的归因记录使用。
 */
export function getRemoteSessionUrl(sessionId: string, ingressUrl?: string): string {
  const baseUrl = getZyAiBaseUrl(sessionId, ingressUrl)
  return `${baseUrl}/code/${sessionId}`
}
