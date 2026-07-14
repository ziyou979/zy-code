import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { TEAM_LEAD_NAME } from 'src/services/swarm/constants.js'
import type { DreamTaskState } from 'src/tasks/dream-task/dreamTask.js'
import type { InProcessTeammateTaskState } from 'src/tasks/in-process-teammate-task/types.js'
import type { LocalAgentTaskState } from 'src/tasks/local-agent-task/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/tasks/local-shell-task/guards.js'
import type { LocalWorkflowTaskState } from 'src/tasks/local-workflow-task/localWorkflowTask.js'
import type { MonitorMcpTaskState } from 'src/tasks/monitor-mcp-task/monitorMcpTask.js'
import type { RemoteAgentTaskState } from 'src/tasks/remote-agent-task/RemoteAgentTask.js'
import type { BackgroundTaskState } from 'src/tasks/types.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { POINTER } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js'

export type ListItem =
  | {
      id: string
      type: 'local_bash'
      label: string
      status: string
      task: DeepImmutable<LocalShellTaskState>
    }
  | {
      id: string
      type: 'remote_agent'
      label: string
      status: string
      task: DeepImmutable<RemoteAgentTaskState>
    }
  | {
      id: string
      type: 'local_agent'
      label: string
      status: string
      task: DeepImmutable<LocalAgentTaskState>
    }
  | {
      id: string
      type: 'in_process_teammate'
      label: string
      status: string
      task: DeepImmutable<InProcessTeammateTaskState>
    }
  | {
      id: string
      type: 'local_workflow'
      label: string
      status: string
      task: DeepImmutable<LocalWorkflowTaskState>
    }
  | {
      id: string
      type: 'monitor_mcp'
      label: string
      status: string
      task: DeepImmutable<MonitorMcpTaskState>
    }
  | {
      id: string
      type: 'dream'
      label: string
      status: string
      task: DeepImmutable<DreamTaskState>
    }
  | {
      id: string
      type: 'leader'
      label: string
      status: 'running'
    }

export function toListItem(task: BackgroundTaskState): ListItem {
  switch (task.type) {
    case 'local_bash':
      return {
        id: task.id,
        type: 'local_bash',
        label: task.kind === 'monitor' ? task.description : task.command,
        status: task.status,
        task,
      }
    case 'remote_agent':
      return {
        id: task.id,
        type: 'remote_agent',
        label: task.title,
        status: task.status,
        task,
      }
    case 'local_agent':
      return {
        id: task.id,
        type: 'local_agent',
        label: task.description,
        status: task.status,
        task,
      }
    case 'in_process_teammate':
      return {
        id: task.id,
        type: 'in_process_teammate',
        label: `@${task.identity.agentName}`,
        status: task.status,
        task,
      }
    case 'local_workflow':
      return {
        id: task.id,
        type: 'local_workflow',
        label: task.summary ?? task.description,
        status: task.status,
        task,
      }
    case 'monitor_mcp':
      return {
        id: task.id,
        type: 'monitor_mcp',
        label: task.description,
        status: task.status,
        task,
      }
    case 'dream':
      return {
        id: task.id,
        type: 'dream',
        label: task.description,
        status: task.status,
        task,
      }
  }
}

export function Item({ item, isSelected }: { item: ListItem; isSelected: boolean }) {
  const { columns } = useTerminalSize()
  const maxActivityWidth = Math.max(30, columns - 26)
  const useGreyPointer = isCoordinatorMode()
  return (
    <Box flexDirection="row">
      {<Text dimColor={useGreyPointer && isSelected}>{isSelected ? `${POINTER} ` : '  '}</Text>}
      {
        <Text color={isSelected && !useGreyPointer ? 'suggestion' : undefined}>
          {item.type === 'leader' ? (
            <Text>@{TEAM_LEAD_NAME}</Text>
          ) : (
            <BackgroundTaskComponent task={item.task} maxActivityWidth={maxActivityWidth} />
          )}
        </Text>
      }
    </Box>
  )
}

export function TeammateTaskGroups({
  teammateTasks,
  currentSelectionId,
}: {
  teammateTasks: ListItem[]
  currentSelectionId: string | undefined
}) {
  const leaderItems = teammateTasks.filter((i) => i.type === 'leader')
  const teammateItems = teammateTasks.filter((i_0) => i_0.type === 'in_process_teammate')
  const teams = new Map<string, ListItem[]>()
  for (const item of teammateItems) {
    const teamName = (item as Extract<ListItem, { type: 'in_process_teammate' }>).task.identity
      .teamName
    const group = teams.get(teamName)
    if (group) {
      group.push(item)
    } else {
      teams.set(teamName, [item])
    }
  }
  const teamEntries = [...teams.entries()]
  return (
    <>
      {teamEntries.map((entry) => {
        const [teamName_0, items] = entry
        const memberCount = items.length + leaderItems.length
        return (
          <Box key={teamName_0} flexDirection="column">
            <Text dimColor={true}>
              {'  '}
              {tSync('backgroundTasks.team')}: {teamName_0} ({memberCount})
            </Text>
            {leaderItems.map((item) => (
              <Item
                key={`${item.id}-${teamName_0}`}
                item={item}
                isSelected={item.id === currentSelectionId}
              />
            ))}
            {items.map((item) => (
              <Item key={item.id} item={item} isSelected={item.id === currentSelectionId} />
            ))}
          </Box>
        )
      })}
    </>
  )
}
