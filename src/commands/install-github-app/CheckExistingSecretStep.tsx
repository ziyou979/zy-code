import { useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, color, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { tSync } from '../../i18n/index.js'

interface CheckExistingSecretStepProps {
  useExistingSecret: boolean
  secretName: string
  onToggleUseExistingSecret: (useExisting: boolean) => void
  onSecretNameChange: (value: string) => void
  onSubmit: () => void
}
export function CheckExistingSecretStep({
  useExistingSecret,
  secretName,
  onToggleUseExistingSecret,
  onSecretNameChange,
  onSubmit,
}: CheckExistingSecretStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminalSize = useTerminalSize()
  const [theme] = useTheme()
  const handlePrevious = () => onToggleUseExistingSecret(true)
  const handleNext = () => onToggleUseExistingSecret(false)
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
      'confirm:yes': onSubmit,
    },
    {
      context: 'Confirmation',
      isActive: useExistingSecret,
    },
  )
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
    },
    {
      context: 'Confirmation',
      isActive: !useExistingSecret,
    },
  )
  const existingPrefix = useExistingSecret ? color('success', theme)('> ') : '  '
  const newPrefix = !useExistingSecret ? color('success', theme)('> ') : '  '
  return (
    <>
      {
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {
            <Box flexDirection="column" marginBottom={1}>
              <Text bold={true}>{tSync('installGitHubApp.installTitle')}</Text>
              <Text dimColor={true}>{tSync('installGitHubApp.setupApiKeySecret')}</Text>
            </Box>
          }
          {
            <Box marginBottom={1}>
              <Text color="warning">{tSync('installGitHubApp.apiKeyAlreadyExists')}</Text>
            </Box>
          }
          {
            <Box marginBottom={1}>
              <Text>{tSync('installGitHubApp.wouldYouLike')}</Text>
            </Box>
          }
          {
            <Box marginBottom={1}>
              <Text>
                {existingPrefix}
                {tSync('installGitHubApp.useExistingApiKey')}
              </Text>
            </Box>
          }
          {
            <Box marginBottom={1}>
              <Text>
                {newPrefix}
                {tSync('installGitHubApp.createNewSecret')}
              </Text>
            </Box>
          }
          {!useExistingSecret && (
            <>
              <Box marginBottom={1}>
                <Text>{tSync('installGitHubApp.enterNewSecretName')}</Text>
              </Box>
              <TextInput
                value={secretName}
                onChange={onSecretNameChange}
                onSubmit={onSubmit}
                focus={true}
                placeholder={tSync('installGitHubApp.secretPlaceholder')}
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </>
          )}
        </Box>
      }
      {
        <Box marginLeft={3}>
          <Text dimColor={true}>{tSync('installGitHubApp.selectNavigate')}</Text>
        </Box>
      }
    </>
  )
}
