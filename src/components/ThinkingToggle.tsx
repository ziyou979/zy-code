import { useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
export type Props = {
  currentValue: boolean
  onSelect: (enabled: boolean) => void
  onCancel?: () => void
  isMidConversation?: boolean
}
export function ThinkingToggle({ currentValue, onSelect, onCancel, isMidConversation }: Props) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  const [confirmationPending, setConfirmationPending] = useState(null)
  const options = [
    {
      value: 'true',
      label: tSync('thinkingToggle.enabled'),
      description: tSync('thinkingToggle.enabledDesc'),
    },
    {
      value: 'false',
      label: tSync('thinkingToggle.disabled'),
      description: tSync('thinkingToggle.disabledDesc'),
    },
  ]
  useKeybinding(
    'confirm:no',
    () => {
      if (confirmationPending !== null) {
        setConfirmationPending(null)
      } else {
        onCancel?.()
      }
    },
    {
      context: 'Confirmation',
    },
  )
  useKeybinding(
    'confirm:yes',
    () => {
      if (confirmationPending !== null) {
        onSelect(confirmationPending)
      }
    },
    {
      context: 'Confirmation',
      isActive: confirmationPending !== null,
    },
  )
  const handleSelectChange = function handleSelectChange(value) {
    const selected = value === 'true'
    if (isMidConversation && selected !== currentValue) {
      setConfirmationPending(selected)
    } else {
      onSelect(selected)
    }
  }
  return (
    <Pane color="permission">
      {
        <Box flexDirection="column">
          {
            <Box marginBottom={1} flexDirection="column">
              <Text color="remember" bold={true}>
                {tSync('thinkingToggle.title')}
              </Text>
              <Text dimColor={true}>{tSync('thinkingToggle.hint')}</Text>
            </Box>
          }
          {confirmationPending !== null ? (
            <Box flexDirection="column" marginBottom={1} gap={1}>
              <Text color="warning">{tSync('thinkingToggle.midConversationWarning')}</Text>
              <Text color="warning">{tSync('thinkingToggle.confirmProceed')}</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginBottom={1}>
              <Select
                defaultValue={currentValue ? 'true' : 'false'}
                defaultFocusValue={currentValue ? 'true' : 'false'}
                options={options}
                onChange={handleSelectChange}
                onCancel={onCancel ?? _temp}
                visibleOptionCount={2}
              />
            </Box>
          )}
        </Box>
      }
      {
        <Text dimColor={true} italic={true}>
          {exitState.pending ? (
            tSync('thinkingToggle.pressAgainToExit', { key: exitState.keyName })
          ) : confirmationPending !== null ? (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="exit"
              />
            </Byline>
          )}
        </Text>
      }
    </Pane>
  )
}
function _temp() {}
