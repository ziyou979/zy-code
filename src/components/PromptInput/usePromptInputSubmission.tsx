import * as path from 'node:path'
import { useCallback, useEffect, useState } from 'react'
import { type IDEAtMentioned, useIdeAtMentioned } from 'src/hooks/useIdeAtMentioned.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { isQueuedCommandEditable, popAllEditable } from 'src/utils/messageQueueManager.js'
import stripAnsi from 'strip-ansi'
import {
  formatImageRef,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  parseReferences,
} from '../../history.js'
import { useDoublePress } from '../../hooks/useDoublePress.js'
import { useTypeahead } from '../../hooks/useTypeahead.js'
import { type Key } from '../../ink.js'
import { logSuggestionSuppressed } from '../../services/prompt-suggestion/promptSuggestion.js'
import { getActiveAgentForInput } from '../../state/selectors.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import {
  getGlobalConfig,
  type PastedContent,
  saveGlobalConfig,
} from '../../services/config/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  parseDirectMemberMessage,
  sendDirectMemberMessage,
} from '../../services/swarm/directMemberMessage.js'
import { errorMessage } from '../../utils/errors.js'
import { PASTE_THRESHOLD } from '../../utils/imagePaste.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../utils/imageStore.js'
import { logError } from '../../utils/log.js'
import { editPromptInEditor } from '../../terminal-ui/promptEditor.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { expandExistingPasteRefsInInput, findExistingPastedTextId } from './inputPaste.js'
import type { SuggestionItem } from './PromptInputFooterSuggestions.js'
import { isNonSpacePrintable } from './utils.js'
import { usePromptInputSuggestions } from './usePromptInputSuggestions.js'
export function usePromptInputSubmission(context: ReturnType<typeof usePromptInputSuggestions>) {
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
    columns,
    rows,
    onSubmitRef,
  } = context

  // Create a suggestions state directly - we'll sync it with useTypeahead later
  const [suggestionsState, setSuggestionsStateRaw] = useState<{
    suggestions: SuggestionItem[]
    selectedSuggestion: number
    commandArgumentHint?: string
  }>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined,
  })

  // Setter for suggestions state
  const setSuggestionsState = useCallback(
    (
      updater:
        | typeof suggestionsState
        | ((prev: typeof suggestionsState) => typeof suggestionsState),
    ) => {
      setSuggestionsStateRaw((prev) => (typeof updater === 'function' ? updater(prev) : updater))
    },
    [],
  )

  let onSubmit!: (inputParam: string, isSubmittingSlashCommand?: boolean) => Promise<void>

  onSubmit = useCallback(
    async (inputParam: string, isSubmittingSlashCommand = false) => {
      inputParam = inputParam.trimEnd()

      // Don't submit if a footer indicator is being opened. Read fresh from
      // store — footer:openSelected calls selectFooterItem(null) then onSubmit
      // in the same tick, and the closure value hasn't updated yet. Apply the
      // same "still visible?" derivation as footerItemSelected so a stale
      // selection (pill disappeared) doesn't swallow Enter.
      const state = store.getState()
      if (state.footerSelection && footerItems.includes(state.footerSelection)) {
        return
      }

      // Enter in selection modes confirms selection (useBackgroundTaskNavigation).
      // BaseTextInput's useInput registers before that hook (child effects fire first),
      // so without this guard Enter would double-fire and auto-submit the suggestion.
      if (state.viewSelectionMode === 'selecting-agent') {
        return
      }

      // Check for images early - we need this for suggestion logic below
      const hasImages = Object.values(pastedContents).some((c) => c.type === 'image')

      // If input is empty OR matches the suggestion, submit it
      // But if there are images attached, don't auto-accept the suggestion -
      // the user wants to submit just the image(s).
      // Only in leader view — promptSuggestion is leader-context, not teammate.
      const suggestionText = promptSuggestionState.text
      const inputMatchesSuggestion = inputParam.trim() === '' || inputParam === suggestionText
      if (inputMatchesSuggestion && suggestionText && !hasImages && !state.viewingAgentTaskId) {
        // If speculation is active, inject messages immediately as they stream
        if (speculation.status === 'active') {
          markAccepted()
          // skipReset: resetSuggestion would abort the speculation before we accept it
          logOutcomeAtSubmission(suggestionText, {
            skipReset: true,
          })
          void onSubmitProp(
            suggestionText,
            {
              setCursorOffset,
              clearBuffer,
              resetHistory,
            },
            {
              state: speculation,
              speculationSessionTimeSavedMs: speculationSessionTimeSavedMs,
              setAppState,
            },
          )
          return // Skip normal query - speculation handled it
        }

        // Regular suggestion acceptance (requires shownAt > 0)
        if (promptSuggestionState.shownAt > 0) {
          markAccepted()
          inputParam = suggestionText
        }
      }

      // Handle @name direct message
      if (isAgentSwarmsEnabled()) {
        const directMessage = parseDirectMemberMessage(inputParam)
        if (directMessage) {
          const result = await sendDirectMemberMessage(
            directMessage.recipientName,
            directMessage.message,
            teamContext,
            writeToMailbox,
          )
          if (result.success) {
            addNotification({
              key: 'direct-message-sent',
              text: `Sent to @${result.recipientName}`,
              priority: 'immediate',
              timeoutMs: 3000,
            })
            trackAndSetInput('')
            setCursorOffset(0)
            clearBuffer()
            resetHistory()
            return
            } else if ((result as { error?: string }).error === 'no_team_context') {
            // No team context - fall through to normal prompt submission
          } else {
            // Unknown recipient - fall through to normal prompt submission
            // This allows e.g. "@utils explain this code" to be sent as a prompt
          }
        }
      }

      // Allow submission if there are images attached, even without text
      if (inputParam.trim() === '' && !hasImages) {
        return
      }

      // PromptInput UX: Check if suggestions dropdown is showing
      // For directory suggestions, allow submission (Tab is used for completion)
      const hasDirectorySuggestions =
        suggestionsState.suggestions.length > 0 &&
        suggestionsState.suggestions.every((s) => s.description === 'directory')
      if (
        suggestionsState.suggestions.length > 0 &&
        !isSubmittingSlashCommand &&
        !hasDirectorySuggestions
      ) {
        logForDebugging(
          `[onSubmit] early return: suggestions showing (count=${suggestionsState.suggestions.length})`,
        )
        return // Don't submit, user needs to clear suggestions first
      }

      // Log suggestion outcome if one exists
      if (promptSuggestionState.text && promptSuggestionState.shownAt > 0) {
        logOutcomeAtSubmission(inputParam)
      }

      // Clear stash hint notification on submit
      removeNotification('stash-hint')

      // Route input to viewed agent (in-process teammate or named local_agent).
      const activeAgent = getActiveAgentForInput(store.getState())
      if (activeAgent.type !== 'leader' && onAgentSubmit) {
        logEvent('zy_transcript_input_to_teammate', {})
        await onAgentSubmit(inputParam, activeAgent.task, {
          setCursorOffset,
          clearBuffer,
          resetHistory,
        })
        return
      }

      // Normal leader submission
      await onSubmitProp(inputParam, {
        setCursorOffset,
        clearBuffer,
        resetHistory,
      })
    },
    [
      promptSuggestionState,
      speculation,
      speculationSessionTimeSavedMs,
      teamContext,
      store,
      footerItems,
      suggestionsState.suggestions,
      onSubmitProp,
      onAgentSubmit,
      clearBuffer,
      resetHistory,
      logOutcomeAtSubmission,
      setAppState,
      markAccepted,
      pastedContents,
      removeNotification,
      trackAndSetInput,
      addNotification,
      setCursorOffset,
    ],
  )
  onSubmitRef.current = onSubmit

  const {
    suggestions,
    selectedSuggestion,
    commandArgumentHint,
    inlineGhostText,
    maxColumnWidth,
    acceptSuggestion,
    onClickSuggestion,
  } = useTypeahead({
    commands,
    onInputChange: trackAndSetInput,
    onSubmit,
    setCursorOffset,
    input,
    cursorOffset,
    mode,
    agents,
    setSuggestionsState,
    suggestionsState,
    suppressSuggestions: isSearchingHistory || historyIndex > 0,
    markAccepted,
    onModeChange,
  })

  // Track if prompt suggestion should be shown (computed later with terminal width).
  // Hidden in teammate view — suggestion is leader-context only.
  const showPromptSuggestion =
    mode === 'prompt' && suggestions.length === 0 && promptSuggestion && !viewingAgentTaskId

  if (showPromptSuggestion) {
    markShown()
  }

  // If suggestion was generated but can't be shown due to timing, log suppression.
  // Exclude teammate view: markShown() is gated above, so shownAt stays 0 there —
  // but that's not a timing failure, the suggestion is valid when returning to leader.
  if (
    promptSuggestionState.text &&
    !promptSuggestion &&
    promptSuggestionState.shownAt === 0 &&
    !viewingAgentTaskId
  ) {
    logSuggestionSuppressed('timing', promptSuggestionState.text)
    setAppState((prev) => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }))
  }

  function onImagePaste(
    image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) {
    logEvent('zy_paste_image', {})
    onModeChange('prompt')
    const pasteId = nextPasteIdRef.current++
    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: image,
      mediaType: mediaType || 'image/png',
      // default to PNG if not provided
      filename: filename || 'Pasted image',
      dimensions,
      sourcePath,
    }

    // Cache path immediately (fast) so links work on render
    cacheImagePath(newContent)

    // Store image to disk in background
    void storeImage(newContent)

    // Update UI
    setPastedContents((prev) => ({
      ...prev,
      [pasteId]: newContent,
    }))
    // Multi-image paste calls onImagePaste in a loop. If the ref is already
    // armed, the previous pill's lazy space fires now (before this pill)
    // rather than being lost.
    const prefix = pendingSpaceAfterPillRef.current ? ' ' : ''
    insertTextAtCursor(prefix + formatImageRef(pasteId))
    pendingSpaceAfterPillRef.current = true
  }

  // Prune images whose [Image #N] placeholder is no longer in the input text.
  // Covers pill backspace, Ctrl+U, char-by-char deletion — any edit that drops
  // the ref. onImagePaste batches setPastedContents + insertTextAtCursor in the
  // same event, so this effect sees the placeholder already present.
  useEffect(() => {
    const referencedIds = new Set(parseReferences(input).map((r) => r.id))
    setPastedContents((prev) => {
      const orphaned = Object.values(prev).filter(
        (c) => c.type === 'image' && !referencedIds.has(c.id),
      )
      if (orphaned.length === 0) {
        return prev
      }
      const next = {
        ...prev,
      }
      for (const img of orphaned) {
        delete next[img.id]
      }
      return next
    })
  }, [input, setPastedContents])

  function onTextPaste(rawText: string) {
    pendingSpaceAfterPillRef.current = false
    // Clean up pasted text - strip ANSI escape codes and normalize line endings and tabs
    let text = stripAnsi(rawText).replace(/\r/g, '\n').replaceAll('\t', '    ')

    // Match typed/auto-suggest: `!cmd` pasted into empty input enters bash mode.
    if (input.length === 0) {
      const pastedMode = getModeFromInput(text)
      if (pastedMode !== 'prompt') {
        onModeChange(pastedMode)
        text = getValueFromInput(text)
      }
    }
    const numLines = getPastedTextRefNumLines(text)
    // Limit the number of lines to show in the input
    // If the overall layout is too high then Ink will repaint
    // the entire terminal.
    // The actual required height is dependent on the content, this
    // is just an estimate.
    const maxLines = Math.min(rows - 10, 2)

    // Use special handling for long pasted text (>PASTE_THRESHOLD chars)
    // or if it exceeds the number of lines we want to show
    if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
      // CC 2.1.207：相同长文本再次粘贴 → 展开已有 [Pasted text #N]，不新建第二条
      const existingId = findExistingPastedTextId(text, pastedContents)
      if (existingId !== undefined) {
        const expanded = expandExistingPasteRefsInInput(input, existingId, text)
        if (expanded !== null) {
          pushToBuffer(input, cursorOffset, pastedContents)
          trackAndSetInput(expanded)
          // 光标移到展开内容末尾（更符合「展开后继续编辑」）
          setCursorOffset(expanded.length)
          return
        }
      }
      const pasteId = nextPasteIdRef.current++
      const newContent: PastedContent = {
        id: pasteId,
        type: 'text',
        content: text,
      }
      setPastedContents((prev) => ({
        ...prev,
        [pasteId]: newContent,
      }))
      insertTextAtCursor(formatPastedTextRef(pasteId, numLines))
    } else {
      // For shorter pastes, just insert the text normally
      insertTextAtCursor(text)
    }
  }

  const lazySpaceInputFilter = useCallback(
    (input: string, key: Key): string => {
      if (!pendingSpaceAfterPillRef.current) {
        return input
      }
      pendingSpaceAfterPillRef.current = false
      if (isNonSpacePrintable(input, key)) {
        return ` ${input}`
      }
      return input
    },
    [pendingSpaceAfterPillRef],
  )

  function insertTextAtCursor(text: string) {
    // Push current state to buffer before inserting
    pushToBuffer(input, cursorOffset, pastedContents)
    const newInput = input.slice(0, cursorOffset) + text + input.slice(cursorOffset)
    trackAndSetInput(newInput)
    setCursorOffset(cursorOffset + text.length)
  }

  const doublePressEscFromEmpty = useDoublePress(
    () => {},
    () => onShowMessageSelector(),
  )

  // Function to get the queued command for editing. Returns true if commands were popped.
  let popAllCommandsFromQueue!: () => boolean

  popAllCommandsFromQueue = useCallback((): boolean => {
    const result = popAllEditable(input, cursorOffset)
    if (!result) {
      return false
    }
    trackAndSetInput(result.text)
    onModeChange('prompt') // Always prompt mode for queued commands
    setCursorOffset(result.cursorOffset)

    // Restore images from queued commands to pastedContents
    if (result.images.length > 0) {
      setPastedContents((prev) => {
        const newContents = {
          ...prev,
        }
        for (const image of result.images) {
          newContents[image.id] = image
        }
        return newContents
      })
    }
    return true
  }, [trackAndSetInput, onModeChange, input, cursorOffset, setPastedContents, setCursorOffset])

  // Insert the at-mentioned reference (the file and, optionally, a line range) when
  // we receive an at-mentioned notification the IDE.
  const onIdeAtMentioned = (atMentioned: IDEAtMentioned) => {
    logEvent('zy_ext_at_mentioned', {})
    let atMentionedText: string
    const relativePath = path.relative(getCwd(), atMentioned.filePath)
    if (atMentioned.lineStart && atMentioned.lineEnd) {
      atMentionedText =
        atMentioned.lineStart === atMentioned.lineEnd
          ? `@${relativePath}#L${atMentioned.lineStart} `
          : `@${relativePath}#L${atMentioned.lineStart}-${atMentioned.lineEnd} `
    } else {
      atMentionedText = `@${relativePath} `
    }
    const cursorChar = input[cursorOffset - 1] ?? ' '
    if (!/\s/.test(cursorChar)) {
      atMentionedText = ` ${atMentionedText}`
    }
    insertTextAtCursor(atMentionedText)
  }

  useIdeAtMentioned(mcpClients, onIdeAtMentioned)

  // Handler for chat:undo - undo last edit
  const handleUndo = useCallback(() => {
    if (canUndo) {
      const previousState = undo()
      if (previousState) {
        trackAndSetInput(previousState.text)
        setCursorOffset(previousState.cursorOffset)
        setPastedContents(previousState.pastedContents)
      }
    }
  }, [canUndo, undo, trackAndSetInput, setPastedContents, setCursorOffset])

  // Handler for chat:newline - insert a newline at the cursor position
  const handleNewline = useCallback(() => {
    pushToBuffer(input, cursorOffset, pastedContents)
    const newInput = `${input.slice(0, cursorOffset)}\n${input.slice(cursorOffset)}`
    trackAndSetInput(newInput)
    setCursorOffset(cursorOffset + 1)
  }, [input, cursorOffset, trackAndSetInput, pushToBuffer, pastedContents, setCursorOffset])

  // Handler for chat:externalEditor - edit in $EDITOR
  const handleExternalEditor = useCallback(async () => {
    logEvent('zy_external_editor_used', {})
    setIsExternalEditorActive(true)
    try {
      // Pass pastedContents to expand collapsed text references
      const result = await editPromptInEditor(input, pastedContents)
      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: result.error,
          color: 'warning',
          priority: 'high',
        })
      }
      if (result.content !== null && result.content !== input) {
        // Push current state to buffer before making changes
        pushToBuffer(input, cursorOffset, pastedContents)
        trackAndSetInput(result.content)
        setCursorOffset(result.content.length)
      }
    } catch (err) {
      if (err instanceof Error) {
        logError(err)
      }
      addNotification({
        key: 'external-editor-error',
        text: `External editor failed: ${errorMessage(err)}`,
        color: 'warning',
        priority: 'high',
      })
    } finally {
      setIsExternalEditorActive(false)
    }
  }, [
    input,
    cursorOffset,
    pastedContents,
    pushToBuffer,
    trackAndSetInput,
    addNotification,
    setIsExternalEditorActive,
    setCursorOffset,
  ])

  // 这些处理器依赖本阶段创建的 suggestions 与队列回填函数，
  // 因此必须在两者初始化后构造，避免跨阶段捕获尚未初始化的绑定。
  function handleHistoryUp() {
    if (suggestions.length > 1) {
      return
    }
    if (!isCursorOnFirstLine) {
      return
    }

    const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable)
    if (hasEditableCommand) {
      void popAllCommandsFromQueue()
      return
    }
    onHistoryUp()
  }

  function handleHistoryDown() {
    if (suggestions.length > 1) {
      return
    }
    if (!isCursorOnLastLine) {
      return
    }

    if (onHistoryDown() && footerItems.length > 0) {
      const first = footerItems[0]!
      selectFooterItem(first)
      if (first === 'tasks' && !getGlobalConfig().hasSeenTasksHint) {
        saveGlobalConfig((config) =>
          config.hasSeenTasksHint ? config : { ...config, hasSeenTasksHint: true },
        )
      }
    }
  }
  return {
    ...context,
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
    handleHistoryUp,
    handleHistoryDown,
  }
}
