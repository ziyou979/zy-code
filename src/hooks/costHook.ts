import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from '../services/cost/costTracker.js'
import { hasConsoleBillingAccess } from '../services/billing/billing.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'

export function useCostSummary(getFpsMetrics?: () => FpsMetrics | undefined): void {
  useEffect(() => {
    const f = () => {
      if (hasConsoleBillingAccess()) {
        process.stdout.write(`\n${formatTotalCost()}\n`)
      }

      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [getFpsMetrics])
}
