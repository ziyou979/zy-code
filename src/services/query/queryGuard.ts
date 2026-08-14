import { createSignal } from '../../utils/signal.js'

export type GuardState = 'idle' | 'dispatching' | 'running'

export class QueryGuard {
  private _state: GuardState = 'idle'
  private _reservation: unknown = null
  private _onChange = createSignal()

  get isActive(): boolean {
    return this._state !== 'idle'
  }

  getState(): GuardState {
    return this._state
  }

  /** 提供给 useSyncExternalStore 的快照；非 idle 状态时返回 true。 */
  getSnapshot = (): boolean => {
    return this._state !== 'idle'
  }

  /** 提供给 useSyncExternalStore 的订阅函数；使用箭头属性以自动绑定 this。 */
  subscribe = (listener: () => void): (() => void) => {
    return this._onChange.subscribe(listener)
  }

  reserve(): boolean {
    if (this._state !== 'idle') {
      return false
    }
    this._state = 'dispatching'
    this._onChange.emit()
    return true
  }

  cancelReservation(): void {
    if (this._state === 'dispatching') {
      this._state = 'idle'
      this._onChange.emit()
    }
  }

  tryStart(reservation?: unknown): unknown {
    if (this._state === 'running') {
      return false
    }
    if (this._state === 'dispatching' && reservation !== this._reservation) {
      return false
    }
    this._state = 'running'
    this._reservation = Symbol('generation')
    this._onChange.emit()
    return this._reservation
  }

  end(generation?: unknown): boolean {
    if (this._state !== 'running') {
      return false
    }
    this._state = 'idle'
    this._onChange.emit()
    return true
  }

  forceEnd(): void {
    this._state = 'idle'
    this._onChange.emit()
  }
}
