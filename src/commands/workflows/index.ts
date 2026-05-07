import type { Command } from '../../commands.js'
import type { LocalCommandModule } from '../../types/command.js'

const cmd = {
  type: 'local' as const,
  name: 'workflows',
  description: 'Manage workflows',
  supportsNonInteractive: false,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement workflows command module
    throw new Error('Workflows command not implemented')
  },
} satisfies Command
export default cmd
