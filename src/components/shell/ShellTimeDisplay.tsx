import React from 'react'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'
import { tSync } from '../../i18n/index.js'
type Props = {
  elapsedTimeSeconds?: number
  timeoutMs?: number
}
export function ShellTimeDisplay({ elapsedTimeSeconds, timeoutMs }: Props) {
  if (elapsedTimeSeconds === undefined && !timeoutMs) {
    return null
  }
  const timeout = timeoutMs
    ? formatDuration(timeoutMs, {
        hideTrailingZeros: true,
      })
    : undefined
  if (elapsedTimeSeconds === undefined) {
    return <Text dimColor={true}>{`(${tSync('shellProgress.timeout')} ${timeout})`}</Text>
  }
  const elapsed = formatDuration(elapsedTimeSeconds * 1000)
  if (timeout) {
    return (
      <Text dimColor={true}>{`(${elapsed} · ${tSync('shellProgress.timeout')} ${timeout})`}</Text>
    )
  }
  return <Text dimColor={true}>{`(${elapsed})`}</Text>
}
