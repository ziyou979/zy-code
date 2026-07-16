import { feature } from 'bun:bundle'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { logEvent } from 'src/services/analytics/index.js'
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js'
import { parseReferences } from '../../services/session-storage/history.js'
import { type HistoryMode, useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { Text } from '../../ink.js'
import { abortPromptSuggestion } from '../../services/prompt-suggestion/promptSuggestion.js'
import { abortSpeculation } from '../../services/prompt-suggestion/speculation.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { getGlobalConfig, type PastedContent } from '../../services/config/config.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import type { Theme } from '../../utils/theme.js'
import { getRainbowColor, isUltrathinkEnabled } from '../../utils/thinking.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { FOOTER_TEMPORARY_STATUS_TIMEOUT } from './Notifications.js'
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { usePromptInputState } from './usePromptInputState.js'
export function usePromptInputSuggestions(context: ReturnType<typeof usePromptInputState>) {
  const {
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
  } = context

  // Find @name mentions and highlight with team member's color
  const memberMentionHighlights = useMemo((): Array<{
    start: number
    end: number
    themeColor: keyof Theme
  }> => {
    if (!isAgentSwarmsEnabled()) {
      return []
    }
    if (!teamContext?.teammates) {
      return []
    }
    const highlights: Array<{
      start: number
      end: number
      themeColor: keyof Theme
    }> = []
    const members = teamContext.teammates
    if (!members) {
      return highlights
    }

    // Find all @name patterns in the input
    const regex = /(^|\s)@([\w-]+)/g
    const memberValues = Object.values(members)
    let match
    while ((match = regex.exec(displayedValue)) !== null) {
      const leadingSpace = match[1] ?? ''
      const nameStart = match.index + leadingSpace.length
      const fullMatch = match[0].trimStart()
      const name = match[2]

      // Check if this name matches a team member
      const member = memberValues.find((t: { name: string }) => t.name === name)
      if (member?.color) {
        const themeColor = AGENT_COLOR_TO_THEME_COLOR[member.color as AgentColorName]
        if (themeColor) {
          highlights.push({
            start: nameStart,
            end: nameStart + fullMatch.length,
            themeColor,
          })
        }
      }
    }
    return highlights
  }, [displayedValue, teamContext])

  const imageRefPositions = useMemo(
    () =>
      parseReferences(displayedValue)
        .filter((r) => r.match.startsWith('[Image'))
        .map((r) => ({
          start: r.index,
          end: r.index + r.match.length,
        })),
    [displayedValue],
  )

  // chip.start is the "selected" state: the inverted chip IS the cursor.
  // chip.end stays a normal position so you can park the cursor right after
  // `]` like any other character.
  const cursorAtImageChip = imageRefPositions.some((r) => r.start === cursorOffset)

  // up/down movement or a fullscreen click can land the cursor strictly
  // inside a chip; snap to the nearer boundary so it's never editable
  // char-by-char.
  useEffect(() => {
    const inside = imageRefPositions.find((r) => cursorOffset > r.start && cursorOffset < r.end)
    if (inside) {
      const mid = (inside.start + inside.end) / 2
      setCursorOffset(cursorOffset < mid ? inside.start : inside.end)
    }
  }, [cursorOffset, imageRefPositions, setCursorOffset])

  const combinedHighlights = useMemo((): TextHighlight[] => {
    const highlights: TextHighlight[] = []

    // Invert the [Image #N] chip when the cursor is at chip.start (the
    // "selected" state) so backspace-to-delete is visually obvious.
    for (const ref of imageRefPositions) {
      if (cursorOffset === ref.start) {
        highlights.push({
          start: ref.start,
          end: ref.end,
          color: undefined,
          inverse: true,
          priority: 8,
        })
      }
    }
    if (isSearchingHistory && historyMatch && !historyFailedMatch) {
      highlights.push({
        start: cursorOffset,
        end: cursorOffset + historyQuery.length,
        color: 'warning',
        priority: 20,
      })
    }

    // Add "btw" highlighting (solid yellow)
    for (const trigger of btwTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'warning',
        priority: 15,
      })
    }

    // Add /command highlighting (blue)
    for (const trigger of slashCommandTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      })
    }

    // Add token budget highlighting (blue)
    for (const trigger of tokenBudgetTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      })
    }
    for (const trigger of slackChannelTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      })
    }

    // Add @name highlighting with team member's color
    for (const mention of memberMentionHighlights) {
      highlights.push({
        start: mention.start,
        end: mention.end,
        color: mention.themeColor,
        priority: 5,
      })
    }

    // Dim interim voice dictation text
    if (voiceInterimRange) {
      highlights.push({
        start: voiceInterimRange.start,
        end: voiceInterimRange.end,
        color: undefined,
        dimColor: true,
        priority: 1,
      })
    }

    // Rainbow highlighting for ultrathink keyword (per-character cycling colors)
    if (isUltrathinkEnabled()) {
      for (const trigger of thinkTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10,
          })
        }
      }
    }

    // Same rainbow treatment for the ultraplan keyword
    if (feature('ULTRAPLAN')) {
      for (const trigger of ultraplanTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10,
          })
        }
      }
    }

    // Same rainbow treatment for the ultrareview keyword
    for (const trigger of ultrareviewTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10,
        })
      }
    }

    return highlights
  }, [
    isSearchingHistory,
    historyQuery,
    historyMatch,
    historyFailedMatch,
    cursorOffset,
    btwTriggers,
    imageRefPositions,
    memberMentionHighlights,
    slashCommandTriggers,
    tokenBudgetTriggers,
    slackChannelTriggers,
    voiceInterimRange,
    thinkTriggers,
    ultraplanTriggers,
    ultrareviewTriggers,
  ])

  const { addNotification, removeNotification } = useNotifications()

  // Show ultrathink notification
  useEffect(() => {
    if (thinkTriggers.length && isUltrathinkEnabled()) {
      addNotification({
        key: 'ultrathink-active',
        text: 'Effort set to high for this turn',
        priority: 'immediate',
        timeoutMs: 5000,
      })
    } else {
      removeNotification('ultrathink-active')
    }
  }, [addNotification, removeNotification, thinkTriggers.length])

  useEffect(() => {
    if (feature('ULTRAPLAN') ? ultraplanTriggers.length > 0 : false) {
      addNotification({
        key: 'ultraplan-active',
        text: 'This prompt will launch an ultraplan session in ZY Code on the web',
        priority: 'immediate',
        timeoutMs: 5000,
      })
    } else {
      removeNotification('ultraplan-active')
    }
  }, [addNotification, removeNotification, ultraplanTriggers.length])

  useEffect(() => {
    if (isUltrareviewEnabled() && ultrareviewTriggers.length) {
      addNotification({
        key: 'ultrareview-active',
        text: 'Run /ultrareview after Zy finishes to review these changes in the cloud',
        priority: 'immediate',
        timeoutMs: 5000,
      })
    }
  }, [addNotification, ultrareviewTriggers.length])

  // Track input length for stash hint
  const prevInputLengthRef = useRef(input.length)

  const peakInputLengthRef = useRef(input.length)

  // Dismiss stash hint when user makes any input change
  const dismissStashHint = useCallback(() => {
    removeNotification('stash-hint')
  }, [removeNotification])

  // Show stash hint when user gradually clears substantial input
  useEffect(() => {
    const prevLength = prevInputLengthRef.current
    const peakLength = peakInputLengthRef.current
    const currentLength = input.length
    prevInputLengthRef.current = currentLength

    // Update peak when input grows
    if (currentLength > peakLength) {
      peakInputLengthRef.current = currentLength
      return
    }

    // Reset state when input is empty
    if (currentLength === 0) {
      peakInputLengthRef.current = 0
      return
    }

    // Detect gradual clear: peak was high, current is low, but this wasn't a single big jump
    // (rapid clears like esc-esc go from 20+ to 0 in one step)
    const clearedSubstantialInput = peakLength >= 20 && currentLength <= 5
    const wasRapidClear = prevLength >= 20 && currentLength <= 5
    if (clearedSubstantialInput && !wasRapidClear) {
      const config = getGlobalConfig()
      if (!config.hasUsedStash) {
        addNotification({
          key: 'stash-hint',
          jsx: (
            <Text dimColor>
              Tip:{' '}
              <ConfigurableShortcutHint
                action="chat:stash"
                context="Chat"
                fallback="ctrl+s"
                description="stash"
              />
            </Text>
          ),
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
        })
      }
      peakInputLengthRef.current = currentLength
    }
  }, [input.length, addNotification])

  // Initialize input buffer for undo functionality
  const { pushToBuffer, undo, canUndo, clearBuffer } = useInputBuffer({
    maxBufferSize: 50,
    debounceMs: 1000,
  })

  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: trackAndSetInput,
    setCursorOffset,
    setPastedContents,
  })

  const defaultPlaceholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName,
  })

  const onChange = useCallback(
    (value: string) => {
      if (value === '?') {
        logEvent('zy_help_toggled', {})
        setHelpOpen((v) => !v)
        return
      }
      setHelpOpen(false)

      // Dismiss stash hint when user makes any input change
      dismissStashHint()

      // Cancel any pending prompt suggestion and speculation when user types
      abortPromptSuggestion()
      abortSpeculation(setAppState)

      // Check if this is a single character insertion at the start
      const isSingleCharInsertion = value.length === input.length + 1
      const insertedAtStart = cursorOffset === 0
      const mode = getModeFromInput(value)
      if (insertedAtStart && mode !== 'prompt') {
        if (isSingleCharInsertion) {
          onModeChange(mode)
          return
        }
        // Multi-char insertion into empty input (e.g. tab-accepting "! gcloud auth login")
        if (input.length === 0) {
          onModeChange(mode)
          const valueWithoutMode = getValueFromInput(value).replaceAll('\t', '    ')
          pushToBuffer(input, cursorOffset, pastedContents)
          trackAndSetInput(valueWithoutMode)
          setCursorOffset(valueWithoutMode.length)
          return
        }
      }
      const processedValue = value.replaceAll('\t', '    ')

      // Push current state to buffer before making changes
      if (input !== processedValue) {
        pushToBuffer(input, cursorOffset, pastedContents)
      }

      // Deselect footer items when user types
      setAppState((prev) =>
        prev.footerSelection === null
          ? prev
          : {
              ...prev,
              footerSelection: null,
            },
      )
      trackAndSetInput(processedValue)
    },
    [
      trackAndSetInput,
      onModeChange,
      input,
      cursorOffset,
      pushToBuffer,
      pastedContents,
      dismissStashHint,
      setAppState,
      setHelpOpen,
      setCursorOffset,
    ],
  )

  const { resetHistory, onHistoryUp, onHistoryDown, dismissSearchHint, historyIndex } =
    useArrowKeyHistory(
      (value: string, historyMode: HistoryMode, pastedContents: Record<number, PastedContent>) => {
        onChange(value)
        onModeChange(historyMode)
        setPastedContents(pastedContents)
      },
      input,
      pastedContents,
      setCursorOffset,
      mode,
    )

  // Dismiss search hint when user starts searching
  useEffect(() => {
    if (isSearchingHistory) {
      dismissSearchHint()
    }
  }, [isSearchingHistory, dismissSearchHint])

  return {
    ...context,
    memberMentionHighlights,
    imageRefPositions,
    cursorAtImageChip,
    combinedHighlights,
    addNotification,
    removeNotification,
    prevInputLengthRef,
    peakInputLengthRef,
    dismissStashHint,
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
    defaultPlaceholder,
    onChange,
    resetHistory,
    onHistoryUp,
    onHistoryDown,
    dismissSearchHint,
    historyIndex,
  }
}
