import { useEffect, useState } from 'react'
import { currentLimits, statusListeners, type ZyAILimits } from './zyAiLimits.js'

export function useZyAiLimits(): ZyAILimits {
  const [limits, setLimits] = useState<ZyAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: ZyAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
