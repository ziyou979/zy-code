import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  description: tSync('commands.resume'),
  aliases: ['continue'],
  argumentHint: tSync('commands.resume.argumentHint'),
  load: () => import('./resume.js'),
}

export default resume
