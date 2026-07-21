import type { Command } from '../../commands/index.js'
import { hasApiKeyAuth } from '../../services/auth/auth.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: hasApiKeyAuth() ? 'Switch accounts' : 'Sign in with your account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
