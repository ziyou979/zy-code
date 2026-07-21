import { AsyncLocalStorage } from 'node:async_hooks'
import { getCwdState, getOriginalCwd } from 'src/bootstrap/runtime/runtimeContext.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
