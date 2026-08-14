import { useCallback, useEffect } from 'react'
import type { InputEvent } from '../ink/events/inputEvent.js'
import { type Key, useInput } from '../ink/index.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

type Options = {
  /** 此绑定所属的 context，默认为 Global。 */
  context?: KeybindingContextName
  /** 仅在活跃时处理，与 useInput 的 isActive 类似。 */
  isActive?: boolean
}

/**
 * 处理快捷键绑定的 Ink 原生 hook。
 *
 * handler 保留在组件中，遵循 React 用法；按键到 action 的绑定来自配置。
 *
 * 支持 "ctrl+k ctrl+s" 等 chord 序列。chord 开始后，hook 会自动管理待完成状态。
 *
 * 绑定处理完毕后调用 stopImmediatePropagation()，避免触发其他 handler。
 *
 * @example
 * ```tsx
 * useKeybinding('app:toggleTodos', () => {
 *   setShowTodos(prev => !prev)
 * }, { context: 'Global' })
 * ```
 */
export function useKeybinding(
  action: string,
  handler: () => void | false | Promise<void>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // 在 context 中注册 handler，供 ChordInterceptor 调用
  useEffect(() => {
    if (!keybindingContext || !isActive) {
      return
    }
    return keybindingContext.registerHandler({ action, context, handler })
  }, [action, context, handler, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // 没有可用的快捷键 context 时跳过解析
      if (!keybindingContext) {
        return
      }

      // 构造 context 列表：已注册的活跃 context、当前 context、Global。
      // 更具体的已注册 context 应优先于 Global。
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // 在保留顺序的同时去重；首次出现者优先
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // chord 已完成时清除待完成状态
          keybindingContext.setPendingChord(null)
          if (result.action === action) {
            if (handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // 用户开始 chord 序列时更新待完成状态
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // chord 因 escape 或无效按键被取消
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // 已明确解绑，清除待完成的 chord
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // 无匹配项，交由其他 handler 尝试
          break
      }
    },
    [action, context, handler, keybindingContext],
  )

  useInput(handleInput, { isActive })
}

/**
 * 在一个 hook 中处理多个快捷键绑定，减少 useInput 调用。
 *
 * 支持 chord 序列；chord 开始后，hook 会自动管理待完成状态。
 *
 * @example
 * ```tsx
 * useKeybindings({
 *   'chat:submit': () => handleSubmit(),
 *   'chat:cancel': () => handleCancel(),
 * }, { context: 'Chat' })
 * ```
 */
export function useKeybindings(
  // handler 返回 false 表示“未消费”，事件会继续传播给后续 useInput/useKeybindings handler。
  // 这适用于回落处理：例如 ScrollBox 内容无需滚动时，ScrollKeybindingHandler 的 scroll:line*
  // 返回 false，让子组件 handler 接管滚轮事件执行列表导航。允许 fire-and-forget 异步 handler
  // 返回 Promise<void>；`!== false` 只会在同步返回 false 时保留传播，不会等待中的 Promise。
  handlers: Record<string, () => void | false | Promise<void>>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // 在 context 中注册所有 handler，供 ChordInterceptor 调用
  useEffect(() => {
    if (!keybindingContext || !isActive) {
      return
    }

    const unregisterFns: Array<() => void> = []
    for (const [action, handler] of Object.entries(handlers)) {
      unregisterFns.push(keybindingContext.registerHandler({ action, context, handler }))
    }

    return () => {
      for (const unregister of unregisterFns) {
        unregister()
      }
    }
  }, [context, handlers, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // 没有可用的快捷键 context 时跳过解析
      if (!keybindingContext) {
        return
      }

      // 构造 context 列表：已注册的活跃 context、当前 context、Global。
      // 更具体的已注册 context 应优先于 Global。
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // 在保留顺序的同时去重；首次出现者优先
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // chord 已完成时清除待完成状态
          keybindingContext.setPendingChord(null)
          if (result.action in handlers) {
            const handler = handlers[result.action]
            if (handler && handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // 用户开始 chord 序列时更新待完成状态
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // chord 因 escape 或无效按键被取消
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // 已明确解绑，清除待完成的 chord
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // 无匹配项，交由其他 handler 尝试
          break
      }
    },
    [context, handlers, keybindingContext],
  )

  useInput(handleInput, { isActive })
}
