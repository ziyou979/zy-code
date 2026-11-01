type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
  normalize?: (previous: T, next: T) => T,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const updated = updater(prev)
      const next = normalize ? normalize(prev, updated) : updated
      if (Object.is(next, prev)) {
        return
      }
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) {
        listener()
      }
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
