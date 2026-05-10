import React, { useEffect, useRef } from 'react'
import { Box, Text } from '../ink.js'
import {EffortLevel, EffortValue} from '../utils/effort.js'
import {
  convertEffortValueToLevel,
  getDefaultEffortForModel,
  getEffortCalloutConfig,
  toPersistableEffort,
} from '../utils/effort.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/select.js'
import { effortLevelToSymbol } from './EffortIndicator.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'
import { tSync } from '../i18n/index.js'
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
  const defaultLevel = defaultEffort ? convertEffortValueToLevel(defaultEffort) : 'high'
  const handleSelect = (value: EffortLevel) => {
    const effortLevel = value === defaultLevel ? undefined : value
    updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(effortLevel),
    })
    onDoneRef.current(value)
  }
  const options = [
    {
      label: <EffortOptionLabel level="medium" text={tSync('effort.mediumRecommended')} />,
      value: 'medium',
    },
    {
      label: <EffortOptionLabel level="high" text={tSync('effort.high')} />,
      value: 'high',
    },
    {
      label: <EffortOptionLabel level="low" text={tSync('effort.low')} />,
      value: 'low',
    },
  ]
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
              {<EffortIndicatorSymbol level="low" />} {tSync('effort.low')} {'\xB7'}{' '}
              {<EffortIndicatorSymbol level="medium" />} {tSync('effort.medium')}
              {' \xB7'} {<EffortIndicatorSymbol level="high" />} {tSync('effort.high')}
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
