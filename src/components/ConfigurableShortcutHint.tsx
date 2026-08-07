import type { KeybindingAction, KeybindingContextName } from '../keybindings/types.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { actionKeyMap } from './design-system/KeyboardShortcutHint.js'
import type { KeyboardShortcutAction } from './design-system/KeyboardShortcutHint.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type Props = {
  /** The keybinding action (e.g., 'app:toggleTranscript') */
  action: KeybindingAction
  /** The keybinding context (e.g., 'Global') */
  context: KeybindingContextName
  /** Default shortcut if keybinding not configured */
  fallback: string
  /**
   * 动作描述：优先传 actionKeyMap 中已注册的动作标识（如 'cancel'），会按当前语言翻译；
   * 否则视为已翻译好的文本（如 tSync(...) 的结果或动态拼接文本），原样展示。
   */
  description: string
  /** Whether to wrap in parentheses */
  parens?: boolean
  /** Whether to show in bold */
  bold?: boolean
}

/**
 * KeyboardShortcutHint that displays the user-configured shortcut.
 * Falls back to default if keybinding context is not available.
 *
 * @example
 * <ConfigurableShortcutHint
 *   action="app:toggleTranscript"
 *   context="Global"
 *   fallback="ctrl+o"
 *   description="expand"
 * />
 */
export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens,
  bold,
}: Props) {
  const shortcut = useShortcutDisplay(action, context, fallback)
  // description 命中已注册动作时交给 KeyboardShortcutHint 翻译；否则视为已翻译文本直接展示，
  // 避免未注册 key 导致模板中的 {action} 占位符无法替换。
  const registered = Object.hasOwn(actionKeyMap, description)
  return (
    <KeyboardShortcutHint
      shortcut={shortcut}
      action={registered ? (description as KeyboardShortcutAction) : undefined}
      actionText={registered ? undefined : description}
      parens={parens}
      bold={bold}
    />
  )
}
