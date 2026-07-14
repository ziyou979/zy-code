import { tSync } from 'src/i18n/index.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { SettingsJson } from '../../services/settings/types.js'
import { Select } from '../CustomSelect/index.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { extractDangerousSettings, formatDangerousSettingsList } from './utils.js'

type Props = {
  settings: SettingsJson
  onAccept: () => void
  onReject: () => void
}
export function ManagedSettingsSecurityDialog({ settings, onAccept, onReject }: Props) {
  const dangerous = extractDangerousSettings(settings)
  const settingsList = formatDangerousSettingsList(dangerous)
  const exitState = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onReject, {
    context: 'Confirmation',
  })
  const onChange = function onChange(value: string) {
    if (value === 'exit') {
      onReject()
      return
    }
    onAccept()
  }
  const settingsListItems = settingsList.map((item, index) => (
    <Box key={index} paddingLeft={2}>
      <Text>
        <Text dimColor={true}>· </Text>
        <Text>{item}</Text>
      </Text>
    </Box>
  ))
  return (
    <PermissionDialog
      color={'warning'}
      titleColor={'warning'}
      title={tSync('managedSettings.requireApproval')}
    >
      {
        <Box flexDirection={'column'} gap={1} paddingTop={1}>
          {<Text>{tSync('managedSettings.orgConfiguredWarning')}</Text>}
          {
            <Box flexDirection={'column'}>
              {<Text dimColor={true}>{tSync('managedSettings.requiringApproval')}</Text>}
              {settingsListItems}
            </Box>
          }
          {<Text>{tSync('managedSettings.onlyAcceptIfTrust')}</Text>}
          {
            <Select
              options={[
                {
                  label: tSync('managedSettings.yesTrust'),
                  value: 'accept',
                },
                {
                  label: tSync('managedSettings.noExit'),
                  value: 'exit',
                },
              ]}
              onChange={(selectedValue: string) => onChange(selectedValue as 'accept' | 'exit')}
              onCancel={() => onChange('exit')}
            />
          }
          {
            <Text dimColor={true}>
              {exitState.pending
                ? tSync('managedSettings.pressAgainToExit', { keyName: exitState.keyName ?? '' })
                : tSync('managedSettings.enterConfirmEscExit')}
            </Text>
          }
        </Box>
      }
    </PermissionDialog>
  )
}
