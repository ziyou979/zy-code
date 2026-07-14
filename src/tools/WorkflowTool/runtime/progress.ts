import { appendFileSync } from 'node:fs'
import { updateTaskState } from '../../../services/task-runtime/framework.js'
import type { SetAppState } from '../../../task.js'
import type { LocalWorkflowTaskState } from '../../../tasks/local-workflow-task/localWorkflowTask.js'

export interface ProgressContext {
  taskId: string
  setAppState: SetAppState
  outputFile: string
}

export function createPhaseFunction(ctx: ProgressContext) {
  return function phase(title: string): void {
    updateTaskState<LocalWorkflowTaskState>(ctx.taskId, ctx.setAppState, (state) => ({
      ...state,
      currentPhase: title,
    }))
    writeToOutput(ctx.outputFile, `[phase] ${title}`)
  }
}

export function createLogFunction(ctx: ProgressContext) {
  return function log(message: string): void {
    writeToOutput(ctx.outputFile, `[log] ${message}`)
  }
}

function writeToOutput(outputFile: string, line: string): void {
  try {
    appendFileSync(outputFile, `${line}\n`)
  } catch {
    // 输出文件写入失败不影响主流程
  }
}
