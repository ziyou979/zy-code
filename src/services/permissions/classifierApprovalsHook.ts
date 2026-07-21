import { useSyncExternalStore } from 'react'
import { isClassifierChecking, subscribeClassifierChecking } from './classifierApprovals.js'

export function useIsClassifierChecking(toolUseID: string): boolean {
  const isChecking = useSyncExternalStore(subscribeClassifierChecking, () =>
    isClassifierChecking(toolUseID),
  )
  return isChecking
}
