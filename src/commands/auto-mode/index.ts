import type { Command } from '../index.js'
import { tSync } from '../../i18n/index.js'

const autoMode = {
  type: 'local-jsx',
  name: 'auto-mode',
  get description() {
    return tSync('commands.autoMode')
  },
  argumentHint: '[evaluate|status]',
  load: () => import('./AutoModeEvaluationDialog.js'),
} satisfies Command

export default autoMode
