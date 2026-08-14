import type * as React from 'react'
import { useCallback, useEffect } from 'react'
import { useAppStateStore, useSetAppState } from 'src/state/AppState.js'
import type { Theme } from '../services/environment/theme.js'

type Priority = 'low' | 'medium' | 'high' | 'immediate'
type BaseNotification = {
  key: string
  /**
   * 此通知会使哪些 key 对应的通知失效。
   * 失效的通知会从队列移除；若正在显示，则立即清除。
   */
  invalidates?: string[]
  priority: Priority
  timeoutMs?: number
  /**
   * 像 Array.reduce() 一样合并具有相同 key 的通知。
   * 队列中已有相同 key 的通知或该通知正在显示时，以 fold(accumulator, incoming) 调用。
   * 返回合并后的通知；返回值应继续携带 fold，以便后续合并。
   */
  fold?: (accumulator: Notification, incoming: Notification) => Notification
}
type TextNotification = BaseNotification & {
  text: string
  color?: keyof Theme
}
type JSXNotification = BaseNotification & {
  jsx: React.ReactNode
}
type AddNotificationFn = (content: Notification) => void
type RemoveNotificationFn = (key: string) => void
export type Notification = TextNotification | JSXNotification
const DEFAULT_TIMEOUT_MS = 8000

