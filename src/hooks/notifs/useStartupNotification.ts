import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { type Notification, useNotifications } from '../../context/notifications.js'
import { logError } from '../../services/infra/log.js'

type Result = Notification | Notification[] | null

/**
 * 挂载时触发一次通知。封装 remote 模式门控和每会话一次的 ref guard，
 * 取代十多个 notifs hook 中各自实现的相同逻辑。
 *
 * compute 函数仅在首次 effect 中运行一次。返回 null 表示跳过，返回 Notification
 * 表示触发一条，返回数组表示触发多条；支持同步或异步。rejection 会交给 logError。
 */
export function useStartupNotification(compute: () => Result | Promise<Result>): void {
  const { addNotification } = useNotifications()
  const hasRunRef = useRef(false)
  const computeRef = useRef(compute)
  computeRef.current = compute

  useEffect(() => {
    if (getIsRemoteMode() || hasRunRef.current) {
      return
    }
    hasRunRef.current = true

    void Promise.resolve()
      .then(() => computeRef.current())
      .then((result) => {
        if (!result) {
          return
        }
        for (const n of Array.isArray(result) ? result : [result]) {
          addNotification(n)
        }
      })
      .catch(logError)
  }, [addNotification])
}
