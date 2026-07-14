import type { AppState } from '../AppStateStore.js'

export type TaskSlice = Pick<
  AppState,
  | 'tasks'
  | 'agentNameRegistry'
  | 'foregroundedTaskId'
  | 'viewingAgentTaskId'
  | 'todos'
  | 'remoteAgentTaskSuggestions'
>

export function createTaskSlice(): TaskSlice {
  return {
    tasks: {},
    agentNameRegistry: new Map(),
    foregroundedTaskId: undefined,
    viewingAgentTaskId: undefined,
    todos: {},
    remoteAgentTaskSuggestions: [],
  }
}

export function selectTaskCount(state: Pick<AppState, 'tasks'>): number {
  return Object.keys(state.tasks).length
}
