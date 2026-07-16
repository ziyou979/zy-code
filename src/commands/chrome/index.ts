import { getIsNonInteractiveSession } from 'src/bootstrap/runtime/runtimeContext.js'
import type { Command } from '../../commands/index.js'

const command: Command = {
  name: 'chrome',
  description: 'Claude in Chrome (Beta) settings',
  availability: ['zy-ai'],
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
