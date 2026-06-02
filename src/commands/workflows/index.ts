import type { Command } from '../../commands.js'
import { tSync } from '../../i18n/index.js'
import type { LocalCommandCall, LocalCommandModule } from '../../types/command.js'

const call: LocalCommandCall = async (_args, context) => {
  const state = context.getAppState()
  const workflowTasks = Object.values(state.tasks ?? {}).filter(
    (t: any) => t.type === 'local_workflow',
  )

  if (workflowTasks.length === 0) {
    return { type: 'text', value: tSync('commands.workflows.empty') }
  }

  const lines = workflowTasks.map((t: any) => {
    const status =
      t.status === 'running'
        ? '⟳ running'
        : t.status === 'completed'
          ? '✓ done'
          : t.status === 'failed'
            ? '✗ failed'
            : t.status
    const phase = t.currentPhase ? ` [${t.currentPhase}]` : ''
    const agents = t.agentCount ? ` (${t.agentCount} agents)` : ''
    const name = t.workflowName ?? t.description ?? t.id
    const duration = t.endTime
      ? ` ${Math.round((t.endTime - t.startTime) / 1000)}s`
      : t.startTime
        ? ` ${Math.round((Date.now() - t.startTime) / 1000)}s`
        : ''
    return `  ${status}  ${name}${phase}${agents}${duration}`
  })

  return { type: 'text', value: `${tSync('commands.workflows.title')}\n${lines.join('\n')}` }
}

const cmd = {
  type: 'local' as const,
  name: 'workflows',
  description: tSync('commands.workflows'),
  supportsNonInteractive: true,
  isEnabled: () => true,
  load: async (): Promise<LocalCommandModule> => ({ call }),
} satisfies Command
export default cmd
