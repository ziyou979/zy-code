import React, { useEffect, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { isMaxSubscriber, isProSubscriber, isTeamSubscriber } from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import type { EffortLevel } from '../utils/effort.js'
import {
  convertEffortValueToLevel,
  getDefaultEffortForModel,
  getOpusDefaultEffortConfig,
  toPersistableEffort,
} from '../utils/effort.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
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
  const defaultEffortConfig = getOpusDefaultEffortConfig()
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })
  const handleCancel = () => {
    onDoneRef.current('dismiss')
  }
  useEffect(() => {
    markV2Dismissed()
  }, [])
  useEffect(() => {
    const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS)
    return () => clearTimeout(timeoutId)
  }, [handleCancel])
  const defaultEffort = getDefaultEffortForModel(model)
  const defaultLevel = defaultEffort ? convertEffortValueToLevel(defaultEffort) : 'high'
  const handleSelect = (value) => {
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
    <PermissionDialog title={defaultEffortConfig.dialogTitle}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {
          <Box marginBottom={1} flexDirection="column">
            <Text>{defaultEffortConfig.dialogDescription}</Text>
          </Box>
        }
        {
          <Box marginBottom={1}>
            <Text dimColor={true}>
              {<EffortIndicatorSymbol level="low" />} low {'\xB7'}{' '}
              {<EffortIndicatorSymbol level="medium" />} medium {'\xB7'}{' '}
              <EffortIndicatorSymbol level="high" /> high
            </Text>
          </Box>
        }
        <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  )
}
function EffortIndicatorSymbol({ level }: { level: EffortLevel }) {
  const t1 = effortLevelToSymbol(level)
  return <Text color="suggestion">{t1}</Text>
}
function EffortOptionLabel({ level, text }: { level: EffortLevel; text: string }) {
  return (
    <>
      {<EffortIndicatorSymbol level={level} />} {text}
    </>
  )
}

/**
 * Check whether to show the effort callout.
 *
 * Audience:
 * - Pro: already had medium default; show unless they saw v1 (effortCalloutDismissed)
 * - Max/Team: getting medium via zy_grey_step2 config; show when enabled
 * - Everyone else: mark as dismissed so it never shows
 */
export function shouldShowEffortCallout(model: string): boolean {
  // Only show for Opus 4.6 for now
  const parsed = parseUserSpecifiedModel(model)
  if (!parsed.toLowerCase().includes('opus-4-6')) {
    return false
  }
  const config = getGlobalConfig()
  if (config.effortCalloutV2Dismissed) return false

  // Don't show to brand-new users — they never knew the old default, so this
  // isn't a change for them. Mark as dismissed so it stays suppressed.
  if (config.numStartups <= 1) {
    markV2Dismissed()
    return false
  }

  // Pro users already had medium default before this PR. Show the new copy,
  // but skip if they already saw the v1 dialog — no point nagging twice.
  if (isProSubscriber()) {
    if (config.effortCalloutDismissed) {
      markV2Dismissed()
      return false
    }
    return getOpusDefaultEffortConfig().enabled
  }

  // Max/Team are the target of the zy_grey_step2 config.
  // Don't mark dismissed when config is disabled — they should see the dialog
  // once it's enabled for them.
  if (isMaxSubscriber() || isTeamSubscriber()) {
    return getOpusDefaultEffortConfig().enabled
  }

  // Everyone else (free tier, API key, non-subscribers): not in scope.
  markV2Dismissed()
  return false
}
function markV2Dismissed(): void {
  saveGlobalConfig((current) => {
    if (current.effortCalloutV2Dismissed) return current
    return {
      ...current,
      effortCalloutV2Dismissed: true,
    }
  })
}
