// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { logEvent } from 'src/services/analytics/index.js'
import { logForDebugging } from 'src/utils/debug.js'
import { type Tools } from 'src/Tool.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { dequeue, enqueue, peek } from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import { notifySessionStateChanged } from 'src/utils/sessionState.js'
import { getInMemoryErrors, logError } from 'src/utils/log.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import { ask } from 'src/QueryEngine.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
} from 'src/utils/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { executeFilePersistence } from 'src/services/filePersistence/filePersistence.js'
import { finalizePendingAsyncHooks } from 'src/utils/hooks/AsyncHookRegistry.js'
import { gracefulShutdownSync, isShuttingDown } from 'src/utils/gracefulShutdown.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import type { WireStatus, WireUserMessageReplay } from 'src/types/index.js'
import type { StdoutMessage } from 'src/types/wire/control.js'
import { cwd } from 'node:process'
import type { ReplWireHandle } from 'src/bridge/replBridge.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { createAbortController } from 'src/utils/abortController.js'
import { TEAMMATE_MESSAGE_TAG } from 'src/constants/xml.js'
import {
  tryGenerateSuggestion,
  logSuggestionOutcome,
  logSuggestionSuppressed,
  type PromptVariant,
} from 'src/services/PromptSuggestion/promptSuggestion.js'
import { getLastCacheSafeParams } from 'src/utils/forkedAgent.js'
import { getInitJsonSchema } from 'src/bootstrap/state.js'
import { statusListeners, type ZyAILimits } from 'src/services/zyAiLimits.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { runWithWorkload } from 'src/utils/workloadContext.js'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  headlessProfilerMemorySample,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import { startQueryProfile, logQueryProfileReport } from 'src/utils/queryProfiler.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from '../../utils/teammate.js'
import {
  readUnreadMessages,
  markMessagesAsRead,
  isShutdownApproved,
} from '../../utils/teammateMailbox.js'
import { removeTeammateFromTeamFile } from '../../services/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../../utils/tasks.js'
import { getRunningTasks } from '../../services/task/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { drainWireEvents } from '../../utils/bridgeEventQueue.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import { createHeadlessSession } from './headlessSession.js'
import { createMcpRuntime } from './mcpRuntime.js'

import {
  canBatchWith,
  joinPromptValues,
  proactiveModule,
  SHUTDOWN_TEAM_PROMPT,
  reregisterChannelHandlerAfterReconnect,
} from '../print.js'

export type RunPhase =
  | 'draining_commands'
  | 'waiting_for_agents'
  | 'finally_flush'
  | 'finally_post_flush'

// 主循环可变状态容器(Phase 4a 引入)。run() 与 run 外并发回调共享同一引用。
export interface LoopState {
  running: boolean
  runPhase: RunPhase | undefined
  inputClosed: boolean
  shutdownPromptInjected: boolean
  heldBackResult: StdoutMessage | null
  abortController: AbortController | undefined
  readFileState: ReturnType<typeof extractReadFilesFromMessages>
  activeUserSpecifiedModel: string | undefined
}

export type SuggestionState = {
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
}

export type HeadlessStreamingOptions = {
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
}

export interface TurnLoopDeps {
  loopState: LoopState
  structuredIO: StructuredIO
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  options: HeadlessStreamingOptions
  output: StructuredIO['outbound']
  session: ReturnType<typeof createHeadlessSession>
  mcp: ReturnType<typeof createMcpRuntime>
  suggestionState: SuggestionState
  pendingSeeds: ReturnType<typeof createFileStateCacheWithSizeLimit>
  buildAllTools: (appState: AppState) => Tools
  forwardMessagesToBridge: () => void
  idleTimeout: ReturnType<typeof createIdleTimeoutManager>
  scheduleProactiveTick: (() => void) | undefined
  unsubscribeSkillChanges: () => void
  unsubscribeAuthStatus: (() => void) | undefined
  rateLimitListener: (limits: ZyAILimits) => void
  kickRun: () => void
  getBridgeHandle: () => ReplWireHandle | null
}

