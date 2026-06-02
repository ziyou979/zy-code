import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context, _args, invokedAs) => {
  const defaultTab = invokedAs === 'stats' ? 'Stats' : context.invokedAs === 'stats' ? 'Stats' : 'Usage'
  return <Settings onClose={onDone} context={context} defaultTab={defaultTab} />
}
