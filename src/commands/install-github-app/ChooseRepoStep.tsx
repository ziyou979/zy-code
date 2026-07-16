import { useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink/index.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { tSync } from '../../i18n/index.js'

interface ChooseRepoStepProps {
  currentRepo: string | null
  useCurrentRepo: boolean
  repoUrl: string
  onRepoUrlChange: (value: string) => void
  onToggleUseCurrentRepo: (useCurrentRepo: boolean) => void
  onSubmit: () => void
}
export function ChooseRepoStep({
  currentRepo,
  useCurrentRepo,
  repoUrl,
  onRepoUrlChange,
  onSubmit,
  onToggleUseCurrentRepo,
}: ChooseRepoStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const [showEmptyError, setShowEmptyError] = useState(false)
  const terminalSize = useTerminalSize()
  const textInputColumns = terminalSize.columns
  const handleSubmit = () => {
    const repoName = useCurrentRepo ? currentRepo : repoUrl
    if (!repoName?.trim()) {
      setShowEmptyError(true)
      return
    }
    onSubmit()
  }
  const isTextInputVisible = !useCurrentRepo || !currentRepo
  const handlePrevious = () => {
    onToggleUseCurrentRepo(true)
    setShowEmptyError(false)
  }
  const handleNext = () => {
    onToggleUseCurrentRepo(false)
    setShowEmptyError(false)
  }
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
      'confirm:yes': handleSubmit,
    },
    {
      context: 'Confirmation',
      isActive: !isTextInputVisible,
    },
  )
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
    },
    {
      context: 'Confirmation',
      isActive: isTextInputVisible,
    },
  )
  return (
    <>
      {
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {
            <Box flexDirection="column" marginBottom={1}>
              <Text bold={true}>{tSync('installGitHubApp.installTitle')}</Text>
              <Text dimColor={true}>{tSync('installGitHubApp.selectRepo')}</Text>
            </Box>
          }
          {currentRepo && (
            <Box marginBottom={1}>
              <Text bold={useCurrentRepo} color={useCurrentRepo ? 'permission' : undefined}>
                {useCurrentRepo ? '> ' : '  '}
                {tSync('installGitHubApp.useCurrentRepo')}: {currentRepo}
              </Text>
            </Box>
          )}
          {
            <Box marginBottom={1}>
              <Text
                bold={!useCurrentRepo || !currentRepo}
                color={!useCurrentRepo || !currentRepo ? 'permission' : undefined}
              >
                {!useCurrentRepo || !currentRepo ? '> ' : '  '}
                {currentRepo
                  ? tSync('installGitHubApp.enterDifferentRepo')
                  : tSync('installGitHubApp.enterRepo')}
              </Text>
            </Box>
          }
          {(!useCurrentRepo || !currentRepo) && (
            <Box marginLeft={2} marginBottom={1}>
              <TextInput
                value={repoUrl}
                onChange={(value) => {
                  onRepoUrlChange(value)
                  setShowEmptyError(false)
                }}
                onSubmit={handleSubmit}
                focus={true}
                placeholder={tSync('installGitHubApp.repoPlaceholder')}
                columns={textInputColumns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          )}
        </Box>
      }
      {showEmptyError && (
        <Box marginLeft={3} marginBottom={1}>
          <Text color="error">{tSync('installGitHubApp.errorEmptyRepo')}</Text>
        </Box>
      )}
      {
        <Box marginLeft={3}>
          <Text dimColor={true}>
            {currentRepo ? tSync('installGitHubApp.selectNavigate') : ''}
            {tSync('installGitHubApp.enterToContinue')}
          </Text>
        </Box>
      }
    </>
  )
}
