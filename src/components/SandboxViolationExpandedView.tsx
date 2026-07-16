import { useEffect, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { SandboxManager } from '../services/sandbox/sandbox-adapter.js'

/**
 * Format a timestamp as "h:mm:ssa" (e.g., "1:30:45pm").
 * Replaces date-fns format() to avoid pulling in a 39MB dependency for one call.
 */
function formatTime(date: Date): string {
  const h = date.getHours() % 12 || 12
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const ampm = date.getHours() < 12 ? 'am' : 'pm'
  return `${h}:${m}:${s}${ampm}`
}

import { getPlatform } from 'src/services/shell/platform.js'
export function SandboxViolationExpandedView() {
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const [violations, setViolations] = useState<any[]>([])
  const [totalCount, setTotalCount] = useState(0)
  useEffect(() => {
    const store = SandboxManager.getSandboxViolationStore()
    const unsubscribe = store.subscribe((allViolations) => {
      setViolations(allViolations.slice(-10))
      setTotalCount(store.getTotalCount())
    })
    return unsubscribe
  }, [])
  if (!SandboxManager.isSandboxingEnabled() || getPlatform() === 'linux') {
    return null
  }
  if (totalCount === 0) {
    return null
  }
  const violationItems = violations.map((v, i) => (
    <Box key={`${v.timestamp.getTime()}-${i}`} paddingLeft={2}>
      <Text dimColor={true}>
        {formatTime(v.timestamp)}
        {v.command ? ` ${v.command}:` : ''} {v.line}
      </Text>
    </Box>
  ))
  const shownCount = Math.min(10, violations.length)
  return (
    <Box flexDirection="column" marginTop={1}>
      {
        <Box marginLeft={0}>
          <Text color="permission">
            ⧈{' '}
            {tSync('sandboxViolation.blockedOperations', {
              count: totalCount,
              operationLabel: tSync(
                totalCount === 1
                  ? 'sandboxViolation.operation_one'
                  : 'sandboxViolation.operation_other',
              ),
            })}
          </Text>
        </Box>
      }
      {violationItems}
      {
        <Box paddingLeft={2}>
          <Text dimColor={true}>
            {tSync('sandboxViolation.showingLast', { shown: shownCount, total: totalCount })}
          </Text>
        </Box>
      }
    </Box>
  )
}