// Phase 4b: 主对话循环外提自 print.ts runHeadlessStreaming。所有闭包依赖经 deps
// 注入(参照 mcpRuntime 约定);loopState 共享可变状态;kickRun 处理 run 自递归;
// getBridgeHandle 取活引用(bridgeHandle 会被 remote_control 控制 handler 重赋值)。
export async function runTurnLoop(deps: TurnLoopDeps): Promise<void> {
  const {
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
    kickRun,
    getBridgeHandle,
  } = deps
  if (loopState.running) {
    return
  }

  loopState.running = true
  loopState.runPhase = undefined
  notifySessionStateChanged('running')
  idleTimeout.stop()

  headlessProfilerCheckpoint('run_entry')
  // TODO(custom-tool-refactor): Should move to the init message, like browser

  await mcp.updateSdkMcp()
  headlessProfilerCheckpoint('after_updateSdkMcp')

  // Resolve deferred plugin installation (ZY_CODE_SYNC_PLUGIN_INSTALL).
  // The promise was started eagerly so installation overlaps with other init.
  // Awaiting here guarantees plugins are available before the first ask().
  // If ZY_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS is set, races against that
  // deadline and proceeds without plugins on timeout (logging an error).
  if (mcp.pluginInstallPromise) {
    const timeoutMs = parseInt(process.env.ZY_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '', 10)
    if (timeoutMs > 0) {
      const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
      const result = await Promise.race([mcp.pluginInstallPromise, timeout])
      if (result === 'timeout') {
        logError(
          new Error(
            `ZY_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
          ),
        )
        logEvent('zy_sync_plugin_install_timeout', {
          timeout_ms: timeoutMs,
        })
      }
    } else {
      await mcp.pluginInstallPromise
    }
    mcp.pluginInstallPromise = null

    // Refresh commands, agents, and hooks now that plugins are installed
    await mcp.refreshPluginState()

    // Set up hot-reload for plugin hooks now that the initial install is done.
    // In sync-install mode, setup.ts skips this to avoid racing with the install.
    const { setupPluginHookHotReload } = await import('../../utils/plugins/loadPluginHooks.js')
    setupPluginHookHotReload()
  }

  // Only main-thread commands (agentId===undefined) — subagent
  // notifications are drained by the subagent's mid-turn gate in query.ts.
  // Defined outside the try block so it's accessible in the post-finally
  // queue re-checks at the bottom of run().
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  try {
    let command: QueuedCommand | undefined
    let waitingForAgents = false

    // Extract command processing into a named function for the do-while pattern.
    // Drains the queue, batching consecutive prompt-mode commands into one
    // ask() call so messages that queued up during a long turn coalesce
    // into a single follow-up turn instead of N separate turns.
    const drainCommandQueue = async () => {
      while ((command = dequeue(isMainThread))) {
        if (
          command.mode !== 'prompt' &&
          command.mode !== 'orphaned-permission' &&
          command.mode !== 'task-notification'
        ) {
          throw new Error('only prompt commands are supported in streaming mode')
        }

        // Non-prompt commands (task-notification, orphaned-permission) carry
        // side effects or orphanedPermission state, so they process singly.
        // Prompt commands greedily collect followers with matching workload.
        const batch: QueuedCommand[] = [command]
        if (command.mode === 'prompt') {
          while (canBatchWith(command, peek(isMainThread))) {
            batch.push(dequeue(isMainThread)!)
          }
          if (batch.length > 1) {
            command = {
              ...command,
              value: joinPromptValues(batch.map((c) => c.value)),
              uuid: batch.findLast((c) => c.uuid)?.uuid ?? command.uuid,
            }
          }
        }
        const batchUuids = batch.map((c) => c.uuid).filter((u) => u !== undefined)

        // QueryEngine will emit a replay for command.uuid (the last uuid in
        // the batch) via its messagesToAck path. Emit replays here for the
        // rest so consumers that track per-uuid delivery (clank's
        // asyncMessages footer, CCR) see an ack for every message they sent,
        // not just the one that survived the merge.
        if (options.replayUserMessages && batch.length > 1) {
          for (const c of batch) {
            if (c.uuid && c.uuid !== command.uuid) {
              output.enqueue({
                type: 'user',
                message: {
                  role: 'user',
                  content:
                    typeof c.value === 'string'
                      ? [{ type: 'text' as const, text: c.value }]
                      : c.value,
                },
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: c.uuid,
                isReplay: true,
              } satisfies WireUserMessageReplay)
            }
          }
        }

        // Combine all MCP clients. appState.mcp is populated incrementally
        // per-server by main.tsx (mirrors useManageMCPConnections). Reading
        // fresh per-command means late-connecting servers are visible on the
        // next turn. registerElicitationHandlers is idempotent (tracking set).
        const appState = getAppState()
        const allMcpClients = [
          ...appState.mcp.clients,
          ...mcp.sdkClients,
          ...mcp.dynamicMcpState.clients,
        ]
        mcp.registerElicitationHandlers(allMcpClients)
        // Channel handlers for servers allowlisted via --channels at
        // construction time (or enableChannel() mid-session). Runs every
        // turn like registerElicitationHandlers — idempotent per-client
        // (setNotificationHandler replaces, not stacks) and no-ops for
        // non-allowlisted servers (one feature-flag check).
        for (const client of allMcpClients) {
          reregisterChannelHandlerAfterReconnect(client)
        }

        const allTools = buildAllTools(appState)

        for (const uuid of batchUuids) {
          notifyCommandLifecycle(uuid, 'started')
        }

        // Task notifications arrive when background agents complete.
        // Emit an SDK system event for SDK consumers, then fall through
        // to ask() so the model sees the agent result and can act on it.
        // This matches TUI behavior where useQueueProcessor always feeds
        // notifications to the model regardless of coordinator mode.
        if (command.mode === 'task-notification') {
          const notificationText = typeof command.value === 'string' ? command.value : ''
          // Parse the XML-formatted notification
          const taskIdMatch = notificationText.match(/<task-id>([^<]+)<\/task-id>/)
          const toolUseIdMatch = notificationText.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)
          const outputFileMatch = notificationText.match(/<output-file>([^<]+)<\/output-file>/)
          const statusMatch = notificationText.match(/<status>([^<]+)<\/status>/)
          const summaryMatch = notificationText.match(/<summary>([^<]+)<\/summary>/)

          const isValidStatus = (
            s: string | undefined,
          ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
            s === 'completed' || s === 'failed' || s === 'stopped' || s === 'killed'
          const rawStatus = statusMatch?.[1]
          const status = isValidStatus(rawStatus)
            ? rawStatus === 'killed'
              ? 'stopped'
              : rawStatus
            : 'completed'

          const usageMatch = notificationText.match(/<usage>([\s\S]*?)<\/usage>/)
          const usageContent = usageMatch?.[1] ?? ''
          const totalTokensMatch = usageContent.match(/<total_tokens>(\d+)<\/total_tokens>/)
          const toolUsesMatch = usageContent.match(/<tool_uses>(\d+)<\/tool_uses>/)
          const durationMsMatch = usageContent.match(/<duration_ms>(\d+)<\/duration_ms>/)

          // Only emit a task_notification SDK event when a <status> tag is
          // present — that means this is a terminal notification (completed/
          // failed/stopped). Stream events from enqueueStreamEvent carry no
          // <status> (they're progress pings); emitting them here would
          // default to 'completed' and falsely close the task for SDK
          // consumers. Terminal bookends are now emitted directly via
          // emitTaskTerminatedBridge, so skipping statusless events is safe.
          if (statusMatch) {
            output.enqueue({
              type: 'system',
              subtype: 'task_notification',
              task_id: taskIdMatch?.[1] ?? '',
              tool_use_id: toolUseIdMatch?.[1],
              status,
              output_file: outputFileMatch?.[1] ?? '',
              summary: summaryMatch?.[1] ?? '',
              usage:
                totalTokensMatch && toolUsesMatch
                  ? {
                      total_tokens: parseInt(totalTokensMatch[1]!, 10),
                      tool_uses: parseInt(toolUsesMatch[1]!, 10),
                      duration_ms: durationMsMatch ? parseInt(durationMsMatch[1]!, 10) : 0,
                    }
                  : undefined,
              session_id: getSessionId(),
              uuid: randomUUID(),
            })
          }
          // No continue -- fall through to ask() so the model processes the result
        }

        const input = command.value

        if (structuredIO instanceof RemoteIO && command.mode === 'prompt') {
          logEvent('zy_bridge_message_received', {
            is_repl: false,
          })
        }

        // Abort any in-flight suggestion generation and track acceptance
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        suggestionState.pendingSuggestion = null
        suggestionState.pendingLastEmittedEntry = null
        if (suggestionState.lastEmitted) {
          if (command.mode === 'prompt') {
            // SDK user messages enqueue UserContentBlock[], not a plain string
            const inputText =
              typeof input === 'string'
                ? input
                : (
                    input.find((b) => b.type === 'text') as
                      | { type: 'text'; text: string }
                      | undefined
                  )?.text
            if (typeof inputText === 'string') {
              logSuggestionOutcome(
                suggestionState.lastEmitted.text,
                inputText,
                suggestionState.lastEmitted.emittedAt,
                suggestionState.lastEmitted.promptId,
                suggestionState.lastEmitted.generationRequestId,
              )
            }
            suggestionState.lastEmitted = null
          }
        }

        loopState.abortController = createAbortController()
        const turnStartTime = feature('FILE_PERSISTENCE') ? Date.now() : undefined

        headlessProfilerCheckpoint('before_ask')
        startQueryProfile()
        // Per-iteration ALS context so bg agents spawned inside ask()
        // inherit workload across their detached awaits. In-process cron
        // stamps cmd.workload; the SDK --workload flag is options.workload.
        // const-capture: TS loses `while ((command = dequeue()))` narrowing
        // inside the closure.
        const cmd = command
        await runWithWorkload(cmd.workload ?? options.workload, async () => {
          for await (const message of ask({
            commands: uniqBy([...mcp.currentCommands, ...appState.mcp.commands], 'name'),
            prompt: input,
            promptUuid: cmd.uuid,
            isMeta: cmd.isMeta,
            cwd: cwd(),
            tools: allTools,
            verbose: options.verbose,
            mcpClients: allMcpClients,
            thinkingConfig: options.thinkingConfig,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            taskBudget: options.taskBudget,
            canUseTool,
            userSpecifiedModel: loopState.activeUserSpecifiedModel,
            fallbackModel: options.fallbackModel,
            jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
            mutableMessages: session.messages,
            getReadFileCache: () =>
              pendingSeeds.size === 0
                ? loopState.readFileState
                : mergeFileStateCaches(loopState.readFileState, pendingSeeds),
            setReadFileCache: (cache) => {
              loopState.readFileState = cache
              for (const [path, seed] of pendingSeeds.entries()) {
                const existing = loopState.readFileState.get(path)
                if (!existing || seed.timestamp > existing.timestamp) {
                  loopState.readFileState.set(path, seed)
                }
              }
              pendingSeeds.clear()
            },
            customSystemPrompt: options.systemPrompt,
            appendSystemPrompt: options.appendSystemPrompt,
            getAppState,
            setAppState,
            abortController: loopState.abortController,
            replayUserMessages: options.replayUserMessages,
            includePartialMessages: options.includePartialMessages,
            handleElicitation: (serverName, params, elicitSignal) =>
              structuredIO.handleElicitation(
                serverName,
                params.message,
                undefined,
                elicitSignal,
                params.mode,
                params.url,
                'elicitationId' in params ? params.elicitationId : undefined,
              ),
            agents: mcp.currentAgents,
            orphanedPermission: cmd.orphanedPermission,
            setSDKStatus: (status) => {
              output.enqueue({
                type: 'system',
                subtype: 'status',
                status,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            },
          })) {
            // Forward messages to bridge incrementally (mid-turn) so
            // zy.ai sees progress and the connection stays alive
            // while blocked on permission requests.
            forwardMessagesToBridge()

            if (message.type === 'result') {
              // Flush pending SDK events so they appear before result on the stream.
              for (const event of drainWireEvents()) {
                output.enqueue(event)
              }

              // Hold-back: don't emit result while background agents are running
              const currentState = getAppState()
              if (
                getRunningTasks(currentState).some(
                  (t) =>
                    (t.type === 'local_agent' || t.type === 'local_workflow') &&
                    isBackgroundTask(t),
                )
              ) {
                loopState.heldBackResult = message
              } else {
                loopState.heldBackResult = null
                output.enqueue(message)
              }
            } else {
              // Flush SDK events (task_started, task_progress) so background
              // agent progress is streamed in real-time, not batched until result.
              for (const event of drainWireEvents()) {
                output.enqueue(event)
              }
              output.enqueue(message)
            }
          }
        }) // end runWithWorkload

        for (const uuid of batchUuids) {
          notifyCommandLifecycle(uuid, 'completed')
        }

        // Forward messages to bridge after each turn
        forwardMessagesToBridge()
        getBridgeHandle()?.sendResult()

        if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
          void executeFilePersistence(
            turnStartTime as any,
            loopState.abortController.signal,
            (result) => {
              output.enqueue({
                type: 'system' as const,
                subtype: 'files_persisted' as const,
                files: result.files as any,
                failed: result.failed as any,
                processed_at: new Date().toISOString(),
                uuid: randomUUID(),
                session_id: getSessionId(),
              })
            },
          )
        }

        // Generate and emit prompt suggestion for SDK consumers
        if (
          options.promptSuggestions &&
          !isEnvDefinedFalsy(process.env.ZY_CODE_ENABLE_PROMPT_SUGGESTION)
        ) {
          // TS narrows suggestionState to never in the while loop body;
          // cast via unknown to reset narrowing.
          const state = suggestionState as unknown as typeof suggestionState
          state.abortController?.abort()
          const localAbort = new AbortController()
          suggestionState.abortController = localAbort

          const cacheSafeParams = getLastCacheSafeParams()
          if (!cacheSafeParams) {
            logSuggestionSuppressed('sdk_no_params', undefined, undefined, 'sdk')
          } else {
            // Use a ref object so the IIFE's finally can compare against its own
            // promise without a self-reference (which upsets TypeScript's flow analysis).
            const ref: { promise: Promise<void> | null } = { promise: null }
            ref.promise = (async () => {
              try {
                const result = await tryGenerateSuggestion(
                  localAbort,
                  session.messages,
                  getAppState,
                  cacheSafeParams,
                  'sdk',
                )
                if (!result || localAbort.signal.aborted) {
                  return
                }
                const suggestionMsg = {
                  type: 'prompt_suggestion' as const,
                  suggestion: result.suggestion,
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                }
                const lastEmittedEntry = {
                  text: result.suggestion,
                  emittedAt: Date.now(),
                  promptId: result.promptId,
                  generationRequestId: result.generationRequestId,
                }
                // Defer emission if the result is being held for background agents,
                // so that prompt_suggestion always arrives after result.
                // Only set lastEmitted when the suggestion is actually delivered
                // to the consumer; deferred suggestions may be discarded before
                // delivery if a new command arrives first.
                if (loopState.heldBackResult) {
                  suggestionState.pendingSuggestion = suggestionMsg
                  suggestionState.pendingLastEmittedEntry = {
                    text: lastEmittedEntry.text,
                    promptId: lastEmittedEntry.promptId,
                    generationRequestId: lastEmittedEntry.generationRequestId,
                  }
                } else {
                  suggestionState.lastEmitted = lastEmittedEntry
                  output.enqueue(suggestionMsg)
                }
              } catch (error) {
                if (
                  error instanceof Error &&
                  (error.name === 'AbortError' || error.name === 'APIUserAbortError')
                ) {
                  logSuggestionSuppressed('aborted', undefined, undefined, 'sdk')
                  return
                }
                logError(toError(error))
              } finally {
                if (suggestionState.inflightPromise === ref.promise) {
                  suggestionState.inflightPromise = null
                }
              }
            })()
            suggestionState.inflightPromise = ref.promise
          }
        }

        // Log headless profiler metrics for this turn and start next turn
        // 内存优化：每个 turn 结束都采样一次，多 turn 对比可发现单调上涨的泄漏
        headlessProfilerMemorySample()
        logHeadlessProfilerTurn()
        logQueryProfileReport()
        headlessProfilerStartTurn()
      }
    }

    // Use a do-while loop to drain commands and then wait for any
    // background agents that are still running. When agents complete,
    // their notifications are enqueued and the loop re-drains.
    do {
      // Drain SDK events (task_started, task_progress) before command queue
      // so progress events precede task_notification on the stream.
      for (const event of drainWireEvents()) {
        output.enqueue(event)
      }

      loopState.runPhase = 'draining_commands'
      await drainCommandQueue()

      // Check for running background tasks before exiting.
      // Exclude in_process_teammate — teammates are long-lived by design
      // (status: 'running' for their whole lifetime, cleaned up by the
      // shutdown protocol, not by transitioning to 'completed'). Waiting
      // on them here loops forever (gh-30008). Same exclusion already
      // exists at useBackgroundTaskNavigation.ts:55 for the same reason;
      // L1839 above is already narrower (type === 'local_agent') so it
      // doesn't hit this.
      waitingForAgents = false
      {
        const state = getAppState()
        const hasRunningBg = getRunningTasks(state).some(
          (t) => isBackgroundTask(t) && t.type !== 'in_process_teammate',
        )
        const hasMainThreadQueued = peek(isMainThread) !== undefined
        if (hasRunningBg || hasMainThreadQueued) {
          waitingForAgents = true
          if (!hasMainThreadQueued) {
            loopState.runPhase = 'waiting_for_agents'
            // No commands ready yet, wait for tasks to complete
            await sleep(100)
          }
          // Loop back to drain any newly queued commands
        }
      }
    } while (waitingForAgents)

    if (loopState.heldBackResult) {
      output.enqueue(loopState.heldBackResult)
      loopState.heldBackResult = null
      if (suggestionState.pendingSuggestion) {
        output.enqueue(suggestionState.pendingSuggestion)
        // Now that the suggestion is actually delivered, record it for acceptance tracking
        if (suggestionState.pendingLastEmittedEntry) {
          suggestionState.lastEmitted = {
            ...suggestionState.pendingLastEmittedEntry,
            emittedAt: Date.now(),
          }
          suggestionState.pendingLastEmittedEntry = null
        }
        suggestionState.pendingSuggestion = null
      }
    }
  } catch (error) {
    // Emit error result message before shutting down
    // Write directly to structuredIO to ensure immediate delivery
    try {
      await structuredIO.write({
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
        errors: [errorMessage(error), ...getInMemoryErrors().map((_) => _.error)],
      })
    } catch {
      // If we can't emit the error result, continue with shutdown anyway
    }
    suggestionState.abortController?.abort()
    gracefulShutdownSync(1)
    return
  } finally {
    loopState.runPhase = 'finally_flush'
    // Flush pending internal events before going idle
    await structuredIO.flushInternalEvents()
    loopState.runPhase = 'finally_post_flush'
    if (!isShuttingDown()) {
      notifySessionStateChanged('idle')
      // Drain so the idle session_state_changed SDK event (plus any
      // terminal task_notification bookends emitted during bg-agent
      // teardown) reach the output stream before we block on the next
      // command. The do-while drain above only runs while
      // waitingForAgents; once we're here the next drain would be the
      // top of the next run(), which won't come if input is idle.
      for (const event of drainWireEvents()) {
        output.enqueue(event)
      }
    }
    loopState.running = false
    // Start idle timer when we finish processing and are waiting for input
    idleTimeout.start()
  }

  // Proactive tick: if proactive is active and queue is empty, inject a tick
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    proactiveModule.isProactiveActive() &&
    !proactiveModule.isProactivePaused()
  ) {
    if (peek(isMainThread) === undefined && !loopState.inputClosed) {
      scheduleProactiveTick!()
      return
    }
  }

  // Re-check the queue after releasing the mutex. A message may have
  // arrived (and called run()) between the last dequeue() returning
  // undefined and `running = false` above. In that case the caller
  // saw `running === true` and returned immediately, leaving the
  // message stranded in the queue with no one to process it.
  if (peek(isMainThread) !== undefined) {
    kickRun()
    return
  }

  // Check for unread teammate messages and process them
  // This mirrors what useInboxPoller does in interactive REPL mode
  // Poll until no more messages (teammates may still be working)
  {
    const currentAppState = getAppState()
    const teamContext = currentAppState.teamContext

    if (teamContext && isTeamLead(teamContext)) {
      const agentName = 'team-lead'

      // Poll for messages while teammates are active
      // This is needed because teammates may send messages while we're waiting
      // Keep polling until the team is shut down
      const POLL_INTERVAL_MS = 500

      while (true) {
        // Check if teammates are still active
        const refreshedState = getAppState()
        const hasActiveTeammates =
          hasActiveInProcessTeammates(refreshedState) ||
          (refreshedState.teamContext &&
            Object.keys(refreshedState.teamContext.teammates).length > 0)

        if (!hasActiveTeammates) {
          logForDebugging('[print.ts] No more active teammates, stopping poll')
          break
        }

        const unread = await readUnreadMessages(agentName, refreshedState.teamContext?.teamName)

        if (unread.length > 0) {
          logForDebugging(`[print.ts] Team-lead found ${unread.length} unread messages`)

          // Mark as read immediately to avoid duplicate processing
          await markMessagesAsRead(agentName, refreshedState.teamContext?.teamName)

          // Process shutdown_approved messages - remove teammates from team file
          // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
          const teamName = refreshedState.teamContext?.teamName
          for (const m of unread) {
            const shutdownApproval = isShutdownApproved(m.text)
            if (shutdownApproval && teamName) {
              const teammateToRemove = shutdownApproval.from
              logForDebugging(`[print.ts] Processing shutdown_approved from ${teammateToRemove}`)

              // Find the teammate ID by name
              const teammateId = refreshedState.teamContext?.teammates
                ? Object.entries(refreshedState.teamContext.teammates).find(
                    ([, t]) => t.name === teammateToRemove,
                  )?.[0]
                : undefined

              if (teammateId) {
                // Remove from team file
                removeTeammateFromTeamFile(teamName, {
                  agentId: teammateId,
                  name: teammateToRemove,
                })
                logForDebugging(`[print.ts] Removed ${teammateToRemove} from team file`)

                // Unassign tasks owned by this teammate
                await unassignTeammateTasks(teamName, teammateId, teammateToRemove, 'shutdown')

                // Remove from teamContext in AppState
                setAppState((prev) => {
                  if (!prev.teamContext?.teammates) {
                    return prev
                  }
                  if (!(teammateId in prev.teamContext.teammates)) {
                    return prev
                  }
                  const { [teammateId]: _, ...remainingTeammates } = prev.teamContext.teammates
                  return {
                    ...prev,
                    teamContext: {
                      ...prev.teamContext,
                      teammates: remainingTeammates,
                    },
                  }
                })
              }
            }
          }

          // Format messages same as useInboxPoller
          const formatted = unread
            .map(
              (m: { from: string; text: string; color?: string }) =>
                `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
            )
            .join('\n\n')

          // Enqueue and process
          enqueue({
            mode: 'prompt',
            value: formatted,
            uuid: randomUUID(),
          })
          kickRun()
          return // run() will come back here after processing
        }

        // No messages - check if we need to prompt for shutdown
        // If input is closed and teammates are active, inject shutdown prompt once
        if (loopState.inputClosed && !loopState.shutdownPromptInjected) {
          loopState.shutdownPromptInjected = true
          logForDebugging(
            '[print.ts] Input closed with active teammates, injecting shutdown prompt',
          )
          enqueue({
            mode: 'prompt',
            value: SHUTDOWN_TEAM_PROMPT,
            uuid: randomUUID(),
          })
          kickRun()
          return // run() will come back here after processing
        }

        // Wait and check again
        await sleep(POLL_INTERVAL_MS)
      }
    }
  }

  if (loopState.inputClosed) {
    // Check for active swarm that needs shutdown
    const hasActiveSwarm = await (async () => {
      // Wait for any working in-process team members to finish
      const currentAppState = getAppState()
      if (hasWorkingInProcessTeammates(currentAppState)) {
        await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
      }

      // Re-fetch state after potential wait
      const refreshedAppState = getAppState()
      const refreshedTeamContext = refreshedAppState.teamContext
      const hasTeamMembersNotCleanedUp =
        refreshedTeamContext && Object.keys(refreshedTeamContext.teammates).length > 0

      return hasTeamMembersNotCleanedUp || hasActiveInProcessTeammates(refreshedAppState)
    })()

    if (hasActiveSwarm) {
      // Team members are idle or pane-based - inject prompt to shut down team
      enqueue({
        mode: 'prompt',
        value: SHUTDOWN_TEAM_PROMPT,
        uuid: randomUUID(),
      })
      kickRun()
    } else {
      // Wait for any in-flight push suggestion before closing the output stream.
      if (suggestionState.inflightPromise) {
        await Promise.race([suggestionState.inflightPromise, sleep(5000)])
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      await finalizePendingAsyncHooks()
      unsubscribeSkillChanges()
      unsubscribeAuthStatus?.()
      statusListeners.delete(rateLimitListener)
      output.done()
    }
  }
}
