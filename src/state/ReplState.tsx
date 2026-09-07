// ReplStore 的 React 绑定层。
// 与 AppState.tsx 相同模式：Context + useSyncExternalStore。

import * as React from 'react'
import { useSyncExternalStore } from 'react'
import type { ReplState, ReplStoreInstance } from './ReplStore.js'

const ReplStoreContext = React.createContext<ReplStoreInstance | null>(null)

export function ReplStoreProvider({
  store,
  children,
}: {
  store: ReplStoreInstance
  children: React.ReactNode
}): React.ReactNode {
  return <ReplStoreContext.Provider value={store}>{children}</ReplStoreContext.Provider>
}

function useReplStoreInternal(): ReplStoreInstance {
  const store = React.useContext(ReplStoreContext)
  if (!store) {
    throw new ReferenceError('useReplState 必须在 <ReplStoreProvider> 内使用')
  }
  return store
}

/**
 * 订阅 ReplStore 的 state 切片。用法等同 useAppState。
 * ```
 * const messages = useReplState(s => s.messages)
 * ```
 */
export function useReplState<T>(selector: (state: ReplState) => T): T {
  const store = useReplStoreInternal()
  const get = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, get, get)
}

/**
 * 获取 ReplStore 实例（getState / setState / mutable / actions）。
 * 返回稳定引用，不因 state 变化而重新渲染。
 */
export function useReplStore(): ReplStoreInstance {
  return useReplStoreInternal()
}

/**
 * 仅订阅输入框值。输入是独立高频通道，不会触发 ReplState 的其他订阅者。
 */
export function useReplInputValue(): string {
  const store = useReplStoreInternal()
  return useSyncExternalStore(store.input.subscribe, store.input.getValue, store.input.getValue)
}

/**
 * 获取 ReplStore 的 setState 更新器。稳定引用，不触发 re-render。
 */
export function useSetReplState() {
  return useReplStoreInternal().setState
}
