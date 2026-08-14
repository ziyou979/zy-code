import type { ClickEvent } from './clickEvent.js'
import type { FocusEvent } from './focusEvent.js'
import type { KeyboardEvent } from './keyboardEvent.js'
// @ts-expect-error
import type { PasteEvent } from './paste-event.js'
// @ts-expect-error
import type { ResizeEvent } from './resize-event.js'

type KeyboardEventHandler = (event: KeyboardEvent) => void
type FocusEventHandler = (event: FocusEvent) => void
type PasteEventHandler = (event: PasteEvent) => void
type ResizeEventHandler = (event: ResizeEvent) => void
type ClickEventHandler = (event: ClickEvent) => void
type HoverEventHandler = () => void

/**
 * Box 和其他 host 组件的事件处理器 props。
 *
 * 遵循 React/DOM 命名约定：
 * - onEventName：冒泡阶段的处理器
 * - onEventNameCapture：捕获阶段的处理器
 */
export type EventHandlerProps = {
  onKeyDown?: KeyboardEventHandler
  onKeyDownCapture?: KeyboardEventHandler

  onFocus?: FocusEventHandler
  onFocusCapture?: FocusEventHandler
  onBlur?: FocusEventHandler
  onBlurCapture?: FocusEventHandler

  onPaste?: PasteEventHandler
  onPasteCapture?: PasteEventHandler

  onResize?: ResizeEventHandler

  onClick?: ClickEventHandler
  onMouseMove?: HoverEventHandler
  onMouseEnter?: HoverEventHandler
  onMouseLeave?: HoverEventHandler
}

/**
 * 反向查找：事件类型字符串 → 处理器 prop 名称。
 * dispatcher 用它以 O(1) 复杂度查找每个节点的处理器。
 */
export const HANDLER_FOR_EVENT: Record<
  string,
  { bubble?: keyof EventHandlerProps; capture?: keyof EventHandlerProps }
> = {
  keydown: { bubble: 'onKeyDown', capture: 'onKeyDownCapture' },
  focus: { bubble: 'onFocus', capture: 'onFocusCapture' },
  blur: { bubble: 'onBlur', capture: 'onBlurCapture' },
  paste: { bubble: 'onPaste', capture: 'onPasteCapture' },
  resize: { bubble: 'onResize' },
  click: { bubble: 'onClick' },
}

/**
 * 所有事件处理器 prop 名称的集合，供 reconciler 识别事件 prop，
 * 并将其存入 _eventHandlers 而不是 attributes。
 */
export const EVENT_HANDLER_PROPS = new Set<string>([
  'onKeyDown',
  'onKeyDownCapture',
  'onFocus',
  'onFocusCapture',
  'onBlur',
  'onBlurCapture',
  'onPaste',
  'onPasteCapture',
  'onResize',
  'onClick',
  'onMouseMove',
  'onMouseEnter',
  'onMouseLeave',
])
