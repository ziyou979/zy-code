import { getEmptyToolPermissionContext } from '../../tools/Tool.js'
import type { PermissionMode } from '../../services/permissions/permissionMode.js'
import type { AppState } from '../AppStateStore.js'

export type PermissionSlice = Pick<
  AppState,
  | 'toolPermissionContext'
  | 'workerSandboxPermissions'
  | 'pendingWorkerRequest'
  | 'pendingSandboxRequest'
>

export function createPermissionSlice(mode: PermissionMode): PermissionSlice {
  return {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode },
    workerSandboxPermissions: { queue: [], selectedIndex: 0 },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
  }
}

export function selectHasPendingPermission(
  state: Pick<AppState, 'pendingWorkerRequest' | 'pendingSandboxRequest'>,
): boolean {
  return state.pendingWorkerRequest !== null || state.pendingSandboxRequest !== null
}
