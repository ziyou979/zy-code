import { Event } from './event.js'

export type TerminalFocusEventType = 'terminalfocus' | 'terminalblur'

/**
 * 终端窗口获得或失去焦点时触发的事件。
 *
 * 使用 DECSET 1004 焦点报告，终端会发送：
 * - 获得焦点时发送 CSI I（\x1b[I）
 * - 失去焦点时发送 CSI O（\x1b[O）
 */
export class TerminalFocusEvent extends Event {
  readonly type: TerminalFocusEventType

  constructor(type: TerminalFocusEventType) {
    super()
    this.type = type
  }
}
