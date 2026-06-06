// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { useStdin, useTheme, useTabStatus } from '../ink.js'
import type { TabStatusKind } from '../ink/hooks/use-tab-status.js'
import * as React from 'react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
} from 'react'
import { useNotifications } from '../context/notifications.js'
import { startPreventSleep, stopPreventSleep } from '../services/preventSleep.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import { updateLastInteractionTime, getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { QueryGuard } from '../utils/QueryGuard.js'
import { isEnvTruthy, isInternalBuild } from '../utils/envUtils.js'
import { getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
} from '../services/swarm/leaderPermissionBridge.js'
import { endInteractionSpan } from '../services/telemetry/sessionTracing.js'
import { useLogMessages } from '../hooks/useLogMessages.js'
import { useReplBridge } from '../hooks/useReplBridge.js'
import { type Command } from '../commands.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { useIdeLogging } from '../hooks/useIdeLogging.js'
import type { DirectConnectConfig } from '../server/directConnectManager.js'
import { useAssistantHistory } from '../hooks/useAssistantHistory.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import { useMoreRight } from '../moreright/useMoreRight.js'
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js'
import { useCostSummary } from '../costHook.js'
import { useFpsMetrics } from '../context/fpsMetrics.js'
import { useAfterFirstRender } from '../hooks/useAfterFirstRender.js'
import { useDeferredHookMessages } from '../hooks/useDeferredHookMessages.js'
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js'
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js'
import { useSwarmInitialization } from '../hooks/useSwarmInitialization.js'
import { useTeammateViewAutoExit } from '../hooks/useTeammateViewAutoExit.js'
import { isHumanTurn } from '../utils/messagePredicates.js'
import useCanUseTool from '../hooks/useCanUseTool.js'
import type { Tool } from '../Tool.js'
import { clearSpeculativeChecks } from '../tools/BashTool/bashPermissions.js'
import type { AutoUpdaterResult } from '../utils/autoUpdater.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { createAgentsKilledMessage } from '../utils/messages.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { useQueueProcessor } from '../hooks/useQueueProcessor.js'
import { useMailboxBridge } from '../hooks/useMailboxBridge.js'
import type { Message as MessageType, UserMessage } from '../types/message.js'
import { useMergedClients } from '../hooks/useMergedClients.js'
import { useMergedTools } from '../hooks/useMergedTools.js'
import { useMergedCommands } from '../hooks/useMergedCommands.js'
import { useSkillsChange } from '../hooks/useSkillsChange.js'
import { useManagePlugins } from '../hooks/useManagePlugins.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { getTools } from '../tools.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { resolveAgentTools } from '../tools/AgentTool/agentToolUtils.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useAppState, useSetAppState, useAppStateStore } from '../state/AppState.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import { extractReadFilesFromMessages } from '../utils/queryHelpers.js'
import {
  provisionContentReplacementState,
  type ContentReplacementRecord,
} from '../utils/toolResultStorage.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import { type FileHistorySnapshot } from '../utils/fileHistory.js'
import { updateSessionActivity } from '../utils/concurrentSessions.js'
import { useInboxPoller } from '../hooks/useInboxPoller.js'
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => {}
const PROACTIVE_FALSE = () => false
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false
import { useGoalMode } from '../hooks/useGoalMode.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { useTaskListWatcher } from '../hooks/useTaskListWatcher.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import { activityManager } from '../utils/activityManager.js'
import { proactiveModule } from '../cli/lazyModules.js'
import { useReplActiveRemote } from './repl/useReplActiveRemote.js'
import { useReplToolPermissionContext } from './repl/useReplToolPermissionContext.js'
import { useReplLoadingState } from './repl/useReplLoadingState.js'
import { useReplIdeState } from './repl/useReplIdeState.js'
import { useReplNotificationsCluster } from './repl/useReplNotificationsCluster.js'
import { useReplOnCancel } from './repl/useReplOnCancel.js'
import { useReplProactive } from './repl/useReplProactive.js'
import { useReplSandboxAsk } from './repl/useReplSandboxAsk.js'
import { useReplRequestPrompt } from './repl/useReplRequestPrompt.js'
import { useReplScheduledTasks } from './repl/useReplScheduledTasks.js'
import { useReplInput } from './repl/useReplInput.js'
import { useReplQueryCallbacks } from './repl/useReplQueryCallbacks.js'
import type { QueryFlowContext } from './repl/replQueryFlow.js'
import { useReplSessionRestore } from './repl/useReplSessionRestore.js'
import { createReplStore, type ToolJSXState } from '../state/ReplStore.js'
import { ReplStoreProvider } from '../state/ReplState.js'
import { useReplTranscript } from './repl/useReplTranscript.js'
import { useReplVoice } from './repl/useReplVoice.js'
import { getFocusedInputDialog } from './repl/getFocusedInputDialog.js'
import {
  rewindConversationToImpl,
  restoreMessageSyncImpl,
  executeQueuedInputImpl,
  handleIncomingPromptImpl,
  onInitImpl,
} from './repl/replCallbacks.js'
import {
  useStopHookSpinnerSuffix,
  useIdleNotification,
  useIdleReturnHint,
} from './repl/useReplEffects.js'
import { useReplInitialMessage } from './repl/useReplInitialMessage.js'
import { ReplTranscriptView } from './repl/ReplTranscriptView.js'
import { usePromptsFromClaudeInChrome } from 'src/hooks/usePromptsFromClaudeInChrome.js'
import {
  useKickOffCheckAndDisableBypassPermissionsIfNeeded,
  useKickOffCheckAndDisableAutoModeIfNeeded,
} from 'src/utils/permissions/bypassPermissionsKillswitch.js'
import { useFileHistorySnapshotInit } from 'src/hooks/useFileHistorySnapshotInit.js'
import { useMcpConnectivityStatus } from 'src/hooks/notifs/useMcpConnectivityStatus.js'
import { performStartupChecks } from 'src/utils/plugins/performStartupChecks.js'
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js'
import { useUnseenDivider, computeUnseenDivider } from '../components/FullscreenLayout.js'
import {
  isFullscreenEnvEnabled,
  maybeGetTmuxMouseHint,
  isMouseTrackingEnabled,
} from '../utils/fullscreen.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ReplMainView } from './repl/ReplMainView.js'

