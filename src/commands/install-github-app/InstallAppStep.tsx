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
          <Text bold={true}>{tSync('installGh.installZyGhApp')}</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text>{tSync('installGh.openingBrowser')}</Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text>{tSync('installGh.ifBrowserNotOpen')}</Text>
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
            {tSync('installGh.installForRepo')} <Text bold={true}>{repoUrl}</Text>
          </Text>
        </Box>
      }
      {
        <Box marginBottom={1}>
          <Text dimColor={true}>{tSync('installGh.grantAccess')}</Text>
        </Box>
      }
      {
        <Box>
          <Text bold={true} color="permission">
            {tSync('installGh.pressEnterAfterInstall')}
            {ELLIPSIS}
          </Text>
        </Box>
      }
      {
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('installGh.havingTrouble')}{' '}
            <Text color="zy">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
          </Text>
        </Box>
      }
    </Box>
  )
}
