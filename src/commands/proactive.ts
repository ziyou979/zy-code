import type { Command } from '../commands/index.js'
import type { LocalCommandModule } from './types.js'

const command = {
  type: 'local',
  name: 'proactive',
  description: 'Enter proactive mode — AI takes initiative',
  supportsNonInteractive: false,
  async load(): Promise<LocalCommandModule> {
    return {
      async call() {
        return {
          type: 'text',
          value: 'Proactive mode: AI will take initiative and drive progress autonomously.',
        }
      },
    }
  },
} satisfies Command

export default command
