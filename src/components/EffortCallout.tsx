import { useEffect, useRef } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import {
  convertEffortValueToLevel,
  EffortLevel,
  getDefaultEffortForModel,
  getEffortCalloutConfig,
  getModelEffortLevels,
  toPersistableEffort,
} from '../utils/effort.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/select.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

type EffortCalloutSelection = EffortLevel | undefined | 'dismiss'
type Props = {
  model: string
  onDone: (selection: EffortCalloutSelection) => void
}
const AUTO_DISMISS_MS = 30_000
export function EffortCallout({ model, onDone }: Props) {
  const defaultEffortConfig = getEffortCalloutConfig()
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })
  const handleCancel = () => {
    onDoneRef.current('dismiss')
  }
  useEffect(() => {
    const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS)
    return () => clearTimeout(timeoutId)
  }, [handleCancel])
  const defaultEffort = getDefaultEffortForModel(model)
  const defaultLevel = defaultEffort ? convertEffortValueToLevel(defaultEffort) : 'thorough'
  const handleSelect = (value: string) => {
    const level = value as EffortLevel
    const effortLevel = level === defaultLevel ? undefined : level
    updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(effortLevel),
    })
    onDoneRef.current(level)
  }

  // 根据模型配置的 effort levels 动态生成选项
  const modelEffortLevels = getModelEffortLevels(model)
  const effortLabels: Record<string, string> = {
    off: tSync('effort.off') || 'Off — thinking disabled',
    on: tSync('effort.on') || 'On — thinking enabled',
    quick: tSync('effort.quick') || 'Quick',
    light: tSync('effort.light') || 'Light',
    balanced: tSync('effort.balanced') || 'Balanced',
    thorough: tSync('effort.thorough') || 'Thorough',
    extreme: tSync('effort.extreme') || 'Extreme',
    ultra: tSync('effort.ultra') || 'Ultra — max thinking + preserve',
  }

  const options = modelEffortLevels
    .filter((level) => level !== 'orchestrate')
    .map((level) => ({
      label: (
        <EffortOptionLabel
          level={level}
          text={effortLabels[level] ?? level}
        />
      ),
      value: level,
    }))
  return (
    <PermissionDialog title={tSync(defaultEffortConfig.dialogTitle)}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {
          <Box marginBottom={1} flexDirection="column">
            <Text>{tSync(defaultEffortConfig.dialogDescription)}</Text>
          </Box>
        }
        {
          <Box marginBottom={1}>
            <Text dimColor={true}>
              {<EffortIndicatorSymbol level="light" />} {tSync('effort.light')} {'\xB7'}{' '}
              {<EffortIndicatorSymbol level="balanced" />} {tSync('effort.balanced')}
              {' \xB7'} {<EffortIndicatorSymbol level="thorough" />} {tSync('effort.thorough')}
            </Text>
          </Box>
        }
        <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  )
}
function EffortIndicatorSymbol({ level }: { level: EffortLevel }) {
  const effortSymbol = effortLevelToSymbol(level)
  return <Text color="suggestion">{effortSymbol}</Text>
}
function EffortOptionLabel({ level, text }: { level: EffortLevel; text: string }) {
  return (
    <>
      {<EffortIndicatorSymbol level={level} />} {text}
    </>
  )
}
