import { tSync } from '../../i18n/index.js'
import { backgroundAll, hasForegroundTasks } from '../../tasks/local-shell-task/LocalShellTask.js'
import type { LocalCommandCall } from '../types.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  if (isEnvTruthy(process.env.ZY_CODE_DISABLE_BACKGROUND_TASKS)) {
    logForDebugging(
      '/background command: background tasks disabled by ZY_CODE_DISABLE_BACKGROUND_TASKS',
    )
    return { type: 'text', value: tSync('bg.disabled') }
  }

  const state = context.getAppState()

  if (!hasForegroundTasks(state)) {
    logForDebugging('/background command: no foreground tasks to background')
    return { type: 'text', value: tSync('bg.noForegroundTasks') }
  }

  backgroundAll(context.getAppState, context.setAppState)
  logForDebugging('/background command: moved foreground tasks to background')
  return { type: 'text', value: tSync('bg.movedToBackground') }
}
