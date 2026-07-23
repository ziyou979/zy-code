import { feature } from 'bun:bundle'
import { useCallback, useEffect, useMemo } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { abortSpeculation } from '../../services/prompt-suggestion/speculation.js'
import { syncTeammateMode } from '../../services/swarm/teamHelpers.js'
import type { ToolPermissionContext } from '../../tools/tool.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { saveGlobalConfig } from '../../services/config/config.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { env } from '../../services/environment/env.js'
import { getImageFromClipboard } from '../../services/attachments/imagePaste.js'
import { setAutoModeActive } from '../../services/permissions/autoModeState.js'
import {
  cyclePermissionMode,
  getNextPermissionMode,
} from '../../services/permissions/getNextPermissionMode.js'
import { transitionPermissionMode } from '../../services/permissions/permissionModeTransitions.js'
import { hasAutoModeOptIn } from '../../services/settings/settings.js'
import { usePromptInputSubmission } from './usePromptInputSubmission.js'
export function usePromptInputKeybindings(context: ReturnType<typeof usePromptInputSubmission>) {
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
  } = context

  // Handler for chat:stash - stash/unstash prompt
  const handleStash = useCallback(() => {
    if (input.trim() === '' && stashedPrompt !== undefined) {
      // Pop stash when input is empty
      trackAndSetInput(stashedPrompt.text)
      setCursorOffset(stashedPrompt.cursorOffset)
      setPastedContents(stashedPrompt.pastedContents)
      setStashedPrompt(undefined)
    } else if (input.trim() !== '') {
      // Push to stash (save text, cursor position, and pasted contents)
      setStashedPrompt({
        text: input,
        cursorOffset,
        pastedContents,
      })
      trackAndSetInput('')
      setCursorOffset(0)
      setPastedContents({})
      // Track usage for /discover and stop showing hint
      saveGlobalConfig((c) => {
        if (c.hasUsedStash) {
          return c
        }
        return {
          ...c,
          hasUsedStash: true,
        }
      })
    }
  }, [
    input,
    cursorOffset,
    stashedPrompt,
    trackAndSetInput,
    setStashedPrompt,
    pastedContents,
    setPastedContents,
    setCursorOffset,
  ])

  // Handler for chat:modelPicker - toggle model picker
  const handleModelPicker = useCallback(() => {
    setShowModelPicker((prev) => !prev)
    if (helpOpen) {
      setHelpOpen(false)
    }
  }, [helpOpen, setHelpOpen, setShowModelPicker])

  // Handler for chat:thinkingToggle - toggle thinking mode
  const handleThinkingToggle = useCallback(() => {
    setShowThinkingToggle((prev) => !prev)
    if (helpOpen) {
      setHelpOpen(false)
    }
  }, [helpOpen, setHelpOpen, setShowThinkingToggle])

  // Handler for chat:cycleMode - cycle through permission modes
  const handleCycleMode = useCallback(() => {
    // When viewing a teammate, cycle their mode instead of the leader's
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      const teammateContext: ToolPermissionContext = {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode,
      }
      // Pass undefined for teamContext (unused but kept for API compatibility)
      const nextMode = getNextPermissionMode(teammateContext, undefined)
      logEvent('zy_mode_cycle', {
        to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const teammateTaskId = viewingAgentTaskId
      setAppState((prev) => {
        const task = prev.tasks[teammateTaskId]
        if (task?.type !== 'in_process_teammate') {
          return prev
        }
        if (task.permissionMode === nextMode) {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [teammateTaskId]: {
              ...task,
              permissionMode: nextMode,
            },
          },
        }
      })
      if (helpOpen) {
        setHelpOpen(false)
      }
      return
    }

    // Compute the next mode without triggering side effects first
    logForDebugging(
      `[auto-mode] handleCycleMode: currentMode=${toolPermissionContext.mode} isAutoModeAvailable=${toolPermissionContext.isAutoModeAvailable} showAutoModeOptIn=${showAutoModeOptIn} timeoutPending=${!!autoModeOptInTimeoutRef.current}`,
    )
    const nextMode = getNextPermissionMode(toolPermissionContext, teamContext)

    // Check if user is entering auto mode for the first time. Gated on the
    // persistent settings flag (hasAutoModeOptIn) rather than the broader
    // hasAutoModeOptInAnySource so that --enable-auto-mode users still see
    // the warning dialog once — the CLI flag should grant carousel access,
    // not bypass the safety text.
    let isEnteringAutoModeFirstTime = false
    isEnteringAutoModeFirstTime =
      nextMode === 'auto' &&
      toolPermissionContext.mode !== 'auto' &&
      !hasAutoModeOptIn() &&
      !viewingAgentTaskId // Only show for primary agent, not subagents
    if (isEnteringAutoModeFirstTime) {
      // Store previous mode so we can revert if user declines
      setPreviousModeBeforeAuto(toolPermissionContext.mode)

      // Only update the UI mode label — do NOT call transitionPermissionMode
      // or cyclePermissionMode yet; we haven't confirmed with the user.
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          mode: 'auto',
        },
      }))
      setToolPermissionContext({
        ...toolPermissionContext,
        mode: 'auto',
      })

      // Show opt-in dialog after 400ms debounce
      if (autoModeOptInTimeoutRef.current) {
        clearTimeout(autoModeOptInTimeoutRef.current)
      }
      autoModeOptInTimeoutRef.current = setTimeout(
        (setShowAutoModeOptIn, autoModeOptInTimeoutRef) => {
          setShowAutoModeOptIn(true)
          autoModeOptInTimeoutRef.current = null
        },
        400,
        setShowAutoModeOptIn,
        autoModeOptInTimeoutRef,
      )
      if (helpOpen) {
        setHelpOpen(false)
      }
      return
    }

    // Dismiss auto mode opt-in dialog if showing or pending (user is cycling away).
    // Do NOT revert to previousModeBeforeAuto here — shift+tab means "advance the
    // carousel", not "decline". Reverting causes a ping-pong loop: auto reverts to
    // the prior mode, whose next mode is auto again, forever.
    // The dialog's own decline button (handleAutoModeOptInDecline) handles revert.
    if (showAutoModeOptIn || autoModeOptInTimeoutRef.current) {
      if (showAutoModeOptIn) {
        logEvent('zy_auto_mode_opt_in_dialog_decline', {})
      }
      setShowAutoModeOptIn(false)
      if (autoModeOptInTimeoutRef.current) {
        clearTimeout(autoModeOptInTimeoutRef.current)
        autoModeOptInTimeoutRef.current = null
      }
      setPreviousModeBeforeAuto(null)
      // Fall through — mode is 'auto', cyclePermissionMode below goes to 'default'.
    }

    // Now that we know this is NOT the first-time auto mode path,
    // call cyclePermissionMode to apply side effects (e.g. strip
    // dangerous permissions, activate classifier)
    const { context: preparedContext } = cyclePermissionMode(toolPermissionContext, teamContext)
    logEvent('zy_mode_cycle', {
      to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // Track when user enters plan mode
    if (nextMode === 'plan') {
      saveGlobalConfig((current) => ({
        ...current,
        lastPlanModeUse: Date.now(),
      }))
    }

    // Set the mode via setAppState directly because setToolPermissionContext
    // intentionally preserves the existing mode (to prevent coordinator mode
    // corruption from workers). Then call setToolPermissionContext to trigger
    // recheck of queued permission prompts.
    setAppState((prev) => ({
      ...prev,
      toolPermissionContext: {
        ...preparedContext,
        mode: nextMode,
      },
    }))
    setToolPermissionContext({
      ...preparedContext,
      mode: nextMode,
    })

    // If this is a teammate, update config.json so team lead sees the change
    syncTeammateMode(nextMode, teamContext?.teamName)

    // Close help tips if they're open when mode is cycled
    if (helpOpen) {
      setHelpOpen(false)
    }
  }, [
    toolPermissionContext,
    teamContext,
    viewingAgentTaskId,
    viewedTeammate,
    setAppState,
    setToolPermissionContext,
    helpOpen,
    showAutoModeOptIn,
    setHelpOpen,
    setPreviousModeBeforeAuto,
    autoModeOptInTimeoutRef,
    setShowAutoModeOptIn,
  ])

  // Handler for auto mode opt-in dialog acceptance
  const handleAutoModeOptInAccept = useCallback(() => {
    setShowAutoModeOptIn(false)
    setPreviousModeBeforeAuto(null)

    // Now that the user accepted, apply the full transition: activate the
    // auto mode backend (classifier, beta headers) and strip dangerous
    // permissions (e.g. Bash(*) always-allow rules).
    const strippedContext = transitionPermissionMode(
      previousModeBeforeAuto ?? toolPermissionContext.mode,
      'auto',
      toolPermissionContext,
    )
    setAppState((prev) => ({
      ...prev,
      toolPermissionContext: {
        ...strippedContext,
        mode: 'auto',
      },
    }))
    setToolPermissionContext({
      ...strippedContext,
      mode: 'auto',
    })

    // Close help tips if they're open when auto mode is enabled
    if (helpOpen) {
      setHelpOpen(false)
    }
  }, [
    helpOpen,
    setHelpOpen,
    previousModeBeforeAuto,
    toolPermissionContext,
    setAppState,
    setToolPermissionContext,
    setShowAutoModeOptIn,
    setPreviousModeBeforeAuto,
  ])

  // Handler for auto mode opt-in dialog decline
  const handleAutoModeOptInDecline = useCallback(() => {
    logForDebugging(
      `[auto-mode] handleAutoModeOptInDecline: reverting to ${previousModeBeforeAuto}, setting isAutoModeAvailable=false`,
    )
    setShowAutoModeOptIn(false)
    if (autoModeOptInTimeoutRef.current) {
      clearTimeout(autoModeOptInTimeoutRef.current)
      autoModeOptInTimeoutRef.current = null
    }

    // Revert to previous mode and remove auto from the carousel
    // for the rest of this session
    if (previousModeBeforeAuto) {
      setAutoModeActive(false)
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          mode: previousModeBeforeAuto,
          isAutoModeAvailable: false,
        },
      }))
      setToolPermissionContext({
        ...toolPermissionContext,
        mode: previousModeBeforeAuto,
        isAutoModeAvailable: false,
      })
      setPreviousModeBeforeAuto(null)
    }
  }, [
    previousModeBeforeAuto,
    toolPermissionContext,
    setAppState,
    setToolPermissionContext,
    setPreviousModeBeforeAuto,
    setShowAutoModeOptIn,
    autoModeOptInTimeoutRef.current,
    autoModeOptInTimeoutRef,
  ])

  // Handler for chat:imagePaste - paste image from clipboard
  const handleImagePaste = useCallback(() => {
    void getImageFromClipboard().then((imageData) => {
      if (imageData) {
        onImagePaste(imageData.base64, imageData.mediaType)
      } else {
        const shortcutDisplay = getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')
        const message = env.isSSH()
          ? "No image found in clipboard. You're SSH'd; try scp?"
          : `No image found in clipboard. Use ${shortcutDisplay} to paste images.`
        addNotification({
          key: 'no-image-in-clipboard',
          text: message,
          priority: 'immediate',
          timeoutMs: 1000,
        })
      }
    })
  }, [addNotification, onImagePaste])

  // Register chat:submit handler directly in the handler registry (not via
  // useKeybindings) so that only the ChordInterceptor can invoke it for chord
  // completions (e.g., "ctrl+e s"). The default Enter binding for submit is
  // handled by TextInput directly (via onSubmit prop) and useTypeahead (for
  // autocomplete acceptance). Using useKeybindings would cause
  // stopImmediatePropagation on Enter, blocking autocomplete from seeing the key.
  const keybindingContext = useOptionalKeybindingContext()

  useEffect(() => {
    if (!keybindingContext || isModalOverlayActive) {
      return
    }
    return keybindingContext.registerHandler({
      action: 'chat:submit',
      context: 'Chat',
      handler: () => {
        void onSubmit(input)
      },
    })
  }, [keybindingContext, isModalOverlayActive, onSubmit, input])

  // Chat context keybindings for editing shortcuts
  // Note: history:previous/history:next are NOT handled here. They are passed as
  // onHistoryUp/onHistoryDown props to TextInput, so that useTextInput's
  // upOrHistoryUp/downOrHistoryDown can try cursor movement first and only
  // fall through to history when the cursor can't move further.
  const chatHandlers = useMemo(
    () => ({
      'chat:undo': handleUndo,
      'chat:newline': handleNewline,
      'chat:externalEditor': handleExternalEditor,
      'chat:stash': handleStash,
      'chat:modelPicker': handleModelPicker,
      'chat:thinkingToggle': handleThinkingToggle,
      'chat:cycleMode': handleCycleMode,
      'chat:imagePaste': handleImagePaste,
    }),
    [
      handleUndo,
      handleNewline,
      handleExternalEditor,
      handleStash,
      handleModelPicker,
      handleThinkingToggle,
      handleCycleMode,
      handleImagePaste,
    ],
  )

  useKeybindings(chatHandlers, {
    context: 'Chat',
    isActive: !isModalOverlayActive,
  })

  // Shift+↑ enters message-actions cursor. Separate isActive so ctrl+r search
  // doesn't leave stale isSearchingHistory on cursor-exit remount.
  useKeybinding('chat:messageActions', () => onMessageActionsEnter?.(), {
    context: 'Chat',
    isActive: !isModalOverlayActive && !isSearchingHistory,
  })

  // Handle help:dismiss keybinding (ESC closes help menu)
  // This is registered separately from Chat context so it has priority over
  // CancelRequestHandler when help menu is open
  useKeybinding(
    'help:dismiss',
    () => {
      setHelpOpen(false)
    },
    {
      context: 'Help',
      isActive: helpOpen,
    },
  )

  // Quick Open / Global Search. Hook calls are unconditional (Rules of Hooks);
  // the handler body is feature()-gated so the setState calls and component
  // references get tree-shaken in external builds.
  const quickSearchActive = feature('QUICK_SEARCH') ? !isModalOverlayActive : false

  useKeybinding(
    'app:quickOpen',
    () => {
      if (feature('QUICK_SEARCH')) {
        setShowQuickOpen(true)
        setHelpOpen(false)
      }
    },
    {
      context: 'Global',
      isActive: quickSearchActive,
    },
  )

  useKeybinding(
    'app:globalSearch',
    () => {
      if (feature('QUICK_SEARCH')) {
        setShowGlobalSearch(true)
        setHelpOpen(false)
      }
    },
    {
      context: 'Global',
      isActive: quickSearchActive,
    },
  )

  useKeybinding(
    'history:search',
    () => {
      if (feature('HISTORY_PICKER')) {
        setShowHistoryPicker(true)
        setHelpOpen(false)
      }
    },
    {
      context: 'Global',
      isActive: feature('HISTORY_PICKER') ? !isModalOverlayActive : false,
    },
  )

  // Handle Ctrl+C to abort speculation when idle (not loading)
  // CancelRequestHandler only handles Ctrl+C during active tasks
  useKeybinding(
    'app:interrupt',
    () => {
      abortSpeculation(setAppState)
    },
    {
      context: 'Global',
      isActive: !isLoading && speculation.status === 'active',
    },
  )
  return {
    ...context,
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
  }
}
