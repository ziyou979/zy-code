import type { Command } from '../../commands/index.js'
import { tSync } from '../../i18n/index.js'

const mem: Command = {
  type: 'local',
  name: 'mem',
  get description() {
    return tSync('commands.mem.description')
  },
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./mem.js'),
}

export default mem
