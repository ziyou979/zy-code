import { createContext } from 'react'
import { EventEmitter } from '../events/emitter.js'
import type { TerminalQuerier } from '../terminalQuerier.js'

export type Props = {
  /**
   * 传递给 `render()` 的 `options.stdin` 的 stdin 流，默认是 `process.stdin`。在需要处理用户输入时很有用。
   */
  readonly stdin: NodeJS.ReadStream

  /**
   * Ink 通过 `<StdinContext>` 暴露此函数以处理 Ctrl+C，因此你应该使用 Ink 的 `setRawMode` 而非 `process.stdin.setRawMode`。
   * 如果传递给 Ink 的 `stdin` 流不支持 setRawMode，此函数不执行任何操作。
   */
  readonly setRawMode: (value: boolean) => void

  /**
   * 布尔标志，判断当前 `stdin` 是否支持 `setRawMode`。使用 `setRawMode` 的组件可以用 `isRawModeSupported` 在不支持 raw mode 的环境中优雅降级。
   */
  readonly isRawModeSupported: boolean

  readonly internal_exitOnCtrlC: boolean

  readonly internal_eventEmitter: EventEmitter

  /** 查询终端并等待响应（DECRQM、OSC 11 等）。
   *  仅在永远不会达到的默认上下文值中为 null。*/
  readonly internal_querier: TerminalQuerier | null
}

/**
 * `StdinContext` 是一个 React 上下文，暴露输入流。
 */

const StdinContext = createContext<Props>({
  stdin: process.stdin,

  internal_eventEmitter: new EventEmitter(),
  setRawMode() {},
  isRawModeSupported: false,

  internal_exitOnCtrlC: true,
  internal_querier: null,
})

// eslint-disable-next-line custom-rules/no-top-level-side-effects
StdinContext.displayName = 'InternalStdinContext'

export default StdinContext
