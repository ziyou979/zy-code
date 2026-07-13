import { tSync } from '../../i18n/index.js'
import Text from '../../ink/components/Text.js'

/** Map common action identifiers to i18n keys */
const actionKeyMap = {
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
} as const

export type KeyboardShortcutAction = keyof typeof actionKeyMap

type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string
  /** The action the key performs (must be registered in actionKeyMap) */
  action: KeyboardShortcutAction
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean
}

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)"
 *
 * Wrap in <Text dimColor> for the common dim styling.
 */
export function KeyboardShortcutHint({ shortcut, action, parens = false, bold = false }: Props) {
  const actionKey = actionKeyMap[action]
  if (!actionKey) {
    // 开发模式提示未注册 action（不应在用户界面显示原始字符串）
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      console.warn(
        `KeyboardShortcutHint: 未注册的 action "${action}"，请在 actionKeyMap 中添加对应 i18n key`,
      )
    }
  }
  const actionText = actionKey ? tSync(actionKey) : action
  const shortcutValue = bold
    ? ((<Text bold={true}>{shortcut}</Text>) as unknown as string)
    : shortcut
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
