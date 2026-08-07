import type { ToolUseContext } from 'src/tools/tool.js'
import type { PermissionUpdate } from 'src/types/index.js'
import { executePermissionRequestHooks } from '../services/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../services/permissions/permissionUpdate.ts'
import type { PermissionDecision } from '../services/permissions/permissionResult.js'

/**
 * Execute PermissionRequest hooks and return a decision if one is made.
 * Returns undefined if no hook made a decision.
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

  // Iterate directly over the generator instead of using `all`
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

        // Apply permission updates if provided by hook ("always allow")
        const permissionUpdates = decision.updatedPermissions ?? []
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // Update permission context via setAppState
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

      // Hook denied the permission
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
