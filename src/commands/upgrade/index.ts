import type { Command } from '../../commands/index.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

const upgrade = {
  type: 'local-jsx',
  name: 'upgrade',
  description: 'Upgrade to Max for higher rate limits and more Opus',
  availability: ['zy-ai'],
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_UPGRADE_COMMAND),
  load: () => import('./upgrade.js'),
} satisfies Command

export default upgrade
