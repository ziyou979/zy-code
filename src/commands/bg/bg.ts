import type { LocalCommandCall } from '../../types/command.js'
import { backgroundAll, hasForegroundTasks } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { tSync } from '../../i18n/index.js'
import { logForDebugging } from '../../utils/debug.js'

export const call: LocalCommandCall = async (_args, context) => {
  const state = context.getAppState()

  if (!hasForegroundTasks(state)) {
    logForDebugging('/bg command: no foreground tasks to background')
    return { type: 'text', value: tSync('bg.noForegroundTasks') }
  }

  backgroundAll(context.getAppState, context.setAppState)
  logForDebugging('/bg command: moved foreground tasks to background')
  return { type: 'text', value: tSync('bg.movedToBackground') }
}
