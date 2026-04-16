import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'

// 类似于 node 内置的 EventEmitter，但也感知我们的 `Event`
// 类，因此 `emit` 会尊重 `stopImmediatePropagation()`。
export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // 禁用默认的 maxListeners 警告。在 React 中，多个组件
    // 监听同一事件是合理的（例如 useInput hooks）。
    // 默认的 10 个限制会导致误报警告。
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // 将 `error` 委托给 node 处理，因为它不被视为普通事件
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    const listeners = this.rawListeners(type)

    if (listeners.length === 0) {
      return false
    }

    const ccEvent = args[0] instanceof Event ? args[0] : null

    for (const listener of listeners) {
      listener.apply(this, args)

      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
    }

    return true
  }
}
