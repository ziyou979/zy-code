import * as React from 'react'
import {
  formatCost,
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  hasUnknownModelCost,
} from '../../cost-tracker.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { formatDuration, formatNumber } from '../../utils/format.js'

// 标签列的固定显示宽度（Ink Box width 按显示宽度计算，自动处理 CJK 双列宽）
const LABEL_COL_WIDTH = 23

function LabelRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_COL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
}

function ModelUsageSection() {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return <Text dimColor>{tSync('costTracker.usageEmpty')}</Text>
  }

  const entries = Object.entries(modelUsageMap)

  return (
    <Box flexDirection="column">
      <Text dimColor>{tSync('costTracker.usageByModel')}</Text>
      {entries.map(([model, usage]) => {
        const parts = [
          `${formatNumber(usage.inputTokens)} ${tSync('costTracker.input')}`,
          `${formatNumber(usage.outputTokens)} ${tSync('costTracker.output')}`,
          `${formatNumber(usage.cacheReadInputTokens)} ${tSync('costTracker.cacheRead')}`,
          `${formatNumber(usage.cacheCreationInputTokens)} ${tSync('costTracker.cacheWrite')}`,
        ]
        if (usage.webSearchRequests > 0) {
          parts.push(
            `${formatNumber(usage.webSearchRequests)} ${tSync('costTracker.webSearch')}`,
          )
        }
        const usageStr = `${parts.join(', ')} (${formatCost(usage.costUSD)})`
        return (
          <Box key={model}>
            <Box width={LABEL_COL_WIDTH} justifyContent="flex-end">
              <Text dimColor>{`${model}:`}</Text>
            </Box>
            <Text>  {usageStr}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function SessionCost() {
  const costDisplay =
    formatCost(getTotalCost()) +
    (hasUnknownModelCost() ? ` ${tSync('costTracker.costsMayBeInaccurate')}` : '')

  const linesAdded = getTotalLinesAdded()
  const linesRemoved = getTotalLinesRemoved()
  const codeChanges = `${tSync(linesAdded === 1 ? 'costTracker.lineAdded' : 'costTracker.linesAdded', { count: linesAdded })}, ${tSync(linesRemoved === 1 ? 'costTracker.lineRemoved' : 'costTracker.linesRemoved', { count: linesRemoved })}`

  return (
    <Box flexDirection="column">
      <Text bold>{tSync('costTracker.sessionHeader')}</Text>
      <Box flexDirection="column" marginTop={1}>
        <LabelRow label={`${tSync('costTracker.totalCost')}:`} value={costDisplay} />
        <LabelRow
          label={`${tSync('costTracker.totalDurationApi')}:`}
          value={formatDuration(getTotalAPIDuration())}
        />
        <LabelRow
          label={`${tSync('costTracker.totalDurationWall')}:`}
          value={formatDuration(getTotalDuration())}
        />
        <LabelRow label={`${tSync('costTracker.totalCodeChanges')}:`} value={codeChanges} />
        <ModelUsageSection />
      </Box>
    </Box>
  )
}
