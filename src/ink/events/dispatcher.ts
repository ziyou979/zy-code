import {
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import { logError } from '../../utils/log.js'
import { HANDLER_FOR_EVENT } from './event-handlers.js'
import type { EventTarget, TerminalEvent } from './terminal-event.js'

// --

type DispatchListener = {
  node: EventTarget
  handler: (event: TerminalEvent) => void
  phase: 'capturing' | 'at_target' | 'bubbling'
}

function getHandler(
  node: EventTarget,
  eventType: string,
  capture: boolean,
): ((event: TerminalEvent) => void) | undefined {
  const handlers = node._eventHandlers
  if (!handlers) return undefined

  const mapping = HANDLER_FOR_EVENT[eventType]
  if (!mapping) return undefined

  const propName = capture ? mapping.capture : mapping.bubble
  if (!propName) return undefined

  return handlers[propName] as ((event: TerminalEvent) => void) | undefined
}

/**
 * 按派发顺序收集事件的所有监听器。
 *
 * 使用 react-dom 的两阶段收集模式：
 * - 从 target 遍历到 root
 * - 捕获阶段的监听器插入到前面（unshift）→ 从 root 开始
 * - 冒泡阶段的监听器追加到后面（push）→ 从 target 开始
 *
 * 结果：[root-cap, ..., parent-cap, target-cap, target-bub, parent-bub, ..., root-bub]
 */
function collectListeners(
  target: EventTarget,
  event: TerminalEvent,
): DispatchListener[] {
  const listeners: DispatchListener[] = []

  let node: EventTarget | undefined = target
  while (node) {
    const isTarget = node === target

    const captureHandler = getHandler(node, event.type, true)
    const bubbleHandler = getHandler(node, event.type, false)

    if (captureHandler) {
      listeners.unshift({
        node,
        handler: captureHandler,
        phase: isTarget ? 'at_target' : 'capturing',
      })
    }

    if (bubbleHandler && (event.bubbles || isTarget)) {
      listeners.push({
        node,
        handler: bubbleHandler,
        phase: isTarget ? 'at_target' : 'bubbling',
      })
    }

    node = node.parentNode
  }

  return listeners
}

/**
 * 执行已收集的监听器，支持传播控制。
 *
 * 在每个监听器执行前，调用 event._prepareForTarget(node)，
 * 以便 event 子类可以执行每个节点的初始化操作。
 */
function processDispatchQueue(
  listeners: DispatchListener[],
  event: TerminalEvent,
): void {
  let previousNode: EventTarget | undefined

  for (const { node, handler, phase } of listeners) {
    if (event._isImmediatePropagationStopped()) {
      break
    }

    if (event._isPropagationStopped() && node !== previousNode) {
      break
    }

    event._setEventPhase(phase)
    event._setCurrentTarget(node)
    event._prepareForTarget(node)

    try {
      handler(event)
    } catch (error) {
      logError(error)
    }

    previousNode = node
  }
}

// --

/**
 * 将终端事件类型映射到 React 调度优先级。
 * 与 react-dom 的 getEventPriority() switch 逻辑一致。
 */
function getEventPriority(eventType: string): number {
  switch (eventType) {
    case 'keydown':
    case 'keyup':
    case 'click':
    case 'focus':
    case 'blur':
    case 'paste':
      return DiscreteEventPriority as number
    case 'resize':
    case 'scroll':
    case 'mousemove':
      return ContinuousEventPriority as number
    default:
      return DefaultEventPriority as number
  }
}

// --

type DiscreteUpdates = <A, B>(
  fn: (a: A, b: B) => boolean,
  a: A,
  b: B,
  c: undefined,
  d: undefined,
) => boolean

/**
 * 管理事件派发状态和捕获/冒泡派发循环。
 *
 * reconciler host config 通过读取 currentEvent 和 currentUpdatePriority
 * 来实现 resolveUpdatePriority、resolveEventType 和
 * resolveEventTimeStamp —— 这与 react-dom 的 host config
 * 读取 ReactDOMSharedInternals 和 window.event 的方式一致。
 *
 * discreteUpdates 在构造函数之后注入（由 InkReconciler 完成），
 * 以打破循环依赖。
 */
export class Dispatcher {
  currentEvent: TerminalEvent | null = null
  currentUpdatePriority: number = DefaultEventPriority as number
  discreteUpdates: DiscreteUpdates | null = null

  /**
   * 根据当前正在派发的事件推断事件优先级。
   * 在未显式设置优先级时，由 reconciler host config 的
   * resolveUpdatePriority 调用。
   */
  resolveEventPriority(): number {
    if (this.currentUpdatePriority !== (NoEventPriority as number)) {
      return this.currentUpdatePriority
    }
    if (this.currentEvent) {
      return getEventPriority(this.currentEvent.type)
    }
    return DefaultEventPriority as number
  }

  /**
   * 通过捕获和冒泡阶段派发事件。
   * 如果未调用 preventDefault()，则返回 true。
   */
  dispatch(target: EventTarget, event: TerminalEvent): boolean {
    const previousEvent = this.currentEvent
    this.currentEvent = event
    try {
      event._setTarget(target)

      const listeners = collectListeners(target, event)
      processDispatchQueue(listeners, event)

      event._setEventPhase('none')
      event._setCurrentTarget(null)

      return !event.defaultPrevented
    } finally {
      this.currentEvent = previousEvent
    }
  }

  /**
   * 以离散（同步）优先级派发事件。
   * 用于用户主动触发的事件：键盘、点击、焦点、粘贴。
   */
  dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean {
    if (!this.discreteUpdates) {
      return this.dispatch(target, event)
    }
    return this.discreteUpdates(
      (t, e) => this.dispatch(t, e),
      target,
      event,
      undefined,
      undefined,
    )
  }

  /**
   * 以连续优先级派发事件。
   * 用于高频事件：resize、scroll、鼠标移动。
   */
  dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean {
    const previousPriority = this.currentUpdatePriority
    try {
      this.currentUpdatePriority = ContinuousEventPriority as number
      return this.dispatch(target, event)
    } finally {
      this.currentUpdatePriority = previousPriority
    }
  }
}
