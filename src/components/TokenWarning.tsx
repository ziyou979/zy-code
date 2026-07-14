import { feature } from 'bun:bundle'
import { useSyncExternalStore } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  calculateTokenWarningState,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js'
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js'

type Props = {
  tokenUsage: number
  model: string
}

/**
 * 实时折叠进度："x / y 已总结"。作为子组件，以便
 * useSyncExternalStore 可以无条件订阅 store 变更
 * （在条件中调用 hooks 会违反 React 规则）。父组件仅在
 * feature('CONTEXT_COLLAPSE') + isContextCollapseEnabled() 时渲染此组件。
 */
function CollapseLabel() {
  const collapseModule = require('../services/compact/context-collapse/index.js')
  const { getStats, subscribe } =
    collapseModule as typeof import('../services/compact/context-collapse/index.js')
  const snapshot = useSyncExternalStore(subscribe, () => {
    const stats = getStats()
    const idleWarn = stats.health.emptySpawnWarningEmitted ? 1 : 0
    return `${stats.collapsedSpans}|${stats.stagedSpans}|${stats.health.totalErrors}|${stats.health.totalEmptySpawns}|${idleWarn}`
  })
  const statsValues = snapshot.split('|').map(Number)
  const [collapsed, staged, errors, emptySpawns, idleWarning] = statsValues
  const total = collapsed + staged
  if (errors > 0 || idleWarning) {
    const problem =
      errors > 0
        ? tSync('tokenWarning.collapseErrors', {
            count: errors,
          })
        : tSync('tokenWarning.collapseIdle', {
            count: emptySpawns,
          })
    return (
      <Text color="warning" wrap="truncate">
        {total > 0
          ? `${tSync('tokenWarning.summarized', {
              collapsed,
              total,
            })} \u00b7 ${problem}`
          : problem}
      </Text>
    )
  }
  if (total === 0) {
    return null
  }
  const label = tSync('tokenWarning.summarized', {
    collapsed,
    total,
  })
  return (
    <Text dimColor={true} wrap="truncate">
      {label}
    </Text>
  )
}
export function TokenWarning({ tokenUsage, model }: Props) {
  const { percentLeft, isAboveWarningThreshold, isAboveErrorThreshold } =
    calculateTokenWarningState(tokenUsage, model)
  const suppressWarning = useCompactWarningSuppression()
  if (!isAboveWarningThreshold || suppressWarning) {
    return null
  }
  const showAutoCompactWarning = isAutoCompactEnabled()
  let displayPercentLeft = percentLeft
  let reactiveOnlyMode = false
  let collapseMode = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('zy_cobalt_raccoon', false)) {
      reactiveOnlyMode = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    const { isContextCollapseEnabled } =
      require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js')
    if (isContextCollapseEnabled()) {
      collapseMode = true
    }
  }
  if (reactiveOnlyMode || collapseMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model)
    const remainingPercent = Math.round(((effectiveWindow - tokenUsage) / effectiveWindow) * 100)
    displayPercentLeft = Math.max(0, remainingPercent)
  }
  if (collapseMode && feature('CONTEXT_COLLAPSE')) {
    return (
      <Box flexDirection="row">
        <CollapseLabel />
      </Box>
    )
  }
  const autoCompactLabel = reactiveOnlyMode
    ? tSync('tokenWarning.contextUsed', {
        pct: 100 - displayPercentLeft,
      })
    : tSync('tokenWarning.untilAutoCompact', {
        pct: displayPercentLeft,
      })
  const contextLowText = tSync('tokenWarning.contextLow', {
    pct: percentLeft,
  })
  const compactAction = tSync('tokenWarning.runCompact')
  return (
    <Box flexDirection="row">
      {showAutoCompactWarning ? (
        <Text dimColor={true} wrap="truncate">
          {autoCompactLabel}
        </Text>
      ) : (
        <Text color={isAboveErrorThreshold ? 'error' : 'warning'} wrap="truncate">
          {`${contextLowText} \u00b7 ${compactAction}`}
        </Text>
      )}
    </Box>
  )
}
