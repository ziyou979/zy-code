import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Link, Text } from '../ink/index.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

export const getAutoModeDescription = () => tSync('autoMode.description')
type Props = {
  onAccept(): void
  onDecline(): void
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean
}
export function AutoModeOptInDialog({ onAccept, onDecline, declineExits }: Props) {
  React.useEffect(() => {
    logEvent('zy_auto_mode_opt_in_dialog_shown', {})
  }, [])
  const onChange = function onChange(value: string) {
    switch (value) {
      case 'accept': {
        logEvent('zy_auto_mode_opt_in_dialog_accept', {})
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
        })
        onAccept()
        break
      }
      case 'accept-default': {
        logEvent('zy_auto_mode_opt_in_dialog_accept_default', {})
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
          permissions: {
            defaultMode: 'auto',
          },
        })
        onAccept()
        break
      }
      case 'decline': {
        logEvent('zy_auto_mode_opt_in_dialog_decline', {})
        onDecline()
      }
    }
  }
  return (
    <Dialog title={tSync('autoMode.title')} color="warning" onCancel={onDecline}>
      {
        <Box flexDirection="column" gap={1}>
          <Text>{getAutoModeDescription()}</Text>
          <Link url="https://code.zy.com/docs/en/security" />
        </Box>
      }
      {
        <Select
          options={[
            {
              label: tSync('autoMode.acceptDefault'),
              value: 'accept-default' as const,
            },
            {
              label: tSync('autoMode.accept'),
              value: 'accept' as const,
            },
            {
              label: declineExits ? tSync('autoMode.declineExit') : tSync('autoMode.declineBack'),
              value: 'decline' as const,
            },
          ]}
          onChange={(value_0: string) =>
            onChange(value_0 as 'accept' | 'accept-default' | 'decline')
          }
          onCancel={onDecline}
        />
      }
    </Dialog>
  )
}
