import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import type { ResumeReturnPrompt } from '../services/sessionStorage/resumeReturn.js'
import { formatTokens } from '../utils/format.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

export type ResumeReturnAction = 'compact' | 'continue' | 'dismiss' | 'never'

type Props = ResumeReturnPrompt & {
  onDone: (action: ResumeReturnAction) => void
}

export function ResumeReturnDialog({
  sessionAgeMinutes,
  estimatedTokens,
  contextUsagePercent,
  onDone,
}: Props) {
  const age = formatAge(sessionAgeMinutes)
  const tokens = formatTokens(estimatedTokens)
  return (
    <Dialog
      title={tSync('resumeReturn.title', {
        age,
        tokens,
        percent: Math.round(contextUsagePercent),
      })}
      onCancel={() => onDone('dismiss')}
    >
      <Box flexDirection="column">
        <Text>{tSync('resumeReturn.description')}</Text>
      </Box>
      <Select
        options={[
          { value: 'compact', label: tSync('resumeReturn.compact') },
          { value: 'continue', label: tSync('resumeReturn.continue') },
          { value: 'never', label: tSync('resumeReturn.neverAsk') },
        ]}
        onChange={(value: string) => onDone(value as ResumeReturnAction)}
      />
    </Dialog>
  )
}

function formatAge(minutes: number): string {
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const remainingMinutes = Math.floor(minutes % 60)
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`
}
