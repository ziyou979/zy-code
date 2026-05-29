import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'

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
  /** Cancel a pending control_request so the web app can dismiss its prompt. */
  cancelRequest(requestId: string): void
  onResponse(requestId: string, handler: (response: WirePermissionResponse) => void): () => void // returns unsubscribe
}

/** Type predicate for validating a parsed control_response payload
 *  as a WirePermissionResponse. Checks the required `behavior`
 *  discriminant rather than using an unsafe `as` cast. */
function isWirePermissionResponse(value: unknown): value is WirePermissionResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  return 'behavior' in value && (value.behavior === 'allow' || value.behavior === 'deny')
}

export type { WirePermissionCallbacks, WirePermissionResponse }
export { isWirePermissionResponse }
