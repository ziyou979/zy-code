/**
 * 将 KeybindingProvider 集成到应用中的设置工具。
 *
 * 本文件提供绑定和可加入应用组件树的组合 provider。它会加载默认绑定和
 * ~/.zy/keybindings.json 中的用户绑定，并在文件变化时支持热重载。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications } from '../context/notifications.js'
// ChordInterceptor 有意使用 useInput，先于其他 handler 拦截所有按键，这是支持 chord 序列所必需的
// eslint-disable-next-line custom-rules/prefer-use-keybindings
import { type InputEvent, type Key, useInput } from '../ink/index.js'
import { count } from '../utils/array.js'
import { logForDebugging } from '../services/infra/debug.js'
import { plural } from '../utils/stringUtils.js'
import { KeybindingProvider } from './KeybindingContext.js'
import { invokeFirstMatchingHandler, type KeybindingHandlerRegistration } from './dispatch.js'
import {
  initializeKeybindingWatcher,
  type KeybindingsLoadResult,
  loadKeybindingsSyncWithWarnings,
  subscribeToKeybindingChanges,
} from './loadUserBindings.js'
import { resolveKeyWithChordState } from './resolver.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'
import type { KeybindingWarning } from './validate.js'

/**
 * chord 序列的超时时间（ms）。
 * 用户未在此时间内完成 chord 时将其取消。
 */
const CHORD_TIMEOUT_MS = 1000
type Props = {
  children: React.ReactNode
}

/**
 * 通过通知向用户展示快捷键警告。
 * 简短消息会引导用户前往 /doctor 查看详情。
 */
function useKeybindingWarnings(warnings: KeybindingWarning[], _isReload: boolean) {
  const { addNotification, removeNotification } = useNotifications()
  useEffect(() => {
    if (warnings.length === 0) {
      removeNotification('keybinding-config-warning')
      return
    }
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    const errorCount = count(warnings, (w: any) => w.severity === 'error')
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    const warnCount = count(warnings, (w: any) => w.severity === 'warning')
    let message
    if (errorCount > 0 && warnCount > 0) {
      message = `Found ${errorCount} keybinding ${plural(errorCount, 'error')} and ${warnCount} ${plural(warnCount, 'warning')}`
    } else {
      if (errorCount > 0) {
        message = `Found ${errorCount} keybinding ${plural(errorCount, 'error')}`
      } else {
        message = `Found ${warnCount} keybinding ${plural(warnCount, 'warning')}`
      }
    }
    message = `${message} \xB7 /doctor for details`
    addNotification({
      key: 'keybinding-config-warning',
      text: message,
      color: errorCount > 0 ? 'error' : 'warning',
      priority: errorCount > 0 ? 'immediate' : 'high',
      timeoutMs: 60000,
    })
  }, [warnings, addNotification, removeNotification])
}

/**
 * 支持默认绑定、用户绑定、热重载及 chord 的快捷键 provider。
 * 使用此 provider 包裹应用即可启用快捷键支持。
 */
