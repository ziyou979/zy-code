import { randomUUID } from 'node:crypto'
import { shouldSkipHookDueToTrust } from '../config.js'

// FileSuggestionCommandInput 在 ../../../types/fileSuggestion.js 实际不导出。
// 该 hook 当前不读取字段，因此用 unknown 占位。
type FileSuggestionCommandInput = unknown

import { createDebugLog } from '../../debug.js'
import { getInitialSettings, getSettingsForSource } from '../../settings/settings.js'
import { jsonStringify } from '../../slowOperations.js'
import { execCommandHook } from '../commandRunner.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../hooksConfigSnapshot.js'

const hookLog = createDebugLog('hooks')

export async function executeFileSuggestionCommand(
  fileSuggestionInput: FileSuggestionCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for typeahead suggestions
): Promise<string[]> {
  // 检查是否所有 hook 都被托管设置禁用
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  // SECURITY: ALL hooks require workspace trust in interactive mode
  // This centralized check prevents RCE vulnerabilities for all current and future hooks
  if (shouldSkipHookDueToTrust()) {
    hookLog(`Skipping FileSuggestion command execution - workspace trust not accepted`)
    return []
  }

  // When disableAllHooks is set in non-managed settings, only managed fileSuggestion runs
  // (non-managed settings cannot disable managed commands, but non-managed commands are disabled)
  const fileSuggestion = shouldAllowManagedHooksOnly()
    ? getSettingsForSource('policySettings')?.fileSuggestion
    : getInitialSettings()?.fileSuggestion

  if (!fileSuggestion || fileSuggestion.type !== 'command') {
    return []
  }

  // 使用提供的 signal 或创建默认的
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    const jsonInput = jsonStringify(fileSuggestionInput)

    const hook = { type: 'command' as const, command: fileSuggestion.command }

    const result = await execCommandHook(
      hook,
      'FileSuggestion',
      'FileSuggestion',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted || result.status !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    hookLog(`File suggestion helper failed: ${error}`, {
      level: 'error',
    })
    return []
  }
}

/**
 * Check if WorktreeCreate hooks are configured (without executing them).
 *
 * Checks both settings-file hooks (getHooksConfigFromSnapshot) and registered
 * hooks (plugin hooks + SDK callback hooks via registerHookCallbacks).
 *
 * Must mirror the managedOnly filtering in getHooksConfig() — when
 * shouldAllowManagedHooksOnly() is true, plugin hooks (pluginRoot set) are
 * skipped at execution, so we must also skip them here. Otherwise this returns
 * true but executeWorktreeCreateHook() finds no matching hooks and throws,
 * blocking the git-worktree fallback.
 */
