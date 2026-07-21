/**
 * ReplMainView -- main prompt-screen render, extracted from REPL.tsx.
 *
 * Renders inside <ReplStoreProvider>; reads store state via useReplState().
 * Only truly local values (callbacks, refs, flags) are props.
 */

import { feature } from 'bun:bundle'
import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Command } from '../../commands/index.js'
import { AnimatedTerminalTitle } from '../../components/AnimatedTerminalTitle.js'
import { AwsAuthStatusBox } from '../../components/AwsAuthStatusBox.js'
import { DevBar } from '../../components/DevBar.js'
import { ExitFlow } from '../../components/ExitFlow.js'
import { FeedbackSurvey } from '../../components/FeedbackSurvey/FeedbackSurvey.js'
import { useFeedbackSurvey } from '../../components/FeedbackSurvey/useFeedbackSurvey.js'
import { useMemorySurvey } from '../../components/FeedbackSurvey/useMemorySurvey.js'
import { usePostCompactSurvey } from '../../components/FeedbackSurvey/usePostCompactSurvey.js'
import type { FeedbackSurveyResponse } from '../../components/FeedbackSurvey/utils.js'
import { computeUnseenDivider, FullscreenLayout } from '../../components/FullscreenLayout.js'
import { MessageSelector } from '../../components/MessageSelector.js'
import { Messages } from '../../components/Messages.js'
import type {
  MessageActionCaps,
  MessageActionsNav,
  MessageActionsState,
} from '../../components/MessageActions.js'
import {
  MessageActionsBar,
  MessageActionsKeybindings,
  useMessageActions,
} from '../../components/MessageActions.js'
import { UserTextMessage } from '../../components/messages/UserTextMessage.js'
import { IssueFlagBanner } from '../../components/PromptInput/IssueFlagBanner.js'
import PromptInput from '../../components/PromptInput/PromptInput.js'
import { PromptInputQueuedCommands } from '../../components/PromptInput/PromptInputQueuedCommands.js'
import { PermissionRequest } from '../../components/permissions/PermissionRequest.js'
import { ScrollKeybindingHandler } from '../../components/ScrollKeybindingHandler.js'
import { SessionBackgroundHint } from '../../components/SessionBackgroundHint.js'
import { SkillImprovementSurvey } from '../../components/SkillImprovementSurvey.js'
import { BriefIdleStatus, SpinnerWithVerb } from '../../components/Spinner.js'
import { TaskList } from '../../components/TaskList.js'
import { TeammateViewHeader } from '../../components/TeammateViewHeader.js'
import { useNotifications } from '../../context/notifications.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { useIssueFlagBanner } from '../../hooks/useIssueFlagBanner.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useSkillImprovementSurvey } from '../../hooks/useSkillImprovementSurvey.js'
import { useTasksWithCollapseEffect } from '../../hooks/useTasks.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import instances from '../../ink/instances.js'
import { selectionBounds } from '../../ink/selection.js'
import { Box } from '../../ink/index.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { ActiveSpeculationState } from '../../services/prompt-suggestion/speculation.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { useReplState } from '../../state/ReplState.js'
import type { ReplStoreInstance } from '../../state/replStore.js'
import type { Tool, ToolPermissionContext } from '../../tools/tool.js'
import { getAllInProcessTeammateTasks } from '../../tasks/in-process-teammate-task/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/in-process-teammate-task/types.js'
import { isInProcessTeammateTask } from '../../tasks/in-process-teammate-task/types.js'
import type { LocalAgentTaskState } from '../../tasks/local-agent-task/LocalAgentTask.js'
import { isLocalAgentTask } from '../../tasks/local-agent-task/LocalAgentTask.js'
import { SLEEP_TOOL_NAME } from '../../tools/SleepTool/prompt.js'
import { toUUID } from '../../types/ids.js'
import type { Message as MessageType, UserMessage } from '../../types/message.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import { createAbortController } from '../../utils/abortController.js'
import {
  AutoRunIssueNotification,
  type AutoRunIssueReason,
  getAutoRunCommand,
  getAutoRunIssueReasonText,
  shouldAutoRunIssue,
} from '../../components/Runtime/AutoRunIssue.js'
import type { AutoUpdaterResult } from '../../services/updater/autoUpdater.js'
import type { PastedContent } from '../../services/config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import type { FileHistoryState } from '../../services/file-persistence/fileHistory.js'
import { fileHistoryRewind } from '../../services/file-persistence/fileHistory.js'
import { isFullscreenEnvEnabled } from '../../services/terminal/fullscreen.js'
import type { PromptInputHelpers } from '../../services/input/handlePromptSubmit.js'
import type { IDEExtensionInstallationStatus } from '../../services/ide/ide.js'
import type { SetAppState } from '../../services/input/messageQueueManager.js'
import { getCommandQueueLength } from '../../services/input/messageQueueManager.js'
import { StreamingThinking } from '../../services/messages/./streaming.js'
import type { Theme } from '../../services/environment/theme.js'
import { tSync } from '../../i18n/index.js'
import type { Screen } from '../REPL.js'
import { handleSummarize as handleSummarizeAction } from './handleSummarize.js'
import { ReplDialogDispatch } from './ReplDialogDispatch.js'
import { buildMessageActionCaps, handleExitImpl, onAgentSubmitImpl } from './replCallbacks.js'
import type {
  ReplFrustrationDetection,
  ReplNotificationsCluster,
} from './useReplNotificationsCluster.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'
import type { ReplVoiceState } from './useReplVoice.js'
import { ReplVoiceKeybindingHandler } from './useReplVoice.js'