export function KeybindingSetup({ children }: Props): React.ReactNode {
  // 为首次渲染同步加载绑定
  const [{ bindings, warnings }, setLoadResult] = useState<KeybindingsLoadResult>(() => {
    const result = loadKeybindingsSyncWithWarnings()
    logForDebugging(
      `[keybindings] KeybindingSetup initialized with ${result.bindings.length} bindings, ${result.warnings.length} warnings`,
    )
    return result
  })

  // 记录本次是否为重载，而非首次加载
  const [isReload, setIsReload] = useState(false)

  // 通过通知展示警告
  useKeybindingWarnings(warnings, isReload)

  // chord 状态使用 ref 供同步访问，使用 state 触发重新渲染。
  // resolve() 通过 ref 获取当前值，无需等待重新渲染；state 则在 UI 更新等场景触发渲染。
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = useState<ParsedKeystroke[] | null>(null)
  const chordTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // action 回调的 handler 注册表，供 ChordInterceptor 调用
  const handlerRegistryRef = useRef(new Map<string, Set<KeybindingHandlerRegistration>>())

  // 跟踪活跃 context，用于解析快捷键优先级。
  // 使用 ref 而非 state 以便同步更新；输入 handler 必须立即看到当前值，不能等待 React 渲染周期。
  const activeContextsRef = useRef<Set<KeybindingContextName>>(new Set())
  const registerActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.add(context)
  }, [])
  const unregisterActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.delete(context)
  }, [])

  // 组件卸载或 chord 变化时清除超时定时器
  const clearChordTimeout = useCallback(() => {
    if (chordTimeoutRef.current) {
      clearTimeout(chordTimeoutRef.current)
      chordTimeoutRef.current = null
    }
  }, [])

  // 封装 setPendingChord，统一管理超时并同步 ref 与 state
  const setPendingChord = useCallback(
    (pending: ParsedKeystroke[] | null) => {
      clearChordTimeout()
      if (pending !== null) {
        // 设置超时，未完成 chord 时将其取消
        chordTimeoutRef.current = setTimeout(() => {
          logForDebugging('[keybindings] Chord timeout - cancelling')
          pendingChordRef.current = null
          setPendingChordState(null)
        }, CHORD_TIMEOUT_MS)
      }

      // 立即更新 ref，供 resolve() 同步访问
      pendingChordRef.current = pending
      // 更新 state，触发 UI 重新渲染
      setPendingChordState(pending)
    },
    [clearChordTimeout],
  )
  useEffect(() => {
    // 初始化文件 watcher；操作幂等，只会运行一次
    void initializeKeybindingWatcher()

    // 订阅变化
    const unsubscribe = subscribeToKeybindingChanges((result) => {
      // 首次加载由 useState 同步完成，而非通过此订阅，因此任何回调调用都属于重载
      setIsReload(true)
      setLoadResult(result)
      logForDebugging(
        `[keybindings] Reloaded: ${result.bindings.length} bindings, ${result.warnings.length} warnings`,
      )
    })
    return () => {
      unsubscribe()
      clearChordTimeout()
    }
  }, [clearChordTimeout])
  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      <ChordInterceptor
        bindings={bindings}
        pendingChordRef={pendingChordRef}
        setPendingChord={setPendingChord}
        activeContexts={activeContextsRef.current}
        handlerRegistryRef={handlerRegistryRef}
      />
      {children}
    </KeybindingProvider>
  )
}

/**
 * 全局 chord 拦截器，先于子组件注册 useInput。
 *
 * 此组件会拦截 chord 序列中的按键，并在 PromptInput 等其他 handler 收到之前停止传播。
 *
 * 若无此拦截，"ctrl+c r" 中的 `r` 等 chord 第二个按键会先被 PromptInput 捕获并写入输入框，
 * 此时快捷键系统还来不及识别 chord 已完成。
 */
function ChordInterceptor({
  bindings,
  pendingChordRef,
  setPendingChord,
  activeContexts,
  handlerRegistryRef,
}: {
  bindings: ParsedBinding[]
  pendingChordRef: React.RefObject<ParsedKeystroke[] | null>
  setPendingChord: (pending: ParsedKeystroke[] | null) => void
  activeContexts: Set<KeybindingContextName>
  handlerRegistryRef: React.RefObject<Map<string, Set<KeybindingHandlerRegistration>>>
}) {
  const handleInput = (input: string, key: Key, event: InputEvent) => {
    if ((key.wheelUp || key.wheelDown) && pendingChordRef.current === null) {
      return
    }
    const registry = handlerRegistryRef.current
    const handlerContexts = new Set<KeybindingContextName>()
    if (registry) {
      for (const handlers of registry.values()) {
        for (const registration of handlers) {
          handlerContexts.add(registration.context)
        }
      }
    }
    const contexts: KeybindingContextName[] = [...handlerContexts, ...activeContexts, 'Global']
    const wasInChord = pendingChordRef.current !== null
    const result = resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current)
    switch (result.type) {
      case 'chord_started': {
        setPendingChord(result.pending)
        event.stopImmediatePropagation()
        break
      }
      case 'match': {
        setPendingChord(null)
        if (wasInChord) {
          if (registry) {
            const handlers = registry.get(result.action)
            if (handlers && handlers.size > 0 && invokeFirstMatchingHandler(handlers, contexts)) {
              event.stopImmediatePropagation()
            }
          }
        }
        break
      }
      case 'chord_cancelled': {
        setPendingChord(null)
        event.stopImmediatePropagation()
        break
      }
      case 'unbound': {
        setPendingChord(null)
        // 单键 null 绑定表示“恢复默认输入”，应继续传给输入组件；若它是 chord 的
        // 后续按键，则前缀已经被消费，仍需拦截以免只插入残缺的尾键。
        if (wasInChord) {
          event.stopImmediatePropagation()
        }
        break
      }
      case 'none':
    }
  }
  useInput(handleInput)
  return null
}
