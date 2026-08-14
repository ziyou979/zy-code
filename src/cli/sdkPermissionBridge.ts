import type { ToolUseContext } from 'src/tools/tool.js'
import type { PermissionUpdate } from 'src/types/index.js'
import { executePermissionRequestHooks } from '../services/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../services/permissions/permissionUpdate.js'
import type { PermissionDecision } from 'src/types/permissions.js'

/**
 * 执行 PermissionRequest hook；若有 hook 作出决定则返回，否则返回 undefined。
 */
export async function executePermissionRequestHooksForSDK(
  toolName: string,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | undefined> {
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode

  // 直接迭代 generator，而不使用 `all`
  const hookGenerator = executePermissionRequestHooks(
    toolName,
    toolUseID,
    input,
    toolUseContext,
    permissionMode,
    suggestions,
    toolUseContext.abortController.signal,
  )

  for await (const hookResult of hookGenerator) {
    if (
      hookResult.permissionRequestResult &&
      (hookResult.permissionRequestResult.behavior === 'allow' ||
        hookResult.permissionRequestResult.behavior === 'deny')
    ) {
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput || input

        // 若 hook 提供权限更新（“始终允许”），则应用更新
        const permissionUpdates = decision.updatedPermissions ?? []
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // 通过 setAppState 更新权限 context
          toolUseContext.setAppState((prev) => {
            if (prev.toolPermissionContext === updatedContext) {
              return prev
            }
            return { ...prev, toolPermissionContext: updatedContext }
          })
        }

        return {
          behavior: 'allow',
          updatedInput: finalInput,
          userModified: false,
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      }

      // hook 拒绝了权限
      return {
        behavior: 'deny',
        message: decision.message || 'Permission denied by PermissionRequest hook',
        decisionReason: {
          type: 'hook',
          hookName: 'PermissionRequest',
        },
      }
    }
  }

  return undefined
}
