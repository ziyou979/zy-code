import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink/index.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import type { BaseTextInputProps } from '../../types/textInputTypes.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getTeammateColor } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import type { Theme } from '../../utils/theme.js'
import { BridgeDialog } from '../BridgeDialog.js'
import TextInput from '../TextInput.js'
import VimTextInput from '../VimTextInput.js'
import { getValueFromInput } from './inputModes.js'
import { Notifications } from './Notifications.js'
import PromptInputFooter from './PromptInputFooter.js'
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js'
import { PromptInputQueuedCommands } from './PromptInputQueuedCommands.js'
import { PromptInputStashNotice } from './PromptInputStashNotice.js'
import { isVimModeEnabled } from './utils.js'
import { usePromptInputViewModel } from './usePromptInputViewModel.js'
export function renderPromptInput(context: ReturnType<typeof usePromptInputViewModel>) {
  if (!('swarmBanner' in context)) {
    return context
  }
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
  } = context

  // Show loop mode menu when requested (ant-only, eliminated from external builds)
  if (modelPickerElement) {
    return modelPickerElement
  }

  if (thinkingToggleElement) {
    return thinkingToggleElement
  }

  if (showBridgeDialog) {
    return (
      <BridgeDialog
        onDone={() => {
          setShowBridgeDialog(false)
          selectFooterItem(null)
        }}
      />
    )
  }

  const baseProps: BaseTextInputProps = {
    multiline: true,
    onSubmit,
    onChange,
    value: historyMatch
      ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display)
      : input,
    // History navigation is handled via TextInput props (onHistoryUp/onHistoryDown),
    // NOT via useKeybindings. This allows useTextInput's upOrHistoryUp/downOrHistoryDown
    // to try cursor movement first and only fall through to history navigation when the
    // cursor can't move further (important for wrapped text and multi-line input).
    onHistoryUp: handleHistoryUp,
    onHistoryDown: handleHistoryDown,
    onHistoryReset: resetHistory,
    placeholder,
    onExit,
    onExitMessage: (show, key) =>
      setExitMessage({
        show,
        key,
      }),
    onImagePaste,
    columns: textInputColumns,
    maxVisibleLines,
    disableCursorMovementForUpDownKeys: suggestions.length > 0 || !!footerItemSelected,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    onPaste: onTextPaste,
    onIsPastingChange: setIsPasting,
    focus: !isSearchingHistory && !isModalOverlayActive && !footerItemSelected,
    showCursor: !footerItemSelected && !isSearchingHistory && !cursorAtImageChip,
    argumentHint: commandArgumentHint,
    onUndo: canUndo
      ? () => {
          const previousState = undo()
          if (previousState) {
            trackAndSetInput(previousState.text)
            setCursorOffset(previousState.cursorOffset)
            setPastedContents(previousState.pastedContents)
          }
        }
      : undefined,
    highlights: combinedHighlights,
    inlineGhostText,
    inputFilter: lazySpaceInputFilter,
  }

  const getBorderColor = (): keyof Theme => {
    const modeColors: Record<string, keyof Theme> = {
      bash: 'bashBorder',
    }

    // Mode colors take priority, then teammate color, then default
    if (modeColors[mode]) {
      return modeColors[mode]
    }

    // In-process teammates run headless - don't apply teammate colors to leader UI
    if (isInProcessTeammate()) {
      return 'promptBorder'
    }

    // Check for teammate color from environment
    const teammateColorName = getTeammateColor()
    if (teammateColorName && AGENT_COLORS.includes(teammateColorName as AgentColorName)) {
      return AGENT_COLOR_TO_THEME_COLOR[teammateColorName as AgentColorName]
    }
    return 'promptBorder'
  }

  if (isExternalEditorActive) {
    return (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        borderColor={getBorderColor()}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Text dimColor italic>
          Save and close editor to continue...
        </Text>
      </Box>
    )
  }

  const textInputElement = isVimModeEnabled() ? (
    <VimTextInput {...baseProps} initialMode={vimMode} onModeChange={setVimMode} />
  ) : (
    <TextInput {...baseProps} />
  )

  return (
    <Box flexDirection="column" marginTop={briefOwnsGap ? 0 : 1}>
      {!isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
      {hasSuppressedDialogs && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Waiting for permission…</Text>
        </Box>
      )}
      <PromptInputStashNotice hasStash={stashedPrompt !== undefined} />
      {swarmBanner ? (
        <>
          <Text color={swarmBanner.bgColor}>
            {swarmBanner.text ? (
              <>
                {'─'.repeat(Math.max(0, columns - stringWidth(swarmBanner.text) - 4))}
                <Text backgroundColor={swarmBanner.bgColor} color="inverseText">
                  {' '}
                  {swarmBanner.text}{' '}
                </Text>
                {'──'}
              </>
            ) : (
              '─'.repeat(columns)
            )}
          </Text>
          <Box flexDirection="row" width="100%">
            {/* @ts-ignore -- PromptInputModeIndicator props extended in ant build */}
            <PromptInputModeIndicator
              mode={mode}
              isLoading={isLoading}
              viewingAgentName={viewingAgentName}
              viewingAgentColor={viewingAgentColor}
            />
            <Box flexGrow={1} flexShrink={0} minHeight={1} onClick={handleInputClick}>
              {textInputElement}
            </Box>
          </Box>
          <Text color={swarmBanner.bgColor}>{'─'.repeat(columns)}</Text>
        </>
      ) : (
        <Box
          flexDirection="row"
          alignItems="flex-start"
          justifyContent="flex-start"
          borderColor={getBorderColor()}
          borderStyle="round"
          borderLeft={false}
          borderRight={false}
          borderBottom
          width="100%"
        >
          {/* @ts-ignore */}
          <PromptInputModeIndicator
            mode={mode}
            isLoading={isLoading}
            viewingAgentName={viewingAgentName}
            viewingAgentColor={viewingAgentColor}
          />
          <Box flexGrow={1} flexShrink={0} minHeight={1} onClick={handleInputClick}>
            {textInputElement}
          </Box>
        </Box>
      )}
      <PromptInputFooter
        apiKeyStatus={apiKeyStatus}
        debug={debug}
        exitMessage={exitMessage}
        vimMode={isVimModeEnabled() ? vimMode : undefined}
        mode={mode}
        autoUpdaterResult={autoUpdaterResult}
        isAutoUpdating={isAutoUpdating}
        verbose={verbose}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={setIsAutoUpdating}
        suggestions={suggestions}
        selectedSuggestion={selectedSuggestion}
        maxColumnWidth={maxColumnWidth}
        onAcceptSuggestion={acceptSuggestion}
        onClickSuggestion={onClickSuggestion}
        toolPermissionContext={effectiveToolPermissionContext}
        helpOpen={helpOpen}
        suppressHint={input.length > 0}
        isLoading={isLoading}
        tasksSelected={tasksSelected}
        teamsSelected={teamsSelected}
        bridgeSelected={bridgeSelected}
        tmuxSelected={tmuxSelected}
        teammateFooterIndex={teammateFooterIndex}
        ideSelection={ideSelection}
        mcpClients={mcpClients}
        isPasting={isPasting}
        isInputWrapped={isInputWrapped}
        messages={messages}
        isSearching={isSearchingHistory}
        historyQuery={historyQuery}
        setHistoryQuery={setHistoryQuery}
        historyFailedMatch={historyFailedMatch}
        onOpenTasksDialog={isFullscreenEnvEnabled() ? handleOpenTasksDialog : undefined}
      />
      {isFullscreenEnvEnabled() ? null : autoModeOptInDialog}
      {isFullscreenEnvEnabled() ? (
        // position=absolute takes zero layout height so the spinner
        // doesn't shift when a notification appears/disappears. Yoga
        // anchors absolute children at the parent's content-box origin;
        // marginTop=-1 pulls it into the marginTop=1 gap row above the
        // prompt border. In brief mode there is no such gap (briefOwnsGap
        // strips our marginTop) and BriefSpinner sits flush against the
        // border — marginTop=-2 skips over the spinner content into
        // BriefSpinner's own marginTop=1 blank row. height=1 +
        // overflow=hidden clips multi-line notifications to a single row.
        // flex-end anchors the bottom line so the visible row is always
        // the most recent. Suppressed while the slash overlay or
        // auto-mode opt-in dialog is up by height=0 (NOT unmount) — this
        // Box renders later in tree order so it would paint over their
        // bottom row. Keeping Notifications mounted prevents AutoUpdater's
        // initial-check effect from re-firing on every slash-completion
        // toggle (PR#22413).
        <Box
          position="absolute"
          marginTop={briefOwnsGap ? -2 : -1}
          height={suggestions.length === 0 && !showAutoModeOptIn ? 1 : 0}
          width="100%"
          paddingLeft={2}
          paddingRight={1}
          flexDirection="column"
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Notifications
            apiKeyStatus={apiKeyStatus}
            autoUpdaterResult={autoUpdaterResult}
            debug={debug}
            isAutoUpdating={isAutoUpdating}
            verbose={verbose}
            messages={messages}
            onAutoUpdaterResult={onAutoUpdaterResult}
            onChangeIsUpdating={setIsAutoUpdating}
            ideSelection={ideSelection}
            mcpClients={mcpClients}
            isInputWrapped={isInputWrapped}
          />
        </Box>
      ) : null}
    </Box>
  )
}
