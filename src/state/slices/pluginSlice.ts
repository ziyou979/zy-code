import type { AppState } from '../AppStateStore.js'

export type PluginSlice = Pick<AppState, 'plugins'>

export function createPluginSlice(): PluginSlice {
  return {
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: { marketplaces: [], plugins: [] },
      needsRefresh: false,
    },
  }
}

export function markPluginStateForRefresh(state: AppState): AppState {
  return {
    ...state,
    plugins: { ...state.plugins, needsRefresh: true },
  }
}
