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
 * cse_→session_ 转换是由 zy_bridge_repl_v2_cse_shim_enabled 控制的临时 shim
 *（见 isCseShimEnabled）。worker endpoint（/v1/code/sessions/{id}/worker/*）需要
 * `cse_*`，但 zy.ai 前端目前按 `session_*` 路由（compat/convert.go:27 校验
 * TagSession）。两者 UUID 主体相同，只有 tag 前缀不同。服务器改为按 environment_kind
 * 标记且前端直接接受 `cse_*` 后，应关闭此 gate。已经是 `session_*` 的 ID 不作处理。
 * 标准 helper 见 src/bridge/sessionIdCompat.ts 的 toCompatSessionId；此处延迟 require，
 * 以保持 constants/ 在模块加载 DAG 中处于叶节点。
 */
export function getRemoteSessionUrl(sessionId: string, ingressUrl?: string): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const baseUrl = getZyAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
