/**
 * useReplEffects.ts — 从 REPL.tsx 提取的大型 effects 和 useMemo。
 *
 * - useStopHookSpinnerSuffix：从消息状态派生停止 hook spinner 后缀
 * - useIdleNotification：Zy 完成且用户空闲时通知
 * - useIdleReturnHint：超过空闲阈值时显示 /clear 提示
 */

import * as React from 'react'
import { useEffect, useMemo } from 'react'
import { getLastInteractionTime } from 'src/bootstrap/runtime/runtimeContext.js'
import { getTotalInputTokens } from 'src/bootstrap/runtime/runtimeContext.js'
import type { Notification } from '../../context/notifications.js'
import type { TerminalNotification } from '../../ink/useTerminalNotification.js'
import { Text } from '../../ink.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { sendNotification } from '../../services/notifier.js'
import type { ReplStoreInstance, ToolJSXState } from '../../state/replStore.js'
import type { HookProgress } from '../../types/hooks/index.js'
import type { Message as MessageType, ProgressMessage } from '../../types/message.js'
import { count } from '../../utils/array.js'
import { getGlobalConfig } from '../../services/config/config.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { formatTokens, truncateToWidth } from '../../utils/format.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'

// ── useStopHookSpinnerSuffix ──

export function useStopHookSpinnerSuffix(
  messages: MessageType[],
  isLoading: boolean,
): string | null {
  return useMemo(() => {
    if (!isLoading) {
      return null
    }

    // 查找停止 hook 进度消息
    const progressMsgs = messages.filter(
      (m): m is ProgressMessage<HookProgress> =>
        m.type === 'progress' &&
        m.data.type === 'hook_progress' &&
        (m.data.hookEvent === 'Stop' || m.data.hookEvent === 'SubagentStop'),
    )
    if (progressMsgs.length === 0) {
      return null
    }

    // 获取最近的停止 hook 执行
    const currentToolUseID = progressMsgs.at(-1)?.toolUseID
    if (!currentToolUseID) {
      return null
    }

    // 检查此执行是否已有摘要消息（hooks 已完成）
    const hasSummaryForCurrentExecution = messages.some(
      (m) =>
        m.type === 'system' &&
        m.subtype === 'stop_hook_summary' &&
        m.toolUseID === currentToolUseID,
    )
    if (hasSummaryForCurrentExecution) {
      return null
    }
    const currentHooks = progressMsgs.filter((p) => p.toolUseID === currentToolUseID)
    const total = currentHooks.length

    // 统计已完成的 hooks
    const completedCount = count(messages, (m) => {
      if (m.type !== 'attachment') {
        return false
      }
      const attachment = m.attachment
      return (
        'hookEvent' in attachment &&
        (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') &&
        'toolUseID' in attachment &&
        attachment.toolUseID === currentToolUseID
      )
    })

    // 检查是否有任何 hook 有自定义状态消息
    const customMessage = currentHooks.find((p) => p.data.statusMessage)?.data.statusMessage
    if (customMessage) {
      return total === 1 ? `${customMessage}…` : `${customMessage}… ${completedCount}/${total}`
    }

    // 回退到默认行为
    const hookType = currentHooks[0]?.data.hookEvent === 'SubagentStop' ? 'subagent stop' : 'stop'
    if (isInternalBuild()) {
      const cmd = currentHooks[completedCount]?.data.command
      const label = cmd ? ` '${truncateToWidth(cmd, 40)}'` : ''
      return total === 1
        ? `running ${hookType} hook${label}`
        : `running ${hookType} hook${label}… ${completedCount}/${total}`
    }
    return total === 1
      ? `running ${hookType} hook`
      : `running stop hooks… ${completedCount}/${total}`
  }, [messages, isLoading])
}

// ── useIdleNotification ──

export function useIdleNotification(params: {
  isLoading: boolean
  toolJSX: ToolJSXState | null
  submitCount: number
  lastQueryCompletionTime: number
  terminal: TerminalNotification
  focusedInputDialogRef: React.RefObject<FocusedInputDialog>
}): void {
  const {
    isLoading,
    toolJSX,
    submitCount,
    lastQueryCompletionTime,
    terminal,
    focusedInputDialogRef,
  } = params
  useEffect(() => {
    // Zy 忙时不显示通知
    if (isLoading) {
      return
    }

    // 仅在此会话中第一次新交互后启用通知
    if (submitCount === 0) {
      return
    }

    // 尚未有查询完成
    if (lastQueryCompletionTime === 0) {
      return
    }

    // 设置超时以检查空闲状态
    const timer = setTimeout(
      (lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal) => {
        // 检查用户在响应结束后是否已交互
        const lastUserInteraction = getLastInteractionTime()
        if (lastUserInteraction > lastQueryCompletionTime) {
          return
        }

        const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime
        if (
          !isLoading &&
          !toolJSX &&
          focusedInputDialogRef.current === undefined &&
          idleTimeSinceResponse >= getGlobalConfig().messageIdleNotifThresholdMs
        ) {
          void sendNotification(
            {
              message: 'Zy is waiting for your input',
              notificationType: 'idle_prompt',
            },
            terminal,
          )
        }
      },
      getGlobalConfig().messageIdleNotifThresholdMs,
      lastQueryCompletionTime,
      isLoading,
      toolJSX,
      focusedInputDialogRef,
      terminal,
    )
    return () => clearTimeout(timer)
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal, focusedInputDialogRef])
}

// ── useIdleReturnHint ──

export function useIdleReturnHint(params: {
  lastQueryCompletionTime: number
  isLoading: boolean
  addNotification: (n: Notification) => void
  removeNotification: (key: string) => void
  replStore: ReplStoreInstance
}): void {
  const { lastQueryCompletionTime, isLoading, addNotification, removeNotification, replStore } =
    params
  useEffect(() => {
    if (lastQueryCompletionTime === 0) {
      return
    }
    if (isLoading) {
      return
    }
    const willowMode: string = getFeatureValue_CACHED_MAY_BE_STALE('zy_willow_mode', 'off')
    if (willowMode !== 'hint' && willowMode !== 'hint_v2') {
      return
    }
    if (getGlobalConfig().idleReturnDismissed) {
      return
    }
    const tokenThreshold = Number(process.env.ZY_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000)
    if (getTotalInputTokens() < tokenThreshold) {
      return
    }
    const idleThresholdMs = Number(process.env.ZY_CODE_IDLE_THRESHOLD_MINUTES ?? 75) * 60_000
    const elapsed = Date.now() - lastQueryCompletionTime
    const remaining = idleThresholdMs - elapsed
    const timer = setTimeout(
      (lqct, addNotif, store, mode) => {
        const msgs = store.getState().messages
        if (msgs.length === 0) {
          return
        }
        const totalTokens = getTotalInputTokens()
        const formattedTokens = formatTokens(totalTokens)
        const idleMinutes = (Date.now() - lqct) / 60_000
        addNotif({
          key: 'idle-return-hint',
          jsx:
            mode === 'hint_v2'
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(Text, { dimColor: true }, 'new task? '),
                  React.createElement(Text, { color: 'suggestion' }, '/clear'),
                  React.createElement(Text, { dimColor: true }, ' to save '),
                  React.createElement(Text, { color: 'suggestion' }, formattedTokens, ' tokens'),
                )
              : React.createElement(
                  Text,
                  { color: 'warning' },
                  `new task? /clear to save ${formattedTokens} tokens`,
                ),
          priority: 'medium',
          timeoutMs: 0x7fffffff,
        })
        store.mutable.idleHintShown = mode
        logEvent('zy_idle_return_action', {
          action: 'hint_shown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          variant: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          idleMinutes: Math.round(idleMinutes),
          messageCount: msgs.length,
          totalInputTokens: totalTokens,
        })
      },
      Math.max(0, remaining),
      lastQueryCompletionTime,
      addNotification,
      replStore,
      willowMode,
    )
    return () => {
      clearTimeout(timer)
      removeNotification('idle-return-hint')
      replStore.mutable.idleHintShown = false
    }
  }, [
    lastQueryCompletionTime,
    isLoading,
    addNotification,
    removeNotification,
    replStore.mutable,
    replStore,
  ])
}
