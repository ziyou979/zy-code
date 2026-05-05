import type { Command } from '../../types/command.js'

const cmd = {
  type: 'local' as const,
  name: 'fork',
  description: 'Fork conversation',
} satisfies Command
export default cmd
