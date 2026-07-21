import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import { getTaskOutputPath, initTaskOutput } from '../../services/task-runtime/diskOutput.js'
import { registerTask, updateTaskState } from '../../services/task-runtime/framework.js'
import type { SetAppState, Task, TaskStateBase } from '../../tasks/task.js'
import { createTaskStateBase, generateTaskId } from '../../tasks/task.js'
import { enqueuePendingNotification } from '../../services/input/messageQueueManager.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowId: string
  workflowName?: string
  scriptPath?: string
  summary?: string
  agentCount: number
  currentPhase?: string
  phases?: Array<{ title: string; detail?: string }>
  error?: string
}

export interface RegisterWorkflowOpts {
  description: string
  workflowName?: string
  scriptPath?: string
  toolUseId?: string
  phases?: Array<{ title: string; detail?: string }>
  workflowId?: string
}

export async function registerWorkflowTask(
  setAppState: SetAppState,
  opts: RegisterWorkflowOpts,
): Promise<{ taskId: string; outputFile: string }> {
  const taskId = generateTaskId('local_workflow')
  const outputFile = await initTaskOutput(taskId)

  const state: LocalWorkflowTaskState = {
    ...createTaskStateBase(taskId, 'local_workflow', opts.description, opts.toolUseId),
    type: 'local_workflow',
    workflowId: opts.workflowId ?? `wf_${taskId}`,
    workflowName: opts.workflowName,
    scriptPath: opts.scriptPath,
    agentCount: 0,
    phases: opts.phases,
    status: 'running',
    outputFile,
  }

  registerTask(state, setAppState)
  return { taskId, outputFile }
}

export function completeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  summary: string,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, (state) => ({
    ...state,
    status: 'completed',
    summary,
    endTime: Date.now(),
  }))
  enqueueWorkflowNotification(taskId, 'completed', summary)
}

export function failWorkflowTask(taskId: string, setAppState: SetAppState, error: string): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, (state) => ({
    ...state,
    status: 'failed',
    error,
    endTime: Date.now(),
  }))
  enqueueWorkflowNotification(taskId, 'failed', `Workflow failed: ${error}`)
}

export function killWorkflowTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, (state) => ({
    ...state,
    status: 'killed',
    endTime: Date.now(),
  }))
  enqueueWorkflowNotification(taskId, 'killed', 'Workflow was stopped')
}

function enqueueWorkflowNotification(
  taskId: string,
  status: 'completed' | 'failed' | 'killed',
  summary: string,
): void {
  const outputPath = getTaskOutputPath(taskId)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>
<task-type>local_workflow</task-type>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
  })
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    killWorkflowTask(taskId, setAppState)
  },
}
