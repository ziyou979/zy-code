/**
 * replQueryFlow.ts — 从 REPL.tsx 提取的 5 个核心查询流函数。
 *
 * 所有函数接收 QueryFlowContext 代替 React 闭包捕获，
 * 使它们成为纯 TypeScript 函数（无 React、无 JSX）。
 */

import { feature } from 'bun:bundle'
import type React from 'react'
import {
  getBudgetContinuationCount,
  getCurrentTurnTokenBudget,
  getTotalInputTokens,
  getTurnOutputTokens,
  snapshotOutputTokensForTurn,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { coordinatorModeModule, proactiveModule } from '../../cli/lazyModules.js'
import type { Command, CommandResultDisplay } from '../../commands/index.js'
import { getCommandName, isCommandEnabled } from '../../commands/index.js'
import {
  messagesAfterAreOnlySynthetic,
  selectableUserMessagesFilter,
} from '../../components/MessageSelector.js'
import { prependModeCharacterToInput } from '../../components/PromptInput/inputModes.js'
import { processBashCommand } from '../../components/process-user-input/BashCommandController.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import {
  BASH_INPUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { Notification } from '../../context/notifications.js'
import { getSystemContext, getUserContext } from '../../services/context/context.js'
import {
  addToHistory,
  expandPastedTextRefs,
  parseReferences,
  removeLastFromHistory,
} from '../../services/session-storage/history.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { mergeClients } from '../../hooks/useMergedClients.js'
import type { TerminalNotification } from '../../ink/useTerminalNotification.js'
import { maybeMarkProjectOnboardingComplete } from '../../services/settings/projectOnboardingState.js'
import { query } from '../../query/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { sendNotification } from '../../services/notifier.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type { ActiveSpeculationState } from '../../services/prompt-suggestion/speculation.js'
import { handleSpeculationAccept } from '../../services/prompt-suggestion/speculation.js'
import { prependToShellHistoryCache } from '../../services/suggestions/shellHistoryCompletion.js'
import { setMemberActive } from '../../services/swarm/teamHelpers.js'
import type { RemoteMessageContent } from '../../services/teleport/api.js'
import type { AppState, AppStateStore } from '../../state/AppStateStore.js'
import type { ReplStoreInstance, ToolJSXState } from '../../state/replStore.js'
import type { CompactProgressEvent, Tool } from '../../tools/tool.js'
import { getAllInProcessTeammateTasks } from '../../tasks/in-process-teammate-task/InProcessTeammateTask.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import { assembleToolPool } from '../../tools/tools.js'
import { toUUID } from '../../types/ids.js'
import type { UserContentBlock } from '../../types/llm.js'
import type { Message as MessageType, UserMessage } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { createAbortController } from '../../utils/abortController.js'
import { isAgentSwarmsEnabled } from '../../services/swarm/agentSwarmsEnabled.js'
import { count } from '../../utils/array.js'
import type { AttributionState } from '../../utils/commitAttribution.js'
import { incrementPromptCount } from '../../utils/commitAttribution.js'
import type { PastedContent } from '../../services/config/config.js'
import { getGlobalConfig } from '../../services/config/config.js'
import { createDebugLog } from '../../utils/debug.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import { isFullscreenEnvEnabled } from '../../services/terminal/fullscreen.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import { handlePromptSubmit } from '../../utils/handlePromptSubmit.js'
import { executeMessageDisplayHooks } from '../../services/hooks/executors/messageDisplay.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../../services/ide/ide.js'
import { closeOpenDiffs, getConnectedIdeClient } from '../../services/ide/ide.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import { enqueue, getCommandQueueLength } from '../../utils/messageQueueManager.js'
import { StreamingThinking } from '../../services/messages/./streaming.js'
import {
  createCommandInputMessage,
  createTurnDurationMessage,
  createUserMessage,
  formatCommandInputTags,
} from '../../services/messages/./constructors.js'
import {
  getContentText,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from '../../services/messages/./predicates.js'
import { handleMessageFromStream } from '../../services/messages/./streaming.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
} from '../../services/permissions/bypassPermissionsKillswitch.js'
import { getScratchpadDir, isScratchpadEnabled } from '../../services/permissions/filesystem.js'
import { getQuerySourceForREPL } from '../../services/analytics/querySource.js'
import { logQueryProfileReport, queryCheckpoint } from '../../utils/queryProfiler.js'
import {
  cacheSessionTitle,
  isEphemeralToolProgress,
  isLoggableMessage,
  recordAttributionSnapshot,
  removeTranscriptMessage,
  saveAiGeneratedTitle,
} from '../../services/sessionStorage.js'
import { generateSessionTitle } from '../../utils/sessionTitle.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import type { ThemeName } from '../../utils/theme.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { parseTokenBudget } from '../../utils/tokenBudget.js'
import { mergeAndFilterTools } from '../../services/tool-runtime/toolPool.js'
import { escapeXml } from '../../utils/xml.js'
import type { ActiveRemote } from './useReplActiveRemote.js'
import type { RequestPromptFactory } from './useReplRequestPrompt.js'
import type { ResumeFunction } from './useReplSessionRestore.js'

const log = createDebugLog('query')

// ── QueryFlowContext ──

export type QueryFlowContext = {
  // ── stores ──
  replStore: ReplStoreInstance
  appStore: AppStateStore
  setAppState: (updater: (prev: AppState) => AppState) => void

  // ── props / config (stable across renders) ──
  debug: boolean
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig
  disabled: boolean
  initialMcpClients: MCPServerConnection[] | undefined
  onTurnComplete: ((messages: MessageType[]) => void | Promise<void>) | undefined
  onBeforeQuery: ((input: string, newMessages: MessageType[]) => Promise<boolean>) | undefined

  // ── derived / memo'd values ──
  commands: Command[]
  combinedInitialTools: Tool[]
  theme: ThemeName
  ideInstallationStatus: IDEExtensionInstallationStatus | null
  sessionTitle: string | undefined
  titleDisabled: boolean
  proactiveActive: boolean
  mainLoopModel: string

  // ── callbacks (from hooks / useCallback in REPL) ──
  setToolJSX: (args: (ToolJSXState & { clearLocalJSX?: boolean }) | null) => void
  setResponseLength: (f: (prev: number) => number) => void
  addNotification: (content: Notification) => void
  reverify: () => void
  terminal: TerminalNotification
  onCompactProgress: (event: CompactProgressEvent) => void
  resume: ResumeFunction
  requestPrompt: RequestPromptFactory | undefined
  onChangeDynamicMcpConfig: (config: Record<string, ScopedMcpServerConfig>) => void
  setIDEToInstallExtension: React.Dispatch<React.SetStateAction<IdeType | null>>
  canUseTool: CanUseToolFn
  resetLoadingState: () => void
  setAbortController: (v: AbortController | null) => void
  forceRenderTitle: (updater: (n: number) => number) => void
  onStreamingText: (f: (current: string | null) => string | null) => void
  setStreamingThinking: (f: (current: StreamingThinking | null) => StreamingThinking | null) => void
  resetTimingRefs: () => void
  setStreamingText: (v: string | null) => void

  // ── moreRight callbacks ──
  mrOnBeforeQuery: (input: string, messages: MessageType[], count: number) => Promise<boolean>
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => Promise<void>

  // ── refs (read in async callbacks) ──
  terminalFocusRef: { current: boolean }
  sendWireResultRef: { current: () => void }
  restoreMessageSyncRef: { current: (m: UserMessage) => void }
  inputValueRef: { current: string }
  loadingStartTimeRef: { current: number }
  totalPausedMsRef: { current: number }
  swarmStartTimeRef: { current: number | null }
  swarmBudgetInfoRef: { current: { tokens: number; limit: number; nudges: number } | undefined }

  // ── toolPermissionContext (from AppState, needed for checkAndDisable*) ──
  toolPermissionContext: AppState['toolPermissionContext']
}

/**
 * Superset of QueryFlowContext with additional deps needed only by onSubmit.
 */
export type SubmitFlowContext = QueryFlowContext & {
  isLoading: boolean
  isExternalLoading: boolean
  inputMode: PromptInputMode
  pastedContents: Record<number, PastedContent>
  ideSelection: IDESelection | undefined
  stashedPrompt:
    | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
    | undefined
  abortController: AbortController | null
  activeRemote: ActiveRemote

  // callbacks
  setInputValue: (v: string) => void
  setInputMode: (v: PromptInputMode) => void
  setPastedContents: (v: Record<number, PastedContent>) => void
  setIDESelection: (v: IDESelection | undefined) => void
  setStashedPrompt: (
    v:
      | { text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }
      | undefined,
  ) => void
  repinScroll: () => void
  awaitPendingHooks: () => Promise<void>
  resetTipPickedThisTurn: () => void
}

// ────────────────────────────────────────────────────────
//  1. buildToolUseContext  (was getToolUseContext)
// ────────────────────────────────────────────────────────

export function buildToolUseContext(
  ctx: QueryFlowContext,
  messages: MessageType[],
  _newMessages: MessageType[],
  abortController: AbortController,
  mainLoopModel: string,
): ProcessUserInputContext {
  const appState = ctx.appStore.getState()
  const replState = ctx.replStore.getState()
  const agentDef = replState.mainThreadAgentDefinition
  const computeTools = () => {
    const state = ctx.appStore.getState()
    const assembled = assembleToolPool(state.toolPermissionContext, state.mcp.tools)
    const merged = mergeAndFilterTools(
      ctx.combinedInitialTools,
      assembled,
      state.toolPermissionContext.mode,
    )
    if (!agentDef) {
      return merged
    }
    return resolveAgentTools(agentDef, merged, false, true).resolvedTools
  }
  const resolvedAllowed = agentDef
    ? resolveAgentTools(agentDef, computeTools(), false, true).allowedAgentTypes
    : undefined
  return {
    abortController,
    options: {
      commands: ctx.commands,
      tools: computeTools(),
      debug: ctx.debug,
      verbose: appState.verbose,
      mainLoopModel,
      thinkingConfig:
        appState.thinkingEnabled !== false ? ctx.thinkingConfig : { type: 'disabled' },
      mcpClients: mergeClients(ctx.initialMcpClients, appState.mcp.clients),
      mcpResources: appState.mcp.resources,
      ideInstallationStatus: ctx.ideInstallationStatus,
      isNonInteractiveSession: false,
      dynamicMcpConfig: replState.dynamicMcpConfig,
      theme: ctx.theme,
      agentDefinitions: resolvedAllowed
        ? { ...appState.agentDefinitions, allowedAgentTypes: resolvedAllowed }
        : appState.agentDefinitions,
      customSystemPrompt: ctx.customSystemPrompt,
      appendSystemPrompt: ctx.appendSystemPrompt,
      refreshTools: computeTools,
    },
    getAppState: () => ctx.appStore.getState(),
    setAppState: ctx.setAppState,
    messages,
    setMessages: ctx.replStore.setMessages,
    updateFileHistoryState(updater: (prev: FileHistoryState) => FileHistoryState) {
      ctx.setAppState((prev) => {
        const updated = updater(prev.fileHistory)
        return updated === prev.fileHistory ? prev : { ...prev, fileHistory: updated }
      })
    },
    updateAttributionState(updater: (prev: AttributionState) => AttributionState) {
      ctx.setAppState((prev) => {
        const updated = updater(prev.attribution)
        return updated === prev.attribution ? prev : { ...prev, attribution: updated }
      })
    },
    openMessageSelector: () => {
      if (!ctx.disabled) {
        ctx.replStore.setIsMessageSelectorVisible(true)
      }
    },
    onChangeAPIKey: ctx.reverify,
    readFileState: ctx.replStore.mutable.readFileState,
    setToolJSX: ctx.setToolJSX,
    addNotification: ctx.addNotification,
    appendSystemMessage: (msg) => ctx.replStore.setMessages((prev) => [...prev, msg]),
    sendOSNotification: (opts) => {
      void sendNotification(opts, ctx.terminal)
    },
    onChangeDynamicMcpConfig: ctx.onChangeDynamicMcpConfig,
    onInstallIDEExtension: ctx.setIDEToInstallExtension,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: ctx.replStore.mutable.loadedNestedMemoryPaths,
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: ctx.replStore.mutable.discoveredSkillNames,
    setResponseLength: ctx.setResponseLength,
    setStreamMode: ctx.replStore.setStreamMode,
    onCompactProgress: ctx.onCompactProgress,
    setInProgressToolUseIDs: ctx.replStore.setInProgressToolUseIDs,
    setHasInterruptibleToolInProgress: (v: boolean) => {
      ctx.replStore.mutable.hasInterruptibleToolInProgress = v
    },
    resume: ctx.resume,
    setConversationId: ctx.replStore.setConversationId,
    requestPrompt: feature('HOOK_PROMPTS') ? ctx.requestPrompt : undefined,
    contentReplacementState: ctx.replStore.mutable.contentReplacementState ?? undefined,
  }
}

// ────────────────────────────────────────────────────────
//  2. handleQueryEvent  (was onQueryEvent)
// ────────────────────────────────────────────────────────

export function handleQueryEvent(
  ctx: QueryFlowContext,
  event: Parameters<typeof handleMessageFromStream>[0],
): void {
  handleMessageFromStream(
    event,
    (newMessage) => {
      if (
        newMessage.type === 'assistant' &&
        ctx.replStore.mutable.lastThinkingDurationMs > 0 &&
        Array.isArray(newMessage.message.content) &&
        newMessage.message.content.some(
          (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
        )
      ) {
        newMessage.thinkingDurationMs = ctx.replStore.mutable.lastThinkingDurationMs
        ctx.replStore.mutable.lastThinkingDurationMs = 0
      }
      if (isCompactBoundaryMessage(newMessage)) {
        if (isFullscreenEnvEnabled()) {
          ctx.replStore.setMessages((old) => [...getMessagesAfterCompactBoundary(old), newMessage])
        } else {
          ctx.replStore.setMessages(() => [newMessage])
        }
        ctx.replStore.regenerateConversationId()
        if (feature('PROACTIVE') || feature('KAIROS')) {
          proactiveModule?.setContextBlocked(false)
        }
      } else if (newMessage.type === 'progress' && isEphemeralToolProgress(newMessage.data.type)) {
        ctx.replStore.setMessages((oldMessages) => {
          const last = oldMessages.at(-1)
          if (
            last?.type === 'progress' &&
            last.parentToolUseID === newMessage.parentToolUseID &&
            last.data.type === newMessage.data.type
          ) {
            const copy = oldMessages.slice()
            copy[copy.length - 1] = newMessage
            return copy
          }
          return [...oldMessages, newMessage]
        })
      } else {
        ctx.replStore.setMessages((oldMessages) => [...oldMessages, newMessage])
      }
      if (feature('PROACTIVE') || feature('KAIROS')) {
        if (
          newMessage.type === 'assistant' &&
          'isApiErrorMessage' in newMessage &&
          newMessage.isApiErrorMessage
        ) {
          proactiveModule?.setContextBlocked(true)
        } else if (newMessage.type === 'assistant') {
          proactiveModule?.setContextBlocked(false)
        }
      }
    },
    (newContent) => {
      ctx.setResponseLength((length) => length + newContent.length)
    },
    ctx.replStore.setStreamMode,
    ctx.replStore.setStreamingToolUses,
    (tombstonedMessage) => {
      ctx.replStore.setMessages((oldMessages) => oldMessages.filter((m) => m !== tombstonedMessage))
      void removeTranscriptMessage(toUUID(tombstonedMessage.uuid))
    },
    ctx.setStreamingThinking,
    ctx.onStreamingText,
  )
}

// ────────────────────────────────────────────────────────
//  3. runQueryImpl  (was onQueryImpl)
// ────────────────────────────────────────────────────────

export async function runQueryImpl(
  ctx: QueryFlowContext,
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext,
  messagesIncludingNewMessages: MessageType[],
  newMessages: MessageType[],
  abortController: AbortController,
  shouldQuery: boolean,
  additionalAllowedTools: string[],
  mainLoopModelParam: string,
  effort?: EffortLevel,
): Promise<void> {
  // 为新提示准备 IDE 集成
  if (shouldQuery) {
    const freshClients = mergeClients(ctx.initialMcpClients, ctx.appStore.getState().mcp.clients)
    void diagnosticTracker.handleQueryStart(freshClients)
    const ideClient = getConnectedIdeClient(freshClients)
    if (ideClient) {
      void closeOpenDiffs(ideClient)
    }
  }

  void maybeMarkProjectOnboardingComplete()

  // AI 标题生成
  if (
    !ctx.titleDisabled &&
    !ctx.sessionTitle &&
    !ctx.replStore.getState().mainThreadAgentDefinition?.agentType &&
    !ctx.replStore.mutable.titleGenerationAttempted
  ) {
    const firstUserMessage = newMessages.find((m) => m.type === 'user' && !m.isMeta)
    const text =
      firstUserMessage?.type === 'user' ? getContentText(firstUserMessage.message.content) : null
    if (
      text &&
      !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) &&
      !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) &&
      !text.startsWith(`<${COMMAND_NAME_TAG}>`) &&
      !text.startsWith(`<${BASH_INPUT_TAG}>`)
    ) {
      ctx.replStore.mutable.titleGenerationAttempted = true
      void generateSessionTitle(text, new AbortController().signal).then(
        (title) => {
          if (title) {
            const sid = getSessionId()
            if (sid) {
              saveAiGeneratedTitle(toUUID(sid), title)
              cacheSessionTitle(title)
              ctx.forceRenderTitle((n) => n + 1)
            }
          } else {
            ctx.replStore.mutable.titleGenerationAttempted = false
          }
        },
        () => {
          ctx.replStore.mutable.titleGenerationAttempted = false
        },
      )
    }
  }

  // 斜杠命令范围的 allowedTools
  ctx.appStore.setState((prev) => {
    const cur = prev.toolPermissionContext.alwaysAllowRules.command
    if (
      cur === additionalAllowedTools ||
      (cur?.length === additionalAllowedTools.length &&
        cur.every((v, i) => v === additionalAllowedTools[i]))
    ) {
      return prev
    }
    return {
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: additionalAllowedTools,
        },
      },
    }
  })

  if (!shouldQuery) {
    if (newMessages.some(isCompactBoundaryMessage)) {
      ctx.replStore.regenerateConversationId()
      if (feature('PROACTIVE') || feature('KAIROS')) {
        proactiveModule?.setContextBlocked(false)
      }
    }
    ctx.resetLoadingState()
    ctx.setAbortController(null)
    return
  }

  const toolUseContext = getToolUseContext(
    messagesIncludingNewMessages,
    newMessages,
    abortController,
    mainLoopModelParam,
  )
  const { tools: freshTools, mcpClients: freshMcpClients } = toolUseContext.options

  if (effort !== undefined) {
    const previousGetAppState = toolUseContext.getAppState
    toolUseContext.getAppState = () => ({
      ...previousGetAppState(),
      effortValue: effort,
    })
  }

  queryCheckpoint('query_context_loading_start')
  const [, , defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
    checkAndDisableBypassPermissionsIfNeeded(ctx.toolPermissionContext, ctx.setAppState),
    checkAndDisableAutoModeIfNeeded(ctx.toolPermissionContext, ctx.setAppState),
    getSystemPrompt(
      freshTools,
      mainLoopModelParam,
      Array.from(ctx.toolPermissionContext.additionalWorkingDirectories.keys()),
      freshMcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])
  const userContext = {
    ...baseUserContext,
    ...(coordinatorModeModule?.getCoordinatorUserContext(
      freshMcpClients,
      isScratchpadEnabled() ? getScratchpadDir() : undefined,
    ) ?? {}),
    ...((feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive() &&
    !ctx.terminalFocusRef.current
      ? {
          terminalFocus: 'The terminal is unfocused — the user is not actively watching.',
        }
      : {}),
  }
  queryCheckpoint('query_context_loading_end')
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: ctx.replStore.getState().mainThreadAgentDefinition,
    toolUseContext,
    customSystemPrompt: ctx.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: ctx.appendSystemPrompt,
  })
  toolUseContext.renderedSystemPrompt = systemPrompt
  queryCheckpoint('query_query_start')
  for await (const event of query({
    messages: messagesIncludingNewMessages,
    systemPrompt,
    userContext,
    systemContext,
    canUseTool: ctx.canUseTool,
    toolUseContext,
    querySource: getQuerySourceForREPL(),
  })) {
    // MessageDisplay hook：消息入 store（即渲染）前的异步边界。display-only —— 结果
    // 放进 message.displayOverride 仅供渲染层读取，不改 content（上下文/转录保留原文）。
    // 仅对非错误的 assistant 消息触发；executor 自身做 hasHookForEvent 短路 + 500ms 超时 + fail-open。
    if (event.type === 'assistant' && !event.isApiErrorMessage) {
      const decision = await executeMessageDisplayHooks(event, toolUseContext)
      if (decision.hide || decision.transformedText !== undefined) {
        event.displayOverride = {
          ...(decision.transformedText !== undefined && { text: decision.transformedText }),
          ...(decision.hide && { hide: true }),
        }
      }
    }
    handleQueryEvent(ctx, event)
  }
  queryCheckpoint('query_end')

  ctx.resetLoadingState()

  logQueryProfileReport()

  await ctx.onTurnComplete?.(ctx.replStore.getState().messages)
}

