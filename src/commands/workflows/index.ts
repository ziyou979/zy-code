import type { Command } from '../../commands/index.js'
import { CLOCKWISE_ARROWS, CROSS, TICK } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import type { LocalCommandCall, LocalCommandModule } from '../types.js'

const call: LocalCommandCall = async (_args, context) => {
  const state = context.getAppState()
  const workflowTasks = Object.values(state.tasks ?? {}).filter(
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    (t: any) => t.type === 'local_workflow',
  )

  if (workflowTasks.length === 0) {
    return { type: 'text', value: tSync('commands.workflows.empty') }
  }

  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  const lines = workflowTasks.map((t: any) => {
    const status =
      t.status === 'running'
        ? `${CLOCKWISE_ARROWS} running`
        : t.status === 'completed'
          ? `${TICK} done`
          : t.status === 'failed'
            ? `${CROSS} failed`
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
  get description() {
    return tSync('commands.workflows')
  },
  supportsNonInteractive: true,
  isEnabled: () => true,
  load: async (): Promise<LocalCommandModule> => ({ call }),
} satisfies Command
export default cmd
