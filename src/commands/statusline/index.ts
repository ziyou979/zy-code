import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'statusline',
  description: 'commands.statusline',
  immediate: true,
  load: () => import('./statusline.js'),
} satisfies Command
