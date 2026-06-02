import { appendFileSync } from 'node:fs'
import { updateTaskState } from '../../../services/task/framework.js'
import type { SetAppState } from '../../../Task.js'
import type { LocalWorkflowTaskState } from '../../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

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
