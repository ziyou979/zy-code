import type { Command } from '../../commands/index.js'

const mem: Command = {
  type: 'local',
  name: 'mem',
  description: 'Show runtime memory usage analysis and diagnostic information',
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./mem.js'),
}

export default mem
