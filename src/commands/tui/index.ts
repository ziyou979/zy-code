import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const command = {
  name: 'tui',
  get description() {
    return tSync('commands.tui')
  },
  get argumentHint() {
    return tSync('commands.tui.argumentHint')
  },
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./tui.js'),
} satisfies Command

export default command
