import type { PermissionUpdate } from 'src/types/permissions.js'
type WirePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}

type WirePermissionCallbacks = {
  sendRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    description: string,
    permissionSuggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): void
  sendResponse(requestId: string, response: WirePermissionResponse): void
  /** 取消待处理的 control_request，使 Web 应用可以关闭其 prompt。 */
  cancelRequest(requestId: string): void
  onResponse(requestId: string, handler: (response: WirePermissionResponse) => void): () => void // 返回取消订阅函数
}

/** 类型谓词：验证解析后的 control_response payload 是否为 WirePermissionResponse。
 *  通过检查必需的 `behavior` 判别字段完成验证，而不使用不安全的 `as` 断言。 */
function isWirePermissionResponse(value: unknown): value is WirePermissionResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  return 'behavior' in value && (value.behavior === 'allow' || value.behavior === 'deny')
}

export type { WirePermissionCallbacks, WirePermissionResponse }
export { isWirePermissionResponse }
