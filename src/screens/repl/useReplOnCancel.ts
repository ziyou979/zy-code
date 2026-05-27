// onCancel 编排：用户按 Esc / 点击 Cancel 时的全局取消流。
// 抽自 screens/REPL.tsx 2024-2084。
//
// 行为分支（按顺序）：
// 1. focusedInputDialog === 'elicitation'：直接 return，elicitation 自管 Esc，
//    不影响 loading state。
// 2. PROACTIVE / KAIROS：暂停 proactive，下次 onSubmit 恢复。
// 3. queryGuard.forceEnd() + skipIdleCheckRef 复位。
// 4. streamingText 有内容则推入 messages，确保最终顺序为
//    [user, partial-assistant, [Request interrupted by user]]，必须发生在
//    resetLoadingState（清掉 streamingText）和 query.ts 的中断标记 yield 之前。
// 5. resetLoadingState() 重置 UI loading state。
// 6. TOKEN_BUDGET：snapshotOutputTokensForTurn(null) 清掉过时预算，避免
//    生成器尚未退出时 fallback 触发。
// 7. 路由：tool-permission → ToolUseConfirm 自管 abort + 清队；prompt →
//    reject 所有 prompt 并 abort；远程模式 → activeRemote.cancelRequest()；
//    其它 → abortController.abort('user-cancel')。
// 8. setAbortController(null) 清掉过时信号，否则 canCancelRunningTask
//    保持 false（信号 .aborted=true）使 Esc 键绑定无法激活。
// 9. forceEnd() 跳过 finally 路径，所以显式触发 mrOnTurnComplete(aborted=true)。
//
// 函数无 useCallback —— 与 REPL.tsx 内的原始定义一致；hook 每次渲染重建
// 闭包以读取最新值。

import { feature } from 'bun:bundle'
import type React from 'react'
import { proactiveModule } from '../../cli/lazyModules.js'
import { snapshotOutputTokensForTurn } from '../../bootstrap/state.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type { Message as MessageType } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createAssistantMessage } from '../../utils/messages.js'
import type { QueryGuard } from '../../utils/QueryGuard.js'
import type { ActiveRemote } from './useReplActiveRemote.js'
import type { PromptQueueItem } from './useReplRequestPrompt.js'

export type FocusedInputDialog =
  | 'message-selector'
  | 'sandbox-permission'
  | 'tool-permission'
  | 'prompt'
  | 'worker-sandbox-permission'
  | 'elicitation'
  | 'cost'
  | 'idle-return'
  | 'init-onboarding'
  | 'ide-onboarding'
  | 'effort-callout'
  | 'remote-callout'
  | 'lsp-recommendation'
  | 'plugin-hint'
  | 'desktop-upsell'
  | 'ultraplan-choice'
  | 'ultraplan-launch'
  | undefined

export type UseReplOnCancelParams = {
  focusedInputDialog: FocusedInputDialog
  streamMode: SpinnerMode
  queryGuard: QueryGuard
  skipIdleCheckRef: React.RefObject<boolean>
  streamingText: string | null
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  resetLoadingState: () => void
  toolUseConfirmQueue: ToolUseConfirm[]
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  promptQueue: PromptQueueItem[]
  setPromptQueue: React.Dispatch<React.SetStateAction<PromptQueueItem[]>>
  abortController: AbortController | null
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  activeRemote: ActiveRemote
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => void | Promise<void>
  messagesRef: React.RefObject<MessageType[]>
}

export function useReplOnCancel(params: UseReplOnCancelParams): () => void {
  const {
    focusedInputDialog,
    streamMode,
    queryGuard,
    skipIdleCheckRef,
    streamingText,
    setMessages,
    resetLoadingState,
    toolUseConfirmQueue,
    setToolUseConfirmQueue,
    promptQueue,
    setPromptQueue,
    abortController,
    setAbortController,
    activeRemote,
    mrOnTurnComplete,
    messagesRef,
  } = params

  return function onCancel() {
    if (focusedInputDialog === 'elicitation') {
      return
    }
    logForDebugging(`[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`)

    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive()
    }
    queryGuard.forceEnd()
    skipIdleCheckRef.current = false

    // 在 resetLoadingState 清 streamingText 前推入，确保 yield 中断标记前到达
    if (streamingText?.trim()) {
      setMessages((prev) => [...prev, createAssistantMessage({ content: streamingText })])
    }
    resetLoadingState()

    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null)
    }

    if (focusedInputDialog === 'tool-permission') {
      toolUseConfirmQueue[0]?.onAbort()
      setToolUseConfirmQueue([])
    } else if (focusedInputDialog === 'prompt') {
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'))
      }
      setPromptQueue([])
      abortController?.abort('user-cancel')
    } else if (activeRemote.isRemoteMode) {
      activeRemote.cancelRequest()
    } else {
      abortController?.abort('user-cancel')
    }

    setAbortController(null)

    // forceEnd() 跳过 finally — 显式触发回合结束（aborted=true）
    void mrOnTurnComplete(messagesRef.current, true)
  }
}
