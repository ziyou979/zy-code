import { getRegisteredHooks } from '../../../bootstrap/runtime/runtimeContext.js'
import { createDebugLog } from '../../utils/debug.js'
import { createBaseHookInput, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from '../config.js'
import { getHooksConfigFromSnapshot, shouldAllowManagedHooksOnly } from '../hooksConfigSnapshot.js'
import { executeHooksOutsideREPL } from '../outsideRepl.js'

const hookLog = createDebugLog('hooks')

export function hasWorktreeCreateHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.WorktreeCreate
  if (snapshotHooks && snapshotHooks.length > 0) {
    return true
  }
  const registeredHooks = getRegisteredHooks()?.WorktreeCreate
  if (!registeredHooks || registeredHooks.length === 0) {
    return false
  }
  // 镜像 getHooksConfig()：在仅托管模式下跳过插件 hook
  const managedOnly = shouldAllowManagedHooksOnly()
  return registeredHooks.some((matcher) => !(managedOnly && 'pluginRoot' in matcher))
}

/**
 * Execute WorktreeCreate hooks.
 * Returns the worktree path from hook stdout.
 * Throws if hooks fail or produce no output.
 * Callers should check hasWorktreeCreateHook() before calling this.
 */
export async function executeWorktreeCreateHook(name: string): Promise<{ worktreePath: string }> {
  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeCreate' as const,
    name,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  // 查找第一个输出非空的成功结果
  const successfulResult = results.find((r) => r.succeeded && r.output.trim().length > 0)

  if (!successfulResult) {
    const failedOutputs = results
      .filter((r) => !r.succeeded)
      .map((r) => `${r.command}: ${r.output.trim() || 'no output'}`)
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs.join('; ') || 'no successful output'}`,
    )
  }

  const worktreePath = successfulResult.output.trim()
  return { worktreePath }
}

/**
 * Execute WorktreeRemove hooks if configured.
 * Returns true if hooks were configured and ran, false if no hooks are configured.
 *
 * Checks both settings-file hooks (getHooksConfigFromSnapshot) and registered
 * hooks (plugin hooks + SDK callback hooks via registerHookCallbacks).
 */
export async function executeWorktreeRemoveHook(worktreePath: string): Promise<boolean> {
  const snapshotHooks = getHooksConfigFromSnapshot()?.WorktreeRemove
  const registeredHooks = getRegisteredHooks()?.WorktreeRemove
  const hasSnapshotHooks = snapshotHooks && snapshotHooks.length > 0
  const hasRegisteredHooks = registeredHooks && registeredHooks.length > 0
  if (!hasSnapshotHooks && !hasRegisteredHooks) {
    return false
  }

  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: worktreePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  if (results.length === 0) {
    return false
  }

  for (const result of results) {
    if (!result.succeeded) {
      hookLog(`WorktreeRemove hook failed [${result.command}]: ${result.output.trim()}`, {
        level: 'error',
      })
    }
  }

  return true
}
