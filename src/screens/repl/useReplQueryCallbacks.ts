/**
 * useReplQueryCallbacks -- query lifecycle callback construction extracted from REPL.tsx.
 *
 * Builds queryFlowCtx, getToolUseContext, onQueryEvent, onQueryImpl, onQuery, onSubmit,
 * handleBackgroundQuery, handleBackgroundSession.
 */

import { useCallback, useRef } from 'react'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { useSessionBackgrounding } from '../../hooks/useSessionBackgrounding.js'
import type { ActiveSpeculationState } from '../../services/prompt-suggestion/speculation.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message as MessageType } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../services/config/config.js'
import type { EffortLevel } from '../../utils/effort.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'

import {
  buildToolUseContext,
  handleQueryEvent,
  handleSubmit,
  type QueryFlowContext,
  runQuery,
  runQueryImpl,
  type SubmitFlowContext,
} from './replQueryFlow.js'
import type { ActiveRemote } from './useReplActiveRemote.js'
import { useReplBackgroundQuery } from './useReplBackgroundQuery.js'

export type UseReplQueryCallbacksParams = {
  // 完整查询上下文，由 REPL 构建（消除曾经重复列举 49 字段的 param 面）
  queryFlowCtx: QueryFlowContext

  // Submit-only deps（onSubmit 内组装 SubmitFlowContext 用）
  isLoading: boolean
  isExternalLoading: boolean
  inputMode: PromptInputMode
  pastedContents: Record<number, PastedContent>
  ideSelection: IDESelection | undefined
  stashedPrompt:
    | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
    | undefined
  abortController: AbortController | null
  activeRemote: ActiveRemote

  setInputValue: (v: string) => void
  setInputMode: (v: PromptInputMode) => void
  setPastedContents: (v: Record<number, PastedContent>) => void
  setIDESelection: (v: IDESelection | undefined) => void
  setStashedPrompt: (
    v:
      | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
      | undefined,
  ) => void
  repinScroll: () => void
  awaitPendingHooks: () => Promise<void>
  resetTipPickedThisTurn: () => void

  // Background query deps（不在 queryFlowCtx 中的部分）
  terminalTitle: string
  mainThreadAgentDefinition: AgentDefinition | undefined
  setIsExternalLoading: (v: boolean) => void
}

export function useReplQueryCallbacks(params: UseReplQueryCallbacksParams) {
  const {
    queryFlowCtx,
    isLoading,
    isExternalLoading,
    inputMode,
    pastedContents,
    ideSelection,
    stashedPrompt,
    abortController,
    activeRemote,
    setInputValue,
    setInputMode,
    setPastedContents,
    setIDESelection,
    setStashedPrompt,
    repinScroll,
    awaitPendingHooks,
    resetTipPickedThisTurn,
    terminalTitle,
    mainThreadAgentDefinition,
    setIsExternalLoading,
  } = params

  // latest-ref：每次 render 同步最新 ctx，查询回调读 ctxRef.current 即可保持稳定身份
  // 且永不读到旧闭包。queryFlowCtx 每 render 都是新对象，直接进回调 dep 会让回调每 render
  // 重建（及其消费方的 useMemo 连锁重算），故走 ref。
  const ctxRef = useRef(queryFlowCtx)
  ctxRef.current = queryFlowCtx

  const getToolUseContext = useCallback(
    (
      messages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      mainLoopModel: string,
    ): ProcessUserInputContext =>
      buildToolUseContext(ctxRef.current, messages, newMessages, abortController, mainLoopModel),
    [],
  )

  const handleBackgroundQuery = useReplBackgroundQuery({
    abortController,
    mainLoopModel: queryFlowCtx.mainLoopModel,
    toolPermissionContext: queryFlowCtx.toolPermissionContext,
    mainThreadAgentDefinition,
    getToolUseContext,
    customSystemPrompt: queryFlowCtx.customSystemPrompt,
    appendSystemPrompt: queryFlowCtx.appendSystemPrompt,
    canUseTool: queryFlowCtx.canUseTool,
    setAppState: queryFlowCtx.setAppState,
    terminalTitle,
    replStore: queryFlowCtx.replStore,
  })

  const { handleBackgroundSession } = useSessionBackgrounding({
    setMessages: queryFlowCtx.replStore.setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState: queryFlowCtx.resetLoadingState,
    setAbortController: queryFlowCtx.setAbortController,
    onBackgroundQuery: handleBackgroundQuery,
  })

  const onQueryEvent = useCallback(
    (
      event: Parameters<
        typeof import('../../services/messages/streaming.js').handleMessageFromStream
      >[0],
    ) => handleQueryEvent(ctxRef.current, event),
    [],
  )

  const onQueryImpl = useCallback(
    (
      messagesIncludingNewMessages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      effort?: EffortLevel,
    ) =>
      runQueryImpl(
        ctxRef.current,
        getToolUseContext,
        messagesIncludingNewMessages,
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModelParam,
        effort,
      ),
    [getToolUseContext],
  )

  const onQuery = useCallback(
    (
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
      input?: string,
      effort?: EffortLevel,
    ): Promise<void> =>
      runQuery(
        ctxRef.current,
        getToolUseContext,
        onQueryImpl,
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModelParam,
        onBeforeQueryCallback,
        input,
        effort,
      ),
    [getToolUseContext, onQueryImpl],
  )

  const onSubmit = useCallback(
    async (
      input: string,
      helpers: PromptInputHelpers,
      speculationAccept?: {
        state: ActiveSpeculationState
        speculationSessionTimeSavedMs: number
        setAppState: SetAppState
      },
      options?: {
        fromKeybinding?: boolean
      },
    ) => {
      const submitCtx: SubmitFlowContext = {
        ...ctxRef.current,
        isLoading,
        isExternalLoading,
        inputMode,
        pastedContents,
        ideSelection,
        stashedPrompt,
        abortController,
        activeRemote,
        setInputValue,
        setInputMode,
        setPastedContents,
        setIDESelection,
        setStashedPrompt,
        repinScroll,
        awaitPendingHooks,
        resetTipPickedThisTurn,
      }
      return handleSubmit(
        submitCtx,
        onQuery,
        getToolUseContext,
        input,
        helpers,
        speculationAccept,
        options,
      )
    },
    // queryFlowCtx 部分经 ctxRef.current 读取（latest-ref），无需进 dep；
    // 仅列 onSubmit 直接闭包的 submit-only 反应式依赖。
    [
      isLoading,
      isExternalLoading,
      inputMode,
      setInputValue,
      pastedContents,
      ideSelection,
      onQuery,
      stashedPrompt,
      awaitPendingHooks,
      repinScroll,
      activeRemote.isRemoteMode,
      activeRemote.sendMessage,
      abortController,
      getToolUseContext,
      setInputMode,
      activeRemote,
      setStashedPrompt,
      setPastedContents,
      setIDESelection,
      resetTipPickedThisTurn,
    ],
  )

  return {
    getToolUseContext,
    handleBackgroundSession,
    onQueryEvent,
    onQueryImpl,
    onQuery,
    onSubmit,
  }
}
