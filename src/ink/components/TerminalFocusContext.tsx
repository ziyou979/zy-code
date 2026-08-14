import React, { createContext, useSyncExternalStore } from 'react'
import {
  getTerminalFocused,
  getTerminalFocusState,
  subscribeTerminalFocus,
  type TerminalFocusState,
} from '../terminalFocusState.js'

export type { TerminalFocusState }
export type TerminalFocusContextProps = {
  readonly isTerminalFocused: boolean
  readonly terminalFocusState: TerminalFocusState
}
const TerminalFocusContext = createContext<TerminalFocusContextProps>({
  isTerminalFocused: true,
  terminalFocusState: 'unknown',
})

// eslint-disable-next-line custom-rules/no-top-level-side-effects
TerminalFocusContext.displayName = 'TerminalFocusContext'

// 单独封装为组件，避免 App.tsx 随焦点变化重新渲染。
// children 的 prop 引用稳定，因此也不会重新渲染；只有使用该 context 的组件会重新渲染。
export function TerminalFocusProvider({
  children,
  ...props
}: TerminalFocusContextProps & { children?: React.ReactNode }) {
  const isTerminalFocused = useSyncExternalStore(subscribeTerminalFocus, getTerminalFocused)
  const terminalFocusState = useSyncExternalStore(subscribeTerminalFocus, getTerminalFocusState)
  const value = {
    isTerminalFocused,
    terminalFocusState,
  }
  return <TerminalFocusContext.Provider value={value}>{children}</TerminalFocusContext.Provider>
}
export default TerminalFocusContext
