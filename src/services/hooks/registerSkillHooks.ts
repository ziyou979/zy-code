import type { AppState } from 'src/state/AppState.js'
import { HOOK_EVENTS } from 'src/types/index.js'
import { createDebugLog } from '../../utils/debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook, removeSessionHook } from './sessionHooks.js'

const hookLog = createDebugLog('hooks')

/**
 * Registers hooks from a skill's frontmatter as session hooks.
 *
 * Hooks are registered as session-scoped hooks that persist for the duration
 * of the session. If a hook has `once: true`, it will be automatically removed
 * after its first successful execution.
 *
 * @param setAppState - Function to update the app state
 * @param sessionId - The current session ID
 * @param hooks - The hooks settings from the skill's frontmatter
 * @param skillName - The name of the skill (for logging)
 * @param skillRoot - The base directory of the skill (for CLAUDE_PLUGIN_ROOT env var)
 */
export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  skillName: string,
  skillRoot?: string,
): void {
  let registeredCount = 0

  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    if (!matchers) {
      continue
    }

    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // For once: true hooks, use onHookSuccess callback to remove after execution
        const onHookSuccess = hook.once
          ? () => {
              hookLog(`Removing one-shot hook for event ${eventName} in skill '${skillName}'`)
              removeSessionHook(setAppState, sessionId, eventName, hook)
            }
          : undefined

        addSessionHook(
          setAppState,
          sessionId,
          eventName,
          matcher.matcher || '',
          hook,
          onHookSuccess,
          skillRoot,
        )
        registeredCount++
      }
    }
  }

  if (registeredCount > 0) {
    hookLog(`Registered ${registeredCount} hooks from skill '${skillName}'`)
  }
}
