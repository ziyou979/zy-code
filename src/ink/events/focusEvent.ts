import { type EventTarget, TerminalEvent } from './terminalEvent.js'

/**
 * 组件焦点变化时触发的 focus 事件。
 *
 * 焦点在元素间移动时分发：'focus' 在新获焦元素上触发，'blur' 在原获焦元素上触发。
 * 两者都会冒泡，与 react-dom 使用 focusin/focusout 的语义一致，
 * 从而让父组件能够观察后代元素的焦点变化。
 */
export class FocusEvent extends TerminalEvent {
  readonly relatedTarget: EventTarget | null

  constructor(type: 'focus' | 'blur', relatedTarget: EventTarget | null = null) {
    super(type, { bubbles: true, cancelable: false })
    this.relatedTarget = relatedTarget
  }
}
