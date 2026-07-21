import { feature } from 'bun:bundle'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

/**
 * 当 `--proactive` flag 或 ZY_CODE_PROACTIVE env 被设置且对应 feature gate 开启时，
 * 激活 proactive 模式。使用动态 require 避免在未开启 feature 的构建里把整段
 * proactive 代码 link 进来。
 */
export function maybeActivateProactive(options: unknown): void {
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((
      options as {
        proactive?: boolean
      }
    ).proactive ||
      isEnvTruthy(process.env.ZY_CODE_PROACTIVE))
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('../../proactive/index.js')
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command')
    }
  }
}
