import type { Command } from '../../commands/index.js'
import { isPolicyAllowed } from '../../services/policy-limits/index.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { isEssentialTrafficOnly } from '../../services/telemetry/privacyLevel.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about ZY Code`,
  argumentHint: '[report]',
  isEnabled: () =>
    !(
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||
      isEssentialTrafficOnly() ||
      isInternalBuild() ||
      !isPolicyAllowed('allow_product_feedback')
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
