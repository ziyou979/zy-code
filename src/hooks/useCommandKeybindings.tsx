/**
 * Component that registers keybinding handlers for command bindings.
 *
 * Must be rendered inside KeybindingSetup to have access to the keybinding context.
 * Reads "command:*" actions from the current keybinding configuration and registers
 * handlers that invoke the corresponding slash command via onSubmit.
 *
 * Commands triggered via keybinding are treated as "immediate" - they execute right
 * away and preserve the user's existing input text (the prompt is not cleared).
 */

import { useIsModalOverlayActive } from '../context/OverlayContext.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import type { PromptInputHelpers } from '../utils/handlePromptSubmit.js'

type Props = {
  // onSubmit accepts additional parameters beyond what we pass here,
  // so we use a rest parameter to allow any additional args
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    ...rest: [
      speculationAccept?: undefined,
      options?: {
        fromKeybinding?: boolean
      },
    ]
  ) => void
  /** Set to false to disable command keybindings (e.g., when a dialog is open) */
  isActive?: boolean
}
const NOOP_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}

/**
 * Registers keybinding handlers for all "command:*" actions found in the
 * user's keybinding configuration. When triggered, each handler submits
 * the corresponding slash command (e.g., "command:commit" submits "/commit").
 */
export function CommandKeybindingHandlers({ onSubmit, isActive = true }: Props) {
  const keybindingContext = useOptionalKeybindingContext()
  const isModalOverlayActive = useIsModalOverlayActive()
  let commandActions
  if (!keybindingContext) {
    commandActions = new Set()
  } else {
    const actions = new Set()
    for (const binding of keybindingContext.bindings) {
      if (binding.action?.startsWith('command:')) {
        actions.add(binding.action)
      }
    }
    commandActions = actions
  }
  const map: Record<string, () => void> = {}
  for (const action of commandActions) {
    const commandName = (action as string).slice(8)
    map[action as string] = () => {
      onSubmit(`/${commandName}`, NOOP_HELPERS, undefined, {
        fromKeybinding: true,
      })
    }
  }
  const handlers = map
  useKeybindings(handlers, {
    context: 'Chat',
    isActive: isActive && !isModalOverlayActive,
  })
  return null
}
