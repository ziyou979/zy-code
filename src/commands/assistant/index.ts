import type { Command } from '../../commands.js'
import type { LocalCommandModule } from '../types.js'

const command = {
  type: 'local',
  name: 'assistant',
  description: 'Manage KAIROS assistant mode',
  supportsNonInteractive: false,
  async load(): Promise<LocalCommandModule> {
    const { isAssistantMode, enableAssistantMode, disableAssistantMode } = await import(
      '../../assistant/index.js'
    )
    return {
      async call(args) {
        const isActive = isAssistantMode()
        if (args === 'on') {
          enableAssistantMode()
          return { type: 'text', value: 'Assistant mode enabled.' }
        }
        if (args === 'off') {
          disableAssistantMode()
          return { type: 'text', value: 'Assistant mode disabled.' }
        }
        return {
          type: 'text',
          value: `Assistant mode is currently ${isActive ? 'enabled' : 'disabled'}. Use "/assistant on" or "/assistant off" to toggle.`,
        }
      },
    }
  },
} satisfies Command

export default command
