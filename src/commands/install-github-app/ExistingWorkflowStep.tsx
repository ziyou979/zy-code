import { Select } from 'src/components/CustomSelect/index.js'
import { Box, Text } from '../../ink/index.js'
import { tSync } from '../../i18n/index.js'

interface ExistingWorkflowStepProps {
  repoName: string
  onSelectAction: (action: 'update' | 'skip' | 'exit') => void
}
export function ExistingWorkflowStep({ repoName, onSelectAction }: ExistingWorkflowStepProps) {
  const options = [
    {
      label: tSync('installGitHubApp.optionUpdateWorkflow'),
      value: 'update',
    },
    {
      label: tSync('installGitHubApp.optionSkipWorkflow'),
      value: 'skip',
    },
    {
      label: tSync('installGitHubApp.optionExit'),
      value: 'exit',
    },
  ]
  const handleSelect = (value: string) => {
    onSelectAction(value as 'update' | 'skip' | 'exit')
  }
  const handleCancel = () => {
    onSelectAction('exit')
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor={true} paddingX={1}>
      {
        <Box flexDirection="column" marginBottom={1}>
          {<Text bold={true}>{tSync('installGitHubApp.existingWorkflowFound')}</Text>}
          <Text dimColor={true}>
            {tSync('installGitHubApp.repository')}: {repoName}
          </Text>
        </Box>
      }
      {
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {tSync('installGitHubApp.workflowFileExists')}{' '}
            <Text color="zy">.github/workflows/zy.yml</Text>
          </Text>
          <Text dimColor={true}>{tSync('installGitHubApp.whatWouldYouLike')}</Text>
        </Box>
      }
      {
        <Box flexDirection="column">
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        </Box>
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('installGitHubApp.viewLatestTemplate')}{' '}
            <Text color="zy">
              https://github.com/anthropics/zy-code-action/blob/main/examples/zy.yml
            </Text>
          </Text>
        </Box>
      }
    </Box>
  )
}
