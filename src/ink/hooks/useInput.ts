import { useCallback, useLayoutEffect, useRef } from 'react'
import type { InputEvent, Key } from '../events/inputEvent.js'
import useStdin from './useStdin.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /**
   * 是否启用用户输入捕获。
   * 当同时使用多个 useInput hook 时非常有用，可避免重复处理相同的输入。
   *
   * @default true
   */
  isActive?: boolean
}

/**
 * 该 hook 用于处理用户输入。
 * 它是使用 `StdinContext` 并监听 `data` 事件的更便捷的替代方案。
 * 当用户输入任意字符时，传给 `useInput` 的回调函数会被调用。
 * 但如果用户粘贴了一段超过一个字符的文本，回调函数只会被调用一次，整个字符串会作为 `input` 传入。
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // 退出程序
 *     }
 *
 *     if (key.leftArrow) {
 *       // 左方向键被按下
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // 在 mount 时仅注册一次监听器，以确保其在 EventEmitter 的 listener 数组中的位置稳定。
  // 如果将 isActive 放在 effect 的 deps 中，监听器会在 false→true 时重新添加，
  // 排在它处于非激活期间注册的监听器之后——这会破坏 stopImmediatePropagation() 的顺序。
  // usehooks-ts 在无 window 的终端环境会退化为普通 effect；这里显式在提交阶段
  // 同步最新回调，避免已订阅的监听器在首次读取或重新激活时仍使用旧状态。
  const handlerRef = useRef({ inputHandler, isActive: options.isActive, internal_exitOnCtrlC })
  useLayoutEffect(() => {
    handlerRef.current = { inputHandler, isActive: options.isActive, internal_exitOnCtrlC }
  })
  const handleData = useCallback((event: InputEvent) => {
    const current = handlerRef.current
    if (current.isActive === false) {
      return
    }
    const { input, key } = event

    // 如果应用不应在 Ctrl+C 时退出，则交由 input 监听器处理
    // 注意：discreteUpdates 在 emit 事件时于 App 层级调用，
    // 因此所有监听器已处于高优先级更新上下文中。
    if (!(input === 'c' && key.ctrl) || !current.internal_exitOnCtrlC) {
      current.inputHandler(input, key, event)
    }
  }, [])

  // 先在提交阶段稳定订阅，再启用终端读取，避免首批按键先于订阅到达。
  useLayoutEffect(() => {
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])

  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }
    setRawMode(true)
    return () => setRawMode(false)
  }, [options.isActive, setRawMode])
}

export default useInput
