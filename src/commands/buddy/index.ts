import type { Command } from '../../types/command.js'

const cmd = { type: 'local' as const, name: 'buddy', description: 'Buddy mode' } satisfies Command
export default cmd
