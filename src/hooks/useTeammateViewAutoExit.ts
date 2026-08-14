import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../tasks/in-process-teammate-task/types.js'

/**
 * 正在查看的 teammate 被终止或遇到错误时，自动退出 teammate 查看模式。
 * teammate 正常完成后仍保留查看状态，便于用户审阅完整 transcript。
 */
export function useTeammateViewAutoExit(): void {
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)
  // 只选择正在查看的任务，而非完整 tasks map；否则任一 teammate 的流式更新
  // 都会让此 hook 重新渲染。
  const task = useAppState((s) =>
    s.viewingAgentTaskId ? s.tasks[s.viewingAgentTaskId] : undefined,
  )

  const viewedTask = task && isInProcessTeammateTask(task) ? task : undefined
  const viewedStatus = viewedTask?.status
  const viewedError = viewedTask?.error
  const taskExists = task !== undefined

  useEffect(() => {
    // 当前未查看任何 teammate
    if (!viewingAgentTaskId) {
      return
    }

    // 任务已从 map 中移除。检查原始 `task`，而不是缩窄为 teammate 的 `viewedTask`；
    // local_agent 任务虽存在，但缩窄后为 undefined，会导致立即退出。
    if (!taskExists) {
      exitTeammateView(setAppState)
      return
    }
    // 下方状态检查仅适用于 teammate（viewedTask 已缩窄）。local_agent 的 viewedStatus
    // 为 undefined，所有检查均为 false，因此不会退出。
    if (!viewedTask) {
      return
    }

    // teammate 被终止、停止、出错或不再运行时自动退出，
    // 覆盖 teammate 在 shutdown 后变为 inactive 的情况
    if (
      viewedStatus === 'killed' ||
      viewedStatus === 'failed' ||
      viewedError ||
      (viewedStatus !== 'running' && viewedStatus !== 'completed' && viewedStatus !== 'pending')
    ) {
      exitTeammateView(setAppState)
      return
    }
  }, [viewingAgentTaskId, taskExists, viewedTask, viewedStatus, viewedError, setAppState])
}
