import { feature } from 'bun:bundle'
import React, { useContext, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import { MailboxProvider } from '../context/mailbox.js'
import { useSettingsChange } from '../hooks/useSettingsChange.js'
import { logForDebugging } from '../utils/debug.js'
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from '../utils/permissions/permissionSetup.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { createStore } from './store.js'

// DCE: voice context is ant-only. External builds get a passthrough.
/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceProvider: (props: { children: React.ReactNode }) => React.ReactNode = feature(
  'VOICE_MODE',
)
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children

/* eslint-enable @typescript-eslint/no-require-imports */
import { type AppState, type AppStateStore, getDefaultAppState } from './AppStateStore.js'

// TODO: Remove these re-exports once all callers import directly from
// ./AppStateStore.js. Kept for back-compat during migration so .ts callers
// can incrementally move off the .tsx import and stop pulling React.
export {
  type AppState,
  type AppStateStore,
  type CompletionBoundary,
  getDefaultAppState,
  IDLE_SPECULATION_STATE,
  type SpeculationResult,
  type SpeculationState,
} from './AppStateStore.js'
export const AppStoreContext = React.createContext<AppStateStore | null>(null)
type Props = {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}
const HasAppStateContext = React.createContext<boolean>(false)
export function AppStateProvider({ children, initialState, onChangeAppState }: Props) {
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error('AppStateProvider can not be nested within another AppStateProvider')
  }
  const [store] = useState(() =>
    createStore(initialState ?? getDefaultAppState(), onChangeAppState),
  )
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (
      toolPermissionContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      logForDebugging(
        'Disabling bypass permissions mode on mount (remote settings loaded before mount)',
      )
      store.setState((prev) => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext),
      }))
    }
  }, [store.setState, store.getState])
  const onSettingsChange = useEffectEvent(
    (source: import('../utils/settings/constants.js').SettingSource) =>
      applySettingsChange(source, store.setState),
  )
  useSettingsChange(onSettingsChange)
  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        {
          <MailboxProvider>
            <VoiceProvider>{children}</VoiceProvider>
          </MailboxProvider>
        }
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError(
      'useAppState/useSetAppState cannot be called outside of an <AppStateProvider />',
    )
  }
  return store
}

/**
 * 订阅 AppState 的某个部分。仅在所选值发生变化时重新渲染
 *（通过 Object.is 比较）。
 *
 * 对于多个独立字段，可以多次调用该 hook：
 * ```
 * const verbose = useAppState(s => s.verbose)
 * const model = useAppState(s => s.mainLoopModel)
 * ```
 *
 * 不要从 selector 中返回新对象 —— Object.is 会将它们始终视为已更改。
 * 相反，选择现有的子对象引用：
 * ```
 * const { text, promptId } = useAppState(s => s.promptSuggestion) // 正确做法
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const get = () => {
    const state = store.getState()
    const selected = selector(state)
    if (false && state === selected) {
      throw new Error(
        `Your selector in \`useAppState(${selector.toString()})\` returned the original state, which is not allowed. You must instead return a property for optimised rendering.`,
      )
    }
    return selected
  }
  return useSyncExternalStore(store.subscribe, get, get)
}

/**
 * 获取 setAppState 更新器，而不订阅任何状态。
 * 返回一个永不变化的稳定引用 —— 仅使用此 hook 的组件
 * 永远不会因状态变化而重新渲染。
 */
export function useSetAppState() {
  return useAppStore().setState
}

/**
 * 直接获取 store（用于将 getState/setState 传递给非 React 代码）。
 */
export function useAppStateStore() {
  return useAppStore()
}
const NOOP_SUBSCRIBE = () => () => {}

/**
 * useAppState 的安全版本，如果在 AppStateProvider 外部调用则返回 undefined。
 * 适用于可能在 AppStateProvider 不可用的上下文中渲染的组件。
 */
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, () =>
    store ? selector(store.getState()) : undefined,
  )
}
