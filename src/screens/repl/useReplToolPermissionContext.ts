// 工具权限上下文 setter + leader 注册 effect。
// 抽自 screens/REPL.tsx 2347-2389：
// - setToolPermissionContext useCallback：写入 AppState.toolPermissionContext，
//   可选 preserveMode（worker → coordinator 模式映射时使用），更新后异步 recheck 排队工具
// - useEffect：把 setter 注册到 leaderPermissionBridge，供进程内 teammate 读取
//
// 内部 useSetAppState；setToolUseConfirmQueue 作为入参（recheck 路径需要遍历当前队列）。

import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import {
  registerLeaderSetToolPermissionContext,
  unregisterLeaderSetToolPermissionContext,
} from '../../services/swarm/leaderPermissionBridge.js'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'

export type SetToolPermissionContext = (
  context: ToolPermissionContext,
  options?: { preserveMode?: boolean },
) => void

export function useReplToolPermissionContext(
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>,
): SetToolPermissionContext {
  const setAppState = useSetAppState()

  const setToolPermissionContext = useCallback<SetToolPermissionContext>(
    (context, options) => {
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: {
          ...context,
          // 仅在显式请求时保留 coordinator 的模式。
          // Worker 的 getAppState() 返回转换后的上下文，模式为
          // 'acceptEdits'，不能通过权限规则更新泄漏到 coordinator 的实际
          // state — 那些调用点传递
          // { preserveMode: true }。用户发起的模式更改（例如，
          // 选择"allow all edits"）不得被覆盖。
          mode: options?.preserveMode ? prev.toolPermissionContext.mode : context.mode,
        },
      }))

      // 权限上下文更改时，重新检查所有排队项
      // 这处理批准 item1 时使用"不再询问"
      // 应自动批准其他现在匹配更新规则的排队项
      setImmediate((setQueue) => {
        // 使用 setToolUseConfirmQueue 回调获取当前队列 state
        // 而不是在闭包中捕获，以避免过时闭包问题
        setQueue((currentQueue) => {
          currentQueue.forEach((item) => {
            void item.recheckPermission()
          })
          return currentQueue
        })
      }, setToolUseConfirmQueue)
    },
    [setAppState, setToolUseConfirmQueue],
  )

  // 为进程内 teammate 注册 leader 的 setToolPermissionContext
  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext)
    return () => unregisterLeaderSetToolPermissionContext()
  }, [setToolPermissionContext])

  return setToolPermissionContext
}
