import type { Command } from '../../commands.js'
import type { LocalCommandModule } from '../../types/command.js'

const cmd = {
  type: 'local' as const,
  name: 'buddy',
  description: 'Buddy mode',
  supportsNonInteractive: false,
  load: async (): Promise<LocalCommandModule> => {
    // TODO: Implement buddy command module
    throw new Error('Buddy command not implemented')
  },
} satisfies Command
export default cmd
