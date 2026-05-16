import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'statusline',
  description: 'commands.statusline',
  argumentHint: '[on|off|reset|<模块>]',
  immediate: true,
  load: () => import('./statusline.js'),
} satisfies Command
