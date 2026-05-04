import type { Command } from '../types/command.js'

const cmd = { type: 'local' as const, name: 'peers', description: 'Manage peers' } satisfies Command
export default cmd
