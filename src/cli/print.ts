// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { dirname } from 'node:path'
import { downloadUserSettings } from 'src/services/settings-sync/index.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands/index.js'
import { createStreamlinedTransformer } from 'src/utils/streamlinedTransform.js'
import { installStreamJsonStdoutGuard } from 'src/utils/streamJsonStdoutGuard.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { assembleToolPool, filterToolsByDenyRules } from 'src/tools/tools.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { mergeAndFilterTools } from 'src/utils/toolPool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { toolMatchesName, type Tool, type Tools } from 'src/tools/Tool.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  parseAgentsFromJson,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import type { Message, MessageOrigin, UserMessage } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import {
  enqueue,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import {
  getSessionState,
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from 'src/services/session-state/sessionState.js'
import { externalMetadataToAppState } from 'src/state/onChangeAppState.js'
import { logError, logMCPDebug } from 'src/utils/log.js'
import { writeToStdout, registerProcessOutputErrorHandlers } from 'src/services/shell/process.js'
import type { Stream } from 'src/utils/stream.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import {
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import {
  ChannelMessageNotificationSchema,
  gateChannelServer,
  wrapChannelMessage,
  findChannelEntry,
} from 'src/services/mcp/channelNotification.js'
import { parsePluginIdentifier } from 'src/services/plugins/pluginIdentifier.js'
import { validateUuid } from 'src/utils/uuid.js'
import { fromArray } from 'src/utils/generators.js'
import type { PermissionPromptTool } from 'src/utils/queryHelpers.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { registerHookEventHandler } from 'src/services/hooks/hookEvents.js'
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import type {
  WireStatus,
  ModelInfo,
  AccountInfo,
  WireMessage,
  WireUserMessage,
  WireUserMessageReplay,
  PermissionResult,
  McpServerConfigForProcessTransport,
  RewindFilesResult,
} from 'src/types/index.js'
import type {
  StdoutMessage,
  WireControlInitializeRequest,
  WireControlInitializeResponse,
  WireControlResponse,
  WireControlMcpSetServersResponse,
} from 'src/types/wire/control.js'
// @ts-expect-error
import type { PermissionMode } from '@zy-ai/agent-sdk'
import type { PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { cwd } from 'node:process'
import { getCwd } from 'src/utils/cwd.js'
import { isPolicyAllowed } from 'src/services/policy-limits/index.js'
import type { ReplWireHandle } from 'src/bridge/replBridge.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { hasPermissionsToUseTool } from 'src/services/permissions/permissions.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from 'src/services/permissions/permissionPromptToolResultSchema.js'
import { createCombinedAbortSignal } from 'src/utils/abortController.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/utils/sessionStart.js'
import { DEFAULT_OUTPUT_STYLE_NAME, getAllOutputStyles } from 'src/constants/outputStyles.js'
import { TICK_TAG } from 'src/constants/xml.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import { settingsChangeDetector } from 'src/services/settings/changeDetector.js'
import { applySettingsChange } from 'src/services/settings/applySettingsChange.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/services/permissions/permissionSetup.js'
import { type PromptVariant } from 'src/services/prompt-suggestion/promptSuggestion.js'
import { getAccountInformation } from 'src/services/auth/auth.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import type { HookCallbackMatcher } from 'src/types/hooks/index.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import type { HookEvent } from 'src/types/index.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  getInitJsonSchema,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import {
  hydrateRemoteSession,
  hydrateFromCCRv2InternalEvents,
  resetSessionFilePointer,
  findUnresolvedToolUse,
  saveAgentSetting,
  saveMode,
  restoreSessionMetadata,
} from 'src/services/sessionStorage.js'
import {
  connectToServer,
  clearServerCache,
  fetchToolsForClient,
  areMcpConfigsEqual,
} from 'src/services/mcp/client.js'
import { filterMcpServersByPolicy } from 'src/services/mcp/config.js'
import { toSDKRateLimitInfo } from 'src/services/messages/mappers.js'
import { createModelSwitchBreadcrumbs } from 'src/services/messages/constructors.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import { statusListeners, type ZyAILimits } from 'src/services/zyAiLimits.js'
import {
  getDefaultMainLoopModel,
  modelDisplayString,
  parseUserSpecifiedModel,
} from 'src/services/model/model.js'
import { getModelOptions } from 'src/services/model/modelOptions.js'
import { getModelEffortLevels } from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/services/feature-flags/betas.js'
import { ensureModelStringsInitialized } from 'src/services/model/modelStrings.js'
import { getSessionId, switchSession } from 'src/bootstrap/runtime/runtimeContext.js'
import { setMainLoopModelOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  setMainThreadAgentType,
  getIsRemoteMode,
  getMainThreadAgentType,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { isSessionPersistenceDisabled } from 'src/bootstrap/runtime/runtimeContext.js'
import { getAllowedChannels, setAllowedChannels } from 'src/bootstrap/runtime/runtimeContext.js'
import type { ChannelEntry } from 'src/bootstrap/runtime/runtimeContext.js'
import { WORKLOAD_CRON } from 'src/utils/workloadContext.js'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { UserContentBlock } from '../types/llm.js'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/utils/fileHistory.js'
import { restoreAgentFromSession, restoreSessionStateFromLog } from 'src/utils/sessionRestore.js'
import { SandboxManager } from 'src/services/sandbox/sandbox-adapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  headlessProfilerMemorySample,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import { asSessionId } from 'src/types/ids.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { skillChangeDetector } from '../services/skill-runtime/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../commands/index.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../utils/envUtils.js'
import { getRunningTasks } from '../services/task-runtime/framework.js'
import { isBackgroundTask } from '../tasks/types.js'
import { initializeGrowthBook } from '../services/analytics/growthbook.js'
import { errorMessage, toError } from '../utils/errors.js'
import { isExtractModeActive } from '../memdir/paths.js'
import { createHeadlessSession } from './headless/headlessSession.js'
import { createMcpRuntime, type DynamicMcpState } from './headless/mcpRuntime.js'
import { runTurnLoop, type TurnLoopDeps, type LoopState } from './headless/turnLoop.js'
import { runControlLoop } from './headless/controlLoop.js'

// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
export const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
const cronSchedulerModule = feature('AGENT_TRIGGERS')
  ? (require('../utils/cronScheduler.js') as typeof import('../utils/cronScheduler.js'))
  : null
const cronJitterConfigModule = feature('AGENT_TRIGGERS')
  ? (require('../services/jobs/cronJitterConfig.js') as typeof import('../services/jobs/cronJitterConfig.js'))
  : null
const cronGate = feature('AGENT_TRIGGERS')
  ? (require('../tools/ScheduleCronTool/prompt.js') as typeof import('../tools/ScheduleCronTool/prompt.js'))
  : null
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('../services/extract-memories/extractMemories.js') as typeof import('../services/extract-memories/extractMemories.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// Track message UUIDs received during the current session runtime
const MAX_RECEIVED_UUIDS = 10_000
export const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

export function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // Evict oldest entries when at capacity
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // new UUID
}

type PromptValue = string | UserContentBlock[]

function toBlocks(v: PromptValue): UserContentBlock[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/**
 * Join prompt values from multiple queued commands into one. Strings are
 * newline-joined; if any value is a block array, all values are normalized
 * to blocks and concatenated.
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) {
    return values[0]!
  }
  if (values.every((v) => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

/**
 * Whether `next` can be batched into the same ask() call as `head`. Only
 * prompt-mode commands batch, and only when the workload tag matches (so the
 * combined turn is attributed correctly) and the isMeta flag matches (so a
 * proactive tick can't merge into a user prompt and lose its hidden-in-
 * transcript marking when the head is spread over the merged command).
 */
export function canBatchWith(head: QueuedCommand, next: QueuedCommand | undefined): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    verbose: boolean | undefined
    outputFormat: string | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    teleport: string | true | null | undefined
    sdkUrl: string | undefined
    replayUserMessages: boolean | undefined
    includePartialMessages: boolean | undefined
    forkSession: boolean | undefined
    rewindFiles: string | undefined
    enableAuthStatus: boolean | undefined
    agent: string | undefined
    workload: string | undefined
    setupTrigger?: 'init' | 'maintenance' | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    setSDKStatus?: (status: WireStatus) => void
  },
): Promise<void> {
  if (isInternalBuild() && isEnvTruthy(process.env.ZY_CODE_EXIT_AFTER_FIRST_RENDER)) {
    process.stderr.write(`\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  // Fire user settings download now so it overlaps with the MCP/tool setup
  // below. Managed settings already started in main.tsx preAction; this gives
  // user settings a similar head start. The cached promise is joined in
  // installPluginsAndApplyMcpInBackground before plugin install reads
  // enabledPlugins.
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.ZY_CODE_REMOTE) || getIsRemoteMode())
  ) {
    void downloadUserSettings()
  }

  // In headless mode there is no React tree, so the useSettingsChange hook
  // never runs. Subscribe directly so that settings changes (including
  // managed-settings / policy updates) are fully applied.
  settingsChangeDetector.subscribe((source) => {
    applySettingsChange(source, setAppState)
  })

  // Proactive activation is now handled in main.tsx before getTools() so
  // SleepTool passes isEnabled() filtering. This fallback covers the case
  // where ZY_CODE_PROACTIVE is set but main.tsx's check didn't fire
  // (e.g. env was injected by the SDK transport after argv parsing).
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.ZY_CODE_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // Periodically force a full GC to keep memory usage in check
  if (typeof Bun !== 'undefined') {
    const gcTimer = setInterval(Bun.gc, 1000)
    gcTimer.unref()
  }

  // Start headless profiler for first turn
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // Initialize GrowthBook so feature flags take effect in headless mode.
  // Without this, the disk cache is empty and all flags fall back to defaults.
  void initializeGrowthBook()

  if (options.resumeSessionAt && !options.resume) {
    process.stderr.write(`Error: --resume-session-at requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && !options.resume) {
    process.stderr.write(`Error: --rewind-files requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && inputPrompt) {
    process.stderr.write(
      `Error: --rewind-files is a standalone operation and cannot be used with a prompt\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  const structuredIO = getStructuredIO(inputPrompt, options)

  // When emitting NDJSON for SDK clients, any stray write to stdout (debug
  // prints, dependency console.log, library banners) breaks the client's
  // line-by-line JSON parser. Install a guard that diverts non-JSON lines to
  // stderr so the stream stays clean. Must run before the first
  // structuredIO.write below.
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044: if user explicitly set sandbox.enabled=true but deps are missing,
  // isSandboxingEnabled() returns false silently. Surface the reason so users
  // know their security config isn't being enforced.
  const sandboxUnavailableReason = SandboxManager.getSandboxUnavailableReason()
  if (sandboxUnavailableReason) {
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${sandboxUnavailableReason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stderr.write(
      `\n⚠ Sandbox disabled: ${sandboxUnavailableReason}\n` +
        `  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n`,
    )
  } else if (SandboxManager.isSandboxingEnabled()) {
    // Initialize sandbox with a callback that forwards network permission
    // requests to the SDK host via the can_use_tool control_request protocol.
    // This must happen after structuredIO is created so we can send requests.
    try {
      await SandboxManager.initialize(structuredIO.createSandboxAskCallback())
    } catch (err) {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
      return
    }
  }

  if (options.outputFormat === 'stream-json' && options.verbose) {
    registerHookEventHandler((event) => {
      const message: StdoutMessage = (() => {
        switch (event.type) {
          case 'started':
            return {
              type: 'system' as const,
              subtype: 'hook_started' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'progress':
            return {
              type: 'system' as const,
              subtype: 'hook_progress' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              stdout: event.stdout,
              stderr: event.stderr,
              output: event.output,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'response':
            return {
              type: 'system' as const,
              subtype: 'hook_response' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exit_code: event.exitCode,
              outcome: event.outcome,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
        }
      })()
      void structuredIO.write(message)
    })
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger)
  }

  headlessProfilerCheckpoint('before_loadInitialMessages')
  const appState = getAppState()
  const {
    messages: initialMessages,
    turnInterruptionState,
    agentSetting: resumedAgentSetting,
  } = await loadInitialMessages(setAppState, {
    continue: options.continue,
    teleport: options.teleport,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
    restoredWorkerState: structuredIO.restoredWorkerState,
  })

  // SessionStart hooks can emit initialUserMessage — the first user turn for
  // headless orchestrator sessions where stdin is empty and additionalContext
  // alone (an attachment, not a turn) would leave the REPL with nothing to
  // respond to. The hook promise is awaited inside loadInitialMessages, so the
  // module-level pending value is set by the time we get here.
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

  // Restore agent setting from the resumed session (if not overridden by current --agent flag
  // or settings-based agent, which would already have set mainThreadAgentType in main.tsx)
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState((prev) => ({ ...prev, agent: restoredAgent.agentType }))
      // Apply the agent's system prompt for non-built-in agents (mirrors main.tsx initial --agent path)
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        const agentSystemPrompt = restoredAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }
      // Re-persist agent setting so future resumes maintain the agent
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync schedules an async shutdown and sets process.exitCode.
  // If a loadInitialMessages error path triggered it, bail early to avoid
  // unnecessary work while the process winds down.
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // Handle --rewind-files: restore filesystem and exit immediately
  if (options.rewindFiles) {
    // File history snapshots are only created for user messages,
    // so we require the target to be a user message
    const targetMessage = initialMessages.find((m) => m.uuid === options.rewindFiles)

    if (!targetMessage || targetMessage.type !== 'user') {
      process.stderr.write(
        `Error: --rewind-files requires a user message UUID, but ${options.rewindFiles} is not a user message in this session\n`,
      )
      gracefulShutdownSync(1)
      return
    }

    const currentAppState = getAppState()
    const result = await handleRewindFiles(
      options.rewindFiles as UUID,
      currentAppState,
      setAppState,
      false,
    )
    if (!result.canRewind) {
      process.stderr.write(`Error: ${result.error || 'Unexpected error'}\n`)
      gracefulShutdownSync(1)
      return
    }

    // Rewind complete - exit successfully
    process.stdout.write(`Files rewound to state at message ${options.rewindFiles}\n`)
    gracefulShutdownSync(0)
    return
  }

  // Check if we need input prompt - skip if we're resuming with a valid session ID/JSONL file or using SDK URL
  const hasValidResumeSessionId =
    typeof options.resume === 'string' &&
    (Boolean(validateUuid(options.resume)) || options.resume.endsWith('.jsonl'))
  const isUsingSdkUrl = Boolean(options.sdkUrl)

  if (!inputPrompt && !hasValidResumeSessionId && !isUsingSdkUrl) {
    process.stderr.write(
      `Error: Input must be provided either through stdin or as a prompt argument when using --print\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  if (options.outputFormat === 'stream-json' && !options.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    )
    gracefulShutdownSync(1)
    return
  }

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(appState.mcp.tools, appState.toolPermissionContext)
  let filteredTools = [...tools, ...allowedMcpTools]

  // When using SDK URL, always use stdio permission prompting to delegate to the SDK
  const effectivePermissionPromptToolName = options.sdkUrl
    ? 'stdio'
    : options.permissionPromptToolName

  // Callback for when a permission prompt is shown
  const onPermissionPrompt = (details: RequiresActionDetails) => {
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState((prev) => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          permissionPromptCount: prev.attribution.permissionPromptCount + 1,
        },
      }))
    }
    notifySessionStateChanged('requires_action', details)
  }

  const canUseTool = getCanUseToolFn(
    effectivePermissionPromptToolName,
    structuredIO,
    () => getAppState().mcp.tools,
    onPermissionPrompt,
  )
  if (options.permissionPromptToolName) {
    // Remove the permission prompt tool from the list of available tools.
    filteredTools = filteredTools.filter(
      (tool) => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // Install errors handlers to gracefully handle broken pipes (e.g., when parent process dies)
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // Ensure model strings are initialized before generating model options.
  // For Bedrock users, this waits for the profile fetch to get correct region strings.
  await ensureModelStringsInitialized()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS inbox store registration is deferred until after `run` is defined
  // so we can pass `run` as the onEnqueue callback (see below).

  // Only `json` + `verbose` needs the full array (jsonStringify(messages) below).
  // For stream-json (SDK/CCR) and default text output, only the last message is
  // read for the exit code / final result. Avoid accumulating every message in
  // memory for the entire session.
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: WireMessage[] = []
  let lastMessage: WireMessage | undefined
  // Streamlined mode transforms messages when ZY_CODE_STREAMLINED_OUTPUT=true and using stream-json
  // Build flag gates this out of external builds; env var is the runtime opt-in for ant builds
  const transformToStreamlined =
    feature('STREAMLINED_OUTPUT') &&
    isEnvTruthy(process.env.ZY_CODE_STREAMLINED_OUTPUT) &&
    options.outputFormat === 'stream-json'
      ? createStreamlinedTransformer()
      : null

  headlessProfilerCheckpoint('before_runHeadlessStreaming')
  for await (const message of runHeadlessStreaming(
    structuredIO,
    appState.mcp.clients,
    [...commands, ...appState.mcp.commands],
    filteredTools,
    initialMessages,
    canUseTool,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    options,
    turnInterruptionState,
  )) {
    if (transformToStreamlined) {
      // Streamlined mode: transform messages and stream immediately
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
    // Should not be getting control messages or stream events in non-stream mode.
    // Also filter out streamlined types since they're only produced by the transformer.
    // SDK-only system events are excluded so lastMessage stays at the result
    // (session_state_changed(idle) and any late task_notification drain after
    // result in the finally block).
    if (
      message.type !== 'control_response' &&
      message.type !== 'control_request' &&
      message.type !== 'control_cancel_request' &&
      !(
        message.type === 'system' &&
        (message.subtype === 'session_state_changed' ||
          message.subtype === 'task_notification' ||
          message.subtype === 'task_started' ||
          message.subtype === 'task_progress' ||
          message.subtype === 'post_turn_summary')
      ) &&
      message.type !== 'stream_event' &&
      message.type !== 'keep_alive' &&
      message.type !== 'streamlined_text' &&
      message.type !== 'streamlined_tool_use_summary' &&
      message.type !== 'prompt_suggestion'
    ) {
      if (needsFullArray) {
        messages.push(message)
      }
      lastMessage = message
    }
  }

  switch (options.outputFormat) {
    case 'json':
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeToStdout(`${jsonStringify(messages)}\n`)
        break
      }
      writeToStdout(`${jsonStringify(lastMessage)}\n`)
      break
    case 'stream-json':
      // already logged above
      break
    default:
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      switch (lastMessage.subtype) {
        case 'success':
          writeToStdout(
            lastMessage.result.endsWith('\n') ? lastMessage.result : `${lastMessage.result}\n`,
          )
          break
        case 'error_during_execution':
          writeToStdout(`Execution error`)
          break
        case 'error_max_turns':
          writeToStdout(`Error: Reached max turns (${options.maxTurns})`)
          break
        case 'error_max_budget_usd':
          writeToStdout(`Error: Exceeded USD budget (${options.maxBudgetUsd})`)
          break
        case 'error_max_structured_output_retries':
          writeToStdout(`Error: Failed to provide valid structured output after maximum retries`)
      }
  }

  // Log headless latency metrics for the final turn
  // 内存优化：采样最终 turn 的内存使用，便于发现长会话退化
  headlessProfilerMemorySample()
  logHeadlessProfilerTurn()

  // Drain any in-flight memory extraction before shutdown. The response is
  // already flushed above, so this adds no user-visible latency — it just
  // delays process exit so gracefulShutdownSync's 5s failsafe doesn't kill
  // the forked agent mid-flight. Gated by isExtractModeActive so the
  // zy_slate_thimble flag controls non-interactive extraction end-to-end.
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    await extractMemoriesModule!.drainPendingExtraction()
  }

  gracefulShutdownSync(lastMessage?.type === 'result' && lastMessage?.isError ? 1 : 0)
}

function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    setSDKStatus?: (status: WireStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
  },
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  // 主循环可变状态容器(Phase 4a)。run()(已外提 turnLoop.ts)与 run 外的并发回调
  // (sigintHandler/stdin 循环/cron/UDS/控制 handler)经 deps 共享同一引用——这些
  // 状态只此一份,值拷贝会破坏互斥锁(running)、中断(abortController)、收尾
  // (inputClosed)语义。readFileState 必须跨 ask() 调用持续(edit 工具依赖它作为
  // 全局状态),且会被 setReadFileCache 回调整体重赋值,故收进容器而非函数局部。
  const loopState: LoopState = {
    running: false,
    runPhase: undefined,
    inputClosed: false,
    shutdownPromptInjected: false,
    heldBackResult: null,
    abortController: undefined,
    readFileState: extractReadFilesFromMessages(initialMessages, cwd(), READ_FILE_STATE_CACHE_SIZE),
    activeUserSpecifiedModel: options.userSpecifiedModel,
  }
  // Same queue sendRequest() enqueues to — one FIFO for everything.
  const output = structuredIO.outbound

  // Ctrl+C in -p mode: abort the in-flight query, then shut down gracefully.
  // gracefulShutdown persists session state and flushes analytics, with a
  // failsafe timer that force-exits if cleanup hangs.
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (loopState.abortController && !loopState.abortController.signal.aborted) {
      // 带明确 reason，配合 query.ts 主循环的白名单过滤，
      // 区分用户主动中断和 GC race 等隐式 abort。
      loopState.abortController.abort('sigint')
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // Dump run()'s state at SIGTERM so a stuck session's healthsweep can name
  // the do/while(waitingForAgents) poll without reading the transcript.
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) {
        bg[t.type] = (bg[t.type] ?? 0) + 1
      }
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: loopState.running,
      run_phase: loopState.runPhase,
      worker_status: getSessionState(),
      internal_events_pending: structuredIO.internalEventsPending,
      bg_tasks: bg,
    })
  })

  // Wire the central onChangeAppState mode-diff hook to the SDK output stream.
  // This fires whenever ANY code path mutates toolPermissionContext.mode —
  // Shift+Tab, ExitPlanMode dialog, /plan slash command, rewind, bridge
  // set_permission_mode, the query loop, stop_task — rather than the two
  // paths that previously went through a bespoke wrapper.
  // The wrapper's body was fully redundant (it enqueued here AND called
  // notifySessionMetadataChanged, both of which onChangeAppState now covers);
  // keeping it would double-emit status messages.
  setPermissionModeChangedListener((newMode) => {
    // Only emit for SDK-exposed modes.
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (true && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // Prompt suggestion tracking (push model)
  const suggestionState: {
    abortController: AbortController | null
    inflightPromise: Promise<void> | null
    lastEmitted: {
      text: string
      emittedAt: number
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
    pendingSuggestion: {
      type: 'prompt_suggestion'
      suggestion: string
      uuid: UUID
      session_id: string
    } | null
    pendingLastEmittedEntry: {
      text: string
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
  } = {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
  }

  // Set up AWS auth status listener if enabled
  let unsubscribeAuthStatus: (() => void) | undefined
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe((status) => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // Set up rate limit status listener to emit WireRateLimitEvent for all status changes.
  // Emitting for all statuses (including 'allowed') ensures consumers can clear warnings
  // when rate limits reset. The upstream emitStatusChange already deduplicates via isEqual.
  const rateLimitListener = (limits: ZyAILimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      output.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
  statusListeners.add(rateLimitListener)

  // 会话消息容器(HeadlessSession)。包含 Assistant/User/Attachment/Progress 消息。
  // ask() 仍按引用原地 push;显式 append 走 session.appendMessages()。
  // 完整封闭 mutable-array(改 ask() 契约)留待后续 Phase。
  const session = createHeadlessSession({ initialMessages })

  // Client-supplied readFileState seeds (via seed_read_state control request).
  // The stdin IIFE runs concurrently with ask() — a seed arriving mid-turn
  // would be lost to ask()'s clone-then-replace (QueryEngine.ts finally block)
  // if written directly into readFileState. Instead, seeds land here, merge
  // into getReadFileCache's view (readFileState-wins-ties: seeds fill gaps),
  // and are re-applied then CLEARED in setReadFileCache. One-shot: each seed
  // survives exactly one clone-replace cycle, then becomes a regular
  // readFileState entry subject to compact's clear like everything else.
  const pendingSeeds = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  // Auto-resume interrupted turns on restart so CC continues from where it
  // left off without requiring the SDK to re-send the prompt.
  const resumeInterruptedTurnEnv = process.env.ZY_CODE_RESUME_INTERRUPTED_TURN
  if (turnInterruptionState && turnInterruptionState.kind !== 'none' && resumeInterruptedTurnEnv) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // Remove the interrupted message and its sentinel, then re-enqueue so
    // the model sees it exactly once. For mid-turn interruptions, the
    // deserialization layer transforms them into interrupted_prompt by
    // appending a synthetic "Continue from where you left off." message.
    removeInterruptedMessage(session.messages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message.content,
      uuid: randomUUID(),
    })
  }

  const modelOptions = getModelOptions()
  const modelInfos = modelOptions.map((option) => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? (getDefaultMainLoopModel() ?? modelId)
        : parseUserSpecifiedModel(modelId)
    const effortLevels = getModelEffortLevels(resolvedModel).filter(
      (l): l is Exclude<typeof l, 'orchestrate'> => l !== 'orchestrate',
    )
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(effortLevels.length > 0 && {
        supportsEffort: true,
        supportedEffortLevels: effortLevels,
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })

  function injectModelSwitchBreadcrumbs(modelArg: string, resolvedModel: string): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(modelArg, modelDisplayString(resolvedModel))
    session.appendMessages(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      const contentText = crumb.message.content.find((b: { type: string }) => b.type === 'text') as
        | { type: 'text'; text: string }
        | undefined
      if (contentText?.text.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)) {
        output.enqueue({
          type: 'user',
          message: crumb.message,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } satisfies WireUserMessageReplay)
      }
    }
  }

  // MCP/插件可变状态容器(Phase 2a)。7 个嵌套函数 + 控制循环共享这些状态;
  // 函数内部通过 mcp.xxx 访问,控制循环暂时也直接读(Phase 3 再统一改路由)。
  const mcp = createMcpRuntime({
    structuredIO,
    getAppState,
    setAppState,
    sdkMcpConfigs,
    handleMcpSetServers,
    initialCommands: commands,
    initialAgents: agents,
  })

  void mcp.updateSdkMcp()

  // Shared tool assembly for ask() and the get_context_usage control request.
  // Closes over mcp.sdkTools/mcp.dynamicMcpState so both call sites see
  // late-connecting servers.
  const buildAllTools = (appState: AppState): Tools => {
    const assembledTools = assembleToolPool(appState.toolPermissionContext, appState.mcp.tools)
    let allTools = uniqBy(
      mergeAndFilterTools(
        [...tools, ...mcp.sdkTools, ...mcp.dynamicMcpState.tools],
        assembledTools,
        appState.toolPermissionContext.mode,
      ),
      'name',
    )
    if (options.permissionPromptToolName) {
      allTools = allTools.filter(
        (tool) => !toolMatchesName(tool, options.permissionPromptToolName!),
      )
    }
    const initJsonSchema = getInitJsonSchema()
    if (initJsonSchema && !options.jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
      if ('tool' in syntheticOutputResult) {
        allTools = [...allTools, syntheticOutputResult.tool]
      }
    }
    return allTools
  }

  // Bridge handle for remote-control (SDK control message).
  // Mirrors the REPL's useReplBridge hook: the handle is created when
  // `remote_control` is enabled and torn down when disabled.
  // 桥接句柄与转发游标收进共享容器(Phase 5a):controlLoop(写)、turnLoop(经
  // getBridgeHandle 读)、forwardMessagesToBridge(读写)三处共享同一引用,外提后
  // 值拷贝会读到陈旧值。
  // lastForwardedIndex: cursor into session.messages — tracks how far we've
  // forwarded (same index-based diff as useReplBridge's lastWrittenIndexRef).
  const bridgeState = {
    handle: null as ReplWireHandle | null,
    lastForwardedIndex: 0,
  }

  // Forward new messages from session.messages to the bridge.
  // Called incrementally during each turn (so zy.ai sees progress
  // and stays alive during permission waits) and again after the turn.
  //
  // writeMessages has its own UUID-based dedup (initialMessageUUIDs,
  // recentPostedUUIDs) — the index cursor here is a pre-filter to avoid
  // O(n) re-scanning of already-sent messages on every call.
  function forwardMessagesToBridge(): void {
    if (!bridgeState.handle) {
      return
    }
    // Guard against session.messages shrinking (compaction truncates it).
    const startIndex = Math.min(bridgeState.lastForwardedIndex, session.messages.length)
    const newMessages = session.messages
      .slice(startIndex)
      .filter((m) => m.type === 'user' || m.type === 'assistant')
    bridgeState.lastForwardedIndex = session.messages.length
    if (newMessages.length > 0) {
      bridgeState.handle.writeMessages(newMessages)
    }
  }

  // Background plugin installation for all headless users
  // Installs marketplaces from extraKnownMarketplaces and missing enabled plugins
  // ZY_CODE_SYNC_PLUGIN_INSTALL=true: resolved in run() before the first
  // query so plugins are guaranteed available on the first ask().
  // --bare / SIMPLE: skip plugin install. Scripted calls don't add plugins
  // mid-session; the next interactive run reconciles.
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.ZY_CODE_SYNC_PLUGIN_INSTALL)) {
      mcp.pluginInstallPromise = mcp.installPluginsAndApplyMcpInBackground()
    } else {
      void mcp.installPluginsAndApplyMcpInBackground()
    }
  }

  // Idle timeout management
  const idleTimeout = createIdleTimeoutManager(() => !loopState.running)

  // Subscribe to skill changes for hot reloading
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then((newCommands) => {
      mcp.currentCommands = newCommands
    })
  })

  // Proactive mode: schedule a tick to keep the model looping autonomously.
  // setTimeout(0) yields to the event loop so pending stdin messages
  // (interrupts, user messages) are processed before the tick fires.
  const scheduleProactiveTick =
    feature('PROACTIVE') || feature('KAIROS')
      ? () => {
          setTimeout(() => {
            if (
              !proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              loopState.inputClosed
            ) {
              return
            }
            const tickContent = `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
            enqueue({
              mode: 'prompt' as const,
              value: tickContent,
              uuid: randomUUID(),
              priority: 'later',
              isMeta: true,
            })
            void run()
          }, 0)
        }
      : undefined

  // Abort the current operation when a 'now' priority message arrives.
  subscribeToCommandQueue(() => {
    if (loopState.abortController && getCommandsByMaxPriority('now').length > 0) {
      loopState.abortController.abort('interrupt')
    }
  })

  let run: () => Promise<void>
  // Phase 4b: 主循环已外提到 turnLoop.ts。deps 注入全部闭包依赖;loopState 共享
  // 可变状态;kickRun 处理自递归;getBridgeHandle 取活引用(remote_control 会重赋值)。
  const turnLoopDeps: TurnLoopDeps = {
    loopState,
    structuredIO,
    canUseTool,
    getAppState,
    setAppState,
    options,
    output,
    session,
    mcp,
    suggestionState,
    pendingSeeds,
    buildAllTools,
    forwardMessagesToBridge,
    idleTimeout,
    scheduleProactiveTick,
    unsubscribeSkillChanges,
    unsubscribeAuthStatus,
    rateLimitListener,
    kickRun: () => void run(),
    getBridgeHandle: () => bridgeState.handle,
  }
  run = () => runTurnLoop(turnLoopDeps)

  // Set up UDS inbox callback so the query loop is kicked off
  // when a message arrives via the UDS socket in headless mode.
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setOnEnqueue } = require('../utils/udsMessaging.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setOnEnqueue(() => {
      if (!loopState.inputClosed) {
        void run()
      }
    })
  }

  // Cron scheduler: runs scheduled_tasks.json tasks in SDK/-p mode.
  // Mirrors REPL's useScheduledTasks hook. Fired prompts enqueue + kick
  // off run() directly — unlike REPL, there's no queue subscriber here
  // that drains on enqueue while idle. The run() mutex makes this safe
  // during an active turn: the call no-ops and the post-run recheck at
  // the end of run() picks up the queued command.
  let cronScheduler: import('../utils/cronScheduler.js').CronScheduler | null = null
  if (feature('AGENT_TRIGGERS') && cronSchedulerModule && cronGate?.isKairosCronEnabled()) {
    cronScheduler = cronSchedulerModule.createCronScheduler({
      onFire: (prompt) => {
        if (loopState.inputClosed) {
          return
        }
        enqueue({
          mode: 'prompt',
          value: prompt,
          uuid: randomUUID(),
          priority: 'later',
          // System-generated — matches useScheduledTasks.ts REPL equivalent.
          // Without this, messages.ts metaProp eval is {} → prompt leaks
          // into visible transcript when cron fires mid-turn in -p mode.
          isMeta: true,
          // Threaded to cc_workload= in the billing-header attribution block
          // so the API can serve cron requests at lower QoS. drainCommandQueue
          // reads this per-iteration and hoists it into bootstrap state for
          // the ask() call.
          workload: WORKLOAD_CRON,
        })
        void run()
      },
      isLoading: () => loopState.running || loopState.inputClosed,
      getJitterConfig: cronJitterConfigModule?.getCronJitterConfig,
      isKilled: () => !cronGate?.isKairosCronEnabled(),
    })
    cronScheduler.start()
  }

  void runControlLoop({
    loopState,
    bridgeState,
    structuredIO,
    options,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    output,
    session,
    mcp,
    suggestionState,
    pendingSeeds,
    buildAllTools,
    modelInfos,
    commands,
    agents,
    mcpClients,
    injectModelSwitchBreadcrumbs,
    scheduleProactiveTick,
    cronScheduler,
    unsubscribeSkillChanges,
    unsubscribeAuthStatus,
    rateLimitListener,
    kickRun: () => void run(),
  })

  return output
}

/**
 * Creates a CanUseToolFn that incorporates a custom permission prompt tool.
 * This function converts the permissionPromptTool into a CanUseToolFn that can be used in ask.tsx
 */
export function createCanUseToolWithPermissionPrompt(
  permissionPromptTool: PermissionPromptTool,
): CanUseToolFn {
  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    const mainPermissionResult =
      forceDecision ??
      (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseId))

    // If the tool is allowed or denied, return the result
    if (mainPermissionResult.behavior === 'allow' || mainPermissionResult.behavior === 'deny') {
      return mainPermissionResult
    }

    // Race the permission prompt tool against the abort signal.
    //
    // Why we need this: The permission prompt tool may block indefinitely waiting
    // for user input (e.g., via stdin or a UI dialog). If the user triggers an
    // interrupt (Ctrl+C), we need to detect it even while the tool is blocked.
    // Without this race, the abort check would only run AFTER the tool completes,
    // which may never happen if the tool is waiting for input that will never come.
    //
    // The second check (combinedSignal.aborted) handles a race condition where
    // abort fires after Promise.race resolves but before we reach this check.
    const { signal: combinedSignal, cleanup: cleanupAbortListener } = createCombinedAbortSignal(
      toolUseContext.abortController.signal,
    )

    // Check if already aborted before starting the race
    if (combinedSignal.aborted) {
      cleanupAbortListener()
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    const abortPromise = new Promise<'aborted'>((resolve) => {
      combinedSignal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      })
    })

    const toolCallPromise = permissionPromptTool.call(
      {
        tool_name: tool.name,
        input,
        toolCallId: toolUseId,
      },
      toolUseContext,
      canUseTool,
      assistantMessage,
    )

    const raceResult = await Promise.race([toolCallPromise, abortPromise])
    cleanupAbortListener()

    if (raceResult === 'aborted' || combinedSignal.aborted) {
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    // TypeScript narrowing: after the abort check, raceResult must be ToolResult
    const result = raceResult as Awaited<typeof toolCallPromise>

    const permissionToolResultBlock = permissionPromptTool.mapToolResultToToolResultBlock(
      result.data,
      '1',
    )
    if (
      !permissionToolResultBlock.content ||
      !Array.isArray(permissionToolResultBlock.content) ||
      !permissionToolResultBlock.content[0] ||
      permissionToolResultBlock.content[0].type !== 'text' ||
      typeof permissionToolResultBlock.content[0].text !== 'string'
    ) {
      throw new Error(
        'Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.',
      )
    }
    return permissionPromptToolResultToPermissionDecision(
      permissionToolOutputSchema().parse(safeParseJSON(permissionToolResultBlock.content[0].text)),
      permissionPromptTool,
      input,
      toolUseContext,
    )
  }
  return canUseTool
}

// Exported for testing — regression: this used to crash at construction when
// getMcpTools() was empty (before per-server connects populated appState).
export function getCanUseToolFn(
  permissionPromptToolName: string | undefined,
  structuredIO: StructuredIO,
  getMcpTools: () => Tool[],
  onPermissionPrompt?: (details: RequiresActionDetails) => void,
): CanUseToolFn {
  if (permissionPromptToolName === 'stdio') {
    return structuredIO.createCanUseTool(onPermissionPrompt)
  }
  if (!permissionPromptToolName) {
    return async (tool, input, toolUseContext, assistantMessage, toolUseId, forceDecision) =>
      forceDecision ??
      (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseId))
  }
  // Lazy lookup: MCP connects are per-server incremental in print mode, so
  // the tool may not be in appState yet at init time. Resolve on first call
  // (first permission prompt), by which point connects have had time to finish.
  let resolved: CanUseToolFn | null = null
  return async (tool, input, toolUseContext, assistantMessage, toolUseId, forceDecision) => {
    if (!resolved) {
      const mcpTools = getMcpTools()
      const permissionPromptTool = mcpTools.find((t) =>
        toolMatchesName(t, permissionPromptToolName),
      ) as PermissionPromptTool | undefined
      if (!permissionPromptTool) {
        const error = `Error: MCP tool ${permissionPromptToolName} (passed via --permission-prompt-tool) not found. Available MCP tools: ${mcpTools.map((t) => t.name).join(', ') || 'none'}`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      if (!permissionPromptTool.inputJSONSchema) {
        const error = `Error: tool ${permissionPromptToolName} (passed via --permission-prompt-tool) must be an MCP tool`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      resolved = createCanUseToolWithPermissionPrompt(permissionPromptTool)
    }
    return resolved(tool, input, toolUseContext, assistantMessage, toolUseId, forceDecision)
  }
}

export async function handleInitializeRequest(
  request: WireControlInitializeRequest,
  requestId: string,
  initialized: boolean,
  output: Stream<StdoutMessage>,
  commands: Command[],
  modelInfos: ModelInfo[],
  structuredIO: StructuredIO,
  enableAuthStatus: boolean,
  options: {
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    agent?: string | undefined
    userSpecifiedModel?: string | undefined
    [key: string]: unknown
  },
  agents: AgentDefinition[],
  _getAppState: () => AppState,
): Promise<void> {
  if (initialized) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        error: 'Already initialized',
        request_id: requestId,
        pending_permission_requests: structuredIO.getPendingPermissionRequests(),
      },
    })
    return
  }

  // Apply systemPrompt/appendSystemPrompt from stdin to avoid ARG_MAX limits
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  // Merge agents from stdin to avoid ARG_MAX limits
  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // Re-evaluate main thread agent after SDK agents are merged
  // This allows --agent to reference agents defined via SDK
  if (options.agent) {
    // If main.tsx already found this agent (filesystem-defined), it already
    // applied systemPrompt/model/initialPrompt. Skip to avoid double-apply.
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find((a) => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      // Update the main thread agent type in bootstrap state
      setMainThreadAgentType(mainThreadAgent.agentType)

      // Apply the agent's system prompt if user hasn't specified a custom one
      // SDK agents are always custom agents (not built-in), so getSystemPrompt() takes no args
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // Apply the agent's model if user didn't specify one and agent has a model
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // SDK-defined agents arrive via init, so main.tsx's lookup missed them.
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // Filesystem-defined agent (alreadyResolved by main.tsx). main.tsx
      // handles initialPrompt for the string inputPrompt case, but when
      // inputPrompt is an AsyncIterable (SDK stream-json), it can't
      // concatenate — fall back to prependUserMessage here.
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const settings = getInitialSettings()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const availableOutputStyles = await getAllOutputStyles(getCwd())

  // Get account information
  const accountInfo = getAccountInformation()
  if (request.hooks) {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const [event, matchers] of Object.entries(request.hooks)) {
      hooks[event as HookEvent] = matchers.map((matcher) => {
        const callbacks = matcher.hookCallbackIds.map((callbackId) => {
          return structuredIO.createHookCallback(callbackId, matcher.timeout)
        })
        return {
          matcher: matcher.matcher,
          hooks: callbacks,
        }
      })
    }
    registerHookCallbacks(hooks)
  }
  if (request.jsonSchema) {
    setInitJsonSchema(request.jsonSchema)
  }
  const initResponse: WireControlInitializeResponse = {
    commands: commands
      .filter((cmd) => cmd.userInvocable !== false)
      .map((cmd) => ({
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
        argumentHint: cmd.argumentHint || '',
      })),
    agents: agents.map((agent) => ({
      name: agent.agentType,
      description: agent.whenToUse,
      // 'inherit' is an internal sentinel; normalize to undefined for the public API
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    output_style: outputStyle,
    available_output_styles: Object.keys(availableOutputStyles),
    models: modelInfos,
    account: {
      email: accountInfo?.email,
      organization: accountInfo?.organization,
      subscriptionType: accountInfo?.subscription,
      tokenSource: accountInfo?.tokenSource,
      apiKeySource: accountInfo?.apiKeySource,
      // getAccountInformation() returns undefined under 3P providers, so the
      // other fields are all absent. apiProvider disambiguates "not logged
      // in" (direct API + tokenSource:none) from "3P, login not applicable".
      apiProvider: getAPIProvider() as AccountInfo['apiProvider'],
    } satisfies AccountInfo,
    pid: process.pid,
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: initResponse as unknown as Record<string, unknown>,
    },
  })

  // After the initialize message, check the auth status-
  // This will get notified of changes, but we also want to send the
  // initial state.
  if (enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    const status = authStatusManager.getStatus()
    if (status) {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
}

export async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(appState.fileHistory, userMessageId)
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged,
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(
      (updater) =>
        setAppState((prev) => ({
          ...prev,
          fileHistory: updater(prev.fileHistory),
        })),
      userMessageId,
    )
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
    }
  }

  return { canRewind: true }
}

