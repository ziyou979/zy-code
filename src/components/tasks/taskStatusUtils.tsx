/**
 * Shared utilities for displaying task status across different task types.
 */

import type { TaskStatus } from 'src/tasks/task.js'
import type { InProcessTeammateTaskState } from 'src/tasks/in-process-teammate-task/types.js'
import { isPanelAgentTask } from 'src/tasks/local-agent-task/LocalAgentTask.js'
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import type { DeepImmutable } from 'src/types/utils.js'
import { summarizeRecentActivities } from 'src/utils/collapseReadSearch.js'
import {
  BULLET,
  CROSS,
  ELLIPSIS,
  PLAY,
  QUESTION_MARK,
  TICK,
  WARNING,
} from '../../constants/figures.js'
import { isInternalBuild } from '../../utils/envUtils.js'

/**
 * Returns true if the given task status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * Returns the appropriate icon for a task based on status and state flags.
 */
export function getTaskStatusIcon(
  status: TaskStatus,
  options?: {
    isIdle?: boolean
    awaitingApproval?: boolean
    hasError?: boolean
    shutdownRequested?: boolean
  },
): string {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {}
  if (hasError) {
    return CROSS
  }
  if (awaitingApproval) {
    return QUESTION_MARK
  }
  if (shutdownRequested) {
    return WARNING
  }
  if (status === 'running') {
    if (isIdle) {
      return ELLIPSIS
    }
    return PLAY
  }
  if (status === 'completed') {
    return TICK
  }
  if (status === 'failed' || status === 'killed') {
    return CROSS
  }
  return BULLET
}

/**
 * Returns the appropriate semantic color for a task based on status and state flags.
 */
export function getTaskStatusColor(
  status: TaskStatus,
  options?: {
    isIdle?: boolean
    awaitingApproval?: boolean
    hasError?: boolean
    shutdownRequested?: boolean
  },
): 'success' | 'error' | 'warning' | 'background' {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } = options ?? {}
  if (hasError) {
    return 'error'
  }
  if (awaitingApproval) {
    return 'warning'
  }
  if (shutdownRequested) {
    return 'warning'
  }
  if (isIdle) {
    return 'background'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'failed') {
    return 'error'
  }
  if (status === 'killed') {
    return 'warning'
  }
  return 'background'
}

/**
 * Derives a human-readable activity string for an in-process teammate,
 * accounting for shutdown/approval/idle states and falling back through
 * recent-activity summary → last activity description → 'working'.
 */
export function describeTeammateActivity(t: DeepImmutable<InProcessTeammateTaskState>): string {
  if (t.shutdownRequested) {
    return 'stopping'
  }
  if (t.awaitingPlanApproval) {
    return 'awaiting approval'
  }
  if (t.isIdle) {
    return 'idle'
  }
  return (
    (t.progress?.recentActivities && summarizeRecentActivities(t.progress.recentActivities)) ??
    t.progress?.lastActivity?.activityDescription ??
    'working'
  )
}

/**
 * Returns true when BackgroundTaskStatus would render nothing because the
 * spinner tree is active and every visible background task is an in-process
 * teammate (teammates are shown in the spinner tree instead).
 *
 * Uses the same task filtering as BackgroundTaskStatus: `isBackgroundTask()`
 * plus exclusion of panel-managed agent tasks for ants (those are shown
 * by CoordinatorTaskPanel).
 */
export function shouldHideTasksFooter(
  tasks: {
    [taskId: string]: TaskState
  },
  showSpinnerTree: boolean,
): boolean {
  if (!showSpinnerTree) {
    return false
  }
  let hasVisibleTask = false
  for (const t of Object.values(tasks) as TaskState[]) {
    if (!isBackgroundTask(t) || (isInternalBuild() && isPanelAgentTask(t))) {
      continue
    }
    hasVisibleTask = true
    if (t.type !== 'in_process_teammate') {
      return false
    }
  }
  return hasVisibleTask
}
