import type { AppState } from '../AppStateStore.js'

export type UiSlice = Pick<
  AppState,
  | 'expandedView'
  | 'isBriefOnly'
  | 'showTeammateMessagePreview'
  | 'selectedIPAgentIndex'
  | 'coordinatorTaskIndex'
  | 'viewSelectionMode'
  | 'footerSelection'
  | 'activeOverlays'
>

export function createUiSlice(): UiSlice {
  return {
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    activeOverlays: new Set<string>(),
  }
}

export function selectHasActiveOverlay(state: Pick<AppState, 'activeOverlays'>): boolean {
  return state.activeOverlays.size > 0
}
