// auto-dream（记忆整理子代理）的后台任务入口。
// 通过现有任务注册表，让原本不可见的 forked agent 显示在页脚状态块和 Shift+Down 对话框中；
// dream agent 本身的行为不变，这里只负责 UI 展示。

import { rollbackConsolidationLock } from '../../services/auto-dream/consolidationLock.js'
import { registerTask, updateTaskState } from '../../services/task-runtime/framework.js'
import type { SetAppState, Task, TaskStateBase } from '../../tasks/task.js'
import { createTaskStateBase, generateTaskId } from '../../tasks/task.js'

// 实时展示只保留最近 N 轮。
const MAX_TURNS = 30

// dream agent 的单轮 assistant 输出；工具调用折叠为数量。
export type DreamTurn = {
  text: string
  toolUseCount: number
}

// 不解析阶段。dream prompt 虽然分为 orient/gather/consolidate/prune 四个阶段，但这里不会
// 识别它们；收到首个 Edit/Write tool_use 时，只把状态从 starting 切换为 updating。
export type DreamPhase = 'starting' | 'updating'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  sessionsReviewing: number
  /**
   * onMessage 从 Edit/Write tool_use 块中观察到的路径。这并不能完整反映 dream agent 的实际
   * 改动：通过 bash 写入的文件不会被记录，也只会捕获模式匹配到的工具调用。因此它表示
   * “至少改动了这些文件”，而不是“只改动了这些文件”。
   */
  filesTouched: string[]
  /** assistant 文本响应，工具调用已折叠；不包含 prompt。 */
  turns: DreamTurn[]
  abortController?: AbortController
  /** 暂存该值，供 kill 回退锁文件的 mtime（与 fork 失败走同一路径）。 */
  priorMtime: number
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'dream'
}

export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string {
  const id = generateTaskId('dream')
  const task: DreamTaskState = {
    ...createTaskStateBase(id, 'dream', 'dreaming'),
    type: 'dream',
    status: 'running',
    phase: 'starting',
    sessionsReviewing: opts.sessionsReviewing,
    filesTouched: [],
    turns: [],
    abortController: opts.abortController,
    priorMtime: opts.priorMtime,
  }
  registerTask(task, setAppState)
  return id
}

export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, (task) => {
    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter((p) => !seen.has(p) && seen.add(p))
    // 如果本轮为空且没有新增改动文件，则完全跳过更新，避免无实际变化时重新渲染。
    if (turn.text === '' && turn.toolUseCount === 0 && newTouched.length === 0) {
      return task
    }
    return {
      ...task,
      phase: newTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newTouched.length > 0 ? [...task.filesTouched, ...newTouched] : task.filesTouched,
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

export function completeDreamTask(taskId: string, setAppState: SetAppState): void {
  // 立即设为 notified: true：dream 没有面向模型的通知路径，仅在 UI 中展示，而清理任务要求
  // 同时满足终态和已通知。内联的 appendSystemMessage 完成消息就是用户可见的反馈。
  updateTaskState<DreamTaskState>(taskId, setAppState, (task) => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, (task) => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',

  async kill(taskId, setAppState) {
    let priorMtime: number | undefined
    updateTaskState<DreamTaskState>(taskId, setAppState, (task) => {
      if (task.status !== 'running') {
        return task
      }
      task.abortController?.abort()
      priorMtime = task.priorMtime
      return {
        ...task,
        status: 'killed',
        endTime: Date.now(),
        notified: true,
        abortController: undefined,
      }
    })
    // 回退锁文件的 mtime，让下一个会话可以重试；这与 autoDream.ts 捕获 fork 失败时的处理
    // 路径一致。若任务已处于终态，updateTaskState 不会更新，priorMtime 仍为 undefined，
    // 此处也会跳过回退。
    if (priorMtime !== undefined) {
      await rollbackConsolidationLock(priorMtime)
    }
  },
}
