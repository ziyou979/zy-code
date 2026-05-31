/**
 * ReplMainView -- main prompt-screen render, extracted from REPL.tsx.
 *
 * Renders inside <ReplStoreProvider>; reads store state via useReplState().
 * Only truly local values (callbacks, refs, flags) are props.
 */

import { feature } from 'bun:bundle'
import { Box } from '../../ink.js'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Tool } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { Message as MessageType, UserMessage } from '../../types/message.js'
import type { ToolJSXState, ReplStoreInstance } from '../../state/ReplStore.js'
import type { StreamingToolUse, StreamingThinking } from '../../utils/messages.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { Screen } from '../REPL.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'
import type { ReplVoiceState } from './useReplVoice.js'
import type {
  ReplFrustrationDetection,
  ReplNotificationsCluster,
} from './useReplNotificationsCluster.js'
import type { Notification } from '../../context/notifications.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { IDEExtensionInstallationStatus } from '../../utils/ide.js'
import type { ActiveSpeculationState } from '../../services/PromptSuggestion/speculation.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { ProcessUserInputContext } from '../../services/processUserInput/processUserInput.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type { VimMode } from '../../types/textInputTypes.js'
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'
import type {
  MessageActionsState,
  MessageActionsNav,
  MessageActionCaps,
} from '../../components/messageActions.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import type { Theme } from '../../utils/theme.js'

import { useAppState, useSetAppState } from '../../state/AppState.js'
import { useReplState } from '../../state/ReplState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { getCommandQueueLength } from '../../utils/messageQueueManager.js'
import { errorMessage } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { createAbortController } from '../../utils/abortController.js'
import {
  shouldAutoRunIssue,
  getAutoRunIssueReasonText,
  getAutoRunCommand,
  AutoRunIssueNotification,
  type AutoRunIssueReason,
} from '../../utils/autoRunIssue.js'
import { computeUnseenDivider } from '../../components/FullscreenLayout.js'
import { handleSummarize as handleSummarizeAction } from './handleSummarize.js'
import { buildMessageActionCaps } from './replCallbacks.js'
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js'

