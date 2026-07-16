import { Text } from 'src/ink/index.js'
import type { BackgroundTaskState } from 'src/tasks/types.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { truncate } from 'src/utils/format.js'
import { toInkColor } from 'src/utils/ink.js'
import { plural } from 'src/utils/stringUtils.js'
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import { RemoteSessionProgress } from './RemoteSessionProgress.js'
import { ShellProgress, TaskStatusText } from './ShellProgress.js'
import { describeTeammateActivity } from './TaskStatusUtils.js'

type Props = {
  task: DeepImmutable<BackgroundTaskState>
  maxActivityWidth?: number
}
export function BackgroundTask({ task, maxActivityWidth }: Props) {
  const activityLimit = maxActivityWidth ?? 40
  switch (task.type) {
    case 'local_bash': {
      const description = task.kind === 'monitor' ? task.description : task.command
      const truncatedDescription = truncate(description, activityLimit, true)
      const progressElement = <ShellProgress shell={task} />
      return (
        <Text>
          {truncatedDescription} {progressElement}
        </Text>
      )
    }
    case 'remote_agent': {
      if (task.isRemoteReview) {
        return (
          <Text>
            <RemoteSessionProgress session={task} />
          </Text>
        )
      }
      const running = task.status === 'running' || task.status === 'pending'
      const statusIcon = running ? DIAMOND_OPEN : DIAMOND_FILLED
      const iconElement = <Text dimColor={true}>{statusIcon} </Text>
      const titleText = truncate(task.title, activityLimit, true)
      const separator = <Text dimColor={true}> · </Text>
      const progressElement = <RemoteSessionProgress session={task} />
      return (
        <Text>
          {iconElement}
          {titleText}
          {separator}
          {progressElement}
        </Text>
      )
    }
    case 'local_agent': {
      const truncatedDescription = truncate(task.description, activityLimit, true)
      const doneLabel = task.status === 'completed' ? tSync('backgroundTasks.done') : undefined
      const unreadSuffix =
        task.status === 'completed' && !task.notified ? tSync('backgroundTasks.unread') : undefined
      const statusElement = (
        <TaskStatusText status={task.status} label={doneLabel} suffix={unreadSuffix} />
      )
      return (
        <Text>
          {truncatedDescription} {statusElement}
        </Text>
      )
    }
    case 'in_process_teammate': {
      const activity = describeTeammateActivity(task)
      const agentColor = toInkColor(task.identity.color)
      const agentNameElement = <Text color={agentColor}>@{task.identity.agentName}</Text>
      const truncatedActivity = truncate(activity, activityLimit, true)
      const activityElement = (
        <Text dimColor={true}>
          {': '}
          {truncatedActivity}
        </Text>
      )
      return (
        <Text>
          {agentNameElement}
          {activityElement}
        </Text>
      )
    }
    case 'local_workflow': {
      const workflowTitle = task.workflowName ?? task.summary ?? task.description
      const truncatedTitle = truncate(workflowTitle, activityLimit, true)
      const statusLabel =
        task.status === 'running'
          ? `${task.agentCount} ${plural(task.agentCount, 'agent')}`
          : task.status === 'completed'
            ? tSync('backgroundTasks.done')
            : undefined
      const unreadSuffix =
        task.status === 'completed' && !task.notified ? tSync('backgroundTasks.unread') : undefined
      const statusElement = (
        <TaskStatusText status={task.status} label={statusLabel} suffix={unreadSuffix} />
      )
      return (
        <Text>
          {truncatedTitle} {statusElement}
        </Text>
      )
    }
    case 'monitor_mcp': {
      const truncatedDescription = truncate(task.description, activityLimit, true)
      const doneLabel = task.status === 'completed' ? tSync('backgroundTasks.done') : undefined
      const unreadSuffix =
        task.status === 'completed' && !task.notified ? tSync('backgroundTasks.unread') : undefined
      const statusElement = (
        <TaskStatusText status={task.status} label={doneLabel} suffix={unreadSuffix} />
      )
      return (
        <Text>
          {truncatedDescription} {statusElement}
        </Text>
      )
    }
    case 'dream': {
      const n = task.filesTouched.length
      const detailText =
        task.phase === 'updating' && n > 0
          ? `${n} ${plural(n, 'file')}`
          : `${task.sessionsReviewing} ${plural(task.sessionsReviewing, 'session')}`
      const detailElement = (
        <Text dimColor={true}>
          · {task.phase} · {detailText}
        </Text>
      )
      const doneLabel = task.status === 'completed' ? tSync('backgroundTasks.done') : undefined
      const unreadSuffix =
        task.status === 'completed' && !task.notified ? tSync('backgroundTasks.unread') : undefined
      const statusElement = (
        <TaskStatusText status={task.status} label={doneLabel} suffix={unreadSuffix} />
      )
      return (
        <Text>
          {task.description} {detailElement} {statusElement}
        </Text>
      )
    }
  }
}
