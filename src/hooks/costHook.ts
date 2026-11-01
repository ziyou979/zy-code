import { useEffect, useRef } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from '../services/cost/costTracker.js'
import { hasConsoleBillingAccess } from '../services/billing/billing.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'

export function useCostSummary(getFpsMetrics?: () => FpsMetrics | undefined): void {
  const getFpsMetricsRef = useRef(getFpsMetrics)
  getFpsMetricsRef.current = getFpsMetrics

  useEffect(() => {
    let saved = false
    const saveOnce = (isProcessExit: boolean) => {
      if (saved) {
        return
      }
      saved = true
      if (isProcessExit && hasConsoleBillingAccess()) {
        process.stdout.write(`\n${formatTotalCost()}\n`)
      }
      saveCurrentSessionCosts(getFpsMetricsRef.current?.())
    }
    const onProcessExit = () => saveOnce(true)
    process.on('exit', onProcessExit)
    return () => {
      process.off('exit', onProcessExit)
      // gracefulShutdown 在 process.exit 之前调用 inst.unmount() 卸载 React 树，
      // 因此卸载清理时必须保存当前会话的费用与耗时数据，避免退出后 /resume 丢失耗时。
      saveOnce(false)
    }
  }, [])
}
