import { useEffect, useRef } from 'react'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import type { AppState } from '../state/AppStateStore.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { enterTeammateView, exitTeammateView } from '../state/teammateViewHelpers.js'
import {
  getRunningTeammatesSorted,
  InProcessTeammateTask,
} from '../tasks/in-process-teammate-task/InProcessTeammateTask.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/in-process-teammate-task/types.js'
import { isBackgroundTask } from '../tasks/types.js'

// 按 delta 步进 teammate 选择，在 leader(-1)..teammates(0..n-1)..hide(n) 之间循环。
// 从折叠状态第一次步进会展开树并停留在 leader 上。
function stepTeammateSelection(
  delta: 1 | -1,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState((prev) => {
    const currentCount = getRunningTeammatesSorted(prev.tasks).length
    if (currentCount === 0) {
      return prev
    }

    if (prev.expandedView !== 'teammates') {
      return {
        ...prev,
        expandedView: 'teammates' as const,
        viewSelectionMode: 'selecting-agent',
        selectedIPAgentIndex: -1,
      }
    }

    const maxIdx = currentCount // hide row
    const cur = prev.selectedIPAgentIndex
    const next = delta === 1 ? (cur >= maxIdx ? -1 : cur + 1) : cur <= -1 ? maxIdx : cur - 1
    return {
      ...prev,
      selectedIPAgentIndex: next,
      viewSelectionMode: 'selecting-agent',
    }
  })
}

/**
 * 自定义 hook，处理后台 task 的 Shift+Up/Down 键盘导航。
 * 当存在 teammates（swarm）时，在 leader 和 teammates 之间导航。
 * 当仅有非 teammate 的后台 task 时，打开后台 task 对话框。
 * 同时处理 Enter 确认选择、'f' 查看转录、'k' 终止。
 */
export function useBackgroundTaskNavigation(options?: { onOpenBackgroundTasks?: () => void }): {
  handleKeyDown: (e: KeyboardEvent) => void
} {
  const tasks = useAppState((s) => s.tasks)
  const viewSelectionMode = useAppState((s) => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)
  const selectedIPAgentIndex = useAppState((s) => s.selectedIPAgentIndex)
  const setAppState = useSetAppState()

  // 过滤出运行中的 teammates 并按字母顺序排序，以匹配 TeammateSpinnerTree 的显示
  const teammateTasks = getRunningTeammatesSorted(tasks)
  const teammateCount = teammateTasks.length

  // 检查是否存在非 teammate 的后台 task（local_agent、local_bash 等）
  const hasNonTeammateBackgroundTasks = Object.values(tasks).some(
    (t) => isBackgroundTask(t) && t.type !== 'in_process_teammate',
  )

  // 记录上一次的 teammate 数量，用于检测 teammate 被移除的情况
  const prevTeammateCountRef = useRef<number>(teammateCount)

  // 当 teammate 被移除或数量归零时，钳位选择索引或重置选择
  useEffect(() => {
    const prevCount = prevTeammateCountRef.current
    prevTeammateCountRef.current = teammateCount

    setAppState((prev) => {
      const currentTeammates = getRunningTeammatesSorted(prev.tasks)
      const currentCount = currentTeammates.length

      // 当 teammate 被移除（数量从 >0 变为 0）时，重置选择
      // 仅在之前有 teammate 时重置（而不是初始挂载时为 0 的情况）
      // 如果正在查看 teammate 转录，不要覆盖 viewSelectionMode——
      // 用户可能正在回顾已完成的 teammate，需要通过 escape 退出
      if (currentCount === 0 && prevCount > 0 && prev.selectedIPAgentIndex !== -1) {
        if (prev.viewSelectionMode === 'viewing-agent') {
          return {
            ...prev,
            selectedIPAgentIndex: -1,
          }
        }
        return {
          ...prev,
          selectedIPAgentIndex: -1,
          viewSelectionMode: 'none',
        }
      }

      // 如果索引超出范围则进行钳位
      // 当 spinner tree 显示时，最大有效索引为 currentCount（"hide" 行）
      const maxIndex = prev.expandedView === 'teammates' ? currentCount : currentCount - 1
      if (currentCount > 0 && prev.selectedIPAgentIndex > maxIndex) {
        return {
          ...prev,
          selectedIPAgentIndex: maxIndex,
        }
      }

      return prev
    })
  }, [teammateCount, setAppState])

  // 获取已选中 teammate 的 task 信息
  const getSelectedTeammate = (): {
    taskId: string
    task: InProcessTeammateTaskState
  } | null => {
    if (teammateCount === 0) {
      return null
    }
    const selectedIndex = selectedIPAgentIndex
    const task = teammateTasks[selectedIndex]
    if (!task) {
      return null
    }

    return { taskId: task.id, task }
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    // Escape 在查看模式下：
    // - 如果 teammate 正在运行：仅中止当前工作（停止当前 turn，teammate 保持存活）
    // - 如果 teammate 未运行（已完成/已终止/已失败）：退出视图回到 leader
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          // 中止 currentWorkAbortController（停止当前 turn），而不是 abortController（会终止 teammate）
          task.currentWorkAbortController?.abort()
          return
        }
      }
      // teammate 未运行或 task 不存在——退出视图
      exitTeammateView(setAppState)
      return
    }

    // Escape 在选择模式下：退出选择而不终止 leader
    if (e.key === 'escape' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      setAppState((prev) => ({
        ...prev,
        viewSelectionMode: 'none',
        selectedIPAgentIndex: -1,
      }))
      return
    }

    // Shift+Up/Down 用于 teammate 转录切换（带循环）
    // 索引 -1 表示 leader，0+ 表示 teammate
    // 当 showSpinnerTree 为 true 时，索引 === teammateCount 是 "hide" 行
    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (teammateCount > 0) {
        stepTeammateSelection(e.key === 'down' ? 1 : -1, setAppState)
      } else if (hasNonTeammateBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      }
      return
    }

    // 'f' 查看已选中 teammate 的转录（仅在选择模式下）
    if (e.key === 'f' && viewSelectionMode === 'selecting-agent' && teammateCount > 0) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected) {
        enterTeammateView(selected.taskId, setAppState)
      }
      return
    }

    // Enter 确认选择（仅在选择模式下）
    if (e.key === 'return' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      if (selectedIPAgentIndex === -1) {
        exitTeammateView(setAppState)
      } else if (selectedIPAgentIndex >= teammateCount) {
        // "Hide" 行被选中——折叠 spinner tree
        setAppState((prev) => ({
          ...prev,
          expandedView: 'none' as const,
          viewSelectionMode: 'none',
          selectedIPAgentIndex: -1,
        }))
      } else {
        const selected = getSelectedTeammate()
        if (selected) {
          enterTeammateView(selected.taskId, setAppState)
        }
      }
      return
    }

    // k 终止已选中的 teammate（仅在选择模式下）
    if (e.key === 'k' && viewSelectionMode === 'selecting-agent' && selectedIPAgentIndex >= 0) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected && selected.task.status === 'running') {
        void InProcessTeammateTask.kill(selected.taskId, setAppState)
      }
      return
    }
  }

  // 向后兼容桥接：REPL.tsx 尚未将 handleKeyDown 传递给 <Box onKeyDown>。
  // 通过 useInput 订阅并适配 InputEvent → KeyboardEvent，
  // 直到消费者迁移完成（单独的 PR）。
  // TODO(onKeyDown-migration): 迁移完成后移除此段代码。
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
