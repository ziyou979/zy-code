import type { Command } from '../../commands/index.js'
import { tSync } from '../../i18n/index.js'
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
          return { type: 'text', value: tSync('commands.out.assistant.enabled') }
        }
        if (args === 'off') {
          disableAssistantMode()
          return { type: 'text', value: tSync('commands.out.assistant.disabled') }
        }
        return {
          type: 'text',
          value: tSync(
            isActive
              ? 'commands.out.assistant.statusEnabled'
              : 'commands.out.assistant.statusDisabled',
          ),
        }
      },
    }
  },
} satisfies Command

export default command
