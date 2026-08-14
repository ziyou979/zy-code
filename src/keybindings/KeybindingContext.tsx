import React, { createContext, type RefObject, useContext, useLayoutEffect } from 'react'
import type { Key } from '../ink/index.js'
import {
  type ChordResolveResult,
  getBindingDisplayText,
  resolveKeyWithChordState,
} from './resolver.js'
import { invokeFirstMatchingHandler, type KeybindingHandlerRegistration } from './dispatch.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

type KeybindingContextValue = {
  /** 将按键输入解析为 action 名称，支持 chord。 */
  resolve: (input: string, key: Key, activeContexts: KeybindingContextName[]) => ChordResolveResult

  /** 更新待完成的 chord 状态。 */
  setPendingChord: (pending: ParsedKeystroke[] | null) => void

  /** 获取 action 的展示文本，例如 "ctrl+t"。 */
  getDisplayText: (action: string, context: KeybindingContextName) => string | undefined

  /** 所有已解析的绑定，用于帮助界面。 */
  bindings: ParsedBinding[]

  /** 当前待完成的 chord 按键；不在 chord 中时为 null。 */
  pendingChord: ParsedKeystroke[] | null

  /** 当前活跃的快捷键 context，用于解析优先级。 */
  activeContexts: Set<KeybindingContextName>

  /** 将 context 注册为活跃状态，挂载时调用。 */
  registerActiveContext: (context: KeybindingContextName) => void

  /** 注销 context，卸载时调用。 */
  unregisterActiveContext: (context: KeybindingContextName) => void

  /** 为 action 注册 handler，供 useKeybinding 使用。 */
  registerHandler: (registration: KeybindingHandlerRegistration) => () => void

  /** 调用 action 对应的 handler，供 ChordInterceptor 使用。 */
  invokeAction: (action: string) => boolean
}
const KeybindingContext = createContext<KeybindingContextValue | null>(null)
type ProviderProps = {
  bindings: ParsedBinding[]
  /** 用于立即访问待完成 chord 的 ref，避免 React 状态延迟。 */
  pendingChordRef: RefObject<ParsedKeystroke[] | null>
  /** 触发重新渲染和 UI 更新的状态值。 */
  pendingChord: ParsedKeystroke[] | null
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  activeContexts: Set<KeybindingContextName>
  registerActiveContext: (context: KeybindingContextName) => void
  unregisterActiveContext: (context: KeybindingContextName) => void
  /** handler 注册表的 ref，供 ChordInterceptor 使用。 */
  handlerRegistryRef: RefObject<Map<string, Set<KeybindingHandlerRegistration>>>
  children: React.ReactNode
}
export function KeybindingProvider({
  bindings,
  pendingChordRef,
  pendingChord,
  setPendingChord,
  activeContexts,
  registerActiveContext,
  unregisterActiveContext,
  handlerRegistryRef,
  children,
}: ProviderProps) {
  const getDisplay = (action: string, context: KeybindingContextName) =>
    getBindingDisplayText(action, context, bindings)
  const registerHandler = (registration: KeybindingHandlerRegistration) => {
    const registry = handlerRegistryRef.current
    if (!registry) {
      throw new Error('Keybinding handler registry is unavailable')
    }
    if (!registry.has(registration.action)) {
      registry.set(registration.action, new Set())
    }
    registry.get(registration.action)!.add(registration)
    return () => {
      const handlers = registry.get(registration.action)
      if (handlers) {
        handlers.delete(registration)
        if (handlers.size === 0) {
          registry.delete(registration.action)
        }
      }
    }
  }
  const invokeAction = (action: string) => {
    const registry = handlerRegistryRef.current
    if (!registry) {
      return false
    }
    const handlers = registry.get(action)
    if (!handlers || handlers.size === 0) {
      return false
    }
    return invokeFirstMatchingHandler(handlers, [...activeContexts])
  }
  const value = {
    resolve: (input: string, key: Key, contexts: KeybindingContextName[]) =>
      resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current),
    setPendingChord,
    getDisplayText: getDisplay,
    bindings,
    pendingChord,
    activeContexts,
    registerActiveContext,
    unregisterActiveContext,
    registerHandler,
    invokeAction,
  }
  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>
}
export function useKeybindingContext() {
  const ctx = useContext(KeybindingContext)
  if (!ctx) {
    throw new Error('useKeybindingContext must be used within KeybindingProvider')
  }
  return ctx
}

/**
 * 可选 hook；在 KeybindingProvider 外返回 undefined。
 * 适用于可能早于 provider 渲染的组件。
 */
export function useOptionalKeybindingContext() {
  return useContext(KeybindingContext)
}

/**
 * 在组件挂载期间将快捷键 context 注册为活跃状态的 hook。
 *
 * context 注册后，其快捷键优先于 Global 绑定。这样在 context 活跃时，ThemePicker 的
 * ctrl+t 等特定绑定就能覆盖切换 todo 等全局绑定。
 *
 * @example
 * ```tsx
 * function ThemePicker() {
 *   useRegisterKeybindingContext('ThemePicker')
 *   // 此时 ThemePicker 的 ctrl+t 绑定优先于 Global
 * }
 * ```
 */
export function useRegisterKeybindingContext(
  context: KeybindingContextName,
  isActiveArg?: boolean,
) {
  const isActive = isActiveArg === undefined ? true : isActiveArg
  const keybindingContext = useOptionalKeybindingContext()
  useLayoutEffect(() => {
    if (!keybindingContext || !isActive) {
      return
    }
    keybindingContext.registerActiveContext(context)
    return () => {
      keybindingContext.unregisterActiveContext(context)
    }
  }, [context, keybindingContext, isActive])
}
