// 停止运行中 task 的共享逻辑，供 TaskStopTool（由 LLM 调用）和 SDK stop_task
// 控制请求使用。

import type { AppState } from '../state/AppStateStore.js'
import type { TaskStateBase } from '../tasks/task.js'
import { getTaskByType } from './index.js'
import { emitTaskTerminatedBridge } from '../services/bridge/bridgeEventQueue.js'
import { isLocalShellTask } from './local-shell-task/guards.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * 按 ID 查找 task，确认它正在运行后终止，并标记为已通知。
 *
 * task 无法停止（不存在、未运行或类型不受支持）时抛出 {@link StopTaskError}。
 * 调用方可检查 `error.code` 区分失败原因。
 */
export async function stopTask(taskId: string, context: StopTaskContext): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }

  if (task.status !== 'running') {
    throw new StopTaskError(`Task ${taskId} is not running (status: ${task.status})`, 'not_running')
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(`Unsupported task type: ${task.type}`, 'unsupported_type')
  }

  await taskImpl.kill(taskId, setAppState)

  // Bash：抑制属于噪声的“exit code 137”通知。agent task 不应抑制；AbortError catch
  // 会发送包含 extractPartialResult(agentMessages) 的通知，这是有效载荷而非噪声。
  if (isLocalShellTask(task)) {
    let suppressed = false
    setAppState((prev) => {
      const prevTask = prev.tasks[taskId]
      if (!prevTask || prevTask.notified) {
        return prev
      }
      suppressed = true
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...prevTask, notified: true },
        },
      }
    })
    // 抑制 XML 通知也会抑制 print.ts 解析出的 task_notification SDK 事件，
    // 因此这里直接发出，使 SDK consumer 能看到 task 关闭。
    if (suppressed) {
      emitTaskTerminatedBridge(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}
