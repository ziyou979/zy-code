import { logEvent } from '../services/analytics/index.js'
import { isTerminalTaskStatus } from '../tasks/task.js'
import type { LocalAgentTaskState } from '../tasks/local-agent-task/LocalAgentTask.js'
import { evictTerminalTask, scheduleTerminalEviction } from '../services/task-runtime/framework.js'

// 内联 PANEL_GRACE_MS 常量以供 release() 使用。虽然 framework.ts 已有导出，
// 但该值在 setAppState 纯函数内使用，保持内联可避免模块级依赖链变化。
const PANEL_GRACE_MS = 30_000

import type { AppState } from './AppStateStore.js'

// Inline type check instead of importing isLocalAgentTask — breaks the
// teammateViewHelpers → LocalAgentTask runtime edge that creates a cycle
// through BackgroundTasksDialog.
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_agent'
}

/**
 * Return the task released back to stub form: retain dropped, messages
 * cleared, evictAfter set if terminal. Shared by exitTeammateView and
 * the switch-away path in enterTeammateView.
 */
function release(task: LocalAgentTaskState): LocalAgentTaskState {
  return {
    ...task,
    retain: false,
    messages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status) ? Date.now() + PANEL_GRACE_MS : undefined,
  }
}

/**
 * Transitions the UI to view a teammate's transcript.
 * Sets viewingAgentTaskId and, for local_agent, retain: true (blocks eviction,
 * enables stream-append, triggers disk bootstrap) and clears evictAfter.
 * If switching from another agent, releases the previous one back to stub.
 */
export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('zy_transcript_view_enter', {})
  let switchedFromId: string | undefined
  setAppState((prev) => {
    const task = prev.tasks[taskId]
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId !== undefined ? prev.tasks[prevId] : undefined
    const switching =
      prevId !== undefined && prevId !== taskId && isLocalAgent(prevTask) && prevTask.retain
    const needsRetain = isLocalAgent(task) && (!task.retain || task.evictAfter !== undefined)
    const needsView =
      prev.viewingAgentTaskId !== taskId || prev.viewSelectionMode !== 'viewing-agent'
    if (!needsRetain && !needsView && !switching) {
      return prev
    }
    let tasks = prev.tasks
    if (switching || needsRetain) {
      tasks = { ...prev.tasks }
      if (switching) {
        tasks[prevId] = release(prevTask)
        if (isTerminalTaskStatus(prevTask.status)) {
          switchedFromId = prevId
        }
      }
      if (needsRetain) {
        tasks[taskId] = { ...task, retain: true, evictAfter: undefined }
      }
    }
    return {
      ...prev,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
      tasks,
    }
  })
  if (switchedFromId) {
    scheduleTerminalEviction(switchedFromId, setAppState)
  }
}

/**
 * Exit teammate transcript view and return to leader's view.
 * Drops retain and clears messages back to stub form; if terminal,
 * schedules eviction via evictAfter so the row lingers briefly.
 */
export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('zy_transcript_view_exit', {})
  let evictedId: string | undefined
  setAppState((prev) => {
    const id = prev.viewingAgentTaskId
    const cleared = {
      ...prev,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none' as const,
    }
    if (id === undefined) {
      return prev.viewSelectionMode === 'none' ? prev : cleared
    }
    const task = prev.tasks[id]
    if (!isLocalAgent(task) || !task.retain) {
      return cleared
    }
    if (isTerminalTaskStatus(task.status)) {
      evictedId = id
    }
    return {
      ...cleared,
      tasks: { ...prev.tasks, [id]: release(task) },
    }
  })
  if (evictedId) {
    scheduleTerminalEviction(evictedId, setAppState)
  }
}

/**
 * Context-sensitive x: running → abort, terminal → dismiss.
 * Dismiss sets evictAfter=0 so the filter hides immediately.
 * If viewing the dismissed agent, also exits to leader.
 */
export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  let shouldEvict = false
  let abortController: AbortController | undefined
  setAppState((prev) => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) {
      return prev
    }
    if (task.status === 'running') {
      // 记录 controller 引用，在回调外执行 abort 以保持 updater 无副作用
      abortController = task.abortController
      return prev
    }
    if (task.evictAfter === 0) {
      return prev
    }
    shouldEvict = true
    const viewingThis = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...release(task), evictAfter: 0 },
      },
      ...(viewingThis && {
        viewingAgentTaskId: undefined,
        viewSelectionMode: 'none',
      }),
    }
  })
  abortController?.abort()
  if (shouldEvict) {
    evictTerminalTask(taskId, setAppState)
  }
}
