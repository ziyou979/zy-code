// 终端焦点状态信号——非 React 方式访问 DECSET 1004 焦点事件。
// 'unknown' 是不支持焦点报告的终端的默认值；
// 调用者将 'unknown' 与 'focused' 同等对待（不做节流）。
// 焦点变化时同步通知订阅者，TerminalFocusProvider 借此避免轮询。
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

let focusState: TerminalFocusState = 'unknown'
const resolvers: Set<() => void> = new Set()
const subscribers: Set<() => void> = new Set()

export function setTerminalFocused(v: boolean): void {
  focusState = v ? 'focused' : 'blurred'
  // 通知 useSyncExternalStore 订阅者
  for (const cb of subscribers) {
    cb()
  }
  if (!v) {
    for (const resolve of resolvers) {
      resolve()
    }
    resolvers.clear()
  }
}

export function getTerminalFocused(): boolean {
  return focusState !== 'blurred'
}

export function getTerminalFocusState(): TerminalFocusState {
  return focusState
}

// 供 useSyncExternalStore 使用
export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function resetTerminalFocusState(): void {
  focusState = 'unknown'
  for (const cb of subscribers) {
    cb()
  }
}
