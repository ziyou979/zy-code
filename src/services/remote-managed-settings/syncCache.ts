import { resetSyncCache as resetLeafCache, setEligibility } from './syncCacheState.js'

export function resetSyncCache(): void {
  resetLeafCache()
}

export function isRemoteManagedSettingsEligible(): boolean {
  // 尚无可信的远程设置服务，也不应用旧端点留下的缓存。
  return setEligibility(false)
}
