import { WARNING } from '../../constants/figures.js'
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Warning } from './types.js'
import { tSync } from '../../i18n/index.js'

interface WarningsStepProps {
  warnings: Warning[]
  onContinue: () => void
}
export function WarningsStep({ warnings, onContinue }: WarningsStepProps) {
  useKeybinding('confirm:yes', onContinue, {
    context: 'Confirmation',
  })
  const warningElements = warnings.map((warning, index) => (
    <Box key={index} flexDirection="column" marginBottom={1}>
      <Text color="warning" bold={true}>
        {warning.title}
      </Text>
      <Text>{warning.message}</Text>
      {warning.instructions.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {warning.instructions.map((instruction, i) => (
            <Text key={i} dimColor={true}>
              • {instruction}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  ))
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {
        <Box flexDirection="column" marginBottom={1}>
          <Text bold={true}>{tSync('installGh.setupWarnings', { warning: WARNING })}</Text>
          <Text dimColor={true}>{tSync('installGh.potentialIssues')}</Text>
        </Box>
      }
      {warningElements}
      {
        <Box marginTop={1}>
          <Text bold={true} color="permission">
            {tSync('installGh.pressEnterToContinue')}
          </Text>
        </Box>
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('installGh.manualSetupSteps')}{' '}
            <Text color="zy">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
          </Text>
        </Box>
      }
    </Box>
  )
}
