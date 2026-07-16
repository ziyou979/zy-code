import { Box, Text } from '../../ink/index.js'
import type { Workflow } from './types.js'
import { tSync } from '../../i18n/index.js'

interface CreatingStepProps {
  currentWorkflowInstallStep: number
  secretExists: boolean
  useExistingSecret: boolean
  secretName: string
  skipWorkflow?: boolean
  selectedWorkflows: Workflow[]
}
export function CreatingStep({
  currentWorkflowInstallStep,
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
  selectedWorkflows,
}: CreatingStepProps) {
  const progressSteps = skipWorkflow
    ? [
        tSync('installGitHubApp.stepGettingRepoInfo'),
        secretExists && useExistingSecret
          ? tSync('installGitHubApp.stepUsingExistingSecret')
          : tSync('installGitHubApp.stepSettingUpSecret', { secretName }),
      ]
    : [
        tSync('installGitHubApp.stepGettingRepoInfo'),
        tSync('installGitHubApp.stepCreatingBranch'),
        selectedWorkflows.length > 1
          ? tSync('installGitHubApp.stepCreatingWorkflowFiles')
          : tSync('installGitHubApp.stepCreatingWorkflowFile'),
        secretExists && useExistingSecret
          ? tSync('installGitHubApp.stepUsingExistingSecret')
          : tSync('installGitHubApp.stepSettingUpSecret', { secretName }),
        tSync('installGitHubApp.stepOpeningPrPage'),
      ]
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {
        <Box flexDirection="column" marginBottom={1}>
          <Text bold={true}>{tSync('installGitHubApp.installTitle')}</Text>
          <Text dimColor={true}>{tSync('installGitHubApp.creatingWorkflow')}</Text>
        </Box>
      }
      {progressSteps.map((stepText, index) => {
        let status = 'pending'
        if (index < currentWorkflowInstallStep) {
          status = 'completed'
        } else {
          if (index === currentWorkflowInstallStep) {
            status = 'in-progress'
          }
        }
        return (
          <Box key={index}>
            <Text
              color={
                status === 'completed'
                  ? 'success'
                  : status === 'in-progress'
                    ? 'warning'
                    : undefined
              }
            >
              {status === 'completed' ? '\u2713 ' : ''}
              {stepText}
              {status === 'in-progress' ? '\u2026' : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
