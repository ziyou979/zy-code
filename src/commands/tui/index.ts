import { tSync } from '../../i18n/index.js'
import type { Command } from '../../commands.js'

const command = {
  name: 'tui',
  description: tSync('commands.tui'),
  argumentHint: tSync('commands.tui.argumentHint'),
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./tui.js'),
} satisfies Command

export default command
