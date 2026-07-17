import { feature } from 'bun:bundle'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useCommandQueue } from 'src/hooks/useCommandQueue.js'
import { useAppState, useAppStateStore, useSetAppState } from 'src/state/AppState.js'
import type { FooterItem } from 'src/state/AppStateStore.js'
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js'
import { hasCommand } from '../../commands/index.js'
import { useIsModalOverlayActive } from '../../context/OverlayContext.js'
import { parseReferences } from '../../services/session-storage/history.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { findSlashCommandPositions } from '../../services/suggestions/commandSuggestions.js'
import {
  findSlackChannelPositions,
  getKnownChannelsVersion,
  hasSlackMcpServer,
  subscribeKnownChannels,
} from '../../services/suggestions/slackChannelSuggestions.js'
import { isInProcessEnabled } from '../../services/swarm/backends/registry.js'
import {
  findUltraplanTriggerPositions,
  findUltrareviewTriggerPositions,
} from '../../services/ultraplan/keyword.js'
import { getViewedTeammateTask } from '../../state/selectors.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { getRunningTeammatesSorted } from '../../tasks/in-process-teammate-task/InProcessTeammateTask.js'
import { isPanelAgentTask } from '../../tasks/local-agent-task/LocalAgentTask.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { count } from '../../utils/array.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { findBtwTriggerPositions } from '../../utils/sideQuestion.js'
import type { TeamSummary } from '../../utils/teamDiscovery.js'
import { findThinkingTriggerPositions } from '../../utils/thinking.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'
import { useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js'
import { shouldHideTasksFooter } from '../tasks/TaskStatusUtils.js'
import { getValueFromInput } from './inputModes.js'
import type { Props } from './promptInputTypes.js'

// Bottom slot has maxHeight="50%"; reserve lines for footer, border, status.
const _PROMPT_FOOTER_LINES = 5

const _MIN_INPUT_VIEWPORT_LINES = 3

/**
 * Compute the initial paste ID by finding the max ID used in existing messages.
 * This handles --continue/--resume scenarios where we need to avoid ID collisions.
 */
function getInitialPasteId(messages: Message[]): number {
  let maxId = 0
  for (const message of messages) {
    if (message.type === 'user') {
      // Check image paste IDs
      if (message.imagePasteIds) {
        for (const id of message.imagePasteIds) {
          if (id > maxId) {
            maxId = id
          }
        }
      }
      // Check text paste references in message content
      if (Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            const refs = parseReferences(block.text)
            for (const ref of refs) {
              if (ref.id > maxId) {
                maxId = ref.id
              }
            }
          }
        }
      }
    }
  }
  return maxId + 1
}
export function usePromptInputState({
  debug,
  ideSelection,
  toolPermissionContext,
  setToolPermissionContext,
  apiKeyStatus,
  commands,
  agents,
  isLoading,
  verbose,
  messages,
  onAutoUpdaterResult,
  autoUpdaterResult,
  input,
  onInputChange,
  mode,
  onModeChange,
  stashedPrompt,
  setStashedPrompt,
  submitCount,
  onShowMessageSelector,
  onMessageActionsEnter,
  mcpClients,
  pastedContents,
  setPastedContents,
  vimMode,
  setVimMode,
  showBashesDialog,
  setShowBashesDialog,
  onExit,
  getToolUseContext,
  onSubmit: onSubmitProp,
  onAgentSubmit,
  isSearchingHistory,
  setIsSearchingHistory,
  onDismissSideQuestion,
  isSideQuestionVisible,
  helpOpen,
  setHelpOpen,
  hasSuppressedDialogs,
  isLocalJSXCommandActive = false,
  insertTextRef,
  voiceInterimRange,
}: Props) {
  const { columns, rows } = useTerminalSize()
  const mainLoopModel = useMainLoopModel()

  // A local-jsx command (e.g., /mcp while agent is running) renders a full-
  // screen dialog on top of PromptInput via the immediate-command path with
  // shouldHidePromptInput: false. Those dialogs don't register in the overlay
  // system, so treat them as a modal overlay here to stop navigation keys from
  // leaking into TextInput/footer handlers and stacking a second dialog.
  const isModalOverlayActive = useIsModalOverlayActive() || isLocalJSXCommandActive

  const [isAutoUpdating, setIsAutoUpdating] = useState(false)

  const [exitMessage, setExitMessage] = useState<{
    show: boolean
    key?: string
  }>({
    show: false,
  })

  const [cursorOffset, setCursorOffset] = useState<number>(input.length)

  // Track the last input value set via internal handlers so we can detect
  // external input changes (e.g. speech-to-text injection) and move cursor to end.
  const lastInternalInputRef = React.useRef(input)

  if (input !== lastInternalInputRef.current) {
    // Input changed externally (not through any internal handler) — move cursor to end
    setCursorOffset(input.length)
    lastInternalInputRef.current = input
  }

  // Wrap onInputChange to track internal changes before they trigger re-render
  const trackAndSetInput = React.useCallback(
    (value: string) => {
      lastInternalInputRef.current = value
      onInputChange(value)
    },
    [onInputChange],
  )

  // Expose an insertText function so callers (e.g. STT) can splice text at the
  // current cursor position instead of replacing the entire input.
  if (insertTextRef) {
    insertTextRef.current = {
      cursorOffset,
      insert: (text: string) => {
        const needsSpace = cursorOffset === input.length && input.length > 0 && !/\s$/.test(input)
        const insertText = needsSpace ? ` ${text}` : text
        const newValue = input.slice(0, cursorOffset) + insertText + input.slice(cursorOffset)
        lastInternalInputRef.current = newValue
        onInputChange(newValue)
        setCursorOffset(cursorOffset + insertText.length)
      },
      setInputWithCursor: (value: string, cursor: number) => {
        lastInternalInputRef.current = value
        onInputChange(value)
        setCursorOffset(cursor)
      },
    }
  }

  const store = useAppStateStore()

  const setAppState = useSetAppState()

  const tasks = useAppState((s) => s.tasks)

  const replWireConnected = useAppState((s) => s.replWireConnected)

  const replWireExplicit = useAppState((s) => s.replWireExplicit)

  const replWireReconnecting = useAppState((s) => s.replWireReconnecting)

  // Must match WireStatusIndicator's render condition (PromptInputFooter.tsx) —
  // the pill returns null for implicit-and-not-reconnecting, so nav must too,
  // otherwise bridge becomes an invisible selection stop.
  const bridgeFooterVisible = replWireConnected && (replWireExplicit || replWireReconnecting)

  // Tmux pill (ant-only) — visible when there's an active tungsten session
  const hasTungstenSession = useAppState(
    (s) => isInternalBuild() && s.tungstenActiveSession !== undefined,
  )

  const tmuxFooterVisible = isInternalBuild() && hasTungstenSession

  // WebBrowser pill — visible when a browser is open
  const bagelFooterVisible = useAppState((_s) => false)

  const teamContext = useAppState((s) => s.teamContext)

  const queuedCommands = useCommandQueue()

  const promptSuggestionState = useAppState((s) => s.promptSuggestion)

  const speculation = useAppState((s) => s.speculation)

  const speculationSessionTimeSavedMs = useAppState((s) => s.speculationSessionTimeSavedMs)

  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)

  const viewSelectionMode = useAppState((s) => s.viewSelectionMode)

  const showSpinnerTree = useAppState((s) => s.expandedView) === 'teammates'

  // Brief mode: BriefSpinner/BriefIdleStatus own the 2-row footprint above
  // the input. Dropping marginTop here lets the spinner sit flush against
  // the input bar. viewingAgentTaskId mirrors the gate on both (Spinner.tsx,
  // REPL.tsx) — teammate view falls back to SpinnerWithVerbInner which has
  // its own marginTop, so the gap stays even without ours.
  const briefOwnsGap =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s) => s.isBriefOnly) && !viewingAgentTaskId
      : false

  const mainLoopModel_ = useAppState((s) => s.mainLoopModel)

  const mainLoopModelForSession = useAppState((s) => s.mainLoopModelForSession)

  const thinkingEnabled = useAppState((s) => s.thinkingEnabled)

  const effortValue = useAppState((s) => s.effortValue)

  const viewedTeammate = getViewedTeammateTask(store.getState())

  const viewingAgentName = viewedTeammate?.identity.agentName

  // identity.color is typed as `string | undefined` (not AgentColorName) because
  // teammate identity comes from file-based config. Validate before casting to
  // ensure we only use valid color names (falls back to cyan if invalid).
  const viewingAgentColor =
    viewedTeammate?.identity.color &&
    AGENT_COLORS.includes(viewedTeammate.identity.color as AgentColorName)
      ? (viewedTeammate.identity.color as AgentColorName)
      : undefined

  // In-process teammates sorted alphabetically for footer team selector
  const inProcessTeammates = useMemo(() => getRunningTeammatesSorted(tasks), [tasks])

  // Team mode: all background tasks are in-process teammates
  const isTeammateMode = inProcessTeammates.length > 0 || viewedTeammate !== undefined

  // When viewing a teammate, show their permission mode in the footer instead of the leader's
  const effectiveToolPermissionContext = useMemo((): ToolPermissionContext => {
    if (viewedTeammate) {
      return {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode,
      }
    }
    return toolPermissionContext
  }, [viewedTeammate, toolPermissionContext])

  const onSubmitRef = useRef<
    (inputParam: string, isSubmittingSlashCommand?: boolean) => Promise<void>
  >(async () => {})
  const { historyQuery, setHistoryQuery, historyMatch, historyFailedMatch } = useHistorySearch(
    (entry) => {
      setPastedContents(entry.pastedContents)
      void onSubmitRef.current(entry.display)
    },
    input,
    trackAndSetInput,
    setCursorOffset,
    cursorOffset,
    onModeChange,
    mode,
    isSearchingHistory,
    setIsSearchingHistory,
    setPastedContents,
    pastedContents,
  )

  // Counter for paste IDs (shared between images and text).
  // Compute initial value once from existing messages (for --continue/--resume).
  // useRef(fn()) evaluates fn() on every render and discards the result after
  // mount — getInitialPasteId walks all messages + regex-scans text blocks,
  // so guard with a lazy-init pattern to run it exactly once.
  const nextPasteIdRef = useRef(-1)

  if (nextPasteIdRef.current === -1) {
    nextPasteIdRef.current = getInitialPasteId(messages)
  }

  // Armed by onImagePaste; if the very next keystroke is a non-space
  // printable, inputFilter prepends a space before it. Any other input
  // (arrow, escape, backspace, paste, space) disarms without inserting.
  const pendingSpaceAfterPillRef = useRef(false)

  const [showTeamsDialog, setShowTeamsDialog] = useState(false)

  const [showBridgeDialog, setShowBridgeDialog] = useState(false)

  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0)

  // -1 sentinel: tasks pill is selected but no specific agent row is selected yet.
  // First ↓ selects the pill, second ↓ moves to row 0. Prevents double-select
  // of pill + row when both bg tasks (pill) and forked agents (rows) are visible.
  const coordinatorTaskIndex = useAppState((s) => s.coordinatorTaskIndex)

  const setCoordinatorTaskIndex = useCallback(
    (v: number | ((prev: number) => number)) =>
      setAppState((prev) => {
        const next = typeof v === 'function' ? v(prev.coordinatorTaskIndex) : v
        if (next === prev.coordinatorTaskIndex) {
          return prev
        }
        return {
          ...prev,
          coordinatorTaskIndex: next,
        }
      }),
    [setAppState],
  )

  const coordinatorTaskCount = useCoordinatorTaskCount()

  // The pill (BackgroundTaskStatus) only renders when non-local_agent bg tasks
  // exist. When only local_agent tasks are running (coordinator/fork mode), the
  // pill is absent, so the -1 sentinel would leave nothing visually selected.
  // In that case, skip -1 and treat 0 as the minimum selectable index.
  const hasBgTaskPill = useMemo(
    () => Object.values(tasks).some((t) => isBackgroundTask(t) && !isPanelAgentTask(t)),
    [tasks],
  )

  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0

  // Clamp index when tasks complete and the list shrinks beneath the cursor
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      setCoordinatorTaskIndex(Math.max(minCoordinatorIndex, coordinatorTaskCount - 1))
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setCoordinatorTaskIndex(minCoordinatorIndex)
    }
  }, [coordinatorTaskCount, coordinatorTaskIndex, minCoordinatorIndex, setCoordinatorTaskIndex])

  const [isPasting, setIsPasting] = useState(false)

  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false)

  const [showModelPicker, setShowModelPicker] = useState(false)

  const [showQuickOpen, setShowQuickOpen] = useState(false)

  const [showGlobalSearch, setShowGlobalSearch] = useState(false)

  const [showHistoryPicker, setShowHistoryPicker] = useState(false)

  const [showThinkingToggle, setShowThinkingToggle] = useState(false)

  const [showAutoModeOptIn, setShowAutoModeOptIn] = useState(false)

  const [previousModeBeforeAuto, setPreviousModeBeforeAuto] = useState<PermissionMode | null>(null)

  const autoModeOptInTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Check if cursor is on the first line of input
  const isCursorOnFirstLine = useMemo(() => {
    const firstNewlineIndex = input.indexOf('\n')
    if (firstNewlineIndex === -1) {
      return true // No newlines, cursor is always on first line
    }
    return cursorOffset <= firstNewlineIndex
  }, [input, cursorOffset])

  const isCursorOnLastLine = useMemo(() => {
    const lastNewlineIndex = input.lastIndexOf('\n')
    if (lastNewlineIndex === -1) {
      return true // No newlines, cursor is always on last line
    }
    return cursorOffset > lastNewlineIndex
  }, [input, cursorOffset])

  // Derive team info from teamContext (no filesystem I/O needed)
  // A session can only lead one team at a time
  const cachedTeams: TeamSummary[] = useMemo(() => {
    if (!isAgentSwarmsEnabled()) {
      return []
    }
    // In-process mode uses Shift+Down/Up navigation instead of footer menu
    if (isInProcessEnabled()) {
      return []
    }
    if (!teamContext) {
      return []
    }
    const teammateCount = count(
      Object.values(teamContext.teammates) as { name: string }[],
      (t) => t.name !== 'team-lead',
    )
    return [
      {
        name: teamContext.teamName,
        memberCount: teammateCount,
        runningCount: 0,
        idleCount: 0,
      },
    ]
  }, [teamContext])

  // ─── Footer pill navigation ─────────────────────────────────────────────
  // Which pills render below the input box. Order here IS the nav order
  // (down/right = forward, up/left = back).
  const runningTaskCount = useMemo(
    () => count(Object.values(tasks) as { status: string }[], (t) => t.status === 'running'),
    [tasks],
  )

  // Panel shows retained-completed agents too (getVisibleAgentTasks), so the
  // pill must stay navigable whenever the panel has rows — not just when
  // something is running.
  const tasksFooterVisible =
    (runningTaskCount > 0 || coordinatorTaskCount > 0) &&
    !shouldHideTasksFooter(tasks, showSpinnerTree)

  const teamsFooterVisible = cachedTeams.length > 0

  const footerItems = useMemo(
    () =>
      [
        tasksFooterVisible && 'tasks',
        tmuxFooterVisible && 'tmux',
        bagelFooterVisible && 'bagel',
        teamsFooterVisible && 'teams',
        bridgeFooterVisible && 'bridge',
      ].filter(Boolean) as FooterItem[],
    [
      tasksFooterVisible,
      tmuxFooterVisible,
      bagelFooterVisible,
      teamsFooterVisible,
      bridgeFooterVisible,
    ],
  )

  // Effective selection: null if the selected pill stopped rendering (bridge
  // disconnected, task finished). The derivation makes the UI correct
  // immediately; the useEffect below clears the raw state so it doesn't
  // resurrect when the same pill reappears (new task starts → focus stolen).
  const rawFooterSelection = useAppState((s) => s.footerSelection)

  const footerItemSelected =
    rawFooterSelection && footerItems.includes(rawFooterSelection) ? rawFooterSelection : null

  useEffect(() => {
    if (rawFooterSelection && !footerItemSelected) {
      setAppState((prev) =>
        prev.footerSelection === null
          ? prev
          : {
              ...prev,
              footerSelection: null,
            },
      )
    }
  }, [rawFooterSelection, footerItemSelected, setAppState])

  const tasksSelected = footerItemSelected === 'tasks'

  const tmuxSelected = footerItemSelected === 'tmux'

  const _bagelSelected = footerItemSelected === 'bagel'

  const teamsSelected = footerItemSelected === 'teams'

  const bridgeSelected = footerItemSelected === 'bridge'

  function selectFooterItem(item: FooterItem | null): void {
    setAppState((prev) =>
      prev.footerSelection === item
        ? prev
        : {
            ...prev,
            footerSelection: item,
          },
    )
    if (item === 'tasks') {
      setTeammateFooterIndex(0)
      setCoordinatorTaskIndex(minCoordinatorIndex)
    }
  }

  // delta: +1 = down/right, -1 = up/left. Returns true if nav happened
  // (including deselecting at the start), false if at a boundary.
  function navigateFooter(delta: 1 | -1, exitAtStart = false): boolean {
    const idx = footerItemSelected ? footerItems.indexOf(footerItemSelected) : -1
    const next = footerItems[idx + delta]
    if (next) {
      selectFooterItem(next)
      return true
    }
    if (delta < 0 && exitAtStart) {
      selectFooterItem(null)
      return true
    }
    return false
  }

  // Prompt suggestion hook - reads suggestions generated by forked agent in query loop
  const {
    suggestion: promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown,
  } = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  })

  const displayedValue = useMemo(
    () =>
      isSearchingHistory && historyMatch
        ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display)
        : input,
    [isSearchingHistory, historyMatch, input],
  )

  const thinkTriggers = useMemo(
    () => findThinkingTriggerPositions(displayedValue),
    [displayedValue],
  )

  const ultraplanSessionUrl = useAppState((s) => s.ultraplanSessionUrl)

  const ultraplanLaunching = useAppState((s) => s.ultraplanLaunching)

  const ultraplanTriggers = useMemo(
    () =>
      feature('ULTRAPLAN')
        ? !ultraplanSessionUrl && !ultraplanLaunching
          ? findUltraplanTriggerPositions(displayedValue)
          : []
        : [],
    [displayedValue, ultraplanSessionUrl, ultraplanLaunching],
  )

  const ultrareviewTriggers = useMemo(
    () => (isUltrareviewEnabled() ? findUltrareviewTriggerPositions(displayedValue) : []),
    [displayedValue],
  )

  const btwTriggers = useMemo(() => findBtwTriggerPositions(displayedValue), [displayedValue])

  const slashCommandTriggers = useMemo(() => {
    const positions = findSlashCommandPositions(displayedValue)
    // Only highlight valid commands
    return positions.filter((pos) => {
      const commandName = displayedValue.slice(pos.start + 1, pos.end) // +1 to skip "/"
      return hasCommand(commandName, commands)
    })
  }, [displayedValue, commands])

  const tokenBudgetTriggers = useMemo(
    () => (feature('TOKEN_BUDGET') ? findTokenBudgetPositions(displayedValue) : []),
    [displayedValue],
  )

  const _knownChannelsVersion = useSyncExternalStore(
    subscribeKnownChannels,
    getKnownChannelsVersion,
  )

  const slackChannelTriggers = useMemo(
    () =>
      hasSlackMcpServer(store.getState().mcp.clients)
        ? findSlackChannelPositions(displayedValue)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable ref
    [displayedValue, store.getState],
  )
  return {
    debug,
    ideSelection,
    toolPermissionContext,
    setToolPermissionContext,
    apiKeyStatus,
    commands,
    agents,
    isLoading,
    verbose,
    messages,
    onAutoUpdaterResult,
    autoUpdaterResult,
    input,
    onInputChange,
    mode,
    onModeChange,
    stashedPrompt,
    setStashedPrompt,
    submitCount,
    onShowMessageSelector,
    onMessageActionsEnter,
    mcpClients,
    pastedContents,
    setPastedContents,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    onExit,
    getToolUseContext,
    onSubmitProp,
    onAgentSubmit,
    isSearchingHistory,
    setIsSearchingHistory,
    onDismissSideQuestion,
    isSideQuestionVisible,
    helpOpen,
    setHelpOpen,
    hasSuppressedDialogs,
    isLocalJSXCommandActive,
    insertTextRef,
    voiceInterimRange,
    mainLoopModel,
    isModalOverlayActive,
    isAutoUpdating,
    setIsAutoUpdating,
    exitMessage,
    setExitMessage,
    cursorOffset,
    setCursorOffset,
    lastInternalInputRef,
    trackAndSetInput,
    store,
    setAppState,
    tasks,
    replWireConnected,
    replWireExplicit,
    replWireReconnecting,
    bridgeFooterVisible,
    hasTungstenSession,
    tmuxFooterVisible,
    bagelFooterVisible,
    teamContext,
    queuedCommands,
    promptSuggestionState,
    speculation,
    speculationSessionTimeSavedMs,
    viewingAgentTaskId,
    viewSelectionMode,
    showSpinnerTree,
    briefOwnsGap,
    mainLoopModel_,
    mainLoopModelForSession,
    thinkingEnabled,
    effortValue,
    viewedTeammate,
    viewingAgentName,
    viewingAgentColor,
    inProcessTeammates,
    isTeammateMode,
    effectiveToolPermissionContext,
    historyQuery,
    setHistoryQuery,
    historyMatch,
    historyFailedMatch,
    nextPasteIdRef,
    pendingSpaceAfterPillRef,
    showTeamsDialog,
    setShowTeamsDialog,
    showBridgeDialog,
    setShowBridgeDialog,
    teammateFooterIndex,
    setTeammateFooterIndex,
    coordinatorTaskIndex,
    setCoordinatorTaskIndex,
    coordinatorTaskCount,
    hasBgTaskPill,
    minCoordinatorIndex,
    isPasting,
    setIsPasting,
    isExternalEditorActive,
    setIsExternalEditorActive,
    showModelPicker,
    setShowModelPicker,
    showQuickOpen,
    setShowQuickOpen,
    showGlobalSearch,
    setShowGlobalSearch,
    showHistoryPicker,
    setShowHistoryPicker,
    showThinkingToggle,
    setShowThinkingToggle,
    showAutoModeOptIn,
    setShowAutoModeOptIn,
    previousModeBeforeAuto,
    setPreviousModeBeforeAuto,
    autoModeOptInTimeoutRef,
    isCursorOnFirstLine,
    isCursorOnLastLine,
    cachedTeams,
    runningTaskCount,
    tasksFooterVisible,
    teamsFooterVisible,
    footerItems,
    rawFooterSelection,
    footerItemSelected,
    tasksSelected,
    tmuxSelected,
    _bagelSelected,
    teamsSelected,
    bridgeSelected,
    selectFooterItem,
    navigateFooter,
    promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown,
    displayedValue,
    thinkTriggers,
    ultraplanSessionUrl,
    ultraplanLaunching,
    ultraplanTriggers,
    ultrareviewTriggers,
    btwTriggers,
    slashCommandTriggers,
    tokenBudgetTriggers,
    _knownChannelsVersion,
    slackChannelTriggers,
    columns,
    rows,
    onSubmitRef,
  }
}
