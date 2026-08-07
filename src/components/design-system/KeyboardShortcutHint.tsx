import { tSync } from '../../i18n/index.js'
import Text from '../../ink/components/Text.js'

/** 将快捷键动作标识映射到 i18n key。 */
export const actionKeyMap = {
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
  change: 'common.change',
  clear: 'common.clear',
  'disable external includes': 'settings.disableExternalIncludes',
  'native select': 'shortcut.nativeSelect',
  'view tasks': 'shortcut.viewTasks',
  'write to file': 'common.writeToFile',
  'return to team lead': 'shortcut.returnToTeamLead',
  'app:toggleTranscript': 'app.toggleTranscript',
  'chat:externalEditor': 'chat.externalEditor',
  'chat:stash': 'chat.stash',
  'plugin:toggle': 'plugin.toggle',
  'plugin:install': 'plugin.install',
  'apply changes': 'managePlugins.shortcutApplyChanges',
  'settings:search': 'settings.search',
  'settings:retry': 'settings.retry',
  'settings:close': 'settings.close',
  'attachments:next': 'attachments.next',
  'attachments:previous': 'attachments.previous',
  'attachments:remove': 'attachments.remove',
  'attachments:exit': 'attachments.exit',
  // 日志选择器动作
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
  // 引导输入动作
  'elicitation:unset': 'elicitation.unset',
  // 常见动作补充（供 ConfigurableShortcutHint 中未带前缀的英文描述查表翻译）
  back: 'common.goBack',
  details: 'common.details',
  exit: 'common.exit',
  install: 'common.install',
  next: 'common.next',
  prev: 'common.previous',
  resolve: 'common.resolve',
  'search history': 'common.searchHistory',
  stash: 'chat.stash',
} as const

export type KeyboardShortcutAction = keyof typeof actionKeyMap

type Props = {
  /** 要展示的按键或组合键，例如 "ctrl+o"、"Enter"、"↑/↓"。 */
  shortcut: string
  /** 按键执行的动作，必须已在 actionKeyMap 注册；与 actionText 二选一。 */
  action?: KeyboardShortcutAction
  /** 已翻译好的动作文本（动作未注册或为动态文本时提供；优先于 action）。 */
  actionText?: string
  /** 是否使用括号包裹提示，默认为 false。 */
  parens?: boolean
  /** 是否以粗体展示快捷键，默认为 false。 */
  bold?: boolean
}

/**
 * 渲染类似 "ctrl+o to expand" 或 "(tab to toggle)" 的快捷键提示。
 */
export function KeyboardShortcutHint({
  shortcut,
  action,
  actionText,
  parens = false,
  bold = false,
}: Props) {
  const actionKey = action !== undefined ? actionKeyMap[action] : undefined
  const resolvedAction = actionText ?? (actionKey ? tSync(actionKey) : '')
  const shortcutValue = bold
    ? ((<Text bold={true}>{shortcut}</Text>) as unknown as string)
    : shortcut
  const template = parens
    ? tSync('shortcut.hintParens', {
        shortcut: shortcutValue,
        action: resolvedAction,
      })
    : tSync('shortcut.hint', {
        shortcut: shortcutValue,
        action: resolvedAction,
      })
  return <Text>{template}</Text>
}
