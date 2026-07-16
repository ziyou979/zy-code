import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import { getLocalizedDurationFormatter } from '../../utils/format.js'

const formatDuration = getLocalizedDurationFormatter()

type Props = {
  elapsedTimeSeconds?: number
  timeoutMs?: number
}
export function ShellTimeDisplay({ elapsedTimeSeconds, timeoutMs }: Props) {
  if (elapsedTimeSeconds === undefined && !timeoutMs) {
    return null
  }
  const timeoutDuration = timeoutMs
    ? formatDuration(timeoutMs, {
        hideTrailingZeros: true,
      })
    : undefined
  if (elapsedTimeSeconds === undefined) {
    return (
      <Text dimColor={true}>
        {`(${tSync('shellProgress.timeout', { duration: timeoutDuration! })})`}
      </Text>
    )
  }
  const elapsed = formatDuration(elapsedTimeSeconds * 1000)
  if (timeoutDuration) {
    return (
      <Text dimColor={true}>
        {`(${elapsed} · ${tSync('shellProgress.timeout', { duration: timeoutDuration })})`}
      </Text>
    )
  }
  return <Text dimColor={true}>{`(${elapsed})`}</Text>
}