// ────────────────────────────────────────────────────────
//  Props
// ────────────────────────────────────────────────────────

export interface ReplMainViewProps {
  replStore: ReplStoreInstance
  // Screen state
  screen: Screen
  setScreen: React.Dispatch<React.SetStateAction<Screen>>
  showAllInTranscript: boolean
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>
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
  setInputMode: React.Dispatch<React.SetStateAction<PromptInputMode>>
  stashedPrompt:
    | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
    | undefined
  setStashedPrompt: (
    v:
      | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
      | undefined,
  ) => void
  pastedContents: Record<number, PastedContent>
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>
  vimMode: VimMode
  setVimMode: (v: VimMode) => void
  showBashesDialog: string | boolean
  setShowBashesDialog: (v: string | boolean) => void
  isSearchingHistory: boolean
  setIsSearchingHistory: (v: boolean) => void
  isHelpOpen: boolean
  setIsHelpOpen: React.Dispatch<React.SetStateAction<boolean>>
  insertTextRef: React.RefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
  // Scroll / divider
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  modalScrollRef: React.RefObject<ScrollBoxHandle | null>
  composedOnScroll: (sticky: boolean, handle: ScrollBoxHandle) => void
  dividerYRef: React.RefObject<number | null>
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
  showFullscreenUpsell: boolean
  setShowFullscreenUpsell: (v: boolean) => void
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
    showFullscreenUpsell,
    setShowFullscreenUpsell,
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
  const _ultraplanPendingChoice = useAppState((s) => s.ultraplanPendingChoice)
  const _ultraplanLaunchPending = useAppState((s) => s.ultraplanLaunchPending)
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
  const todoTasks = useTasksWithCollapseEffect()

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
    if (lastAssistant?.type !== 'assistant') {
      return false
    }
    const content = lastAssistant.message.content
    if (!Array.isArray(content)) {
      return false
    }
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

  /**
   * 全屏拖选后 Delete/Backspace：仅从输入框删除选中文本。
   * 对话历史不支持拖选删除；历史区选区只清高亮（由调用方 stop + clear）。
   * 返回值表示是否改动了 input；调用方总会 stop 按键传播。
   */
  const handleDeleteSelection = useCallback(
    (selectedText: string): boolean => {
      if (!selectedText) {
        return false
      }

      const ink = instances.get(process.stdout)
      const bounds = ink ? selectionBounds(ink.selection) : null
      const scroll = scrollRef.current

      // 选区中点在 ScrollBox 视口内 → 对话历史，不删消息、不碰输入
      if (bounds && scroll) {
        const vpTop = scroll.getViewportTop()
        const vpH = scroll.getViewportHeight()
        const vpBottom = vpTop + Math.max(0, vpH - 1)
        const midRow = Math.floor((bounds.start.row + bounds.end.row) / 2)
        if (midRow >= vpTop && midRow <= vpBottom) {
          return false
        }
      }

      // 屏幕选区可能带软换行拼回的 \n，或带上 ❯/! 提示符装饰
      const candidates = [
        selectedText,
        selectedText.replace(/\n/g, ''),
        selectedText.replace(/^[❯›>!]\u00a0?\s*/, '').replace(/\n/g, ''),
        selectedText.trim(),
      ].filter((t, i, arr) => t.length > 0 && arr.indexOf(t) === i)

      const helpers = insertTextRef?.current
      const currentInput = inputValue
      const cursor = helpers?.cursorOffset ?? currentInput.length

      for (const cand of candidates) {
        let at = currentInput.lastIndexOf(cand, Math.max(0, cursor))
        if (at < 0) {
          at = currentInput.indexOf(cand)
        }
        if (at < 0) {
          continue
        }
        const nextValue = currentInput.slice(0, at) + currentInput.slice(at + cand.length)
        if (helpers?.setInputWithCursor) {
          helpers.setInputWithCursor(nextValue, at)
        } else {
          setInputValue(nextValue)
        }
        return true
      }

      // 匹配失败（例如只选中了提示符装饰）——已由调用方 stop，避免单字符删除
      return false
    },
    [inputValue, setInputValue, insertTextRef, scrollRef],
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
      mainLoopModel,
      addNotification,
      replStore,
      canUseTool,
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
  }, [setIsMessageSelectorVisible])

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
          require('../../services/messages/constructors.js') as typeof import('../../services/messages/constructors.js')
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
  const _UltraplanChoiceDialog: React.FC<Record<string, unknown>> = () => null
  const _UltraplanLaunchDialog: React.FC<Record<string, unknown>> = () => null

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
        onDeleteSelection={handleDeleteSelection}
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
                streamingThinking={streamingThinking}
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
                  todoTasks &&
                  todoTasks.length > 0 && (
                    <Box width="100%" flexDirection="column" flexShrink={1} overflow="hidden">
                      <TaskList tasks={todoTasks} isStandalone={true} />
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
                  setShowFullscreenUpsell={setShowFullscreenUpsell}
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
                          message={tSync('misc.repl.memorySurvey.question')}
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
                        insertTextRef={insertTextRef}
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
