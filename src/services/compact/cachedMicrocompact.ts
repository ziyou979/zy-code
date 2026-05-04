export type CachedMCState = {
  enabled: boolean
}

export type CacheEditsBlock = {
  type: 'cache_edit'
  content: string
}

export type PinnedCacheEdits = {
  id: string
  content: string
}

export function getCachedMCState(): CachedMCState {
  return { enabled: true }
}

export function createCachedMCState(): CachedMCState {
  return { enabled: true }
}

export function markToolsSentToAPI(_state: CachedMCState): void {
  // no-op: ZY Code 暂不需要跟踪发送到 API 的工具
}

export function resetCachedMCState(_state: CachedMCState): void {
  _state.enabled = true
}
