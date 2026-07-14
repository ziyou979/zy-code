import type { Command } from '../../commands.js'
import type { LocalCommandModule } from '../types.js'

const cmd = {
  type: 'local' as const,
  name: 'peers',
  description: 'Manage peers',
  supportsNonInteractive: false,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement peers command module
    throw new Error('Peers command not implemented')
  },
} satisfies Command
export default cmd
