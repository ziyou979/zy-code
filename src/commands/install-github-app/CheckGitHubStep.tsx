import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
export function CheckGitHubStep() {
  return <Text>{tSync('installGitHubApp.checkingGithub')}</Text>
}
