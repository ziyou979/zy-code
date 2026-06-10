// onCancel 编排 + abortController 状态 + 排队命令恢复。
//
// 合并原 3 个 hook：
// - useReplAbortController：AbortController state + 镜像 ref
// - useReplOnCancel：Esc / Cancel 全局取消流
// - useReplQueuedCommandRestore：取消权限请求时把排队命令恢复到输入框
//
// abortController / setAbortController / abortControllerRef 由本模块创建并
// 在返回值暴露（onQuery / handlePromptSubmit / cancelRequestProps 等多处需要）。
// handleQueuedCommandOnCancel 作为 cancelRequestProps.popCommandFromQueue 暴露。

import { feature } from 'bun:bundle'
import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { snapshotOutputTokensForTurn } from '../../bootstrap/state.js'
import { proactiveModule } from '../../cli/lazyModules.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type { ReplStoreInstance } from '../../state/ReplStore.js'
import type { Message as MessageType } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { popAllEditable } from '../../utils/messageQueueManager.js'
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
  | 'fullscreen-upsell'
  | 'desktop-upsell'
  | 'ultraplan-choice'
  | 'ultraplan-launch'
  | undefined

export type UseReplOnCancelParams = {
  focusedInputDialog: FocusedInputDialog
  streamMode: SpinnerMode
  queryGuard: QueryGuard
  streamingText: string | null
  replStore: ReplStoreInstance
  resetLoadingState: () => void
  toolUseConfirmQueue: ToolUseConfirm[]
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  promptQueue: PromptQueueItem[]
  setPromptQueue: React.Dispatch<React.SetStateAction<PromptQueueItem[]>>
  activeRemote: ActiveRemote
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => void | Promise<void>
  // 排队命令恢复依赖
  inputValue: string
  setInputValue: (value: string) => void
  setInputMode: React.Dispatch<React.SetStateAction<PromptInputMode>>
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>
}

export type ReplOnCancelApi = {
  onCancel: () => void
  handleQueuedCommandOnCancel: () => void
  abortController: AbortController | null
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  abortControllerRef: React.RefObject<AbortController | null>
}

export function useReplOnCancel(params: UseReplOnCancelParams): ReplOnCancelApi {
  // ── abort controller state + ref 镜像 ──
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  abortControllerRef.current = abortController

  // ── 排队命令恢复（cancelRequestProps.popCommandFromQueue）──
  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(params.inputValue, 0)
    if (!result) {
      return
    }
    params.setInputValue(result.text)
    params.setInputMode('prompt')
    if (result.images.length > 0) {
      params.setPastedContents((prev) => {
        const newContents = { ...prev }
        for (const image of result.images) {
          newContents[image.id] = image
        }
        return newContents
      })
    }
  }, [params.inputValue, params.setInputValue, params.setInputMode, params.setPastedContents])

  // ── onCancel 主流程（无 useCallback，每次渲染重建闭包读取最新值）──
  function onCancel() {
    if (params.focusedInputDialog === 'elicitation') {
      return
    }
    logForDebugging(
      `[onCancel] focusedInputDialog=${params.focusedInputDialog} streamMode=${params.streamMode}`,
    )

    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive()
    }
    params.queryGuard.forceEnd()
    params.replStore.mutable.skipIdleCheck = false

    if (params.streamingText?.trim()) {
      params.replStore.setMessages((prev) => [
        ...prev,
        createAssistantMessage({ content: params.streamingText! }),
      ])
    }
    params.resetLoadingState()

    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null)
    }

    if (params.focusedInputDialog === 'tool-permission') {
      params.toolUseConfirmQueue[0]?.onAbort()
      params.setToolUseConfirmQueue([])
    } else if (params.focusedInputDialog === 'prompt') {
      for (const item of params.promptQueue) {
        item.reject(new Error('Prompt cancelled by user'))
      }
      params.setPromptQueue([])
      abortController?.abort('user-cancel')
    } else if (params.activeRemote.isRemoteMode) {
      params.activeRemote.cancelRequest()
    } else {
      abortController?.abort('user-cancel')
    }

    setAbortController(null)
    void params.mrOnTurnComplete(params.replStore.getState().messages, true)
  }

  return {
    onCancel,
    handleQueuedCommandOnCancel,
    abortController,
    setAbortController,
    abortControllerRef,
  }
}
