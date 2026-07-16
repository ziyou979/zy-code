import { Box, Text } from '../../ink.js'
import { tSync } from '../../i18n/index.js'

type SuccessStepProps = {
  secretExists: boolean
  useExistingSecret: boolean
  secretName: string
  skipWorkflow?: boolean
}
export function SuccessStep({
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
}: SuccessStepProps) {
  return (
    <>
      {
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {
            <Box flexDirection="column" marginBottom={1}>
              <Text bold={true}>{tSync('installGitHubApp.installTitle')}</Text>
              <Text dimColor={true}>{tSync('installGitHubApp.success')}</Text>
            </Box>
          }
          {!skipWorkflow && (
            <Text color="success">{tSync('installGitHubApp.workflowCreated')}</Text>
          )}
          {secretExists && useExistingSecret && (
            <Box marginTop={1}>
              <Text color="success">{tSync('installGitHubApp.usingExistingSecret')}</Text>
            </Box>
          )}
          {(!secretExists || !useExistingSecret) && (
            <Box marginTop={1}>
              <Text color="success">{tSync('installGitHubApp.apiKeySavedAs', { secretName })}</Text>
            </Box>
          )}
          {
            <Box marginTop={1}>
              <Text>{tSync('installGitHubApp.nextSteps')}</Text>
            </Box>
          }
          {skipWorkflow ? (
            <>
              <Text>{tSync('installGitHubApp.stepInstallApp')}</Text>
              <Text>{tSync('installGitHubApp.stepWorkflowUnchanged')}</Text>
              <Text>{tSync('installGitHubApp.stepApiKeyReady')}</Text>
            </>
          ) : (
            <>
              <Text>{tSync('installGitHubApp.stepPrCreated')}</Text>
              <Text>{tSync('installGitHubApp.stepInstallApp2')}</Text>
              <Text>{tSync('installGitHubApp.stepMergePr')}</Text>
            </>
          )}
        </Box>
      }
      {
        <Box marginLeft={3}>
          <Text dimColor={true}>{tSync('installGitHubApp.pressAnyKeyExit')}</Text>
        </Box>
      }
    </>
  )
}