export function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  // Check if trying to switch to bypassPermissions mode
  if (request.mode === 'bypassPermissions') {
    if (isBypassPermissionsModeDisabled()) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
        },
      })
      return toolPermissionContext
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
        },
      })
      return toolPermissionContext
    }
  }

  // Check if trying to switch to auto mode without the classifier gate
  if (true && request.mode === 'auto' && !isAutoModeGateEnabled()) {
    const reason = getAutoModeUnavailableReason()
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: reason
          ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
          : 'Cannot set permission mode to auto',
      },
    })
    return toolPermissionContext
  }

  // Allow the mode switch
  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return {
    ...transitionPermissionMode(toolPermissionContext.mode, request.mode, toolPermissionContext),
    mode: request.mode,
  }
}

/**
 * IDE-triggered channel enable. Derives the ChannelEntry from the connection's
 * pluginSource (IDE can't spoof kind/marketplace — we only take the server
 * name), appends it to session allowedChannels, and runs the full gate. On
 * gate failure, rolls back the append. On success, registers a notification
 * handler that enqueues channel messages at priority:'next' — drainCommandQueue
 * picks them up between turns.
 *
 * Intentionally does NOT register the zy/channel/permission handler that
 * useManageMCPConnections sets up for interactive mode. That handler resolves
 * a pending dialog inside handleInteractivePermission — but print.ts never
 * calls handleInteractivePermission. When SDK permission lands on 'ask', it
 * goes to the consumer's canUseTool callback over stdio; there is no CLI-side
 * dialog for a remote "yes tbxkq" to resolve. If an IDE wants channel-relayed
 * tool approval, that's IDE-side plumbing against its own pending-map. (Also
 * gated separately by zy_harbor_permissions — not yet shipping on
 * interactive either.)
 */
