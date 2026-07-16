import type { Command } from '../../commands/index.js'

const installSlackApp = {
  type: 'local',
  name: 'install-slack-app',
  description: 'Install the Zy Slack app',
  availability: ['zy-ai'],
  supportsNonInteractive: false,
  load: () => import('./install-slack-app.js'),
} satisfies Command

export default installSlackApp
