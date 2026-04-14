import React from 'react';
import Text from '../../ink/components/Text.js';
import { tSync } from '../../i18n/index.js';
type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string;
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string;
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean;
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean;
};

/** Map common action identifiers to i18n keys */
const actionKeyMap: Record<string, string> = {
  'expand': 'common.expand',
  'collapse': 'common.collapse',
  'select': 'common.select',
  'confirm': 'common.confirm',
  'cancel': 'common.cancel',
  'navigate': 'common.navigate',
  'toggle': 'common.toggle',
  'manage': 'common.manage',
  'interrupt': 'shortcut.interrupt',
  'background': 'shortcut.background',
  'amend': 'permission.amend',
  'explain': 'permission.explain',
  'hide': 'permission.hide',
  'add': 'common.add',
  'complete': 'common.complete',
  'stop agents': 'shortcut.stopAgents'
};

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 */
export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false
}: Props) {
  // Look up the action in the key map; fall back to raw action string
  const actionKey = actionKeyMap[action];
  const actionText = actionKey ? tSync(actionKey) : action;
  const shortcutValue = bold ? <Text bold={true}>{shortcut}</Text> : shortcut;
  const template = parens ? tSync('shortcut.hintParens', {
    shortcut: shortcutValue,
    action: actionText
  }) : tSync('shortcut.hint', {
    shortcut: shortcutValue,
    action: actionText
  });
  return <Text>{template}</Text>;
}
