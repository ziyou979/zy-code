import { useEffect, useRef } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import {
  type EffortLevel,
  getDefaultEffortForModel,
  getEffortCalloutConfig,
  getModelEffortLevels,
  isEffortLevel,
  toPersistableEffort,
} from '../utils/effort.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
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
  const defaultLevel = defaultEffort && isEffortLevel(defaultEffort) ? defaultEffort : 'thorough'
  const handleSelect = (value: string) => {
    const level = value as EffortLevel
    // 始终写入用户选择，避免因等于默认值而被清除导致下次启动再次弹出
    updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(level),
    })
    onDoneRef.current(level)
  }

  // 根据模型配置的 effort levels 动态生成选项，避免向用户展示模型不支持的档位。
  const modelEffortLevels = getModelEffortLevels(model)
  const visibleEffortLevels = modelEffortLevels.filter((level) => level !== 'orchestrate')
  const hasStrengthLevels = visibleEffortLevels.some((level) => level !== 'off' && level !== 'on')
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

  const options = visibleEffortLevels.map((level) => ({
    label: <EffortOptionLabel level={level} text={effortLabels[level] ?? level} />,
    value: level,
  }))
  const title = hasStrengthLevels
    ? tSync(defaultEffortConfig.dialogTitle)
    : tSync('effort.toggleDialogTitle')
  const description = hasStrengthLevels
    ? tSync(defaultEffortConfig.dialogDescription)
    : tSync('effort.toggleDialogDescription')
  return (
    <PermissionDialog title={title}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {
          <Box marginBottom={1} flexDirection="column">
            <Text>{description}</Text>
          </Box>
        }
        {
          <Box marginBottom={1}>
            <Text dimColor={true}>
              {visibleEffortLevels.map((level, index) => (
                <EffortSummaryItem
                  key={level}
                  level={level}
                  text={effortLabels[level] ?? level}
                  showSeparator={index > 0}
                />
              ))}
            </Text>
          </Box>
        }
        <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  )
}
function EffortSummaryItem({
  level,
  text,
  showSeparator,
}: {
  level: EffortLevel
  text: string
  showSeparator: boolean
}) {
  return (
    <>
      {showSeparator ? ' \xB7 ' : ''}
      {<EffortIndicatorSymbol level={level} />} {text}
    </>
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
