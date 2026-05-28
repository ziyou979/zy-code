// 3 个火忘 system message effects：
// 1. swarm teammate 全部完成时插入延迟 turn-duration 消息
// 2. 首次进入 auto mode（YOLO）时显示安全警告（跨会话最多 3 次，防抖 800ms）
// 3. worktree 创建慢且未配 sparse-checkout 时提示
//
// 抽自 screens/REPL.tsx 1357-1450。
//
// hasRunningTeammates 在 hook 内计算（useMemo over tasks）并 return，
// 因为 REPL 其它路径（showSpinner / JSX 条件）也需要它。
// swarmStartTimeRef / swarmBudgetInfoRef 由 hook 创建并 return，onQuery
// 体内写入。

import { useEffect, useMemo, useRef } from 'react'
import { feature } from 'bun:bundle'
import type React from 'react'
import { AUTO_MODE_DESCRIPTION } from '../../components/AutoModeOptInDialog.js'
import { getAllInProcessTeammateTasks } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { useAppState } from '../../state/AppState.js'
import type { Message as MessageType } from '../../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { createTurnDurationMessage, createSystemMessage } from '../../utils/messages.js'
import { count } from '../../utils/array.js'
import { isLoggableMessage } from '../../utils/sessionStorage.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

export type ReplSystemHints = {
  hasRunningTeammates: boolean
  /** onQuery 体内设置 swarm 回合起始时间 */
  swarmStartTimeRef: React.RefObject<number | null>
  /** onQuery 体内记录 swarm 预算信息 */
  swarmBudgetInfoRef: React.RefObject<
    | {
        tokens: number
        limit: number
        nudges: number
      }
    | undefined
  >
}

export function useReplSystemHints(
  setMessages: (action: React.SetStateAction<MessageType[]>) => void,
): ReplSystemHints {
  const tasks = useAppState((s) => s.tasks)
  const toolPermissionMode = useAppState((s) => s.toolPermissionContext.mode)

  const hasRunningTeammates = useMemo(
    () => getAllInProcessTeammateTasks(tasks).some((t) => t.status === 'running'),
    [tasks],
  )

  // -- swarm 延迟 turn-duration 消息
  const swarmStartTimeRef = useRef<number | null>(null)
  const swarmBudgetInfoRef = useRef<
    | {
        tokens: number
        limit: number
        nudges: number
      }
    | undefined
  >(undefined)

  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current
      const deferredBudget = swarmBudgetInfoRef.current
      swarmStartTimeRef.current = null
      swarmBudgetInfoRef.current = undefined
      setMessages((prev) => [
        ...prev,
        createTurnDurationMessage(totalMs, deferredBudget, count(prev, isLoggableMessage)),
      ])
    }
  }, [hasRunningTeammates, setMessages])

  // -- auto mode 安全警告（跨会话最多 3 次，防抖 800ms）
  const safeYoloMessageShownRef = useRef(false)
  useEffect(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (toolPermissionMode !== 'auto') {
        safeYoloMessageShownRef.current = false
        return
      }
      if (safeYoloMessageShownRef.current) {
        return
      }
      const config = getGlobalConfig()
      const cnt = config.autoPermissionsNotificationCount ?? 0
      if (cnt >= 3) {
        return
      }
      const timer = setTimeout(
        (ref: React.RefObject<boolean>, setMsgs: typeof setMessages) => {
          ;(ref as React.MutableRefObject<boolean>).current = true
          saveGlobalConfig((prev) => {
            const prevCount = prev.autoPermissionsNotificationCount ?? 0
            if (prevCount >= 3) {
              return prev
            }
            return { ...prev, autoPermissionsNotificationCount: prevCount + 1 }
          })
          setMsgs((prev) => [...prev, createSystemMessage(AUTO_MODE_DESCRIPTION, 'warn')])
        },
        800,
        safeYoloMessageShownRef,
        setMessages,
      )
      return () => clearTimeout(timer)
    }
  }, [toolPermissionMode, setMessages])

  // -- worktree 创建慢时的 sparse-checkout 提示
  const worktreeTipShownRef = useRef(false)
  useEffect(() => {
    if (worktreeTipShownRef.current) {
      return
    }
    const wt = getCurrentWorktreeSession()
    if (!wt?.creationDurationMs || wt.usedSparsePaths) {
      return
    }
    if (wt.creationDurationMs < 15_000) {
      return
    }
    worktreeTipShownRef.current = true
    const secs = Math.round(wt.creationDurationMs / 1000)
    setMessages((prev) => [
      ...prev,
      createSystemMessage(
        `Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .zy/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`,
        'info',
      ),
    ])
  }, [setMessages])

  return { hasRunningTeammates, swarmStartTimeRef, swarmBudgetInfoRef }
}
