import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js'
import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'

interface ErrorStepProps {
  error: string | undefined
  errorReason?: string
  errorInstructions?: string[]
}
export function ErrorStep({ error, errorReason, errorInstructions }: ErrorStepProps) {
  return (
    <>
      {
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {
            <Box flexDirection="column" marginBottom={1}>
              <Text bold={true}>{tSync('installGh.installTitle')}</Text>
            </Box>
          }
          {
            <Text color="error">
              {tSync('installGh.error')} {error}
            </Text>
          }
          {errorReason && (
            <Box marginTop={1}>
              <Text dimColor={true}>
                {tSync('installGh.reason')} {errorReason}
              </Text>
            </Box>
          )}
          {errorInstructions && errorInstructions.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={true}>{tSync('installGh.howToFix')}</Text>
              {errorInstructions.map((instruction, index) => (
                <Box key={index} marginLeft={2}>
                  <Text dimColor={true}>• </Text>
                  <Text>{instruction}</Text>
                </Box>
              ))}
            </Box>
          )}
          {
            <Box marginTop={1}>
              <Text dimColor={true}>
                {tSync('installGh.manualSetup')}{' '}
                <Text color="zy">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
              </Text>
            </Box>
          }
        </Box>
      }
      {
        <Box marginLeft={3}>
          <Text dimColor={true}>{tSync('installGh.pressAnyKeyExit')}</Text>
        </Box>
      }
    </>
  )
}
