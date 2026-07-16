import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
export function CheckGitHubStep() {
  return <Text>{tSync('installGitHubApp.checkingGithub')}</Text>
}
