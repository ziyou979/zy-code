import { tSync } from '../../i18n/index.js'
import Text from '../../ink/components/Text.js'

type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean
}

/** Map common action identifiers to i18n keys */
const actionKeyMap: Record<string, string> = {
  expand: 'common.expand',
  collapse: 'common.collapse',
  select: 'common.select',
  confirm: 'common.confirm',
  'confirm:no': 'common.confirmNo',
  'confirm:yes': 'common.confirmYes',
  cancel: 'common.cancel',
  navigate: 'common.navigate',
  nav: 'common.nav',
  toggle: 'common.toggle',
  manage: 'common.manage',
  interrupt: 'shortcut.interrupt',
  'run in background': 'bash.runInBackground',
  background: 'shortcut.background',
  amend: 'permission.amend',
  explain: 'permission.explain',
  hide: 'permission.hide',
  add: 'common.add',
  complete: 'common.complete',
  'stop agents': 'shortcut.stopAgents',
  close: 'common.close',
  cycle: 'shortcut.cycleMode',
  'go back': 'common.goBack',
  'enter text': 'common.enterText',
  continue: 'common.continue',
  'open in editor': 'common.openInEditor',
  'toggle selection': 'common.toggleSelection',
  submit: 'common.submit',
  save: 'common.save',
  'edit in your editor': 'common.editInEditor',
  stop: 'backgroundTasks.action.stop',
  foreground: 'backgroundTasks.action.foreground',
  teleport: 'backgroundTasks.action.teleport',
  view: 'backgroundTasks.action.view',
  'insert path': 'globalSearch.insertPath',
  mention: 'globalSearch.mention',
  'select:accept': 'common.selectAccept',
  'select:previous': 'common.selectPrevious',
  'select:cancel': 'common.selectCancel',
  copy: 'common.copy',
  return: 'common.return',
  update: 'common.update',
  remove: 'common.remove',
  resume: 'common.resume',
  switch: 'common.switch',
  tabs: 'shortcut.tabs',
  'native select': 'shortcut.nativeSelect',
  'view tasks': 'shortcut.viewTasks',
  'write to file': 'common.writeToFile',
  'return to team lead': 'shortcut.returnToTeamLead',
  'app:toggleTranscript': 'app.toggleTranscript',
  'chat:externalEditor': 'chat.externalEditor',
  'chat:stash': 'chat.stash',
  'plugin:toggle': 'plugin.toggle',
  'plugin:install': 'plugin.install',
  'settings:search': 'settings.search',
  'settings:retry': 'settings.retry',
  'settings:close': 'settings.close',
  'attachments:next': 'attachments.next',
  'attachments:previous': 'attachments.previous',
  'attachments:remove': 'attachments.remove',
  'attachments:exit': 'attachments.exit',
  // LogSelector actions
  'logSelector:save': 'logSelector.save',
  'logSelector:search': 'logSelector.search',
  'logSelector:skip': 'logSelector.skip',
  'logSelector:showCurrentDir': 'logSelector.showCurrentDir',
  'logSelector:showAllProjects': 'logSelector.showAllProjects',
  'logSelector:toggleBranch': 'logSelector.toggleBranch',
  'logSelector:showCurrentWorktree': 'logSelector.showCurrentWorktree',
  'logSelector:showAllWorktrees': 'logSelector.showAllWorktrees',
  'logSelector:preview': 'logSelector.preview',
  'logSelector:rename': 'logSelector.rename',
  // Elicitation actions
  'elicitation:unset': 'elicitation.unset',
}

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 */
export function KeyboardShortcutHint({ shortcut, action, parens = false, bold = false }: Props) {
  // Look up the action in the key map; fall back to raw action string
  const actionKey = actionKeyMap[action]
  const actionText = actionKey ? tSync(actionKey) : action
  const shortcutValue = bold ? (<Text bold={true}>{shortcut}</Text>) as unknown as string : shortcut
  const template = parens
    ? tSync('shortcut.hintParens', {
        shortcut: shortcutValue,
        action: actionText,
      })
    : tSync('shortcut.hint', {
        shortcut: shortcutValue,
        action: actionText,
      })
  return <Text>{template}</Text>
}