const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []
const HISTORY_STUB = { maybeLoadOlder: (_: ScrollBoxHandle) => {} }

export type Props = {
  commands: Command[]
  debug: boolean
  initialTools: Tool[]
  initialMessages?: MessageType[]
  pendingHookMessages?: Promise<MessageType[]>
  initialFileHistorySnapshots?: FileHistorySnapshot[]
  initialContentReplacements?: ContentReplacementRecord[]
  initialAgentName?: string
  initialAgentColor?: AgentColorName
  mcpClients?: MCPServerConnection[]
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  autoConnectIdeFlag?: boolean
  strictMcpConfig?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>
  disabled?: boolean
  mainThreadAgentDefinition?: AgentDefinition
  disableSlashCommands?: boolean
  taskListId?: string
  remoteSessionConfig?: RemoteSessionConfig
  directConnectConfig?: DirectConnectConfig
  sshSession?: SSHSession
  thinkingConfig: ThinkingConfig
}
export type Screen = 'prompt' | 'transcript'
export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  disableSlashCommands = false,
  taskListId,
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  thinkingConfig,
}: Props): React.ReactNode {
  const isRemoteSession = !!remoteSessionConfig

  const titleDisabled = useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_TERMINAL_TITLE), [])
  const moreRightEnabled = useMemo(
    () => isInternalBuild() && isEnvTruthy(process.env.CLAUDE_MORERIGHT),
    [],
  )
  const disableVirtualScroll = useMemo(
    () => isEnvTruthy(process.env.ZY_CODE_DISABLE_VIRTUAL_SCROLL),
    [],
  )
  const disableMessageActions = feature('MESSAGE_ACTIONS')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_MESSAGE_ACTIONS), [])
    : false

  useEffect(() => {
    logForDebugging(`[REPL:mount] REPL mounted, disabled=${disabled}`)
    return () => logForDebugging(`[REPL:unmount] REPL unmounting`)
  }, [disabled])

  const toolPermissionContext = useAppState((s) => s.toolPermissionContext)
  const mcp = useAppState((s) => s.mcp)
  const plugins = useAppState((s) => s.plugins)
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const fileHistory = useAppState((s) => s.fileHistory)
  const initialMessage = useAppState((s) => s.initialMessage)
  const queuedCommands = useCommandQueue()
  const pendingWorkerRequest = useAppState((s) => s.pendingWorkerRequest)
  const pendingSandboxRequest = useAppState((s) => s.pendingSandboxRequest)
  const tasks = useAppState((s) => s.tasks)
  const ultraplanPendingChoice = useAppState((s) => s.ultraplanPendingChoice)
  const ultraplanLaunchPending = useAppState((s) => s.ultraplanLaunchPending)
  const workerSandboxPermissions = useAppState((s) => s.workerSandboxPermissions)
  const elicitation = useAppState((s) => s.elicitation)
  const setAppState = useSetAppState()

  const store = useAppStateStore()
  const terminal = useTerminalNotification()
  const mainLoopModel = useMainLoopModel()

  const [localCommands, setLocalCommands] = useState(initialCommands)
  useSkillsChange(isRemoteSession ? undefined : getProjectRoot(), setLocalCommands)

  const proactiveActive = React.useSyncExternalStore(
    proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE,
    proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE,
  )

  const _isBriefOnly = useAppState((s) => s.isBriefOnly)
  const localTools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext])
  useKickOffCheckAndDisableBypassPermissionsIfNeeded()
  useKickOffCheckAndDisableAutoModeIfNeeded()
  const setDynamicMcpConfigRef = useRef<
    React.Dispatch<React.SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>>
  >(() => {})
  const [screen, setScreen] = useState<Screen>('prompt')
  const [showAllInTranscript, setShowAllInTranscript] = useState(false)
  const { addNotification, removeNotification } = useNotifications()
  const mcpClients = useMergedClients(initialMcpClients, mcp.clients)

  const {
    ideSelection,
    setIDESelection,
    ideToInstallExtension,
    setIDEToInstallExtension,
    ideInstallationStatus,
    showIdeOnboarding,
    setShowIdeOnboarding,
  } = useReplIdeState({
    autoConnectIdeFlag,
    isRemoteSession,
    mcpClients,
    rawMcpClients: mcp.clients,
    setDynamicMcpConfig: (v) => setDynamicMcpConfigRef.current(v),
  })
  useMcpConnectivityStatus({ mcpClients })

  const combinedInitialTools = useMemo(
    () => [...localTools, ...initialTools],
    [localTools, initialTools],
  )
  useManagePlugins({ enabled: !isRemoteSession })

  useEffect(() => {
    if (isRemoteSession) {
      return
    }
    void performStartupChecks(setAppState)
  }, [setAppState, isRemoteSession])

  usePromptsFromClaudeInChrome(
    isRemoteSession ? EMPTY_MCP_CLIENTS : mcpClients,
    toolPermissionContext.mode,
  )
  useSwarmInitialization(setAppState, initialMessages, { enabled: !isRemoteSession })

  const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext)
  const commandsWithPlugins = useMergedCommands(localCommands, plugins.commands as Command[])
  const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands as Command[])
  const commands = useMemo(
    () => (disableSlashCommands ? [] : mergedCommands),
    [disableSlashCommands, mergedCommands],
  )
  useIdeLogging(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients)
  const [theme] = useTheme()

  const [initialReadFileState] = useState(() =>
    createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
  )
  const sendWireResultRef = useRef<() => void>(() => {})
  const restoreMessageSyncRef = useRef<(m: UserMessage) => void>(() => {})
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const modalScrollRef = useRef<ScrollBoxHandle>(null)
  const lastUserScrollTsRef = useRef(0)
  const queryGuard = React.useRef(new QueryGuard()).current

  // ── ReplStore ──
  const [replStore] = React.useState(() =>
    createReplStore({
      initialMessages,
      initialMainThreadAgentDefinition,
      initialDynamicMcpConfig,
      initialExternalLoading: remoteSessionConfig?.hasInitialPrompt ?? false,
      queryGuard,
      titleGenerationAttempted: (initialMessages?.length ?? 0) > 0,
      readFileState: initialReadFileState,
      contentReplacementState:
        provisionContentReplacementState(initialMessages, initialContentReplacements) ?? null,
    }),
  )
  // 订阅整个 ReplState 而非按字段选择器：REPL 在自身派生逻辑中读取
  // ~13/14 个字段（terminalTitle / focusedInputDialog / isWaitingForApproval /
  // tools useMemo / idle hooks 等），且其中高频字段（messages / toolJSX /
  // toolUseConfirmQueue）几乎每次 store 更新都变。按字段订阅不会减少
  // REPL 重渲染频率，反而增加 14 个 useSyncExternalStore 调用。子组件
  // （ReplMainView）用 useReplState 按字段订阅以获得自身的细粒度优化。
  const replState = React.useSyncExternalStore(
    replStore.subscribe,
    replStore.getState,
    replStore.getState,
  )
  const {
    messages,
    conversationId,
    submitCount,
    streamMode,
    streamingToolUses,
    inProgressToolUseIDs,
    toolUseConfirmQueue,
    toolJSX,
    idleReturnPending,
    isMessageSelectorVisible,
    mainThreadAgentDefinition,
    lastQueryCompletionTime,
    promptQueue,
    sandboxPermissionRequestQueue,
  } = replState
  const {
    setMessages,
    setStreamMode,
    setStreamingToolUses,
    setInProgressToolUseIDs,
    setToolUseConfirmQueue,
    setPromptQueue,
    setSandboxPermissionRequestQueue,
    setDynamicMcpConfig,
    setMainThreadAgentDefinition,
    setUserInputOnProcessing,
  } = replStore
  const onChangeDynamicMcpConfig = replStore.setDynamicMcpConfig as (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  setDynamicMcpConfigRef.current = setDynamicMcpConfig

  const { tools } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return { tools: mergedTools, allowedAgentTypes: undefined as string[] | undefined }
    }
    const resolved = resolveAgentTools(mainThreadAgentDefinition, mergedTools, false, true)
    return { tools: resolved.resolvedTools, allowedAgentTypes: resolved.allowedAgentTypes }
  }, [mainThreadAgentDefinition, mergedTools])

  const onResetAdditionalRef = useRef<() => void>(() => {})
  const {
    isLoading,
    isExternalLoading,
    setIsExternalLoading,
    resetTimingRefs,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    spinnerMessage,
    spinnerColor,
    spinnerShimmerColor,
    onCompactProgress,
    ingestBashToolsFromMessages,
    clearBashToolsTracking,
    resetTipPickedThisTurn,
    streamingText,
    setStreamingText,
    onStreamingText,
    visibleStreamingText,
    showStreamingText,
    streamingThinking,
    setStreamingThinking,
    resetLoadingState,
  } = useReplLoadingState({
    queryGuard,
    initialExternalLoading: remoteSessionConfig?.hasInitialPrompt ?? false,
    theme,
    replStore,
    onResetAdditional: () => onResetAdditionalRef.current(),
  })

  const focusedInputDialogRef = React.useRef<ReturnType<typeof getFocusedInputDialog>>(undefined)
  const [autoUpdaterResult, setAutoUpdaterResult] = useState<AutoUpdaterResult | null>(null)
  useEffect(() => {
    if (autoUpdaterResult?.notifications) {
      autoUpdaterResult.notifications.forEach((n) => {
        addNotification({ key: 'auto-updater-notification', text: n, priority: 'low' })
      })
    }
  }, [autoUpdaterResult, addNotification])

  useEffect(() => {
    if (isFullscreenEnvEnabled()) {
      void maybeGetTmuxMouseHint().then((hint) => {
        if (hint) {
          addNotification({ key: 'tmux-mouse-hint', text: hint, priority: 'low' })
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addNotification])

  const localJSXCommandRef = useRef<(ToolJSXState & { isLocalJSXCommand: true }) | null>(null)
  const updateToolJSX = useCallback(
    (v: ToolJSXState | null) => replStore.update({ toolJSX: v }),
    [replStore],
  )
  const setToolJSX = useCallback(
    (args: (ToolJSXState & { clearLocalJSX?: boolean }) | null) => {
      if (args?.isLocalJSXCommand) {
        const { clearLocalJSX: _, ...rest } = args
        localJSXCommandRef.current = { ...rest, isLocalJSXCommand: true }
        updateToolJSX(rest)
        return
      }
      if (localJSXCommandRef.current) {
        if (args?.clearLocalJSX) {
          localJSXCommandRef.current = null
          updateToolJSX(null)
        }
        return
      }
      if (args?.clearLocalJSX) {
        updateToolJSX(null)
        return
      }
      updateToolJSX(args)
    },
    [updateToolJSX],
  )

  // ── Terminal title ──
  const terminalTitleFromRename = useAppState((s) => s.settings.terminalTitleFromRename) !== false
  const sessionTitle = terminalTitleFromRename ? getCurrentSessionTitle(getSessionId()) : undefined
  const [, forceRenderTitle] = useState(0)
  const agentTitle = mainThreadAgentDefinition?.agentType
  const terminalTitle = sessionTitle ?? agentTitle ?? 'ZY Code'
  const isWaitingForApproval =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    pendingWorkerRequest ||
    pendingSandboxRequest
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null
  const titleIsAnimating = isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand

  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep()
      return () => stopPreventSleep()
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand])

  const sessionStatus: TabStatusKind =
    isWaitingForApproval || isShowingLocalJSXCommand ? 'waiting' : isLoading ? 'busy' : 'idle'
  const waitingFor =
    sessionStatus !== 'waiting'
      ? undefined
      : toolUseConfirmQueue.length > 0
        ? `approve ${toolUseConfirmQueue[0]!.tool.name}`
        : pendingWorkerRequest
          ? 'worker request'
          : pendingSandboxRequest
            ? 'sandbox request'
            : isShowingLocalJSXCommand
              ? 'dialog open'
              : 'input needed'

  useEffect(() => {
    if (feature('BG_SESSIONS')) {
      void updateSessionActivity({ status: sessionStatus, waitingFor })
    }
  }, [sessionStatus, waitingFor])

  const tabStatusGateEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_terminal_sidebar', false)
  const showStatusInTerminalTab =
    tabStatusGateEnabled && (getGlobalConfig().showStatusInTerminalTab ?? false)
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus)

  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue)
    return () => unregisterLeaderToolUseConfirmQueue()
  }, [setToolUseConfirmQueue])

  const hasRunningTeammates = useMemo(
    () => getAllInProcessTeammateTasks(tasks).some((t) => t.status === 'running'),
    [tasks],
  )

  // ── Scroll / unseen divider ──
  const { dividerIndex, dividerYRef, onScrollAway, onRepin, jumpToNew, shiftDivider } =
    useUnseenDivider(messages.length)
  const unseenDivider = useMemo(
    () => computeUnseenDivider(messages, dividerIndex),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dividerIndex, messages.length, messages],
  )
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom()
    onRepin()
  }, [onRepin])

  const lastMsg = messages.at(-1)
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg)
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll()
    }
  }, [lastMsgIsHuman, repinScroll])

  const { maybeLoadOlder } = feature('KAIROS')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useAssistantHistory({
        config: remoteSessionConfig,
        setMessages,
        scrollRef,
        onPrepend: shiftDivider,
      })
    : HISTORY_STUB

  const composedOnScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      lastUserScrollTsRef.current = Date.now()
      if (sticky) {
        onRepin()
      } else {
        onScrollAway(handle)
        if (feature('KAIROS')) {
          maybeLoadOlder(handle)
        }
      }
    },
    [onRepin, onScrollAway, maybeLoadOlder],
  )

  const awaitPendingHooks = useDeferredHookMessages(pendingHookMessages, setMessages)
  const deferredMessages = useDeferredValue(messages)

  const {
    inputValue,
    setInputValueRaw,
    setInputValue,
    inputValueRef,
    insertTextRef,
    isPromptInputActive,
    setIsPromptInputActive,
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
    isTerminalFocused,
    terminalFocusRef,
  } = useReplInput({
    repinScroll,
    lastUserScrollTsRef,
    trySuggestBgPRIntercept: SUGGEST_BG_PR_NOOP,
  })
  const [isExiting, _setIsExiting] = useState(false)
  const [exitFlow, _setExitFlow] = useState<React.ReactNode>(null)

  useEffect(() => {
    if (ultraplanPendingChoice && showBashesDialog) {
      setShowBashesDialog(false)
    }
  }, [ultraplanPendingChoice, showBashesDialog, setShowBashesDialog])

  // ── Remote / response length ──
  const activeRemote = useReplActiveRemote({
    remoteSessionConfig,
    directConnectConfig,
    sshSession,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
    setLocalCommands,
  })
  const setResponseLength = useCallback(
    (f: (prev: number) => number) => {
      replStore.mutable.responseLengthRef = f(replStore.mutable.responseLengthRef)
    },
    [replStore],
  )
  const [responseLengthRef] = useState(() => ({
    get current() {
      return replStore.mutable.responseLengthRef
    },
  }))
  const regenerateConversationId = replStore.regenerateConversationId

  onResetAdditionalRef.current = () => {
    setUserInputOnProcessing(undefined)
    replStore.mutable.responseLengthRef = 0
    setStreamingToolUses([])
    endInteractionSpan()
    clearSpeculativeChecks()
  }

  const restoreReadFileState = useCallback(
    (messages: MessageType[], cwd: string) => {
      const extracted = extractReadFilesFromMessages(messages, cwd, READ_FILE_STATE_CACHE_SIZE)
      replStore.mutable.readFileState = mergeFileStateCaches(
        replStore.mutable.readFileState,
        extracted,
      )
      ingestBashToolsFromMessages(messages)
    },
    [ingestBashToolsFromMessages, replStore.mutable.readFileState, replStore.mutable],
  )

  const {
    onBeforeQuery: mrOnBeforeQuery,
    onTurnComplete: mrOnTurnComplete,
    render: mrRender,
  } = useMoreRight({
    enabled: moreRightEnabled,
    setMessages,
    inputValue,
    setInputValue,
    setToolJSX,
  })

  // ── Notifications cluster (needed by queryFlowCtx for swarmStartTimeRef/swarmBudgetInfoRef) ──
  const hasActivePrompt =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    sandboxPermissionRequestQueue.length > 0
  const {
    lspRecommendation,
    handleLspResponse,
    hintRecommendation,
    handleHintResponse,
    showEffortCallout,
    setShowEffortCallout,
    showRemoteCallout,
    showDesktopUpsellStartup,
    setShowDesktopUpsellStartup,
    swarmStartTimeRef,
    swarmBudgetInfoRef,
    frustrationDetection,
  } = useReplNotificationsCluster({
    mainLoopModel,
    messages,
    setMessages,
    isLoading,
    hasActivePrompt,
    hasRunningTeammates,
    isSurveyOpen: false,
  })

  useFileHistorySnapshotInit(initialFileHistorySnapshots, fileHistory, (fh) =>
    setAppState((prev) => ({ ...prev, fileHistory: fh })),
  )
  const setAbortControllerRef = useRef<
    React.Dispatch<React.SetStateAction<AbortController | null>>
  >(() => {})
  const resume = useReplSessionRestore({
    initialMessages,
    initialMainThreadAgentDefinition,
    replStore,
    setInputValue,
    setToolJSX,
    setAbortController: (v) => setAbortControllerRef.current(v),
    mainThreadAgentDefinition,
    setMainThreadAgentDefinition,
    resetLoadingState,
    restoreReadFileState,
    forceRenderTitle,
  })
  const { status: apiKeyStatus, reverify } = useApiKeyVerification()

  // ── focusedInputDialog ──
  const focusedInputDialog = getFocusedInputDialog({
    isExiting,
    exitFlow,
    isMessageSelectorVisible,
    isPromptInputActive,
    sandboxPermissionRequestQueue,
    toolJSX,
    toolUseConfirmQueue,
    promptQueue,
    workerSandboxPermissionsQueue: workerSandboxPermissions.queue,
    elicitationQueue: elicitation.queue,
    idleReturnPending,
    isLoading,
    ultraplanPendingChoice,
    ultraplanLaunchPending,
    showIdeOnboarding,
    showEffortCallout,
    showRemoteCallout,
    lspRecommendation,
    hintRecommendation,
    showDesktopUpsellStartup,
  })
  const hasSuppressedDialogs =
    isPromptInputActive &&
    (sandboxPermissionRequestQueue[0] || toolUseConfirmQueue[0] || promptQueue[0])
  focusedInputDialogRef.current = focusedInputDialog

  useEffect(() => {
    if (!isLoading) {
      return
    }
    const isPaused = focusedInputDialog === 'tool-permission'
    const now = Date.now()
    if (isPaused && pauseStartTimeRef.current === null) {
      pauseStartTimeRef.current = now
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      totalPausedMsRef.current += now - pauseStartTimeRef.current
      pauseStartTimeRef.current = null
    }
  }, [
    focusedInputDialog,
    isLoading,
    pauseStartTimeRef.current,
    pauseStartTimeRef,
    totalPausedMsRef,
  ])

  const prevDialogRef = useRef(focusedInputDialog)
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission'
    const now = focusedInputDialog === 'tool-permission'
    if (was !== now) {
      repinScroll()
    }
    prevDialogRef.current = focusedInputDialog
  }, [focusedInputDialog, repinScroll])

  // ── Cancel ──
  const {
    onCancel,
    handleQueuedCommandOnCancel,
    abortController,
    setAbortController,
    abortControllerRef,
  } = useReplOnCancel({
    focusedInputDialog,
    streamMode,
    queryGuard,
    streamingText,
    replStore,
    resetLoadingState,
    toolUseConfirmQueue,
    setToolUseConfirmQueue,
    promptQueue,
    setPromptQueue,
    activeRemote,
    mrOnTurnComplete,
    inputValue,
    setInputValue,
    setInputMode,
    setPastedContents,
  })
  setAbortControllerRef.current = setAbortController

  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () => setMessages((prev) => [...prev, createAgentsKilledMessage()]),
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

  const { sandboxWireCleanupRef } = useReplSandboxAsk({
    setSandboxPermissionRequestQueue,
    addNotification,
  })
  const setToolPermissionContext = useReplToolPermissionContext(setToolUseConfirmQueue)
  const canUseTool = useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext)
  const requestPrompt = useReplRequestPrompt(setPromptQueue)

  // 查询流上下文：每次 render 重新组装为普通对象（无 useMemo / dep 数组）。
  // useReplQueryCallbacks 内部用 latest-ref 读取它，故查询回调保持稳定身份且永不读到
  // 旧闭包 —— 消除了此前 49 字段 / 41 dep 双份手维护的 stale-closure footgun。
  const queryFlowCtx: QueryFlowContext = {
    replStore,
    appStore: store,
    setAppState,
    debug,
    customSystemPrompt,
    appendSystemPrompt,
    thinkingConfig,
    disabled,
    initialMcpClients,
    onTurnComplete,
    onBeforeQuery,
    commands,
    combinedInitialTools,
    theme,
    ideInstallationStatus,
    sessionTitle,
    titleDisabled,
    proactiveActive,
    mainLoopModel,
    setToolJSX,
    setResponseLength,
    addNotification,
    reverify,
    terminal,
    onCompactProgress,
    resume,
    requestPrompt,
    onChangeDynamicMcpConfig,
    setIDEToInstallExtension,
    canUseTool,
    resetLoadingState,
    setAbortController,
    forceRenderTitle,
    onStreamingText,
    setStreamingThinking,
    resetTimingRefs,
    setStreamingText,
    mrOnBeforeQuery,
    mrOnTurnComplete,
    terminalFocusRef,
    sendWireResultRef,
    restoreMessageSyncRef,
    inputValueRef,
    loadingStartTimeRef,
    totalPausedMsRef,
    swarmStartTimeRef,
    swarmBudgetInfoRef,
    toolPermissionContext,
  }

  const {
    getToolUseContext,
    handleBackgroundSession,
    onQueryEvent,
    onQueryImpl,
    onQuery,
    onSubmit,
  } = useReplQueryCallbacks({
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
  })

  useReplInitialMessage({
    replStore,
    store,
    isLoading,
    setMessages,
    setAppState,
    setAbortController,
    mainLoopModel,
    fileHistory,
    clearBashToolsTracking,
    awaitPendingHooks,
    onSubmit,
    onQuery,
  })

  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    })
  }, [])

  const rewindCtx = useMemo(
    () => ({ replStore, setMessages, setAppState, regenerateConversationId }),
    [setMessages, setAppState, replStore, regenerateConversationId],
  )
  const rewindConversationTo = useCallback(
    (message: UserMessage) => rewindConversationToImpl(rewindCtx, message),
    [rewindCtx],
  )
  const restoreMessageSync = useCallback(
    (message: UserMessage) =>
      restoreMessageSyncImpl(
        { rewindConversationTo, setInputValue, setInputMode, setPastedContents },
        message,
      ),
    [rewindConversationTo, setInputValue, setPastedContents, setInputMode],
  )
  restoreMessageSyncRef.current = restoreMessageSync
  const handleRestoreMessage = useCallback(
    async (message: UserMessage) => {
      setImmediate((r, m) => r(m), restoreMessageSync, message)
    },
    [restoreMessageSync],
  )

  const onInit = useCallback(() => onInitImpl({ reverify, replStore }), [reverify, replStore])
  useCostSummary(useFpsMetrics())
  useLogMessages(messages, messages.length === initialMessages?.length)

  const { sendWireResult } = useReplBridge(
    messages,
    setMessages,
    abortControllerRef,
    commands,
    mainLoopModel,
  )
  sendWireResultRef.current = sendWireResult
  useAfterFirstRender()

  const hasCountedQueueUseRef = useRef(false)
  useEffect(() => {
    if (queuedCommands.length < 1) {
      hasCountedQueueUseRef.current = false
      return
    }
    if (hasCountedQueueUseRef.current) {
      return
    }
    hasCountedQueueUseRef.current = true
    saveGlobalConfig((c) => ({ ...c, promptQueueUseCount: (c.promptQueueUseCount ?? 0) + 1 }))
  }, [queuedCommands.length])

  const executeQueuedInputCtx = useMemo(
    () => ({
      queryGuard,
      commands,
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      onBeforeQuery,
      canUseTool,
      addNotification,
      setMessages,
    }),
    [
      queryGuard,
      commands,
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      canUseTool,
      onQuery,
      addNotification,
      setAppState,
      onBeforeQuery,
      setMessages,
      setAbortController,
    ],
  )
  const executeQueuedInput = useCallback(
    (qc: QueuedCommand[]) => executeQueuedInputImpl(executeQueuedInputCtx, qc),
    [executeQueuedInputCtx],
  )
  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard,
  })

  useEffect(() => {
    activityManager.recordUserActivity()
    updateLastInteractionTime(true)
  }, [])
  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping()
    }
  }, [submitCount])
  useIdleNotification({
    isLoading,
    toolJSX,
    submitCount,
    lastQueryCompletionTime,
    terminal,
    focusedInputDialogRef,
  })
  useIdleReturnHint({
    lastQueryCompletionTime,
    isLoading,
    addNotification,
    removeNotification,
    replStore,
  })

  const incomingPromptCtx = useMemo(
    () => ({ queryGuard, setAbortController, onQuery, mainLoopModel }),
    [onQuery, mainLoopModel, queryGuard, setAbortController],
  )
  const handleIncomingPrompt = useCallback(
    (content: string, options?: { isMeta?: boolean }) =>
      handleIncomingPromptImpl(incomingPromptCtx, content, options),
    [incomingPromptCtx],
  )

  const voice = useReplVoice({ setInputValueRaw, inputValueRef, insertTextRef })
  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt,
  })
  useMailboxBridge({ isLoading, onSubmitMessage: handleIncomingPrompt })
  useReplScheduledTasks({ isLoading, assistantMode: store.getState().kairosEnabled, setMessages })

  if (isInternalBuild()) {
    // biome-ignore lint/correctness/useHookAtTopLevel: conditional for dead code elimination in external builds
    useTaskListWatcher({ taskListId, isLoading, onSubmitTask: handleIncomingPrompt })
    useReplProactive({
      isLoading: isLoading || initialMessage !== null,
      queuedCommandsLength: queuedCommands.length,
      hasActiveLocalJsxUI: isShowingLocalJSXCommand,
      isInPlanMode: toolPermissionContext.mode === 'plan',
      onSubmitTick: (p: string) => handleIncomingPrompt(p, { isMeta: true }),
      onQueueTick: (p: string) => enqueue({ mode: 'prompt', value: p, isMeta: true }),
    })
  }

  useGoalMode({
    isLoading: isLoading || initialMessage !== null,
    queuedCommandsLength: queuedCommands.length,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    onQueueGoalNudge: (p: string) => enqueue({ mode: 'prompt', value: p, isMeta: true }),
  })

  useEffect(() => {
    if (queuedCommands.some((cmd) => cmd.priority === 'now')) {
      abortControllerRef.current?.abort('interrupt')
    }
  }, [queuedCommands, abortControllerRef.current?.abort])

  useEffect(() => {
    void onInit()
    return () => {
      void diagnosticTracker.shutdown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onInit])

  const { internal_eventEmitter } = useStdin()
  const [remountKey, setRemountKey] = useState(0)
  useEffect(() => {
    const handleSuspend = () => {
      process.stdout.write(
        `\nZY Code has been suspended. Run \`fg\` to bring ZY Code back.\nNote: ctrl + z now suspends ZY Code, ctrl + _ undoes input.\n`,
      )
    }
    const handleResume = () => setRemountKey((p) => p + 1)
    internal_eventEmitter?.on('suspend', handleSuspend)
    internal_eventEmitter?.on('resume', handleResume)
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend)
      internal_eventEmitter?.off('resume', handleResume)
    }
  }, [internal_eventEmitter])

  const stopHookSpinnerSuffix = useStopHookSpinnerSuffix(messages, isLoading)
  const virtualScrollActive = isFullscreenEnvEnabled() && !disableVirtualScroll

  const {
    handleEnterTranscript,
    handleExitTranscript,
    transcriptMessages,
    transcriptStreamingToolUses,
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
    dumpMode,
    editorStatus,
  } = useReplTranscript({
    messages,
    streamingToolUses,
    deferredMessages,
    screen,
    virtualScrollActive,
    tools,
    setShowAllInTranscript,
  })

  useBackgroundTaskNavigation({
    onOpenBackgroundTasks: isShowingLocalJSXCommand ? undefined : () => setShowBashesDialog(true),
  })
  useTeammateViewAutoExit()

  if (screen === 'transcript') {
    const globalKeybindingProps = {
      screen,
      setScreen,
      showAllInTranscript,
      setShowAllInTranscript,
      messageCount: messages.length,
      onEnterTranscript: handleEnterTranscript,
      onExitTranscript: handleExitTranscript,
      virtualScrollActive,
      searchBarOpen: searchOpen,
    }
    return (
      <ReplTranscriptView
        replStore={replStore}
        disableVirtualScroll={disableVirtualScroll}
        dumpMode={dumpMode}
        screen={screen}
        showAllInTranscript={showAllInTranscript}
        showStatusInTerminalTab={showStatusInTerminalTab}
        titleIsAnimating={titleIsAnimating}
        terminalTitle={terminalTitle}
        titleDisabled={titleDisabled}
        transcriptMessages={transcriptMessages}
        transcriptStreamingToolUses={transcriptStreamingToolUses}
        inProgressToolUseIDs={inProgressToolUseIDs}
        conversationId={conversationId}
        agentDefinitions={agentDefinitions}
        streamingThinking={streamingThinking}
        isLoading={isLoading}
        toolJSX={toolJSX}
        tools={tools}
        commands={commands}
        scrollRef={scrollRef}
        jumpRef={jumpRef}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchCount={searchCount}
        setSearchCount={setSearchCount}
        searchCurrent={searchCurrent}
        setSearchCurrent={setSearchCurrent}
        onSearchMatchesChange={onSearchMatchesChange}
        setHighlight={setHighlight}
        scanElement={scanElement}
        setPositions={setPositions}
        editorStatus={editorStatus}
        globalKeybindingProps={globalKeybindingProps}
        cancelRequestProps={cancelRequestProps}
        focusedInputDialog={focusedInputDialog}
        voice={voice}
        onSubmit={onSubmit}
        handleOpenRateLimitOptions={handleOpenRateLimitOptions}
      />
    )
  }

  const mainReturn = (
    <ReplMainView
      replStore={replStore}
      screen={screen}
      setScreen={setScreen}
      showAllInTranscript={showAllInTranscript}
      setShowAllInTranscript={setShowAllInTranscript}
      titleIsAnimating={titleIsAnimating}
      terminalTitle={terminalTitle}
      titleDisabled={titleDisabled}
      showStatusInTerminalTab={showStatusInTerminalTab}
      disableMessageActions={disableMessageActions}
      handleEnterTranscript={handleEnterTranscript}
      handleExitTranscript={handleExitTranscript}
      searchBarOpen={searchOpen}
      virtualScrollActive={virtualScrollActive}
      inputValue={inputValue}
      setInputValue={setInputValue}
      inputMode={inputMode}
      setInputMode={setInputMode}
      stashedPrompt={stashedPrompt}
      setStashedPrompt={setStashedPrompt}
      pastedContents={pastedContents}
      setPastedContents={setPastedContents}
      vimMode={vimMode}
      setVimMode={setVimMode}
      showBashesDialog={showBashesDialog}
      setShowBashesDialog={setShowBashesDialog}
      isSearchingHistory={isSearchingHistory}
      setIsSearchingHistory={setIsSearchingHistory}
      isHelpOpen={isHelpOpen}
      setIsHelpOpen={setIsHelpOpen}
      insertTextRef={insertTextRef}
      scrollRef={scrollRef}
      modalScrollRef={modalScrollRef}
      composedOnScroll={composedOnScroll}
      dividerYRef={dividerYRef}
      unseenDivider={unseenDivider}
      jumpToNew={jumpToNew}
      repinScroll={repinScroll}
      deferredMessages={deferredMessages}
      isLoading={isLoading}
      isExternalLoading={isExternalLoading}
      showStreamingText={showStreamingText}
      visibleStreamingText={visibleStreamingText}
      streamingThinking={streamingThinking}
      spinnerMessage={spinnerMessage}
      spinnerColor={spinnerColor}
      spinnerShimmerColor={spinnerShimmerColor}
      loadingStartTimeRef={loadingStartTimeRef}
      totalPausedMsRef={totalPausedMsRef}
      pauseStartTimeRef={pauseStartTimeRef}
      stopHookSpinnerSuffix={stopHookSpinnerSuffix}
      responseLengthRef={responseLengthRef}
      clearBashToolsTracking={clearBashToolsTracking}
      onSubmit={onSubmit}
      getToolUseContext={getToolUseContext}
      onCancel={onCancel}
      handleQueuedCommandOnCancel={handleQueuedCommandOnCancel}
      abortController={abortController}
      isRemoteSession={isRemoteSession}
      voice={voice}
      handleBackgroundSession={handleBackgroundSession}
      mrRender={mrRender}
      regenerateConversationId={regenerateConversationId}
      tools={tools}
      commands={commands}
      mcpClients={mcpClients}
      strictMcpConfig={strictMcpConfig}
      setToolPermissionContext={setToolPermissionContext}
      canUseTool={canUseTool}
      sandboxWireCleanupRef={sandboxWireCleanupRef}
      focusedInputDialog={focusedInputDialog}
      hasSuppressedDialogs={!!hasSuppressedDialogs}
      ideSelection={ideSelection}
      setIDESelection={setIDESelection}
      ideInstallationStatus={ideInstallationStatus}
      showIdeOnboarding={showIdeOnboarding}
      setShowIdeOnboarding={setShowIdeOnboarding}
      showEffortCallout={showEffortCallout}
      setShowEffortCallout={setShowEffortCallout}
      showRemoteCallout={showRemoteCallout}
      showDesktopUpsellStartup={showDesktopUpsellStartup}
      setShowDesktopUpsellStartup={setShowDesktopUpsellStartup}
      lspRecommendation={lspRecommendation}
      handleLspResponse={handleLspResponse}
      hintRecommendation={hintRecommendation}
      handleHintResponse={handleHintResponse}
      frustrationDetection={frustrationDetection}
      remountKey={remountKey}
      apiKeyStatus={apiKeyStatus}
      debug={debug}
      disabled={disabled}
      rewindConversationTo={rewindConversationTo}
      handleRestoreMessage={handleRestoreMessage}
      autoUpdaterResult={autoUpdaterResult}
      setAutoUpdaterResult={setAutoUpdaterResult}
    />
  )
  if (isFullscreenEnvEnabled()) {
    return (
      <ReplStoreProvider store={replStore}>
        <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{mainReturn}</AlternateScreen>
      </ReplStoreProvider>
    )
  }
  return <ReplStoreProvider store={replStore}>{mainReturn}</ReplStoreProvider>
}
