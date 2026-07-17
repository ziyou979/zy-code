import { feature } from 'bun:bundle'
import { useCallback, useEffect, useMemo } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isQueuedCommandEditable } from 'src/utils/messageQueueManager.js'
import { getNativeCSIuTerminalDisplayName } from '../../commands/terminal-setup/TerminalSetup.js'
import { useSetPromptOverlayDialog } from '../../context/PromptOverlayContext.js'
import { Box, type ClickEvent, Text, useInput } from '../../ink/index.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { modelDisplayString } from '../../services/model/model.js'
import { abortSpeculation } from '../../services/prompt-suggestion/speculation.js'
import {
  enterTeammateView,
  exitTeammateView,
  stopOrDismissAgent,
} from '../../state/teammateViewHelpers.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { Cursor } from '../../utils/cursor.js'
import type { EffortLevel } from '../../services/effort/effort.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { isFullscreenEnvEnabled } from '../../services/terminal/fullscreen.js'
import { isMacosOptionChar, MACOS_OPTION_SPECIAL_CHARS } from '../../utils/keyboardShortcuts.js'
import { getPlatform } from '../../services/shell/platform.js'
import { AutoModeOptInDialog } from '../AutoModeOptInDialog.js'
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js'
import { getEffortNotificationText } from '../EffortIndicator.js'
import { GlobalSearchDialog } from '../GlobalSearchDialog.js'
import { HistorySearchDialog } from '../HistorySearchDialog.js'
import { ModelPicker } from '../ModelPicker.js'
import { QuickOpenDialog } from '../QuickOpenDialog.js'
import { ThinkingToggle } from '../ThinkingToggle.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import { TeamsDialog } from '../teams/TeamsDialog.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { useSwarmBanner } from './useSwarmBanner.js'
import { usePromptInputKeybindings } from './usePromptInputKeybindings.js'
import { MIN_INPUT_VIEWPORT_LINES, PROMPT_FOOTER_LINES } from './promptInputConstants.js'
export function usePromptInputViewModel(context: ReturnType<typeof usePromptInputKeybindings>) {
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
    handleHistoryUp,
    handleHistoryDown,
    suggestionsState,
    setSuggestionsStateRaw,
    setSuggestionsState,
    onSubmit,
    suggestions,
    selectedSuggestion,
    commandArgumentHint,
    inlineGhostText,
    maxColumnWidth,
    acceptSuggestion,
    onClickSuggestion,
    showPromptSuggestion,
    onImagePaste,
    onTextPaste,
    lazySpaceInputFilter,
    insertTextAtCursor,
    doublePressEscFromEmpty,
    popAllCommandsFromQueue,
    onIdeAtMentioned,
    handleUndo,
    handleNewline,
    handleExternalEditor,
    handleStash,
    handleModelPicker,
    handleThinkingToggle,
    handleCycleMode,
    handleAutoModeOptInAccept,
    handleAutoModeOptInDecline,
    handleImagePaste,
    keybindingContext,
    chatHandlers,
    quickSearchActive,
    columns,
    rows,
  } = context

  // Footer indicator navigation keybindings. ↑/↓ live here (not in
  // handleHistoryUp/Down) because TextInput focus=false when a pill is
  // selected — its useInput is inactive, so this is the only path.
  useKeybindings(
    {
      'footer:up': () => {
        // ↑ scrolls within the coordinator task list before leaving the pill
        if (
          tasksSelected &&
          coordinatorTaskCount > 0 &&
          coordinatorTaskIndex > minCoordinatorIndex
        ) {
          setCoordinatorTaskIndex((prev) => prev - 1)
          return
        }
        navigateFooter(-1, true)
      },
      'footer:down': () => {
        // ↓ scrolls within the coordinator task list, never leaves the pill
        if (tasksSelected && coordinatorTaskCount > 0) {
          if (coordinatorTaskIndex < coordinatorTaskCount - 1) {
            setCoordinatorTaskIndex((prev) => prev + 1)
          }
          return
        }
        if (tasksSelected && !isTeammateMode) {
          setShowBashesDialog(true)
          selectFooterItem(null)
          return
        }
        navigateFooter(1)
      },
      'footer:next': () => {
        // Teammate mode: ←/→ cycles within the team member list
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length
          setTeammateFooterIndex((prev) => (prev + 1) % totalAgents)
          return
        }
        navigateFooter(1)
      },
      'footer:previous': () => {
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length
          setTeammateFooterIndex((prev) => (prev - 1 + totalAgents) % totalAgents)
          return
        }
        navigateFooter(-1)
      },
      'footer:openSelected': () => {
        if (viewSelectionMode === 'selecting-agent') {
          return
        }
        switch (footerItemSelected) {
          case 'tasks':
            if (isTeammateMode) {
              // Enter switches to the selected agent's view
              if (teammateFooterIndex === 0) {
                exitTeammateView(setAppState)
              } else {
                const teammate = inProcessTeammates[teammateFooterIndex - 1]
                if (teammate) {
                  enterTeammateView(teammate.id, setAppState)
                }
              }
            } else if (coordinatorTaskIndex === 0 && coordinatorTaskCount > 0) {
              exitTeammateView(setAppState)
            } else {
              const selectedTaskId = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]?.id
              if (selectedTaskId) {
                enterTeammateView(selectedTaskId, setAppState)
              } else {
                setShowBashesDialog(true)
                selectFooterItem(null)
              }
            }
            break
          case 'tmux':
            if (isInternalBuild()) {
              setAppState((prev) =>
                prev.tungstenPanelAutoHidden
                  ? {
                      ...prev,
                      tungstenPanelAutoHidden: false,
                    }
                  : {
                      ...prev,
                      tungstenPanelVisible: !(prev.tungstenPanelVisible ?? true),
                    },
              )
            }
            break
          case 'bagel':
            break
          case 'teams':
            setShowTeamsDialog(true)
            selectFooterItem(null)
            break
          case 'bridge':
            setShowBridgeDialog(true)
            selectFooterItem(null)
            break
        }
      },
      'footer:clearSelection': () => {
        selectFooterItem(null)
      },
      'footer:close': () => {
        if (tasksSelected && coordinatorTaskIndex >= 1) {
          const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]
          if (!task) {
            return false
          }
          // When the selected row IS the viewed agent, 'x' types into the
          // steering input. Any other row — dismiss it.
          if (viewSelectionMode === 'viewing-agent' && task.id === viewingAgentTaskId) {
            onChange(`${input.slice(0, cursorOffset)}x${input.slice(cursorOffset)}`)
            setCursorOffset(cursorOffset + 1)
            return
          }
          stopOrDismissAgent(task.id, setAppState)
          if (task.status !== 'running') {
            setCoordinatorTaskIndex((i) => Math.max(minCoordinatorIndex, i - 1))
          }
          return
        }
        // Not handled — let 'x' fall through to type-to-exit
        return false
      },
    },
    {
      context: 'Footer',
      isActive: !!footerItemSelected && !isModalOverlayActive,
    },
  )

  useInput((char, key) => {
    // Skip all input handling when a full-screen dialog is open. These dialogs
    // render via early return, but hooks run unconditionally — so without this
    // guard, Escape inside a dialog leaks to the double-press message-selector.
    if (showTeamsDialog || showQuickOpen || showGlobalSearch || showHistoryPicker) {
      return
    }

    // Detect failed Alt shortcuts on macOS (Option key produces special characters)
    if (getPlatform() === 'macos' && isMacosOptionChar(char)) {
      const shortcut = MACOS_OPTION_SPECIAL_CHARS[char]
      const terminalName = getNativeCSIuTerminalDisplayName()
      const jsx = terminalName ? (
        <Text dimColor>
          To enable {shortcut}, set <Text bold>Option as Meta</Text> in {terminalName} preferences
          (⌘,)
        </Text>
      ) : (
        <Text dimColor>To enable {shortcut}, run /terminal-setup</Text>
      )
      addNotification({
        key: 'option-meta-hint',
        jsx,
        priority: 'immediate',
        timeoutMs: 5000,
      })
      // Don't return - let the character be typed so user sees the issue
    }

    // Footer navigation is handled via useKeybindings above (Footer context)

    // NOTE: ctrl+_, ctrl+g, ctrl+s are handled via Chat context keybindings above

    // Type-to-exit footer: printable chars while a pill is selected refocus
    // the input and type the char. Nav keys are captured by useKeybindings
    // above, so anything reaching here is genuinely not a footer action.
    // onChange clears footerSelection, so no explicit deselect.
    if (footerItemSelected && char && !key.ctrl && !key.meta && !key.escape && !key.return) {
      onChange(input.slice(0, cursorOffset) + char + input.slice(cursorOffset))
      setCursorOffset(cursorOffset + char.length)
      return
    }

    // Exit special modes when backspace/escape/delete/ctrl+u is pressed at cursor position 0
    if (
      cursorOffset === 0 &&
      (key.escape || key.backspace || key.delete || (key.ctrl && char === 'u'))
    ) {
      onModeChange('prompt')
      setHelpOpen(false)
    }

    // Exit help mode when backspace is pressed and input is empty
    if (helpOpen && input === '' && (key.backspace || key.delete)) {
      setHelpOpen(false)
    }

    // esc is a little overloaded:
    // - when we're loading a response, it's used to cancel the request
    // - otherwise, it's used to show the message selector
    // - when double pressed, it's used to clear the input
    // - when input is empty, pop from command queue

    // Handle ESC key press
    if (key.escape) {
      // Abort active speculation
      if (speculation.status === 'active') {
        abortSpeculation(setAppState)
        return
      }

      // Dismiss side question response if visible
      if (isSideQuestionVisible && onDismissSideQuestion) {
        onDismissSideQuestion()
        return
      }

      // Close help menu if open
      if (helpOpen) {
        setHelpOpen(false)
        return
      }

      // Footer selection clearing is now handled via Footer context keybindings
      // (footer:clearSelection action bound to escape)
      // If a footer item is selected, let the Footer keybinding handle it
      if (footerItemSelected) {
        return
      }

      // If there's an editable queued command, move it to the input for editing when ESC is pressed
      const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable)
      if (hasEditableCommand) {
        void popAllCommandsFromQueue()
        return
      }
      if (messages.length > 0 && !input && !isLoading) {
        doublePressEscFromEmpty()
      }
    }
    if (key.return && helpOpen) {
      setHelpOpen(false)
    }
  })

  const swarmBanner = useSwarmBanner()

  // Show effort notification on startup and when effort changes.
  // Suppressed in brief/assistant mode — the value reflects the local
  // client's effort, not the connected agent's.
  const effortNotificationText = briefOwnsGap
    ? undefined
    : getEffortNotificationText(effortValue, mainLoopModel)

  useEffect(() => {
    if (!effortNotificationText) {
      removeNotification('effort-level')
      return
    }
    addNotification({
      key: 'effort-level',
      text: effortNotificationText,
      priority: 'high',
      timeoutMs: 12_000,
    })
  }, [effortNotificationText, addNotification, removeNotification])

  const textInputColumns = columns - 3

  // POC: click-to-position-cursor. Mouse tracking is only enabled inside
  // <AlternateScreen>, so this is dormant in the normal main-screen REPL.
  // localCol/localRow are relative to the onClick Box's top-left; the Box
  // tightly wraps the text input so they map directly to (column, line)
  // in the Cursor wrap model. MeasuredText.getOffsetFromPosition handles
  // wide chars, wrapped lines, and clamps past-end clicks to line end.
  const maxVisibleLines = isFullscreenEnvEnabled()
    ? Math.max(MIN_INPUT_VIEWPORT_LINES, Math.floor(rows / 2) - PROMPT_FOOTER_LINES)
    : undefined

  const handleInputClick = useCallback(
    (e: ClickEvent) => {
      // During history search the displayed text is historyMatch, not
      // input, and showCursor is false anyway — skip rather than
      // compute an offset against the wrong string.
      if (!input || isSearchingHistory) {
        return
      }
      const c = Cursor.fromText(input, textInputColumns, cursorOffset)
      const viewportStart = c.getViewportStartLine(maxVisibleLines)
      const offset = c.measuredText.getOffsetFromPosition({
        line: e.localRow + viewportStart,
        column: e.localCol,
      })
      setCursorOffset(offset)
    },
    [input, textInputColumns, isSearchingHistory, cursorOffset, maxVisibleLines, setCursorOffset],
  )

  const handleOpenTasksDialog = useCallback(
    (taskId?: string) => setShowBashesDialog(taskId ?? true),
    [setShowBashesDialog],
  )

  const placeholder =
    showPromptSuggestion && promptSuggestion ? promptSuggestion : defaultPlaceholder

  // Calculate if input has multiple lines
  const isInputWrapped = useMemo(() => input.includes('\n'), [input])

  // Memoized callbacks for model picker to prevent re-renders when unrelated
  // state (like notifications) changes. This prevents the inline model picker
  // from visually "jumping" when notifications arrive.
  const handleModelSelect = useCallback(
    (model: string | null, effort: EffortLevel | undefined) => {
      setAppState((prev) => ({
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null,
        effortValue: effort,
      }))
      setShowModelPicker(false)
      const message = `Model set to ${modelDisplayString(model)}`
      addNotification({
        key: 'model-switched',
        jsx: <Text>{message}</Text>,
        priority: 'immediate',
        timeoutMs: 3000,
      })
      logEvent('zy_model_picker_hotkey', {
        model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    },
    [setAppState, addNotification, setShowModelPicker],
  )

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false)
  }, [setShowModelPicker])

  // Memoize the model picker element to prevent unnecessary re-renders
  // when AppState changes for unrelated reasons (e.g., notifications arriving)
  const modelPickerElement = useMemo(() => {
    if (!showModelPicker) {
      return null
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <ModelPicker
          initial={mainLoopModel_}
          sessionModel={mainLoopModelForSession}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
          isStandaloneCommand
        />
      </Box>
    )
  }, [
    showModelPicker,
    mainLoopModel_,
    mainLoopModelForSession,
    handleModelSelect,
    handleModelCancel,
  ])

  // Memoized callbacks for thinking toggle
  const handleThinkingSelect = useCallback(
    (enabled: boolean) => {
      setAppState((prev) => ({
        ...prev,
        thinkingEnabled: enabled,
      }))
      setShowThinkingToggle(false)
      logEvent('zy_thinking_toggled_hotkey', {
        enabled,
      })
      addNotification({
        key: 'thinking-toggled-hotkey',
        jsx: (
          <Text color={enabled ? 'suggestion' : undefined} dimColor={!enabled}>
            Thinking {enabled ? 'on' : 'off'}
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 3000,
      })
    },
    [setAppState, addNotification, setShowThinkingToggle],
  )

  const handleThinkingCancel = useCallback(() => {
    setShowThinkingToggle(false)
  }, [setShowThinkingToggle])

  // Memoize the thinking toggle element
  const thinkingToggleElement = useMemo(() => {
    if (!showThinkingToggle) {
      return null
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <ThinkingToggle
          currentValue={thinkingEnabled ?? true}
          onSelect={handleThinkingSelect}
          onCancel={handleThinkingCancel}
          isMidConversation={messages.some((m) => m.type === 'assistant')}
        />
      </Box>
    )
  }, [
    showThinkingToggle,
    thinkingEnabled,
    handleThinkingSelect,
    handleThinkingCancel,
    messages.some,
  ])

  // Portal dialog to DialogOverlay in fullscreen so it escapes the bottom
  // slot's overflowY:hidden clip (same pattern as SuggestionsOverlay).
  // Must be called before early returns below to satisfy rules-of-hooks.
  // Memoized so the portal useEffect doesn't churn on every PromptInput render.
  const autoModeOptInDialog = useMemo(
    () =>
      showAutoModeOptIn ? (
        <AutoModeOptInDialog
          onAccept={handleAutoModeOptInAccept}
          onDecline={handleAutoModeOptInDecline}
        />
      ) : null,
    [showAutoModeOptIn, handleAutoModeOptInAccept, handleAutoModeOptInDecline],
  )

  useSetPromptOverlayDialog(isFullscreenEnvEnabled() ? autoModeOptInDialog : null)

  if (showBashesDialog) {
    return (
      <BackgroundTasksDialog
        onDone={() => setShowBashesDialog(false)}
        toolUseContext={getToolUseContext(messages, [], new AbortController(), mainLoopModel)}
        initialDetailTaskId={typeof showBashesDialog === 'string' ? showBashesDialog : undefined}
      />
    )
  }

  if (isAgentSwarmsEnabled() && showTeamsDialog) {
    return (
      <TeamsDialog
        initialTeams={cachedTeams}
        onDone={() => {
          setShowTeamsDialog(false)
        }}
      />
    )
  }

  if (feature('QUICK_SEARCH')) {
    const insertWithSpacing = (text: string) => {
      const cursorChar = input[cursorOffset - 1] ?? ' '
      insertTextAtCursor(/\s/.test(cursorChar) ? text : ` ${text}`)
    }
    if (showQuickOpen) {
      return <QuickOpenDialog onDone={() => setShowQuickOpen(false)} onInsert={insertWithSpacing} />
    }
    if (showGlobalSearch) {
      return (
        <GlobalSearchDialog
          onDone={() => setShowGlobalSearch(false)}
          onInsert={insertWithSpacing}
        />
      )
    }
  }

  if (feature('HISTORY_PICKER') ? showHistoryPicker : false) {
    return (
      <HistorySearchDialog
        initialQuery={input}
        onSelect={(entry) => {
          const entryMode = getModeFromInput(entry.display)
          const value = getValueFromInput(entry.display)
          onModeChange(entryMode)
          trackAndSetInput(value)
          setPastedContents(entry.pastedContents)
          setCursorOffset(value.length)
          setShowHistoryPicker(false)
        }}
        onCancel={() => setShowHistoryPicker(false)}
      />
    )
  }
  return {
    ...context,
    swarmBanner,
    effortNotificationText,
    columns,
    rows,
    textInputColumns,
    maxVisibleLines,
    handleInputClick,
    handleOpenTasksDialog,
    placeholder,
    isInputWrapped,
    handleModelSelect,
    handleModelCancel,
    modelPickerElement,
    handleThinkingSelect,
    handleThinkingCancel,
    thinkingToggleElement,
    autoModeOptInDialog,
  }
}
