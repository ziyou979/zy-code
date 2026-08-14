/**
 * 管理会话后台化的 hook（Ctrl+B 在后台/前台会话间切换）。
 *
 * 负责：
 * - 调用 onBackgroundQuery，为当前 query 创建后台任务
 * - 将已置前台的任务重新放回后台
 * - 将前台任务的消息和状态同步到主视图
 */

import { useCallback, useEffect, useRef } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'

type UseSessionBackgroundingProps = {
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void
  setIsLoading: (loading: boolean) => void
  resetLoadingState: () => void
  setAbortController: (controller: AbortController | null) => void
  onBackgroundQuery: () => void
}

type UseSessionBackgroundingResult = {
  /** 用户希望切至后台（Ctrl+B）时调用。 */
  handleBackgroundSession: () => void
}

export function useSessionBackgrounding({
  setMessages,
  setIsLoading,
  resetLoadingState,
  setAbortController,
  onBackgroundQuery,
}: UseSessionBackgroundingProps): UseSessionBackgroundingResult {
  const foregroundedTaskId = useAppState((s) => s.foregroundedTaskId)
  const foregroundedTask = useAppState((s) =>
    s.foregroundedTaskId ? s.tasks[s.foregroundedTaskId] : undefined,
  )
  const setAppState = useSetAppState()
  const lastSyncedMessagesLengthRef = useRef<number>(0)

  const handleBackgroundSession = useCallback(() => {
    if (foregroundedTaskId) {
      // 将前台任务重新放回后台
      setAppState((prev) => {
        const taskId = prev.foregroundedTaskId
        if (!taskId) {
          return prev
        }
        const task = prev.tasks[taskId]
        if (!task) {
          return { ...prev, foregroundedTaskId: undefined }
        }
        return {
          ...prev,
          foregroundedTaskId: undefined,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...task, isBackgrounded: true },
          },
        }
      })
      setMessages([])
      resetLoadingState()
      setAbortController(null)
      return
    }

    onBackgroundQuery()
  }, [
    foregroundedTaskId,
    setAppState,
    setMessages,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery,
  ])

  // 将前台任务的消息和加载状态同步到主视图
  useEffect(() => {
    if (!foregroundedTaskId) {
      // 没有前台任务时重置
      lastSyncedMessagesLengthRef.current = 0
      return
    }

    if (!foregroundedTask || foregroundedTask.type !== 'local_agent') {
      setAppState((prev) => ({ ...prev, foregroundedTaskId: undefined }))
      resetLoadingState()
      lastSyncedMessagesLengthRef.current = 0
      return
    }

    // 将后台任务消息同步到主视图；仅在消息确实变化时更新，避免重复渲染
    const taskMessages = foregroundedTask.messages ?? []
    if (taskMessages.length !== lastSyncedMessagesLengthRef.current) {
      lastSyncedMessagesLengthRef.current = taskMessages.length
      setMessages([...taskMessages])
    }

    if (foregroundedTask.status === 'running') {
      // 检查任务是否已中止（用户按下 Escape）
      const taskAbortController = foregroundedTask.abortController
      if (taskAbortController?.signal.aborted) {
        // 任务已中止，立即清除前台状态
        setAppState((prev) => {
          if (!prev.foregroundedTaskId) {
            return prev
          }
          const task = prev.tasks[prev.foregroundedTaskId]
          if (!task) {
            return { ...prev, foregroundedTaskId: undefined }
          }
          return {
            ...prev,
            foregroundedTaskId: undefined,
            tasks: {
              ...prev.tasks,
              [prev.foregroundedTaskId]: { ...task, isBackgrounded: true },
            },
          }
        })
        resetLoadingState()
        setAbortController(null)
        lastSyncedMessagesLengthRef.current = 0
        return
      }

      setIsLoading(true)
      // 将 abort controller 设为前台任务的 controller，供 Escape 处理
      if (taskAbortController) {
        setAbortController(taskAbortController)
      }
    } else {
      // 任务完成后恢复到后台，并清除前台视图
      setAppState((prev) => {
        const taskId = prev.foregroundedTaskId
        if (!taskId) {
          return prev
        }
        const task = prev.tasks[taskId]
        if (!task) {
          return { ...prev, foregroundedTaskId: undefined }
        }
        return {
          ...prev,
          foregroundedTaskId: undefined,
          tasks: { ...prev.tasks, [taskId]: { ...task, isBackgrounded: true } },
        }
      })
      resetLoadingState()
      setAbortController(null)
      lastSyncedMessagesLengthRef.current = 0
    }
  }, [
    foregroundedTaskId,
    foregroundedTask,
    setAppState,
    setMessages,
    setIsLoading,
    resetLoadingState,
    setAbortController,
  ])

  return {
    handleBackgroundSession,
  }
}