// ────────────────────────────────────────────────────────
//  4. runQuery  (was onQuery)
// ────────────────────────────────────────────────────────

export async function runQuery(
  ctx: QueryFlowContext,
  _getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext,
  onQueryImplFn: (
    messagesIncludingNewMessages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModel: string,
    effort?: EffortLevel,
  ) => Promise<void>,
  newMessages: MessageType[],
  abortController: AbortController,
  shouldQuery: boolean,
  additionalAllowedTools: string[],
  mainLoopModelParam: string,
  onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
  input?: string,
  effort?: EffortLevel,
): Promise<void> {
  const queryGuard = ctx.replStore.mutable.queryGuard

  // teammate 回合开始时标记为活动
  if (isAgentSwarmsEnabled()) {
    const teamName = getTeamName()
    const agentName = getAgentName()
    if (teamName && agentName) {
      void setMemberActive(teamName, agentName, true)
    }
  }

  const thisGeneration = queryGuard.tryStart()
  if (thisGeneration === null) {
    logEvent('zy_concurrent_onquery_detected', {})

    newMessages
      .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
      .map((_) => getContentText(_.message.content))
      .filter((_) => _ !== null)
      .forEach((msg, i) => {
        enqueue({
          value: msg,
          mode: 'prompt',
        })
        if (i === 0) {
          logEvent('zy_concurrent_onquery_enqueued', {})
        }
      })
    return
  }

  try {
    ctx.resetTimingRefs()
    ctx.replStore.setMessages((oldMessages) => [...oldMessages, ...newMessages])
    ctx.replStore.mutable.responseLengthRef = 0
    if (feature('TOKEN_BUDGET')) {
      const parsedBudget = input ? parseTokenBudget(input) : null
      snapshotOutputTokensForTurn(parsedBudget ?? getCurrentTurnTokenBudget())
    }
    ctx.replStore.setStreamingToolUses([])
    ctx.setStreamingText(null)

    const latestMessages = ctx.replStore.getState().messages
    if (input) {
      await ctx.mrOnBeforeQuery(input, latestMessages, newMessages.length)
    }

    if (onBeforeQueryCallback && input) {
      const shouldProceed = await onBeforeQueryCallback(input, latestMessages)
      if (!shouldProceed) {
        return
      }
    }
    await onQueryImplFn(
      latestMessages,
      newMessages,
      abortController,
      shouldQuery,
      additionalAllowedTools,
      mainLoopModelParam,
      effort,
    )
  } finally {
    if (queryGuard.end(thisGeneration)) {
      ctx.replStore.setLastQueryCompletionTime(Date.now())
      ctx.replStore.mutable.skipIdleCheck = false
      ctx.resetLoadingState()
      await ctx.mrOnTurnComplete(ctx.replStore.getState().messages, abortController.signal.aborted)

      ctx.sendWireResultRef.current()

      if (isInternalBuild() && !abortController.signal.aborted) {
        ctx.setAppState((prev) => {
          if (prev.tungstenActiveSession === undefined) {
            return prev
          }
          if (prev.tungstenPanelAutoHidden === true) {
            return prev
          }
          return {
            ...prev,
            tungstenPanelAutoHidden: true,
          }
        })
      }

      let budgetInfo:
        | {
            tokens: number
            limit: number
            nudges: number
          }
        | undefined
      if (feature('TOKEN_BUDGET')) {
        if (
          getCurrentTurnTokenBudget() !== null &&
          getCurrentTurnTokenBudget()! > 0 &&
          !abortController.signal.aborted
        ) {
          budgetInfo = {
            tokens: getTurnOutputTokens(),
            limit: getCurrentTurnTokenBudget()!,
            nudges: getBudgetContinuationCount(),
          }
        }
        snapshotOutputTokensForTurn(null)
      }

      const turnDurationMs =
        Date.now() - ctx.loadingStartTimeRef.current - ctx.totalPausedMsRef.current
      // CC 行为对齐：仅在实际发起模型查询时（shouldQuery=true）才生成 turn_duration 消息。
      // /clear、/model、/compact 等本地命令 shouldQuery=false，不应显示"处理完成"。
      // 旧代码无条件生成导致 /clear 后出现"⣝ 处理完成，耗时 0 秒"。
      if (shouldQuery && !abortController.signal.aborted && !ctx.proactiveActive) {
        const hasRunningSwarmAgents = getAllInProcessTeammateTasks(
          ctx.appStore.getState().tasks,
        ).some((t) => t.status === 'running')
        if (hasRunningSwarmAgents) {
          if (ctx.swarmStartTimeRef.current === null) {
            ctx.swarmStartTimeRef.current = ctx.loadingStartTimeRef.current
          }
          if (budgetInfo) {
            ctx.swarmBudgetInfoRef.current = budgetInfo
          }
        } else {
          ctx.replStore.setMessages((prev) => [
            ...prev,
            createTurnDurationMessage(turnDurationMs, budgetInfo, count(prev, isLoggableMessage)),
          ])
        }
      }
      ctx.setAbortController(null)
    }

    // 自动恢复
    if (
      abortController.signal.reason === 'user-cancel' &&
      !queryGuard.isActive &&
      ctx.inputValueRef.current === '' &&
      getCommandQueueLength() === 0 &&
      !ctx.appStore.getState().viewingAgentTaskId
    ) {
      const msgs = ctx.replStore.getState().messages
      const lastUserMsg = msgs.findLast(selectableUserMessagesFilter)
      if (lastUserMsg) {
        const idx = msgs.lastIndexOf(lastUserMsg)
        if (messagesAfterAreOnlySynthetic(msgs, idx)) {
          removeLastFromHistory()
          ctx.restoreMessageSyncRef.current(lastUserMsg)
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────
//  5. handleSubmit  (was onSubmit)
// ────────────────────────────────────────────────────────

export async function handleSubmit(
  ctx: SubmitFlowContext,
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModel: string,
    onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
    input?: string,
    effort?: EffortLevel,
  ) => Promise<void>,
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext,
  input: string,
  helpers: PromptInputHelpers,
  speculationAccept?: {
    state: ActiveSpeculationState
    speculationSessionTimeSavedMs: number
    setAppState: SetAppState
  },
  options?: {
    fromKeybinding?: boolean
  },
): Promise<void> {
  const queryGuard = ctx.replStore.mutable.queryGuard

  // 提交时重新固定滚动到底部
  ctx.repinScroll()

  // 如果暂停则恢复 loop mode
  if (feature('PROACTIVE') || feature('KAIROS')) {
    proactiveModule?.resumeProactive()
  }

  // 处理即时命令
  if (!speculationAccept && input.trim().startsWith('/')) {
    const trimmedInput = expandPastedTextRefs(input, ctx.pastedContents).trim()
    const spaceIndex = trimmedInput.indexOf(' ')
    const commandName =
      spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex)
    const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim()

    const matchingCommand = ctx.commands.find(
      (cmd) =>
        isCommandEnabled(cmd) &&
        (cmd.name === commandName ||
          cmd.aliases?.includes(commandName) ||
          getCommandName(cmd) === commandName),
    )
    if (matchingCommand?.name === 'clear' && ctx.replStore.mutable.idleHintShown) {
      logEvent('zy_idle_return_action', {
        action: 'hint_converted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        variant: ctx.replStore.mutable
          .idleHintShown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        idleMinutes: Math.round(
          (Date.now() - ctx.replStore.getState().lastQueryCompletionTime) / 60_000,
        ),
        messageCount: ctx.replStore.getState().messages.length,
        totalInputTokens: getTotalInputTokens(),
      })
      ctx.replStore.mutable.idleHintShown = false
    }
    const shouldTreatAsImmediate =
      queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding)
    if (matchingCommand && shouldTreatAsImmediate && matchingCommand.type === 'local-jsx') {
      if (input.trim() === ctx.inputValueRef.current.trim()) {
        ctx.setInputValue('')
        helpers.setCursorOffset(0)
        helpers.clearBuffer()
        ctx.setPastedContents({})
      }
      const pastedTextRefs = parseReferences(input).filter(
        (r) => ctx.pastedContents[r.id]?.type === 'text',
      )
      const pastedTextCount = pastedTextRefs.length
      const pastedTextBytes = pastedTextRefs.reduce(
        (sum, r) => sum + (ctx.pastedContents[r.id]?.content.length ?? 0),
        0,
      )
      logEvent('zy_paste_text', {
        pastedTextCount,
        pastedTextBytes,
      })
      logEvent('zy_immediate_command_executed', {
        commandName:
          matchingCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fromKeybinding: options?.fromKeybinding ?? false,
      })

      const executeImmediateCommand = async (): Promise<void> => {
        let doneWasCalled = false
        const onDone = (
          result?: string,
          doneOptions?: {
            display?: CommandResultDisplay
            metaMessages?: string[]
          },
        ): void => {
          doneWasCalled = true
          ctx.setToolJSX({
            jsx: null,
            shouldHidePromptInput: false,
            clearLocalJSX: true,
          })
          const newMessages: MessageType[] = []
          if (result && doneOptions?.display !== 'skip') {
            ctx.addNotification({
              key: `immediate-${matchingCommand.name}`,
              text: result,
              priority: 'immediate',
            })
            if (!isFullscreenEnvEnabled()) {
              newMessages.push(
                createCommandInputMessage(
                  formatCommandInputTags(getCommandName(matchingCommand), commandArgs),
                ),
                createCommandInputMessage(
                  `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`,
                ),
              )
            }
          }
          if (doneOptions?.metaMessages?.length) {
            newMessages.push(
              ...doneOptions.metaMessages.map((content) =>
                createUserMessage({
                  content: [{ type: 'text' as const, text: content }],
                  isMeta: true,
                }),
              ),
            )
          }
          if (newMessages.length) {
            ctx.replStore.setMessages((prev) => [...prev, ...newMessages])
          }
          if (ctx.stashedPrompt !== undefined) {
            ctx.setInputValue(ctx.stashedPrompt.text)
            helpers.setCursorOffset(ctx.stashedPrompt.cursorOffset)
            ctx.setPastedContents(ctx.stashedPrompt.pastedContents)
            ctx.setStashedPrompt(undefined)
          }
        }

        const context = getToolUseContext(
          ctx.replStore.getState().messages,
          [],
          createAbortController(),
          ctx.mainLoopModel,
        )
        const mod = await matchingCommand.load()
        const jsx = await mod.call(
          onDone,
          { ...context, invokedAs: commandName },
          commandArgs,
          commandName,
        )

        if (jsx && !doneWasCalled) {
          ctx.setToolJSX({
            jsx,
            shouldHidePromptInput: false,
            isLocalJSXCommand: true,
          })
        }
      }
      void executeImmediateCommand()
      return
    }
  }

  // 远程模式空输入检查
  if (ctx.activeRemote.isRemoteMode && !input.trim()) {
    return
  }

  // 空闲返回检查
  {
    const willowMode = getFeatureValue_CACHED_MAY_BE_STALE('zy_willow_mode', 'off')
    const idleThresholdMin = Number(process.env.ZY_CODE_IDLE_THRESHOLD_MINUTES ?? 75)
    const tokenThreshold = Number(process.env.ZY_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000)
    if (
      willowMode !== 'off' &&
      !getGlobalConfig().idleReturnDismissed &&
      !ctx.replStore.mutable.skipIdleCheck &&
      !speculationAccept &&
      !input.trim().startsWith('/') &&
      ctx.replStore.getState().lastQueryCompletionTime > 0 &&
      getTotalInputTokens() >= tokenThreshold
    ) {
      const idleMs = Date.now() - ctx.replStore.getState().lastQueryCompletionTime
      const idleMinutes = idleMs / 60_000
      if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
        ctx.replStore.setIdleReturnPending({
          input,
          idleMinutes,
        })
        ctx.setInputValue('')
        helpers.setCursorOffset(0)
        helpers.clearBuffer()
        return
      }
    }
  }

  // 历史记录
  if (!options?.fromKeybinding) {
    addToHistory({
      display: speculationAccept ? input : prependModeCharacterToInput(input, ctx.inputMode),
      pastedContents: speculationAccept ? {} : ctx.pastedContents,
    })
    if (ctx.inputMode === 'bash') {
      prependToShellHistoryCache(input.trim())
    }
  }

  // stash 恢复
  const isSlashCommand = !speculationAccept && input.trim().startsWith('/')
  const submitsNow = !ctx.isLoading || speculationAccept || ctx.activeRemote.isRemoteMode
  if (ctx.stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
    ctx.setInputValue(ctx.stashedPrompt.text)
    helpers.setCursorOffset(ctx.stashedPrompt.cursorOffset)
    ctx.setPastedContents(ctx.stashedPrompt.pastedContents)
    ctx.setStashedPrompt(undefined)
  } else if (submitsNow) {
    if (!options?.fromKeybinding) {
      ctx.setInputValue('')
      helpers.setCursorOffset(0)
    }
    ctx.setPastedContents({})
  }
  if (submitsNow) {
    ctx.setInputMode('prompt')
    ctx.setIDESelection(undefined)
    ctx.replStore.incrementSubmitCount()
    helpers.clearBuffer()
    ctx.resetTipPickedThisTurn()

    if (
      !isSlashCommand &&
      ctx.inputMode === 'prompt' &&
      !speculationAccept &&
      !ctx.activeRemote.isRemoteMode
    ) {
      ctx.replStore.setUserInputOnProcessing(input)
      ctx.resetTimingRefs()
    }

    if (feature('COMMIT_ATTRIBUTION')) {
      ctx.setAppState((prev) => ({
        ...prev,
        attribution: incrementPromptCount(prev.attribution, (snapshot) => {
          void recordAttributionSnapshot(snapshot).catch((error) => {
            log(`Attribution: Failed to save snapshot: ${error}`)
          })
        }),
      }))
    }
  }

  // 推测接受处理
  if (speculationAccept) {
    const { queryRequired } = await handleSpeculationAccept(
      speculationAccept.state,
      speculationAccept.speculationSessionTimeSavedMs,
      speculationAccept.setAppState,
      input,
      {
        setMessages: ctx.replStore.setMessages,
        readFileState: {
          get current() {
            return ctx.replStore.mutable.readFileState
          },
          set current(v) {
            ctx.replStore.mutable.readFileState = v
          },
        },
        cwd: getOriginalCwd(),
      },
    )
    if (queryRequired) {
      const newAbortController = createAbortController()
      ctx.setAbortController(newAbortController)
      void onQuery([], newAbortController, true, [], ctx.mainLoopModel)
    }
    return
  }

  // 远程模式
  if (
    ctx.activeRemote.isRemoteMode &&
    !(
      isSlashCommand &&
      ctx.commands.find((c) => {
        const name = input.trim().slice(1).split(/\s/)[0]
        return (
          isCommandEnabled(c) &&
          (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name)
        )
      })?.type === 'local-jsx'
    )
  ) {
    const pastedValues = Object.values(ctx.pastedContents)
    const imageContents = pastedValues.filter((c) => c.type === 'image')
    const imagePasteIds = imageContents.length > 0 ? imageContents.map((c) => c.id) : undefined
    let messageContent: UserContentBlock[] = [{ type: 'text' as const, text: input.trim() }]
    let remoteContent: RemoteMessageContent = input.trim()
    if (pastedValues.length > 0) {
      const contentBlocks: UserContentBlock[] = []
      const remoteBlocks: Array<{
        type: string
        [key: string]: unknown
      }> = []
      const trimmedInput = input.trim()
      if (trimmedInput) {
        contentBlocks.push({
          type: 'text',
          text: trimmedInput,
        })
        remoteBlocks.push({
          type: 'text',
          text: trimmedInput,
        })
      }
      for (const pasted of pastedValues) {
        if (pasted.type === 'image') {
          const source = {
            type: 'base64' as const,
            mediaType: (pasted.mediaType ?? 'image/png') as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: pasted.content,
          }
          contentBlocks.push({
            type: 'image',
            mimeType: source.mediaType,
            data: source.data,
          })
          remoteBlocks.push({
            type: 'image',
            mimeType: source.mediaType,
            data: source.data,
          })
        } else {
          contentBlocks.push({
            type: 'text',
            text: pasted.content,
          })
          remoteBlocks.push({
            type: 'text',
            text: pasted.content,
          })
        }
      }
      messageContent = contentBlocks
      remoteContent = remoteBlocks
    }

    const userMessage = createUserMessage({
      content: messageContent,
      imagePasteIds,
    })
    ctx.replStore.setMessages((prev) => [...prev, userMessage])

    await ctx.activeRemote.sendMessage(remoteContent, {
      uuid: userMessage.uuid,
    })
    return
  }

  // 正常提交路径
  await ctx.awaitPendingHooks()
  await handlePromptSubmit({
    input,
    helpers,
    queryGuard,
    isExternalLoading: ctx.isExternalLoading,
    mode: ctx.inputMode,
    commands: ctx.commands,
    onInputChange: ctx.setInputValue,
    setPastedContents: ctx.setPastedContents,
    setToolJSX: ctx.setToolJSX,
    getToolUseContext,
    messages: ctx.replStore.getState().messages,
    mainLoopModel: ctx.mainLoopModel,
    pastedContents: ctx.pastedContents,
    ideSelection: ctx.ideSelection,
    setUserInputOnProcessing: ctx.replStore.setUserInputOnProcessing,
    setAbortController: ctx.setAbortController,
    abortController: ctx.abortController,
    onQuery,
    setAppState: ctx.setAppState,
    querySource: getQuerySourceForREPL(),
    onBeforeQuery: ctx.onBeforeQuery,
    canUseTool: ctx.canUseTool,
    addNotification: ctx.addNotification,
    setMessages: ctx.replStore.setMessages,
    streamMode: ctx.replStore.getState().streamMode,
    hasInterruptibleToolInProgress: ctx.replStore.mutable.hasInterruptibleToolInProgress,
    processBashCommand,
  })

  // stash 延迟恢复
  if ((isSlashCommand || ctx.isLoading) && ctx.stashedPrompt !== undefined) {
    ctx.setInputValue(ctx.stashedPrompt.text)
    helpers.setCursorOffset(ctx.stashedPrompt.cursorOffset)
    ctx.setPastedContents(ctx.stashedPrompt.pastedContents)
    ctx.setStashedPrompt(undefined)
  }
}
