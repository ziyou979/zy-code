import { ELLIPSIS } from '../../constants/figures.js'
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { tSync } from '../../i18n/index.js'

interface InstallAppStepProps {
  repoUrl: string
  onSubmit: () => void
}
export function InstallAppStep({ repoUrl, onSubmit }: InstallAppStepProps) {
  useKeybinding('confirm:yes', onSubmit, {
    context: 'Confirmation',
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor={true} paddingX={1}>
      {
        <Box flexDirection="column" marginBottom={1}>
          <Text bold={true}>{tSync('installGitHubApp.installZyGhApp')}</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text>{tSync('installGitHubApp.openingBrowser')}</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text>{tSync('installGitHubApp.ifBrowserNotOpen')}</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text underline={true}>https://github.com/apps/zy</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text>
            {tSync('installGitHubApp.installForRepo')} <Text bold={true}>{repoUrl}</Text>
          </Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text dimColor={true}>{tSync('installGitHubApp.grantAccess')}</Text>
        </Box>
      }
      {
        <Box>
          <Text bold={true} color="permission">
            {tSync('installGitHubApp.pressEnterAfterInstall')}
            {ELLIPSIS}
          </Text>
        </Box>
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('installGitHubApp.havingTrouble')}{' '}
            <Text color="zy">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
          </Text>
        </Box>
      }
    </Box>
  )
}