export function handleChannelEnable(
  requestId: string,
  serverName: string,
  connectionPool: readonly MCPServerConnection[],
  output: Stream<StdoutMessage>,
): void {
  const respondError = (error: string) =>
    output.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })

  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) {
    return respondError('channels feature not available in this build')
  }

  // Only a 'connected' client has .capabilities and .client to register the
  // handler on. The pool spread at the call site matches mcp_status.
  const connection = connectionPool.find((c) => c.name === serverName && c.type === 'connected')
  if (!connection || connection.type !== 'connected') {
    return respondError(`server ${serverName} is not connected`)
  }

  const pluginSource = connection.config.pluginSource
  const parsed = pluginSource ? parsePluginIdentifier(pluginSource) : undefined
  if (!parsed?.marketplace) {
    // No pluginSource or @-less source — can never pass the {plugin,
    // marketplace}-keyed allowlist. Short-circuit with the same reason the
    // gate would produce.
    return respondError(
      `server ${serverName} is not plugin-sourced; channel_enable requires a marketplace plugin`,
    )
  }

  const entry: ChannelEntry = {
    kind: 'plugin',
    name: parsed.name,
    marketplace: parsed.marketplace,
  }
  // Idempotency: don't double-append on repeat enable.
  const prior = getAllowedChannels()
  const already = prior.some(
    (e) => e.kind === 'plugin' && e.name === entry.name && e.marketplace === entry.marketplace,
  )
  if (!already) {
    setAllowedChannels([...prior, entry])
  }

  const gate = gateChannelServer(serverName, connection.capabilities, pluginSource)
  if (gate.action === 'skip') {
    // Rollback — only remove the entry we appended.
    if (!already) {
      setAllowedChannels(prior)
    }
    return respondError(gate.reason)
  }

  const pluginId =
    `${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  logMCPDebug(serverName, 'Channel notifications registered')
  logEvent('zy_mcp_channel_enable', { plugin: pluginId })

  // Identical enqueue shape to the interactive register block in
  // useManageMCPConnections. drainCommandQueue processes it between turns —
  // channel messages queue at priority 'next' and are seen by the model on
  // the turn after they arrive.
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema(),
    async (notification) => {
      const { content, meta } = notification.params
      logMCPDebug(serverName, `notifications/zy/channel: ${content.slice(0, 80)}`)
      logEvent('zy_mcp_channel_message', {
        content_length: content.length,
        meta_key_count: Object.keys(meta ?? {}).length,
        entry_kind: 'plugin' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_dev: false,
        plugin: pluginId,
      })
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(serverName, content, meta),
        priority: 'next',
        isMeta: true,
        origin: {
          kind: 'channel',
          channel: serverName,
          server: serverName,
        } satisfies MessageOrigin,
        skipSlashCommands: true,
      })
    },
  )

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: undefined,
    },
  })
}

/**
 * Re-register the channel notification handler after mcp_reconnect /
 * mcp_toggle creates a new client. handleChannelEnable bound the handler to
 * the OLD client object; allowedChannels survives the reconnect but the
 * handler binding does not. Without this, channel messages silently drop
 * after a reconnect while the IDE still believes the channel is live.
 *
 * Mirrors the interactive CLI's onConnectionAttempt in
 * useManageMCPConnections, which re-gates on every new connection. Paired
 * with registerElicitationHandlers at the same call sites.
 *
 * No-op if the server was never channel-enabled: gateChannelServer calls
 * findChannelEntry internally and returns skip/session for an unlisted
 * server, so reconnecting a non-channel MCP server costs one feature-flag
 * check.
 */
export function reregisterChannelHandlerAfterReconnect(connection: MCPServerConnection): void {
  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) {
    return
  }
  if (connection.type !== 'connected') {
    return
  }

  const gate = gateChannelServer(
    connection.name,
    connection.capabilities,
    connection.config.pluginSource,
  )
  if (gate.action !== 'register') {
    return
  }

  const entry = findChannelEntry(connection.name, getAllowedChannels())
  const pluginId =
    entry?.kind === 'plugin'
      ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : undefined

  logMCPDebug(connection.name, 'Channel notifications re-registered after reconnect')
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema(),
    async (notification) => {
      const { content, meta } = notification.params
      logMCPDebug(connection.name, `notifications/zy/channel: ${content.slice(0, 80)}`)
      logEvent('zy_mcp_channel_message', {
        content_length: content.length,
        meta_key_count: Object.keys(meta ?? {}).length,
        entry_kind: entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_dev: entry?.dev ?? false,
        plugin: pluginId,
      })
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(connection.name, content, meta),
        priority: 'next',
        isMeta: true,
        origin: {
          kind: 'channel',
          channel: connection.name,
          server: connection.name,
        } satisfies MessageOrigin,
        skipSlashCommands: true,
      })
    },
  )
}

/**
 * Emits an error message in the correct format based on outputFormat.
 * When using stream-json, writes JSON to stdout; otherwise writes plain text to stderr.
 */
function emitLoadError(message: string, outputFormat: string | undefined): void {
  if (outputFormat === 'stream-json') {
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      isError: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(`${jsonStringify(errorResult)}\n`)
  } else {
    process.stderr.write(`${message}\n`)
  }
}

/**
 * Removes an interrupted user message and its synthetic assistant sentinel
 * from the message array. Used during gateway-triggered restarts to clean up
 * the message history before re-enqueuing the interrupted prompt.
 *
 * @internal Exported for testing
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: UserMessage,
): void {
  const idx = messages.findIndex((m) => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // Remove the user message and the sentinel that immediately follows it.
    // splice safely handles the case where idx is the last element.
    messages.splice(idx, 2)
  }
}

type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}

async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    teleport: string | true | null | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    restoredWorkerState: Promise<SessionExternalMetadata | null>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  // Handle continue in print mode
  if (options.continue) {
    try {
      logEvent('zy_continue_print', {})

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* file path */,
      )
      if (result) {
        // Match coordinator mode to the resumed session's mode
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(result.mode)
          if (warning) {
            process.stderr.write(`${warning}\n`)
            // Refresh agent definitions to reflect the mode switch
            const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js')
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(getCwd())

            setAppState((prev) => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
          }
        }

        // Reuse the resumed session's ID
        if (!options.forkSession) {
          if (result.sessionId) {
            switchSession(
              asSessionId(result.sessionId),
              result.fullPath ? dirname(result.fullPath) : null,
            )
            if (persistSession) {
              await resetSessionFilePointer()
            }
          }
        }
        restoreSessionStateFromLog(result, setAppState)

        // Restore session metadata so it's re-appended on exit via reAppendSessionMetadata
        restoreSessionMetadata(
          options.forkSession ? { ...result, worktreeSession: undefined } : result,
        )

        // Write mode entry for the resumed session
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          saveMode(coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal')
        }

        return {
          messages: result.messages,
          turnInterruptionState: result.turnInterruptionState,
          agentSetting: result.agentSetting,
        }
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Handle teleport in print mode
  if (options.teleport) {
    try {
      if (!isPolicyAllowed('allow_remote_sessions')) {
        throw new Error("Remote sessions are disabled by your organization's policy.")
      }

      logEvent('zy_teleport_print', {})

      if (typeof options.teleport !== 'string') {
        throw new Error('No session ID provided for teleport')
      }

      const {
        checkOutTeleportedSessionBranch,
        processMessagesForTeleportResume,
        teleportResumeCodeSession,
        validateGitState,
      } = await import('src/services/teleport/teleport.js')
      await validateGitState()
      const teleportResult = await teleportResumeCodeSession(options.teleport)
      const { branchError } = await checkOutTeleportedSessionBranch(teleportResult.branch)
      return {
        messages: processMessagesForTeleportResume(teleportResult.log, branchError),
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Handle resume in print mode (accepts session ID or URL)
  // URLs are [INNER-ONLY]
  if (options.resume) {
    try {
      logEvent('zy_resume_print', {})

      // In print mode - we require a valid session ID, JSONL file or URL
      const parsedSessionId = parseSessionIdentifier(
        typeof options.resume === 'string' ? options.resume : '',
      )
      if (!parsedSessionId) {
        let errorMessage =
          'Error: --resume requires a valid session ID when used with --print. Usage: zycode -p --resume <session-id>'
        if (typeof options.resume === 'string') {
          errorMessage += `. Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000). Provided value "${options.resume}" is not a valid UUID`
        }
        emitLoadError(errorMessage, options.outputFormat)
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      // Hydrate local transcript from remote before loading
      if (isEnvTruthy(process.env.ZY_CODE_)) {
        // Await restore alongside hydration so SSE catchup lands on
        // restored state, not a fresh default.
        const [, metadata] = await Promise.all([
          hydrateFromCCRv2InternalEvents(parsedSessionId.sessionId),
          options.restoredWorkerState,
        ])
        if (metadata) {
          setAppState(externalMetadataToAppState(metadata))
          if (typeof metadata.model === 'string') {
            setMainLoopModelOverride(metadata.model)
          }
        }
      } else if (
        parsedSessionId.isUrl &&
        parsedSessionId.ingressUrl &&
        isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE)
      ) {
        // v1: fetch session logs from Session Ingress
        await hydrateRemoteSession(parsedSessionId.sessionId, parsedSessionId.ingressUrl)
      }

      // Load the conversation with the specified session ID
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile || undefined,
      )

      // hydrateFromCCRv2InternalEvents writes an empty transcript file for
      // fresh sessions (writeFile(sessionFile, '') with zero events), so
      // loadConversationForResume returns {messages: []} not null. Treat
      // empty the same as null so SessionStart still fires.
      if (!result || result.messages.length === 0) {
        // For URL-based or CCR v2 resume, start with empty session (it was hydrated but empty)
        if (parsedSessionId.isUrl || isEnvTruthy(process.env.ZY_CODE_)) {
          // Execute SessionStart hooks for startup since we're starting a new session
          return {
            messages: await (options.sessionStartHooksPromise ??
              processSessionStartHooks('startup')),
          }
        } else {
          emitLoadError(
            `No conversation found with session ID: ${parsedSessionId.sessionId}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }
      }

      // Handle resumeSessionAt feature
      if (options.resumeSessionAt) {
        const index = result.messages.findIndex((m) => m.uuid === options.resumeSessionAt)
        if (index < 0) {
          emitLoadError(
            `No message found with message.uuid of: ${options.resumeSessionAt}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }

        result.messages = index >= 0 ? result.messages.slice(0, index + 1) : []
      }

      // Match coordinator mode to the resumed session's mode
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          process.stderr.write(`${warning}\n`)
          // Refresh agent definitions to reflect the mode switch
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js')
          getAgentDefinitionsWithOverrides.cache.clear?.()
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(getCwd())

          setAppState((prev) => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
            },
          }))
        }
      }

      // Reuse the resumed session's ID
      if (!options.forkSession && result.sessionId) {
        switchSession(
          asSessionId(result.sessionId),
          result.fullPath ? dirname(result.fullPath) : null,
        )
        if (persistSession) {
          await resetSessionFilePointer()
        }
      }
      restoreSessionStateFromLog(result, setAppState)

      // Restore session metadata so it's re-appended on exit via reAppendSessionMetadata
      restoreSessionMetadata(
        options.forkSession ? { ...result, worktreeSession: undefined } : result,
      )

      // Write mode entry for the resumed session
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        saveMode(coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal')
      }

      return {
        messages: result.messages,
        turnInterruptionState: result.turnInterruptionState,
        agentSetting: result.agentSetting,
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with --print mode'
      emitLoadError(errorMessage, options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Join the SessionStart hooks promise kicked in main.tsx (or run fresh if
  // it wasn't kicked — e.g. --continue with no prior session falls through
  // here with sessionStartHooksPromise undefined because main.tsx guards on continue)
  return {
    messages: await (options.sessionStartHooksPromise ?? processSessionStartHooks('startup')),
  }
}

function getStructuredIO(
  inputPrompt: string | AsyncIterable<string>,
  options: {
    sdkUrl: string | undefined
    replayUserMessages?: boolean
  },
): StructuredIO {
  let inputStream: AsyncIterable<string>
  if (typeof inputPrompt === 'string') {
    if (inputPrompt.trim() !== '') {
      // Normalize to a streaming input.
      inputStream = fromArray([
        jsonStringify({
          type: 'user',
          session_id: '',
          message: {
            role: 'user',
            content:
              typeof inputPrompt === 'string'
                ? [{ type: 'text' as const, text: inputPrompt }]
                : inputPrompt,
          },
          parent_tool_use_id: null,
        } satisfies WireUserMessage),
      ])
    } else {
      // Empty string - create empty stream
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  // Use RemoteIO if sdkUrl is provided, otherwise use regular StructuredIO
  return options.sdkUrl
    ? new RemoteIO(options.sdkUrl, inputStream, options.replayUserMessages)
    : new StructuredIO(inputStream, options.replayUserMessages)
}

/**
 * Handles unexpected permission responses by looking up the unresolved tool
 * call in the transcript and enqueuing it for execution.
 *
 * Returns true if a permission was enqueued, false otherwise.
 */
export async function handleOrphanedPermissionResponse({
  message,
  setAppState,
  onEnqueued,
  handledToolUseIds,
}: {
  message: WireControlResponse
  setAppState: (f: (prev: AppState) => AppState) => void
  onEnqueued?: () => void
  handledToolUseIds: Set<string>
}): Promise<boolean> {
  if (
    message.response.subtype === 'success' &&
    message.response.response?.toolUseID &&
    typeof message.response.response.toolUseID === 'string'
  ) {
    const permissionResult = message.response.response as PermissionResult
    const { toolUseID } = permissionResult
    if (!toolUseID) {
      return false
    }

    logForDebugging(
      `handleOrphanedPermissionResponse: received orphaned control_response for toolUseID=${toolUseID} request_id=${message.response.request_id}`,
    )

    // Prevent re-processing the same orphaned tool_use. Without this guard,
    // duplicate control_response deliveries (e.g. from WebSocket reconnect)
    // cause the same tool to be executed multiple times, producing duplicate
    // tool_use IDs in the messages array and a 400 error from the API.
    // Once corrupted, every retry accumulates more duplicates.
    if (handledToolUseIds.has(toolUseID)) {
      logForDebugging(
        `handleOrphanedPermissionResponse: skipping duplicate orphaned permission for toolUseID=${toolUseID} (already handled)`,
      )
      return false
    }

    const assistantMessage = await findUnresolvedToolUse(toolUseID)
    if (!assistantMessage) {
      logForDebugging(
        `handleOrphanedPermissionResponse: no unresolved tool_use found for toolUseID=${toolUseID} (already resolved in transcript)`,
      )
      return false
    }

    handledToolUseIds.add(toolUseID)
    logForDebugging(
      `handleOrphanedPermissionResponse: enqueuing orphaned permission for toolUseID=${toolUseID} messageID=${assistantMessage.message.id}`,
    )
    enqueue({
      mode: 'orphaned-permission' as const,
      value: [],
      orphanedPermission: {
        permissionResult,
        assistantMessage,
      },
    })

    onEnqueued?.()
    return true
  }
  return false
}

export type { DynamicMcpState } from './headless/mcpRuntime.js'

/**
 * Converts a process transport config to a scoped config.
 * The types are structurally compatible, so we just add the scope.
 */
function toScopedConfig(config: McpServerConfigForProcessTransport): ScopedMcpServerConfig {
  // McpServerConfigForProcessTransport is a subset of McpServerConfig
  // (it excludes IDE-specific types like sse-ide and ws-ide)
  // Adding scope makes it a valid ScopedMcpServerConfig
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

/**
 * State for SDK MCP servers that run in the SDK process.
 */
export type WireMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/**
 * Result of handleMcpSetServers - contains new state and response data.
 */
export type McpSetServersResult = {
  response: WireControlMcpSetServersResponse
  newWireState: WireMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

/**
 * Handles mcp_set_servers requests by processing both SDK and process-based servers.
 * SDK servers run in the SDK process; process-based servers are spawned by the CLI.
 *
 * Applies enterprise allowedMcpServers/deniedMcpServers policy — same filter as
 * --mcp-config (see filterMcpServersByPolicy call in main.tsx). Without this,
 * SDK V2 Query.setMcpServers() was a second policy bypass vector. Blocked servers
 * are reported in response.errors so the SDK consumer knows why they weren't added.
 */
export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: WireMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  // Enforce enterprise MCP policy on process-based servers (stdio/http/sse).
  // Mirrors the --mcp-config filter in main.tsx — both user-controlled injection
  // paths must have the same gate. type:'sdk' servers are exempt (SDK-managed,
  // CLI never spawns/connects for them — see filterMcpServersByPolicy jsdoc).
  // Blocked servers go into response.errors so the SDK caller sees why.
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  const policyErrors: Record<string, string> = {}
  for (const name of blocked) {
    policyErrors[name] = 'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  // Separate SDK servers from process-based servers
  const sdkServers: Record<string, McpSdkServerConfig> = {}
  const processServers: Record<string, McpServerConfigForProcessTransport> = {}

  for (const [name, config] of Object.entries(allowedServers)) {
    if (config.type === 'sdk') {
      sdkServers[name] = config
    } else {
      processServers[name] = config
    }
  }

  // Handle SDK servers
  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

  // Remove SDK servers no longer in desired state
  for (const name of currentSdkNames) {
    if (!newSdkNames.has(name)) {
      const client = newSdkClients.find((c) => c.name === name)
      if (client && client.type === 'connected') {
        await client.cleanup()
      }
      newSdkClients = newSdkClients.filter((c) => c.name !== name)
      const prefix = `mcp__${name}__`
      newSdkTools = newSdkTools.filter((t) => !t.name.startsWith(prefix))
      delete newSdkConfigs[name]
      sdkRemoved.push(name)
    }
  }

  // Add new SDK servers as pending - they'll be upgraded to connected
  // when updateSdkMcp() runs on the next query
  for (const [name, config] of Object.entries(sdkServers)) {
    if (!currentSdkNames.has(name)) {
      newSdkConfigs[name] = config
      const pendingClient: MCPServerConnection = {
        type: 'pending',
        name,
        config: { ...config, scope: 'dynamic' as const },
      }
      newSdkClients = [...newSdkClients, pendingClient]
      sdkAdded.push(name)
    }
  }

  // Handle process-based servers
  const processResult = await reconcileMcpServers(processServers, dynamicState, setAppState)

  return {
    response: {
      added: [...sdkAdded, ...processResult.response.added],
      removed: [...sdkRemoved, ...processResult.response.removed],
      errors: { ...policyErrors, ...processResult.response.errors },
    },
    newWireState: {
      configs: newSdkConfigs,
      clients: newSdkClients,
      tools: newSdkTools,
    },
    newDynamicState: processResult.newState,
    sdkServersChanged: sdkAdded.length > 0 || sdkRemoved.length > 0,
  }
}

/**
 * Reconciles the current set of dynamic MCP servers with a new desired state.
 * Handles additions, removals, and config changes.
 */
export async function reconcileMcpServers(
  desiredConfigs: Record<string, McpServerConfigForProcessTransport>,
  currentState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<{
  response: WireControlMcpSetServersResponse
  newState: DynamicMcpState
}> {
  const currentNames = new Set(Object.keys(currentState.configs))
  const desiredNames = new Set(Object.keys(desiredConfigs))

  const toRemove = [...currentNames].filter((n) => !desiredNames.has(n))
  const toAdd = [...desiredNames].filter((n) => !currentNames.has(n))

  // Check for config changes (same name, different config)
  const toCheck = [...currentNames].filter((n) => desiredNames.has(n))
  const toReplace = toCheck.filter((name) => {
    const currentConfig = currentState.configs[name]
    const desiredConfigRaw = desiredConfigs[name]
    if (!currentConfig || !desiredConfigRaw) {
      return true
    }
    const desiredConfig = toScopedConfig(desiredConfigRaw)
    return !areMcpConfigsEqual(currentConfig, desiredConfig)
  })

  const removed: string[] = []
  const added: string[] = []
  const errors: Record<string, string> = {}

  let newClients = [...currentState.clients]
  let newTools = [...currentState.tools]

  // Remove old servers (including ones being replaced)
  for (const name of [...toRemove, ...toReplace]) {
    const client = newClients.find((c) => c.name === name)
    const config = currentState.configs[name]
    if (client && config) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (e) {
          logError(e)
        }
      }
      // Clear the memoization cache
      await clearServerCache(name, config)
    }

    // Remove tools from this server
    const prefix = `mcp__${name}__`
    newTools = newTools.filter((t) => !t.name.startsWith(prefix))

    // Remove from clients list
    newClients = newClients.filter((c) => c.name !== name)

    // Track removal (only for actually removed, not replaced)
    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  // Add new servers (including replacements)
  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) {
      continue
    }
    const scopedConfig = toScopedConfig(config)

    // SDK servers are managed by the SDK process, not the CLI.
    // Just track them without trying to connect.
    if (config.type === 'sdk') {
      added.push(name)
      continue
    }

    try {
      const client = await connectToServer(name, scopedConfig)
      newClients.push(client)

      if (client.type === 'connected') {
        const serverTools = await fetchToolsForClient(client)
        newTools.push(...serverTools)
      } else if (client.type === 'failed') {
        errors[name] = client.error || 'Connection failed'
      }

      added.push(name)
    } catch (e) {
      const err = toError(e)
      errors[name] = err.message
      logError(err)
    }
  }

  // Build new configs
  const newConfigs: Record<string, ScopedMcpServerConfig> = {}
  for (const name of desiredNames) {
    const config = desiredConfigs[name]
    if (config) {
      newConfigs[name] = toScopedConfig(config)
    }
  }

  const newState: DynamicMcpState = {
    clients: newClients,
    tools: newTools,
    configs: newConfigs,
  }

  // Update AppState with the new tools
  setAppState((prev) => {
    // Get all dynamic server names (current + new)
    const allDynamicServerNames = new Set([
      ...Object.keys(currentState.configs),
      ...Object.keys(newConfigs),
    ])

    // Remove old dynamic tools
    const nonDynamicTools = prev.mcp.tools.filter((t) => {
      for (const serverName of allDynamicServerNames) {
        if (t.name.startsWith(`mcp__${serverName}__`)) {
          return false
        }
      }
      return true
    })

    // Remove old dynamic clients
    const nonDynamicClients = prev.mcp.clients.filter((c) => {
      return !allDynamicServerNames.has(c.name)
    })

    return {
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [...nonDynamicTools, ...newTools],
        clients: [...nonDynamicClients, ...newClients],
      },
    }
  })

  return {
    response: { added, removed, errors },
    newState,
  }
}
