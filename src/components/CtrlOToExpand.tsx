import chalk from 'chalk'
import React, { useContext } from 'react'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { InVirtualListContext } from './messageActions.js'

// 上下文跟踪我们是否在子 agent 内
// 类似于 MessageResponseContext，这帮助我们避免在子 agent 输出中显示
// 太多 "(ctrl+o to expand)" 提示
const SubAgentContext = React.createContext(false)
export function SubAgentProvider({ children }) {
  return <SubAgentContext.Provider value={true}>{children}</SubAgentContext.Provider>
}
export function CtrlOToExpand() {
  const isInSubAgent = useContext(SubAgentContext)
  const inVirtualList = useContext(InVirtualListContext)
  const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  if (isInSubAgent || inVirtualList) {
    return null
  }
  return (
    <Text dimColor={true}>
      <KeyboardShortcutHint shortcut={expandShortcut} action="expand" parens={true} />
    </Text>
  )
}
export function ctrlOToExpand(): string {
  const shortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  return chalk.dim(
    tSync('shortcut.toExpand', {
      shortcut,
    }),
  )
}
