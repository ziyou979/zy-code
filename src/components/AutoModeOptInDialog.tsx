import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from 'src/i18n/index.js'
import { Box, Link, Text } from '../ink.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
export const AUTO_MODE_DESCRIPTION =
  "Auto mode lets Zy handle permission prompts automatically — Zy checks each tool call for risky actions and prompt injection before executing. Actions Zy identifies as safe are executed, while actions Zy identifies as risky are blocked and Zy may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. Zy can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode."
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
  const onChange = function onChange(value) {
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
          <Text>{AUTO_MODE_DESCRIPTION}</Text>
          <Link url="https://code.zy.com/docs/en/security" />
        </Box>
      }
      {
        <Select
          options={[
            ...(true
              ? [
                  {
                    label: 'Yes, and make it my default mode',
                    value: 'accept-default' as const,
                  },
                ]
              : []),
            {
              label: 'Yes, enable auto mode',
              value: 'accept' as const,
            },
            {
              label: declineExits ? 'No, exit' : 'No, go back',
              value: 'decline' as const,
            },
          ]}
          onChange={(value_0) => onChange(value_0 as 'accept' | 'accept-default' | 'decline')}
          onCancel={onDecline}
        />
      }
    </Dialog>
  )
}
