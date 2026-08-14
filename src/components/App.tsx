import React from 'react'
import { FpsMetricsProvider } from '../context/FpsMetrics.js'
import { StatsProvider, type StatsStore } from '../context/stats.js'
import type { AppState } from '../state/AppStateStore.js'
import { AppStateProvider } from '../state/AppState.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'

type Props = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
  children: React.ReactNode
}

/**
 * 交互式会话的顶层 wrapper。
 * 向组件树提供 FPS 指标、stats context 和应用状态。
 */
export function App({ getFpsMetrics, stats, initialState, children }: Props) {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      {
        <StatsProvider store={stats}>
          {
            <AppStateProvider initialState={initialState} onChangeAppState={onChangeAppState}>
              {children}
            </AppStateProvider>
          }
        </StatsProvider>
      }
    </FpsMetricsProvider>
  )
}
