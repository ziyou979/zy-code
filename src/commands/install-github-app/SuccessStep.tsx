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
              <Text bold={true}>{tSync('installGh.installTitle')}</Text>
              <Text dimColor={true}>{tSync('installGh.success')}</Text>
            </Box>
          }
          {!skipWorkflow && <Text color="success">{tSync('installGh.workflowCreated')}</Text>}
          {secretExists && useExistingSecret && (
            <Box marginTop={1}>
              <Text color="success">{tSync('installGh.usingExistingSecret')}</Text>
            </Box>
          )}
          {(!secretExists || !useExistingSecret) && (
            <Box marginTop={1}>
              <Text color="success">{tSync('installGh.apiKeySavedAs', { secretName })}</Text>
            </Box>
          )}
          {
            <Box marginTop={1}>
              <Text>{tSync('installGh.nextSteps')}</Text>
            </Box>
          }
          {skipWorkflow ? (
            <>
              <Text>{tSync('installGh.stepInstallApp')}</Text>
              <Text>{tSync('installGh.stepWorkflowUnchanged')}</Text>
              <Text>{tSync('installGh.stepApiKeyReady')}</Text>
            </>
          ) : (
            <>
              <Text>{tSync('installGh.stepPrCreated')}</Text>
              <Text>{tSync('installGh.stepInstallApp2')}</Text>
              <Text>{tSync('installGh.stepMergePr')}</Text>
            </>
          )}
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
