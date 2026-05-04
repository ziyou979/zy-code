import type { Command } from '../commands.js'
import type { LocalCommandModule } from '../types/command.js'

const command = {
  type: 'local',
  name: 'force-snip',
  description: 'Force snip compaction of conversation history',
  supportsNonInteractive: false,
  async load(): Promise<LocalCommandModule> {
    return {
      async call() {
        return { type: 'text', value: 'Snip compaction triggered.' }
      },
    }
  },
} satisfies Command

export default command
