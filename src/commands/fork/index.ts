import type { Command } from '../../commands/index.js'
import type { LocalCommandModule } from '../types.js'

const cmd = {
  type: 'local' as const,
  name: 'fork',
  description: 'Fork conversation',
  supportsNonInteractive: false,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement fork command module
    throw new Error('Fork command not implemented')
  },
} satisfies Command
export default cmd
