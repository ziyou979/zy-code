import type { Command } from '../../types/command.js'

const cmd = {
  type: 'local' as const,
  name: 'workflows',
  description: 'Manage workflows',
} satisfies Command
export default cmd