// 跟踪当前 timeout，以便即时通知到达时将其清除。
let currentTimeoutId: NodeJS.Timeout | null = null
export function useNotifications(): {
  addNotification: AddNotificationFn
  removeNotification: RemoveNotificationFn
} {
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  // 当前通知结束或队列变化时处理队列。
  const processQueue = useCallback(() => {
    setAppState((prev) => {
      const next = getNext(prev.notifications.queue)
      if (prev.notifications.current !== null || !next) {
        return prev
      }
      currentTimeoutId = setTimeout(
        (setAppState, nextKey, processQueue) => {
          currentTimeoutId = null
          setAppState((prev) => {
            // 按 key 而非引用比较，以支持重新创建的通知。
            if (prev.notifications.current?.key !== nextKey) {
              return prev
            }
            return {
              ...prev,
              notifications: {
                queue: prev.notifications.queue,
                current: null,
              },
            }
          })
          processQueue()
        },
        next.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        setAppState,
        next.key,
        processQueue,
      )
      return {
        ...prev,
        notifications: {
          queue: prev.notifications.queue.filter((_) => _ !== next),
          current: next,
        },
      }
    })
  }, [setAppState])
  const addNotification = useCallback<AddNotificationFn>(
    (notif: Notification) => {
      // 处理即时优先级通知。
      if (notif.priority === 'immediate') {
        // 即将显示新的即时通知，因此清除已有 timeout。
        if (currentTimeoutId) {
          clearTimeout(currentTimeoutId)
          currentTimeoutId = null
        }

        // 为即时通知设置 timeout。
        currentTimeoutId = setTimeout(
          (setAppState, notif, processQueue) => {
            currentTimeoutId = null
            setAppState((prev) => {
              // 按 key 而非引用比较，以支持重新创建的通知。
              if (prev.notifications.current?.key !== notif.key) {
                return prev
              }
              return {
                ...prev,
                notifications: {
                  queue: prev.notifications.queue.filter(
                    (_) => !notif.invalidates?.includes(_.key),
                  ),
                  current: null,
                },
              }
            })
            processQueue()
          },
          notif.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          setAppState,
          notif,
          processQueue,
        )

        // 立即显示即时通知。
        setAppState((prev) => ({
          ...prev,
          notifications: {
            current: notif,
            queue:
              // 当前通知不是即时通知时才重新入队。
              [
                ...(prev.notifications.current ? [prev.notifications.current] : []),
                ...prev.notifications.queue,
              ].filter((_) => _.priority !== 'immediate' && !notif.invalidates?.includes(_.key)),
          },
        }))
        return // IMPORTANT: Exit addNotification for immediate notifications
      }

      // 处理非即时通知。
      setAppState((prev) => {
        // 检查能否折叠到具有相同 key 的已有通知。
        if (notif.fold) {
          // key 匹配时折叠到当前通知。
          if (prev.notifications.current?.key === notif.key) {
            const folded = notif.fold(prev.notifications.current, notif)
            // 重置折叠后通知的 timeout。
            if (currentTimeoutId) {
              clearTimeout(currentTimeoutId)
              currentTimeoutId = null
            }
            currentTimeoutId = setTimeout(
              (setAppState, foldedKey, processQueue) => {
                currentTimeoutId = null
                setAppState((p) => {
                  if (p.notifications.current?.key !== foldedKey) {
                    return p
                  }
                  return {
                    ...p,
                    notifications: {
                      queue: p.notifications.queue,
                      current: null,
                    },
                  }
                })
                processQueue()
              },
              folded.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              setAppState,
              folded.key,
              processQueue,
            )
            return {
              ...prev,
              notifications: {
                current: folded,
                queue: prev.notifications.queue,
              },
            }
          }

          // key 匹配时折叠到队列中的通知。
          const queueIdx = prev.notifications.queue.findIndex((_) => _.key === notif.key)
          if (queueIdx !== -1) {
            const folded = notif.fold(prev.notifications.queue[queueIdx]!, notif)
            const newQueue = [...prev.notifications.queue]
            newQueue[queueIdx] = folded
            return {
              ...prev,
              notifications: {
                current: prev.notifications.current,
                queue: newQueue,
              },
            }
          }
        }

        // 不存在时才加入队列，防止重复。
        const queuedKeys = new Set(prev.notifications.queue.map((_) => _.key))
        const shouldAdd =
          !queuedKeys.has(notif.key) && prev.notifications.current?.key !== notif.key
        if (!shouldAdd) {
          return prev
        }
        const invalidatesCurrent =
          prev.notifications.current !== null &&
          notif.invalidates?.includes(prev.notifications.current.key)
        if (invalidatesCurrent && currentTimeoutId) {
          clearTimeout(currentTimeoutId)
          currentTimeoutId = null
        }
        return {
          ...prev,
          notifications: {
            current: invalidatesCurrent ? null : prev.notifications.current,
            queue: [
              ...prev.notifications.queue.filter(
                (_) => _.priority !== 'immediate' && !notif.invalidates?.includes(_.key),
              ),
              notif,
            ],
          },
        }
      })

      // 加入通知后处理队列。
      processQueue()
    },
    [setAppState, processQueue],
  )
  const removeNotification = useCallback<RemoveNotificationFn>(
    (key: string) => {
      setAppState((prev) => {
        const isCurrent = prev.notifications.current?.key === key
        const inQueue = prev.notifications.queue.some((n) => n.key === key)
        if (!isCurrent && !inQueue) {
          return prev
        }
        if (isCurrent && currentTimeoutId) {
          clearTimeout(currentTimeoutId)
          currentTimeoutId = null
        }
        return {
          ...prev,
          notifications: {
            current: isCurrent ? null : prev.notifications.current,
            queue: prev.notifications.queue.filter((n) => n.key !== key),
          },
        }
      })
      processQueue()
    },
    [setAppState, processQueue],
  )

  // 挂载时若初始状态中有通知，则处理队列。这里使用命令式读取而非 useAppState；
  // 只在挂载时运行的 effect 若建立订阅会变成无用负担，并使所有调用方在队列变化时重渲染。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect, store is a stable context ref
  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) {
      processQueue()
    }
  }, [])
  return {
    addNotification,
    removeNotification,
  }
}
const PRIORITIES: Record<Priority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
}
export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) {
    return undefined
  }
  return queue.reduce((min, n) => (PRIORITIES[n.priority] < PRIORITIES[min.priority] ? n : min))
}
