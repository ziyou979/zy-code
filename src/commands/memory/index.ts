import type { Command } from '../../commands/index.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit Zy memory files',
  load: () => import('./memory.js'),
}

export default memory
