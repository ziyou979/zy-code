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

  /** Snapshot for useSyncExternalStore. Returns true when not idle. */
  getSnapshot = (): boolean => {
    return this._state !== 'idle'
  }

  /** Subscribe for useSyncExternalStore. Arrow property = auto-bound. */
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
