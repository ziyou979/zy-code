import { c as _c } from "react/compiler-runtime";
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
};

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 */
export function KeyboardShortcutHint(t0) {
  const $ = _c(10);
  const {
    shortcut,
    action,
    parens: t1,
    bold: t2
  } = t0;
  const parens = t1 === undefined ? false : t1;
  const bold = t2 === undefined ? false : t2;
  let t3;
  if ($[0] !== bold || $[1] !== shortcut) {
    t3 = bold ? <Text bold={true}>{shortcut}</Text> : shortcut;
    $[0] = bold;
    $[1] = shortcut;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  const shortcutText = t3;
  // Look up the action in the key map; fall back to raw action string
  const actionKey = actionKeyMap[action];
  const actionText = actionKey ? tSync(actionKey) : action;
  const template = parens
    ? tSync('shortcut.hintParens', { shortcut: shortcutText, action: actionText })
    : tSync('shortcut.hint', { shortcut: shortcutText, action: actionText });
  let t4;
  if ($[3] !== template) {
    t4 = <Text>{template}</Text>;
    $[3] = template;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  return t4;
}
