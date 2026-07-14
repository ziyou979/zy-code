import type { AppState } from '../AppStateStore.js'

export type NotificationSlice = Pick<AppState, 'notifications' | 'elicitation'>

export function createNotificationSlice(): NotificationSlice {
  return {
    notifications: { current: null, queue: [] },
    elicitation: { queue: [] },
  }
}

export function selectNotificationCount(state: Pick<AppState, 'notifications'>): number {
  return state.notifications.queue.length + (state.notifications.current ? 1 : 0)
}
