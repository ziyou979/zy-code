import type { Command } from '../../commands/index.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  aliases: ['cost', 'stats'],
  description: 'Show session cost, plan usage, and activity stats',
  immediate: true,
  load: () => import('./usage.js'),
} satisfies Command
