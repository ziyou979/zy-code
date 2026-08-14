import { useContext } from 'react'
import TerminalFocusContext from '../components/TerminalFocusContext.js'

/**
 * 检查终端是否拥有焦点的 hook。
 *
 * 使用 DECSET 1004 焦点报告：终端获得或失去焦点时会发送 escape sequence。
 * Ink 会自动处理这些序列，并在 useInput 中将其过滤掉。
 *
 * @returns true if the terminal is focused (or focus state is unknown)
 */
export function useTerminalFocus(): boolean {
  const { isTerminalFocused } = useContext(TerminalFocusContext)
  return isTerminalFocused
}
