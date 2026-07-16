import type { Command } from '../../commands/index.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: 'Show your ZY Code usage statistics and activity',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
