/**
 * ReplTranscriptView — transcript screen 的渲染子组件，从 REPL.tsx 提取。
 *
 * 在 <ReplStoreProvider> 内渲染，可通过 useReplStore() 访问 store。
 */

import { feature } from 'bun:bundle'
import * as React from 'react'
import type { Command } from '../../commands/index.js'
import { AnimatedTerminalTitle } from '../../components/AnimatedTerminalTitle.js'
import { FullscreenLayout } from '../../components/FullscreenLayout.js'
import { Messages } from '../../components/Messages.js'
import { SandboxViolationExpandedView } from '../../components/SandboxViolationExpandedView.js'
import { ScrollKeybindingHandler } from '../../components/ScrollKeybindingHandler.js'
import { TranscriptModeFooter } from '../../components/TranscriptModeFooter.js'
import { TranscriptSearchBar } from '../../components/TranscriptSearchBar.js'
import type { JumpHandle } from '../../components/VirtualMessageList.js'
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js'
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js'
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { useSearchHighlight } from '../../ink/hooks/useSearchHighlight.js'
import { Box } from '../../ink/index.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import type { ActiveSpeculationState } from '../../services/prompt-suggestion/speculation.js'
import { ReplStoreProvider } from '../../state/ReplState.js'
import type { ReplStoreInstance, ToolJSXState } from '../../state/replStore.js'
import type { Tool } from '../../tools/tool.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message as MessageType } from '../../types/message.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../../services/terminal/fullscreen.js'
import type { PromptInputHelpers } from '../../services/input/handlePromptSubmit.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import { StreamingThinking, StreamingToolUse } from '../../services/messages/./streaming.js'
import type { Screen } from '../REPL.js'
import type { FocusedInputDialog } from './useReplOnCancel.js'
import { ReplVoiceKeybindingHandler, type ReplVoiceState } from './useReplVoice.js'

export interface ReplTranscriptViewProps {
  // Store
  replStore: ReplStoreInstance
  // Screen / display
  disableVirtualScroll: boolean
  dumpMode: boolean
  screen: Screen
  showAllInTranscript: boolean
  showStatusInTerminalTab: boolean
  titleIsAnimating: boolean
  terminalTitle: string
  titleDisabled: boolean
  // Messages
  transcriptMessages: MessageType[]
  transcriptStreamingToolUses: StreamingToolUse[]
  inProgressToolUseIDs: Set<string>
  conversationId: string
  agentDefinitions: AgentDefinitionsResult
  streamingThinking: StreamingThinking | null
  isLoading: boolean
  // ToolJSX
  toolJSX: ToolJSXState | null
  // Tools / commands
  tools: readonly Tool[]
  commands: Command[]
  // Scroll
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  // Search
  jumpRef: React.RefObject<JumpHandle | null>
  searchOpen: boolean
  setSearchOpen: (v: boolean) => void
  searchQuery: string
  setSearchQuery: (v: string) => void
  searchCount: number
  setSearchCount: (v: number) => void
  searchCurrent: number
  setSearchCurrent: (v: number) => void
  onSearchMatchesChange: (count: number, current: number) => void
  setHighlight: (q: string) => void
  scanElement: ReturnType<typeof useSearchHighlight>['scanElement']
  setPositions: ReturnType<typeof useSearchHighlight>['setPositions']
  editorStatus: string | false
  // Keybinding props — forwarded as-is; type safety at REPL.tsx call site
  globalKeybindingProps: Parameters<typeof GlobalKeybindingHandlers>[0]
  cancelRequestProps: Parameters<typeof CancelRequestHandler>[0]
  focusedInputDialog: FocusedInputDialog
  // Voice
  voice: ReplVoiceState
  // Callbacks
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
  handleOpenRateLimitOptions: () => void
}

