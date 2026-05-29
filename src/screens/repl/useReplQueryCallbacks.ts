/**
 * useReplQueryCallbacks -- query lifecycle callback construction extracted from REPL.tsx.
 *
 * Builds queryFlowCtx, getToolUseContext, onQueryEvent, onQueryImpl, onQuery, onSubmit,
 * handleBackgroundQuery, handleBackgroundSession.
 */

import { useCallback } from 'react'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message as MessageType } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ProcessUserInputContext } from '../../services/processUserInput/processUserInput.js'
import type { EffortValue } from '../../utils/effort.js'
import type { PastedContent } from '../../utils/config.js'
import type { ActiveSpeculationState } from '../../services/PromptSuggestion/speculation.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { ActiveRemote } from './useReplActiveRemote.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'

import {
  buildToolUseContext,
  handleQueryEvent,
  runQueryImpl,
  runQuery,
  handleSubmit,
  type QueryFlowContext,
  type SubmitFlowContext,
} from './replQueryFlow.js'
import { useReplBackgroundQuery } from './useReplBackgroundQuery.js'
import { useSessionBackgrounding } from '../../hooks/useSessionBackgrounding.js'

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

  const getToolUseContext = useCallback(
    (
      messages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      mainLoopModel: string,
    ): ProcessUserInputContext =>
      buildToolUseContext(queryFlowCtx, messages, newMessages, abortController, mainLoopModel),
    [queryFlowCtx],
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
    (event: Parameters<typeof import('../../utils/messages.js').handleMessageFromStream>[0]) =>
      handleQueryEvent(queryFlowCtx, event),
    [queryFlowCtx],
  )

  const onQueryImpl = useCallback(
    (
      messagesIncludingNewMessages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      effort?: EffortValue,
    ) =>
      runQueryImpl(
        queryFlowCtx,
        getToolUseContext,
        messagesIncludingNewMessages,
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModelParam,
        effort,
      ),
    [queryFlowCtx, getToolUseContext],
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
      effort?: EffortValue,
    ): Promise<void> =>
      runQuery(
        queryFlowCtx,
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
    [queryFlowCtx, getToolUseContext, onQueryImpl],
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
        ...queryFlowCtx,
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
    // commands / mainLoopModel / onBeforeQuery / replStore 已并入 queryFlowCtx，
    // 其变化会改变 queryFlowCtx 引用，故无需单列。
    [
      queryFlowCtx,
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
