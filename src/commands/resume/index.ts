import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  get description() {
    return tSync('commands.resume')
  },
  aliases: ['continue'],
  get argumentHint() {
    return tSync('commands.resume.argumentHint')
  },
  load: () => import('./resume.js'),
}

export default resume
