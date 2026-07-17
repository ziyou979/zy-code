import type { Command } from '../../commands/index.js'
import { isBgSession } from '../../services/session/concurrentSessions.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const installGitHubApp = {
  type: 'local-jsx',
  name: 'install-github-app',
  description: 'Set up Zy GitHub Actions for a repository',
  availability: ['zy-ai', 'console'],
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND) && !isBgSession(),
  load: () => import('./install-github-app.js'),
} satisfies Command

export default installGitHubApp
