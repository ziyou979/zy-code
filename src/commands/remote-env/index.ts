import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () => false,
  get isHidden() {
    return true
  },
  load: () => import('./remote-env.js'),
} satisfies Command
