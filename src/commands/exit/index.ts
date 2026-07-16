import type { Command } from '../../commands/index.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit the CLI',
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

export default exit
