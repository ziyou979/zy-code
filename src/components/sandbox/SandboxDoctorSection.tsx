import { Box, Text } from '../../ink.js'
import { SandboxManager } from '../../services/sandbox/sandbox-adapter.js'
export function SandboxDoctorSection() {
  if (!SandboxManager.isSupportedPlatform()) {
    return null
  }
  if (!SandboxManager.isSandboxEnabledInSettings()) {
    return null
  }
  let boxElement
  let earlyReturn
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const depCheck = SandboxManager.checkDependencies()
  const hasErrors = depCheck.errors.length > 0
  const hasWarnings = depCheck.warnings.length > 0
  if (!hasErrors && !hasWarnings) {
    earlyReturn = null
  } else {
    const statusColor = hasErrors ? ('error' as const) : ('warning' as const)
    const statusText = hasErrors ? 'Missing dependencies' : 'Available (with warnings)'
    boxElement = (
      <Box flexDirection="column">
        <Text bold={true}>Sandbox</Text>
        <Text>
          └ Status: <Text color={statusColor}>{statusText}</Text>
        </Text>
        {depCheck.errors.map((e, i) => (
          <Text key={i} color="error">
            └ {e}
          </Text>
        ))}
        {depCheck.warnings.map((w, i_0) => (
          <Text key={i_0} color="warning">
            └ {w}
          </Text>
        ))}
        {hasErrors && <Text dimColor={true}>└ Run /sandbox for install instructions</Text>}
      </Box>
    )
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn
  }
  return boxElement
}