export function ReplTranscriptView(props: ReplTranscriptViewProps): React.ReactNode {
  const {
    replStore,
    disableVirtualScroll,
    dumpMode,
    screen,
    showAllInTranscript,
    showStatusInTerminalTab,
    titleIsAnimating,
    terminalTitle,
    titleDisabled,
    transcriptMessages,
    transcriptStreamingToolUses,
    inProgressToolUseIDs,
    conversationId,
    agentDefinitions,
    streamingThinking,
    isLoading,
    toolJSX,
    tools,
    commands,
    scrollRef,
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
    editorStatus,
    globalKeybindingProps,
    cancelRequestProps,
    focusedInputDialog,
    voice,
    onSubmit,
    handleOpenRateLimitOptions,
  } = props

  const transcriptScrollRef =
    isFullscreenEnvEnabled() && !disableVirtualScroll && !dumpMode ? scrollRef : undefined

  const transcriptMessagesElement = (
    <Messages
      messages={transcriptMessages}
      tools={tools}
      commands={commands}
      verbose={true}
      toolJSX={null}
      toolUseConfirmQueue={[]}
      inProgressToolUseIDs={inProgressToolUseIDs}
      isMessageSelectorVisible={false}
      conversationId={conversationId}
      screen={screen}
      agentDefinitions={agentDefinitions}
      streamingToolUses={transcriptStreamingToolUses}
      showAllInTranscript={showAllInTranscript}
      onOpenRateLimitOptions={handleOpenRateLimitOptions}
      isLoading={isLoading}
      hidePastThinking={true}
      streamingThinking={streamingThinking}
      scrollRef={transcriptScrollRef}
      jumpRef={jumpRef}
      onSearchMatchesChange={onSearchMatchesChange}
      scanElement={scanElement}
      setPositions={setPositions}
      disableRenderCap={dumpMode}
    />
  )

  const transcriptToolJSX = toolJSX && (
    <Box flexDirection="column" width="100%">
      {toolJSX.jsx}
    </Box>
  )

  const transcriptReturn = (
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
      {transcriptScrollRef ? (
        <ScrollKeybindingHandler
          scrollRef={scrollRef}
          isActive={focusedInputDialog !== 'ultraplan-choice'}
          isModal={!searchOpen}
          onScroll={() => jumpRef.current?.disarmSearch()}
        />
      ) : null}
      <CancelRequestHandler {...cancelRequestProps} />
      {transcriptScrollRef ? (
        <FullscreenLayout
          scrollRef={scrollRef}
          scrollable={
            <>
              {transcriptMessagesElement}
              {transcriptToolJSX}
              <SandboxViolationExpandedView />
            </>
          }
          bottom={
            searchOpen ? (
              <TranscriptSearchBar
                jumpRef={jumpRef}
                initialQuery=""
                count={searchCount}
                current={searchCurrent}
                onClose={(q) => {
                  setSearchQuery(searchCount > 0 ? q : '')
                  setSearchOpen(false)
                  if (!q) {
                    setSearchCount(0)
                    setSearchCurrent(0)
                    jumpRef.current?.setSearchQuery('')
                  }
                }}
                onCancel={() => {
                  setSearchOpen(false)
                  jumpRef.current?.setSearchQuery('')
                  jumpRef.current?.setSearchQuery(searchQuery)
                  setHighlight(searchQuery)
                }}
                setHighlight={setHighlight}
              />
            ) : (
              <TranscriptModeFooter
                showAllInTranscript={showAllInTranscript}
                virtualScroll={true}
                status={editorStatus || ''}
                searchBadge={
                  searchQuery && searchCount > 0
                    ? {
                        current: searchCurrent,
                        count: searchCount,
                      }
                    : null
                }
              />
            )
          }
        />
      ) : (
        <>
          {transcriptMessagesElement}
          {transcriptToolJSX}
          <SandboxViolationExpandedView />
          <TranscriptModeFooter
            showAllInTranscript={showAllInTranscript}
            virtualScroll={false}
            suppressShowAll={dumpMode}
            status={editorStatus || ''}
            searchBadge={null}
          />
        </>
      )}
    </KeybindingSetup>
  )

  if (transcriptScrollRef) {
    return (
      <ReplStoreProvider store={replStore}>
        <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
          {transcriptReturn}
        </AlternateScreen>
      </ReplStoreProvider>
    )
  }
  return <ReplStoreProvider store={replStore}>{transcriptReturn}</ReplStoreProvider>
}
