import type { Command } from '../../commands/index.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Manage allow & deny tool permission rules',
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
