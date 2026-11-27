import type { Command } from '../../commands/index.js'
import { tSync } from '../../i18n/index.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  get description() {
    return tSync('commands.feedback')
  },
  argumentHint: '[report]',
  isEnabled: () =>
    !(
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND)
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