import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AnimatedTerminalTitle } from '../../components/AnimatedTerminalTitle.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import { ScrollKeybindingHandler } from '../../components/ScrollKeybindingHandler.js'
import { FullscreenLayout } from '../../components/FullscreenLayout.js'
import { PermissionRequest } from '../../components/permissions/PermissionRequest.js'
import PromptInput from '../../components/PromptInput/PromptInput.js'
import { PromptInputQueuedCommands } from '../../components/PromptInput/PromptInputQueuedCommands.js'
import { Messages } from '../../components/Messages.js'
import { SpinnerWithVerb, BriefIdleStatus } from '../../components/Spinner.js'
import { TaskListV2 } from '../../components/TaskListV2.js'
import { TeammateViewHeader } from '../../components/TeammateViewHeader.js'
import { ReplDialogDispatch } from './ReplDialogDispatch.js'
import { ReplVoiceKeybindingHandler } from './useReplVoice.js'
import { MessageSelector } from '../../components/MessageSelector.js'
import {
  useMessageActions,
  MessageActionsKeybindings,
  MessageActionsBar,
} from '../../components/messageActions.js'
import { SkillImprovementSurvey } from '../../components/SkillImprovementSurvey.js'
import { useSkillImprovementSurvey } from '../../hooks/useSkillImprovementSurvey.js'
import { useFeedbackSurvey } from '../../components/FeedbackSurvey/useFeedbackSurvey.js'
import type { FeedbackSurveyResponse } from '../../components/FeedbackSurvey/utils.js'
import { useMemorySurvey } from '../../components/FeedbackSurvey/useMemorySurvey.js'
import { usePostCompactSurvey } from '../../components/FeedbackSurvey/usePostCompactSurvey.js'
import { FeedbackSurvey } from '../../components/FeedbackSurvey/FeedbackSurvey.js'
import { useTasksV2WithCollapseEffect } from '../../hooks/useTasksV2.js'
import { useIssueFlagBanner } from '../../hooks/useIssueFlagBanner.js'
import { IssueFlagBanner } from '../../components/PromptInput/IssueFlagBanner.js'
import { ExitFlow } from '../../components/ExitFlow.js'
import { SessionBackgroundHint } from '../../components/SessionBackgroundHint.js'
import { UserTextMessage } from '../../components/messages/UserTextMessage.js'
import { AwsAuthStatusBox } from '../../components/AwsAuthStatusBox.js'
import { DevBar } from '../../components/DevBar.js'
import { fileHistoryRewind } from '../../utils/fileHistory.js'
import { getAllInProcessTeammateTasks } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { onAgentSubmitImpl, handleExitImpl } from './replCallbacks.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { toUUID } from '../../types/ids.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useNotifications } from '../../context/notifications.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const WebBrowserPanelModule = feature('WEB_BROWSER_TOOL')
  ? (require('../../tools/WebBrowserTool/WebBrowserPanel.js') as typeof import('../../tools/WebBrowserTool/WebBrowserPanel.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// ────────────────────────────────────────────────────────
//  Props
// ────────────────────────────────────────────────────────

export interface ReplMainViewProps {
  replStore: ReplStoreInstance
  // Screen state
  screen: Screen
  setScreen: (s: Screen) => void
  showAllInTranscript: boolean
  setShowAllInTranscript: (v: boolean) => void
  // Keybinding flags
  titleIsAnimating: boolean
  terminalTitle: string
  titleDisabled: boolean
  showStatusInTerminalTab: boolean
  disableMessageActions: boolean
  // Transcript hooks output
  handleEnterTranscript: () => void
  handleExitTranscript: () => void
  searchBarOpen: boolean
  virtualScrollActive: boolean
  // Input state
  inputValue: string
  setInputValue: (v: string) => void
  inputMode: PromptInputMode
  setInputMode: (v: PromptInputMode) => void
  stashedPrompt:
    | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
    | undefined
  setStashedPrompt: (
    v:
      | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
      | undefined,
  ) => void
  pastedContents: Record<number, PastedContent>
  setPastedContents: (v: Record<number, PastedContent>) => void
  vimMode: VimMode
  setVimMode: (v: VimMode) => void
  showBashesDialog: string | boolean
  setShowBashesDialog: (v: string | boolean) => void
  isSearchingHistory: boolean
  setIsSearchingHistory: (v: boolean) => void
  isHelpOpen: boolean
  setIsHelpOpen: (v: boolean) => void
  insertTextRef: React.RefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
  // Scroll / divider
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  modalScrollRef: React.RefObject<ScrollBoxHandle | null>
  composedOnScroll: (sticky: boolean, handle: ScrollBoxHandle) => void
  dividerYRef: React.MutableRefObject<number>
  unseenDivider: ReturnType<typeof computeUnseenDivider>
  jumpToNew: (handle: ScrollBoxHandle | null) => void
  repinScroll: () => void
  // Deferred messages
  deferredMessages: MessageType[]
  // Loading state
  isLoading: boolean
  isExternalLoading: boolean
  showStreamingText: boolean
  visibleStreamingText: string | null
  streamingThinking: StreamingThinking | null
  spinnerMessage: string | null
  spinnerColor: keyof Theme | null
  spinnerShimmerColor: keyof Theme | null
  loadingStartTimeRef: React.MutableRefObject<number>
  totalPausedMsRef: React.MutableRefObject<number>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  stopHookSpinnerSuffix: string | null
  responseLengthRef: { readonly current: number }
  clearBashToolsTracking: () => void
  // Query callbacks
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: ActiveSpeculationState
      speculationSessionTimeSavedMs: number
      setAppState: SetAppState
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  onCancel: () => void
  handleQueuedCommandOnCancel: () => void
  abortController: AbortController | null
  // Remote
  isRemoteSession: boolean
  // Voice
  voice: ReplVoiceState
  // Misc callbacks
  handleBackgroundSession: () => void
  mrRender: () => React.ReactNode
  regenerateConversationId: () => void
  // Tools / commands
  tools: readonly Tool[]
  commands: Command[]
  mcpClients: MCPServerConnection[]
  strictMcpConfig: boolean
  // Permissions
  setToolPermissionContext: (v: ToolPermissionContext) => void
  canUseTool: CanUseToolFn
  sandboxWireCleanupRef: React.RefObject<Map<string, Array<() => void>>>
  // Focus
  focusedInputDialog: FocusedInputDialog
  hasSuppressedDialogs: boolean
  // IDE
  ideSelection: IDESelection | undefined
  setIDESelection: (v: IDESelection | undefined) => void
  ideInstallationStatus: IDEExtensionInstallationStatus | null
  showIdeOnboarding: boolean
  setShowIdeOnboarding: (v: boolean) => void
  // Notifications cluster (only dialog-driving subset)
  showEffortCallout: boolean
  setShowEffortCallout: (v: boolean) => void
  showRemoteCallout: boolean
  showDesktopUpsellStartup: boolean
  setShowDesktopUpsellStartup: (v: boolean) => void
  lspRecommendation: ReplNotificationsCluster['lspRecommendation']
  handleLspResponse: ReplNotificationsCluster['handleLspResponse']
  hintRecommendation: ReplNotificationsCluster['hintRecommendation']
  handleHintResponse: ReplNotificationsCluster['handleHintResponse']
  frustrationDetection: ReplFrustrationDetection
  // Key for MCP remount
  remountKey: number
  // Api key
  apiKeyStatus: VerificationStatus
  // Debug / disabled
  debug: boolean
  disabled: boolean
  // Rewind / restore (for MessageSelector)
  rewindConversationTo: (msg: UserMessage) => void
  handleRestoreMessage: (msg: UserMessage) => Promise<void>
  // autoUpdater
  autoUpdaterResult: AutoUpdaterResult | null
  setAutoUpdaterResult: (v: AutoUpdaterResult | null) => void
}

// ────────────────────────────────────────────────────────
//  Component
// ────────────────────────────────────────────────────────

export function ReplMainView(props: ReplMainViewProps): React.ReactNode {
  const {
    replStore,
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    titleIsAnimating,
    terminalTitle,
    titleDisabled,
    showStatusInTerminalTab,
    disableMessageActions,
    handleEnterTranscript,
    handleExitTranscript,
    searchBarOpen,
    virtualScrollActive,
    inputValue,
    setInputValue,
    inputMode,
    setInputMode,
    stashedPrompt,
    setStashedPrompt,
    pastedContents,
    setPastedContents,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    isSearchingHistory,
    setIsSearchingHistory,
    isHelpOpen,
    setIsHelpOpen,
    insertTextRef,
    scrollRef,
    modalScrollRef,
    composedOnScroll,
    dividerYRef,
    unseenDivider,
    jumpToNew,
    repinScroll,
    deferredMessages,
    isLoading,
    isExternalLoading,
    showStreamingText,
    visibleStreamingText,
    streamingThinking,
    spinnerMessage,
    spinnerColor,
    spinnerShimmerColor,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    stopHookSpinnerSuffix,
    responseLengthRef,
    clearBashToolsTracking,
    onSubmit,
    getToolUseContext,
    onCancel,
    handleQueuedCommandOnCancel,
    abortController,
    isRemoteSession,
    voice,
    handleBackgroundSession,
    mrRender,
    regenerateConversationId,
    tools,
    commands,
    mcpClients,
    strictMcpConfig,
    setToolPermissionContext,
    canUseTool,
    sandboxWireCleanupRef,
    focusedInputDialog,
    hasSuppressedDialogs,
    ideSelection,
    setIDESelection,
    ideInstallationStatus,
    showIdeOnboarding,
    setShowIdeOnboarding,
    showEffortCallout,
    setShowEffortCallout,
    showRemoteCallout,
    showDesktopUpsellStartup,
    setShowDesktopUpsellStartup,
    lspRecommendation,
    handleLspResponse,
    hintRecommendation,
    handleHintResponse,
    frustrationDetection,
    remountKey,
    apiKeyStatus,
    debug,
    disabled,
    rewindConversationTo,
    handleRestoreMessage,
    autoUpdaterResult,
    setAutoUpdaterResult,
  } = props

  // ── Context / hook-derived (无状态上下文类，组件自取避免无意义的 prop drilling）──
  const mainLoopModel = useMainLoopModel()
  const { addNotification } = useNotifications()

  // ── Store-derived state ──
  const messages = useReplState((s) => s.messages)
  const conversationId = useReplState((s) => s.conversationId)
  const submitCount = useReplState((s) => s.submitCount)
  const streamMode = useReplState((s) => s.streamMode)
  const streamingToolUses = useReplState((s) => s.streamingToolUses)
  const inProgressToolUseIDs = useReplState((s) => s.inProgressToolUseIDs)
  const toolUseConfirmQueue = useReplState((s) => s.toolUseConfirmQueue)
  const toolJSX = useReplState((s) => s.toolJSX)
  const userInputOnProcessing = useReplState((s) => s.userInputOnProcessing)
  const isMessageSelectorVisible = useReplState((s) => s.isMessageSelectorVisible)
  const messageSelectorPreselect = useReplState((s) => s.messageSelectorPreselect)
  const dynamicMcpConfig = useReplState((s) => s.dynamicMcpConfig)
  const promptQueue = useReplState((s) => s.promptQueue)
  const sandboxPermissionRequestQueue = useReplState((s) => s.sandboxPermissionRequestQueue)
  const {
    setMessages,
    setToolUseConfirmQueue,
    setIsMessageSelectorVisible,
    setMessageSelectorPreselect,
  } = replStore

  // ── AppState-derived ──
  const verbose = useAppState((s) => s.verbose)
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const fileHistory = useAppState((s) => s.fileHistory)
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext)
  const spinnerTip = useAppState((s) => s.spinnerTip)
  const showExpandedTodos = useAppState((s) => s.expandedView) === 'tasks'
  const pendingWorkerRequest = useAppState((s) => s.pendingWorkerRequest)
  const tasks = useAppState((s) => s.tasks)
  const isBriefOnly = useAppState((s) => s.isBriefOnly)
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)
  const elicitation = useAppState((s) => s.elicitation)
  const workerSandboxPermissions = useAppState((s) => s.workerSandboxPermissions)
  const ultraplanPendingChoice = useAppState((s) => s.ultraplanPendingChoice)
  const ultraplanLaunchPending = useAppState((s) => s.ultraplanLaunchPending)
  const setAppState = useSetAppState()

  // ── Local state ──
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode | null>(null)
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null)
  const [isExiting, setIsExiting] = useState(false)
  const [autoRunIssueReason, setAutoRunIssueReason] = useState<AutoRunIssueReason | null>(null)
  const didAutoRunIssueRef = useRef(false)
  const [cursor, setCursor] = useState<MessageActionsState | null>(null)
  const cursorNavRef = useRef<MessageActionsNav | null>(null)

  // ── Stable onSubmit ref (prevents 35MB closure leak over 1000 turns) ──
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  // ── Hooks only used by this view ──
  const tasksV2 = useTasksV2WithCollapseEffect()

  const hasRunningTeammates = useMemo(
    () => getAllInProcessTeammateTasks(tasks).some((t) => t.status === 'running'),
    [tasks],
  )

  const hasActivePrompt =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    sandboxPermissionRequestQueue.length > 0 ||
    elicitation.queue.length > 0 ||
    workerSandboxPermissions.queue.length > 0

  const feedbackSurveyOriginal = useFeedbackSurvey(
    messages,
    isLoading,
    submitCount,
    'feedback',
    hasActivePrompt,
  )
  const skillImprovementSurvey = useSkillImprovementSurvey(setMessages)
  const showIssueFlagBanner = useIssueFlagBanner(messages, submitCount)

  const feedbackSurvey = useMemo(
    () => ({
      ...feedbackSurveyOriginal,
      handleSelect: (selected: FeedbackSurveyResponse) => {
        didAutoRunIssueRef.current = false
        const showedTranscriptPrompt = feedbackSurveyOriginal.handleSelect(selected)
        if (
          selected === 'bad' &&
          !showedTranscriptPrompt &&
          shouldAutoRunIssue('feedback_survey_bad')
        ) {
          setAutoRunIssueReason('feedback_survey_bad')
          didAutoRunIssueRef.current = true
        }
      },
    }),
    [feedbackSurveyOriginal],
  )

  const postCompactSurvey = usePostCompactSurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession,
  })
  const memorySurvey = useMemorySurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession,
  })

  // ── onlySleepToolActive + showSpinner ──
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast((m) => m.type === 'assistant')
    if (lastAssistant?.type !== 'assistant') return false
    const content = lastAssistant.message.content
    if (!Array.isArray(content)) return false
    const inProgress = content.filter(
      (b) => b.type === 'tool_call' && inProgressToolUseIDs.has(b.id),
    )
    return (
      inProgress.length > 0 &&
      inProgress.every((b) => b.type === 'tool_call' && b.name === SLEEP_TOOL_NAME)
    )
  }, [messages, inProgressToolUseIDs])

  const showSpinner =
    (!toolJSX || toolJSX.showSpinner === true) &&
    toolUseConfirmQueue.length === 0 &&
    promptQueue.length === 0 &&
    (isLoading || userInputOnProcessing || hasRunningTeammates || getCommandQueueLength() > 0) &&
    !pendingWorkerRequest &&
    !onlySleepToolActive &&
    (!visibleStreamingText || isBriefOnly)

  // ── Viewed agent task ──
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const viewedTeammateTask =
    viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined
  const viewedAgentTask =
    viewedTeammateTask ?? (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined)

  // ── Displayed messages ──
  const usesSyncMessages = showStreamingText || !isLoading
  const displayedMessages = viewedAgentTask
    ? (viewedAgentTask.messages ?? [])
    : usesSyncMessages
      ? messages
      : deferredMessages

  const placeholderText =
    userInputOnProcessing &&
    !viewedAgentTask &&
    displayedMessages.length <= replStore.mutable.userInputBaseline
      ? userInputOnProcessing
      : undefined

  // ── Tool permission overlay ──
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null
  const toolPermissionOverlay =
    focusedInputDialog === 'tool-permission' ? (
      <PermissionRequest
        key={toolUseConfirmQueue[0]?.toolUseID}
        onDone={() => setToolUseConfirmQueue(([_, ...tail]) => tail)}
        onReject={handleQueuedCommandOnCancel}
        toolUseConfirm={toolUseConfirmQueue[0]!}
        toolUseContext={getToolUseContext(
          messages,
          messages,
          abortController ?? createAbortController(),
          mainLoopModel,
        )}
        verbose={verbose}
        workerBadge={toolUseConfirmQueue[0]?.workerBadge}
        setStickyFooter={isFullscreenEnvEnabled() ? setPermissionStickyFooter : undefined}
      />
    ) : null

  const toolJsxCentered = isFullscreenEnvEnabled() && toolJSX?.isLocalJSXCommand === true
  const centeredModal: React.ReactNode = toolJsxCentered ? toolJSX!.jsx : null

  // ── Message actions ──
  const messageActionCaps: MessageActionCaps = buildMessageActionCaps({
    messages,
    addNotification,
    fileHistory,
    onCancel,
    handleRestoreMessage,
    setMessageSelectorPreselect,
    setIsMessageSelectorVisible,
  })
  const { enter: enterMessageActions, handlers: messageActionHandlers } = useMessageActions(
    cursor,
    setCursor,
    cursorNavRef,
    messageActionCaps,
  )

  // ── onAgentSubmit ──
  const agentSubmitCtx = useMemo(
    () => ({
      setAppState,
      setInputValue,
      getToolUseContext,
      canUseTool,
      mainLoopModel,
      addNotification,
      replStore,
    }),
    [
      setAppState,
      setInputValue,
      getToolUseContext,
      toolPermissionContext,
      mainLoopModel,
      addNotification,
      replStore,
    ],
  )
  const onAgentSubmit = useCallback(
    (
      input: string,
      task: InProcessTeammateTaskState | LocalAgentTaskState,
      helpers: PromptInputHelpers,
    ) => onAgentSubmitImpl(agentSubmitCtx, input, task, helpers),
    [agentSubmitCtx],
  )

  // ── Handlers only used by this view ──
  const handleAutoRunIssue = useCallback(() => {
    const command = autoRunIssueReason ? getAutoRunCommand(autoRunIssueReason) : '/issue'
    setAutoRunIssueReason(null)
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    }).catch((err) => {
      logForDebugging(`Auto-run ${command} failed: ${errorMessage(err)}`)
    })
  }, [onSubmit, autoRunIssueReason])

  const handleCancelAutoRunIssue = useCallback(() => {
    setAutoRunIssueReason(null)
  }, [])

  const handleSurveyRequestFeedback = useCallback(() => {
    const command = isInternalBuild() ? '/issue' : '/feedback'
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    }).catch((err) => {
      logForDebugging(
        `Survey feedback request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }, [onSubmit])

  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    })
  }, [])

  const handleExit = useCallback(() => handleExitImpl({ setIsExiting, setExitFlow }, ExitFlow), [])

  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible((prev) => !prev)
  }, [])

  // ── Keybinding props ──
  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive,
    searchBarOpen,
  }

  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () =>
      setMessages((prev: MessageType[]) => [
        ...prev,
        (
          require('../../utils/messages.js') as typeof import('../../utils/messages.js')
        ).createAgentsKilledMessage(),
      ]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  }

  // Stub components (ultraplan gate not imported)
  const UltraplanChoiceDialog: React.FC<Record<string, unknown>> = () => null
  const UltraplanLaunchDialog: React.FC<Record<string, unknown>> = () => null

  return (
    <KeybindingSetup>
      <AnimatedTerminalTitle
        isAnimating={titleIsAnimating}
        title={terminalTitle}
        disabled={titleDisabled}
        noPrefix={showStatusInTerminalTab}
      />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      {feature('VOICE_MODE') ? (
        <ReplVoiceKeybindingHandler
          voiceHandleKeyEvent={voice.handleKeyEvent}
          stripTrailing={voice.stripTrailing}
          resetAnchor={voice.resetAnchor}
          isActive={!toolJSX?.isLocalJSXCommand}
        />
      ) : null}
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        isActive={
          isFullscreenEnvEnabled() &&
          (centeredModal != null || !focusedInputDialog || focusedInputDialog === 'tool-permission')
        }
        onScroll={
          centeredModal || toolPermissionOverlay || viewedAgentTask ? undefined : composedOnScroll
        }
      />
      {feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? (
        <MessageActionsKeybindings handlers={messageActionHandlers} isActive={cursor !== null} />
      ) : null}
      <CancelRequestHandler {...cancelRequestProps} />
      <MCPConnectionManager
        key={remountKey}
        dynamicMcpConfig={dynamicMcpConfig}
        isStrictMcpConfig={strictMcpConfig}
      >
        <FullscreenLayout
          scrollRef={scrollRef}
          overlay={toolPermissionOverlay}
          modal={centeredModal}
          modalScrollRef={modalScrollRef}
          dividerYRef={dividerYRef}
          hidePill={!!viewedAgentTask}
          hideSticky={!!viewedTeammateTask}
          newMessageCount={unseenDivider?.count ?? 0}
          onPillClick={() => {
            setCursor(null)
            jumpToNew(scrollRef.current)
          }}
          scrollable={
            <>
              <TeammateViewHeader />
              <Messages
                messages={displayedMessages}
                tools={tools}
                commands={commands}
                verbose={verbose}
                toolJSX={toolJSX}
                toolUseConfirmQueue={toolUseConfirmQueue}
                inProgressToolUseIDs={
                  viewedTeammateTask
                    ? (viewedTeammateTask.inProgressToolUseIDs ?? new Set())
                    : inProgressToolUseIDs
                }
                isMessageSelectorVisible={isMessageSelectorVisible}
                conversationId={conversationId}
                screen={screen}
                streamingToolUses={streamingToolUses}
                showAllInTranscript={showAllInTranscript}
                agentDefinitions={agentDefinitions}
                onOpenRateLimitOptions={handleOpenRateLimitOptions}
                isLoading={isLoading}
                streamingText={isLoading && !viewedAgentTask ? visibleStreamingText : null}
                isBriefOnly={viewedAgentTask ? false : isBriefOnly}
                unseenDivider={viewedAgentTask ? undefined : unseenDivider}
                scrollRef={isFullscreenEnvEnabled() ? scrollRef : undefined}
                trackStickyPrompt={isFullscreenEnvEnabled() ? true : undefined}
                cursor={cursor}
                setCursor={setCursor}
                cursorNavRef={cursorNavRef}
              />
              <AwsAuthStatusBox />
              {!disabled && placeholderText && !centeredModal && (
                <UserTextMessage
                  param={{
                    text: placeholderText,
                    type: 'text',
                  }}
                  addMargin={true}
                  verbose={verbose}
                />
              )}
              {toolJSX &&
                !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) &&
                !toolJsxCentered && (
                  <Box flexDirection="column" width="100%">
                    {toolJSX.jsx}
                  </Box>
                )}
              {feature('WEB_BROWSER_TOOL')
                ? WebBrowserPanelModule &&
                  React.createElement(WebBrowserPanelModule.WebBrowserPanel)
                : null}
              <Box flexGrow={1} />
              {showSpinner && (
                <SpinnerWithVerb
                  mode={streamMode}
                  spinnerTip={spinnerTip}
                  responseLengthRef={responseLengthRef}
                  overrideMessage={spinnerMessage}
                  spinnerSuffix={stopHookSpinnerSuffix}
                  verbose={verbose}
                  loadingStartTimeRef={loadingStartTimeRef}
                  totalPausedMsRef={totalPausedMsRef}
                  pauseStartTimeRef={pauseStartTimeRef}
                  overrideColor={spinnerColor}
                  overrideShimmerColor={spinnerShimmerColor}
                  hasActiveTools={inProgressToolUseIDs.size > 0}
                  leaderIsIdle={!isLoading}
                />
              )}
              {!showSpinner &&
                !isLoading &&
                !userInputOnProcessing &&
                !hasRunningTeammates &&
                isBriefOnly &&
                !viewedAgentTask && <BriefIdleStatus />}
              {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
            </>
          }
          bottom={
            <Box flexDirection="row" width="100%" alignItems="flex-end">
              <Box flexDirection="column" flexGrow={1}>
                {permissionStickyFooter}
                {toolJSX?.isLocalJSXCommand && toolJSX.isImmediate && !toolJsxCentered && (
                  <Box flexDirection="column" width="100%">
                    {toolJSX.jsx}
                  </Box>
                )}
                {!showSpinner &&
                  !toolJSX?.isLocalJSXCommand &&
                  showExpandedTodos &&
                  tasksV2 &&
                  tasksV2.length > 0 && (
                    <Box width="100%" flexDirection="column">
                      <TaskListV2 tasks={tasksV2} isStandalone={true} />
                    </Box>
                  )}
                <ReplDialogDispatch
                  focusedInputDialog={focusedInputDialog}
                  sandboxWireCleanupRef={sandboxWireCleanupRef}
                  setInputValue={setInputValue}
                  clearBashToolsTracking={clearBashToolsTracking}
                  onSubmitRef={onSubmitRef}
                  ideInstallationStatus={ideInstallationStatus}
                  setShowIdeOnboarding={setShowIdeOnboarding}
                  mainLoopModel={mainLoopModel}
                  setShowEffortCallout={setShowEffortCallout}
                  hintRecommendation={hintRecommendation}
                  handleHintResponse={handleHintResponse}
                  lspRecommendation={lspRecommendation}
                  handleLspResponse={handleLspResponse}
                  setShowDesktopUpsellStartup={setShowDesktopUpsellStartup}
                  createAbortController={createAbortController}
                  exitFlow={exitFlow}
                />

                {mrRender()}

                {!toolJSX?.shouldHidePromptInput &&
                  !focusedInputDialog &&
                  !isExiting &&
                  !disabled &&
                  !cursor && (
                    <>
                      {autoRunIssueReason && (
                        <AutoRunIssueNotification
                          onRun={handleAutoRunIssue}
                          onCancel={handleCancelAutoRunIssue}
                          reason={getAutoRunIssueReasonText(autoRunIssueReason)}
                        />
                      )}
                      {postCompactSurvey.state !== 'closed' ? (
                        <FeedbackSurvey
                          state={postCompactSurvey.state}
                          lastResponse={postCompactSurvey.lastResponse}
                          handleSelect={postCompactSurvey.handleSelect}
                          inputValue={inputValue}
                          setInputValue={setInputValue}
                          onRequestFeedback={handleSurveyRequestFeedback}
                        />
                      ) : memorySurvey.state !== 'closed' ? (
                        <FeedbackSurvey
                          state={memorySurvey.state}
                          lastResponse={memorySurvey.lastResponse}
                          handleSelect={memorySurvey.handleSelect}
                          handleTranscriptSelect={memorySurvey.handleTranscriptSelect}
                          inputValue={inputValue}
                          setInputValue={setInputValue}
                          onRequestFeedback={handleSurveyRequestFeedback}
                          message="How well did Zy use its memory? (optional)"
                        />
                      ) : (
                        <FeedbackSurvey
                          state={feedbackSurvey.state}
                          lastResponse={feedbackSurvey.lastResponse}
                          handleSelect={feedbackSurvey.handleSelect}
                          handleTranscriptSelect={feedbackSurvey.handleTranscriptSelect}
                          inputValue={inputValue}
                          setInputValue={setInputValue}
                          onRequestFeedback={
                            didAutoRunIssueRef.current ? undefined : handleSurveyRequestFeedback
                          }
                        />
                      )}
                      {frustrationDetection.state !== 'closed' && (
                        <FeedbackSurvey
                          state={frustrationDetection.state}
                          lastResponse={null}
                          handleSelect={() => {}}
                          handleTranscriptSelect={frustrationDetection.handleTranscriptSelect}
                          inputValue={inputValue}
                          setInputValue={setInputValue}
                        />
                      )}
                      {isInternalBuild() && skillImprovementSurvey.suggestion && (
                        <SkillImprovementSurvey
                          isOpen={skillImprovementSurvey.isOpen}
                          skillName={skillImprovementSurvey.suggestion.skillName}
                          updates={skillImprovementSurvey.suggestion.updates}
                          handleSelect={skillImprovementSurvey.handleSelect}
                          inputValue={inputValue}
                          setInputValue={setInputValue}
                        />
                      )}
                      {showIssueFlagBanner && <IssueFlagBanner />}
                      {}
                      <PromptInput
                        debug={debug}
                        ideSelection={ideSelection}
                        hasSuppressedDialogs={!!hasSuppressedDialogs}
                        isLocalJSXCommandActive={isShowingLocalJSXCommand}
                        getToolUseContext={getToolUseContext}
                        toolPermissionContext={toolPermissionContext}
                        setToolPermissionContext={setToolPermissionContext}
                        apiKeyStatus={apiKeyStatus}
                        commands={commands}
                        agents={agentDefinitions.activeAgents}
                        isLoading={isLoading}
                        onExit={handleExit}
                        verbose={verbose}
                        messages={messages}
                        onAutoUpdaterResult={setAutoUpdaterResult}
                        autoUpdaterResult={autoUpdaterResult}
                        input={inputValue}
                        onInputChange={setInputValue}
                        mode={inputMode}
                        onModeChange={setInputMode}
                        stashedPrompt={stashedPrompt}
                        setStashedPrompt={setStashedPrompt}
                        submitCount={submitCount}
                        onShowMessageSelector={handleShowMessageSelector}
                        onMessageActionsEnter={
                          feature('MESSAGE_ACTIONS') &&
                          isFullscreenEnvEnabled() &&
                          !disableMessageActions
                            ? enterMessageActions
                            : undefined
                        }
                        mcpClients={mcpClients}
                        pastedContents={pastedContents}
                        setPastedContents={setPastedContents}
                        vimMode={vimMode}
                        setVimMode={setVimMode}
                        showBashesDialog={showBashesDialog}
                        setShowBashesDialog={setShowBashesDialog}
                        onSubmit={onSubmit}
                        onAgentSubmit={onAgentSubmit}
                        isSearchingHistory={isSearchingHistory}
                        setIsSearchingHistory={setIsSearchingHistory}
                        helpOpen={isHelpOpen}
                        setHelpOpen={setIsHelpOpen}
                        insertTextRef={feature('VOICE_MODE') ? insertTextRef : undefined}
                        voiceInterimRange={voice.interimRange}
                      />
                      <SessionBackgroundHint
                        onBackgroundSession={handleBackgroundSession}
                        isLoading={isLoading}
                      />
                    </>
                  )}
                {cursor && <MessageActionsBar cursor={cursor} />}
                {focusedInputDialog === 'message-selector' && (
                  <MessageSelector
                    messages={messages}
                    preselectedMessage={messageSelectorPreselect}
                    onPreRestore={onCancel}
                    onRestoreCode={async (message: UserMessage) => {
                      await fileHistoryRewind(
                        (updater: (prev: FileHistoryState) => FileHistoryState) => {
                          setAppState((prev) => ({
                            ...prev,
                            fileHistory: updater(prev.fileHistory),
                          }))
                        },
                        toUUID(message.uuid),
                      )
                    }}
                    onSummarize={(message, feedback, direction) =>
                      handleSummarizeAction({
                        message,
                        feedback,
                        direction,
                        messages,
                        createAbortController,
                        getToolUseContext,
                        mainLoopModel,
                        setMessages,
                        regenerateConversationId,
                        setInputValue,
                        setInputMode,
                        addNotification,
                      })
                    }
                    onRestoreMessage={handleRestoreMessage}
                    onClose={() => {
                      setIsMessageSelectorVisible(false)
                      setMessageSelectorPreselect(undefined)
                    }}
                  />
                )}
                {isInternalBuild() && <DevBar />}
              </Box>
            </Box>
          }
        />
      </MCPConnectionManager>
    </KeybindingSetup>
  )
}
