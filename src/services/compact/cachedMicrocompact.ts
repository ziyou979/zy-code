// Stub for src/services/compact/cachedMicrocompact.ts

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
  return { enabled: false }
}
