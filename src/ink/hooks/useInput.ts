import { useEffect, useLayoutEffect } from 'react'
import { useEventCallback } from 'usehooks-ts'
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

  // 使用 useLayoutEffect（而非 useEffect）以便在 React 的 commit 阶段同步启用 raw mode，
  // 这样 render() 返回时 raw mode 已就绪。如果使用 useEffect，raw mode 的设置会通过
  // React 的调度器推迟到下一个事件循环 tick，导致终端在此期间处于 cooked 模式——
  // 按键会回显且光标可见，直到 effect 触发。
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    setRawMode(true)

    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // 在 mount 时仅注册一次监听器，以确保其在 EventEmitter 的 listener 数组中的位置稳定。
  // 如果将 isActive 放在 effect 的 deps 中，监听器会在 false→true 时重新添加，
  // 排在它处于非激活期间注册的监听器之后——这会破坏 stopImmediatePropagation() 的顺序。
  // useEventCallback 保持引用稳定，同时通过闭包读取最新的 isActive/inputHandler
  //（它通过 useLayoutEffect 同步，对编译器安全）。
  const handleData = useEventCallback((event: InputEvent) => {
    if (options.isActive === false) {
      return
    }
    const { input, key } = event

    // 如果应用不应在 Ctrl+C 时退出，则交由 input 监听器处理
    // 注意：discreteUpdates 在 emit 事件时于 App 层级调用，
    // 因此所有监听器已处于高优先级更新上下文中。
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput
