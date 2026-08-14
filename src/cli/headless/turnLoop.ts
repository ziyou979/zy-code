// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import type { ThinkingConfig } from 'src/services/messages/thinking.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { logEvent } from 'src/services/analytics/index.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import type { Tools, ToolUseContext } from 'src/tools/tool.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { dequeue, enqueue, peek } from 'src/services/input/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/services/hooks/commandLifecycle.js'
import { notifySessionStateChanged } from 'src/services/session-state/sessionState.js'
import { getInMemoryErrors, logError } from 'src/services/infra/log.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import { ask } from 'src/query/queryEngine.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
} from 'src/services/file-persistence/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/services/query/queryHelpers.js'
import { executeFilePersistence } from 'src/services/file-persistence/filePersistence.js'
import { finalizePendingAsyncHooks } from 'src/services/hooks/asyncHookRegistry.js'
import { gracefulShutdownSync, isShuttingDown } from 'src/bootstrap/lifecycle/gracefulShutdown.js'
import { createIdleTimeoutManager } from 'src/services/session/idleTimeout.js'
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
} from 'src/services/prompt-suggestion/promptSuggestion.js'
import { getLastCacheSafeParams } from 'src/services/agent/forkedAgent.js'
import { getInitJsonSchema } from 'src/bootstrap/runtime/runtimeContext.js'
import { statusListeners, type ZyAILimits } from 'src/services/zyAiLimits.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { runWithWorkload } from 'src/services/swarm/workloadContext.js'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  headlessProfilerMemorySample,
  logHeadlessProfilerTurn,
} from 'src/services/analytics/headlessProfiler.js'
import { startQueryProfile, logQueryProfileReport } from 'src/services/query/queryProfiler.js'
import { isEnvDefinedFalsy } from '../../services/infra/envUtils.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from '../../services/swarm/teammate.js'
import { isShutdownApproved } from '../../services/swarm/teammateMailboxMessages.js'
import { readUnreadMessages, markMessagesAsRead } from '../../services/swarm/teammateMailbox.js'
import { removeTeammateFromTeamFile } from '../../services/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../../services/tasks-service/tasks.js'
import { getRunningTasks } from '../../services/task-runtime/framework.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { drainWireEvents } from '../../services/bridge/bridgeEventQueue.js'
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
  // TODO(custom-tool-refactor)：应像 browser 一样移到 init 消息中

  await mcp.updateSdkMcp()
  headlessProfilerCheckpoint('after_updateSdkMcp')

  // 等待延迟的 plugin 安装（ZY_CODE_SYNC_PLUGIN_INSTALL）。promise 已提前启动，使安装与其他
  // 初始化并行；此处 await 可保证首次 ask() 前 plugin 可用。若设置
  // ZY_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS，则与该截止时间竞争；超时后记录错误并在无 plugin
  // 状态下继续。
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

    // plugin 安装完成后刷新 command、agent 与 hook
    await mcp.refreshPluginState()

    // 初始安装完成后为 plugin hook 设置热重载。同步安装模式下 setup.ts 会跳过此步骤，避免与
    // 安装过程竞争。
    const { setupPluginHookHotReload } = await import('../../services/plugins/loadPluginHooks.js')
    setupPluginHookHotReload()
  }

  // 仅处理主线程 command（agentId === undefined）；子代理通知由 query.ts 中子代理的 turn
  // 中途关卡清空。定义在 try 块外，使 run() 底部 finally 后的队列复查也能访问。
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  try {
    let command: QueuedCommand | undefined
    let waitingForAgents = false

    // 将 command 处理提取为命名函数供 do-while 使用。清空队列时，把连续 prompt 模式 command
    // 批量合并到一次 ask()，使长 turn 期间积累的消息合并为一个后续 turn，而非 N 个独立 turn。
    const drainCommandQueue = async () => {
      while ((command = dequeue(isMainThread))) {
        if (
          command.mode !== 'prompt' &&
          command.mode !== 'orphaned-permission' &&
          command.mode !== 'task-notification'
        ) {
          throw new Error('only prompt commands are supported in streaming mode')
        }

        // 非 prompt command（task-notification、orphaned-permission）带有副作用或
        // orphanedPermission 状态，因此逐个处理。prompt command 则尽量收集 workload 相同的后续项。
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

        // QueryEngine 会通过 messagesToAck 路径为 command.uuid（批次最后一个 UUID）发送 replay。
        // 此处为其余项发送 replay，使按 UUID 跟踪投递的消费方（clank 的 asyncMessages footer、
        // CCR）能看到每条消息的 ack，而非只有合并后保留的那条。
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

        // 合并所有 MCP client。main.tsx 按 server 增量填充 appState.mcp，与
        // useManageMCPConnections 一致。每个 command 都重新读取，使较晚连接的 server 在下个 turn
        // 可见。registerElicitationHandlers 通过集合跟踪，调用幂等。
        const appState = getAppState()
        const allMcpClients = [
          ...appState.mcp.clients,
          ...mcp.sdkClients,
          ...mcp.dynamicMcpState.clients,
        ]
        mcp.registerElicitationHandlers(allMcpClients)
        // 为构造时通过 --channels 加入允许列表的 server 注册 channel handler，也支持会话中途调用
        // enableChannel()。与 registerElicitationHandlers 一样每个 turn 都运行；对各 client 幂等
        //（setNotificationHandler 会替换而非叠加），不在允许列表的 server 只做一次功能开关检查。
        for (const client of allMcpClients) {
          reregisterChannelHandlerAfterReconnect(client)
        }

        const allTools = buildAllTools(appState)

        for (const uuid of batchUuids) {
          notifyCommandLifecycle(uuid, 'started')
        }

        // 后台 agent 完成时会收到 task 通知。先为 SDK 消费方发送系统事件，再继续进入 ask()，
        // 使模型看到并处理 agent 结果。这与 TUI 行为一致：useQueueProcessor 无论 coordinator
        // 模式如何，都会将通知交给模型。
        if (command.mode === 'task-notification') {
          const notificationText = typeof command.value === 'string' ? command.value : ''
          // 解析 XML 格式的通知
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

          // 仅当存在 <status> 标签时发送 task_notification SDK 事件，说明这是终态通知
          //（completed/failed/stopped）。enqueueStreamEvent 的流事件不含 <status>，只是进度 ping；
          // 若在此发送会默认成 'completed'，导致 SDK 消费方错误关闭任务。终态边界事件现由
          // emitTaskTerminatedBridge 直接发送，因此安全跳过无 status 的事件。
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
          // 不 continue，继续进入 ask() 让模型处理结果
        }

        const input = command.value

        if (structuredIO instanceof RemoteIO && command.mode === 'prompt') {
          logEvent('zy_bridge_message_received', {
            is_repl: false,
          })
        }

        // 中止正在进行的建议生成并跟踪接受情况
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        suggestionState.pendingSuggestion = null
        suggestionState.pendingLastEmittedEntry = null
        if (suggestionState.lastEmitted) {
          if (command.mode === 'prompt') {
            // SDK 用户消息入队的是 UserContentBlock[]，而非普通字符串
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
        const turnStartTime = feature('FILE_PERSISTENCE')
          ? { wallMs: Date.now(), processMs: performance.now() }
          : undefined

        headlessProfilerCheckpoint('before_ask')
        startQueryProfile()
        // 每轮创建 ALS context，使 ask() 内启动的后台 agent 在脱离主流程的 await 中继承 workload。
        // 进程内 cron 写入 cmd.workload，SDK --workload 参数对应 options.workload。使用 const 捕获，
        // 因为 TS 会在闭包内丢失 `while ((command = dequeue()))` 的类型缩窄。
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
            handleElicitation: (
              ...[serverName, params, elicitSignal]: Parameters<
                NonNullable<ToolUseContext['handleElicitation']>
              >
            ) =>
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
            // turn 进行中增量向 bridge 转发消息，让 zy.ai 能看到进度，并在等待权限请求时保持连接。
            forwardMessagesToBridge()

            if (message.type === 'result') {
              // flush 待发送的 SDK 事件，使其在流中的 result 前出现。
              for (const event of drainWireEvents()) {
                output.enqueue(event)
              }

              // 延迟发送：后台 agent 运行期间不发送 result
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
              // flush SDK 事件（task_started、task_progress），实时流式发送后台 agent 进度，而不是
              // 等到 result 时批量发送。
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

        // 每个 turn 后向 bridge 转发消息
        forwardMessagesToBridge()
        getBridgeHandle()?.sendResult()

        if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
          void executeFilePersistence(turnStartTime, loopState.abortController.signal, (result) => {
            output.enqueue({
              type: 'system' as const,
              subtype: 'files_persisted' as const,
              files: result.files,
              failed: result.failed,
              processed_at: new Date().toISOString(),
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          })
        }

        // 为 SDK 消费方生成并发送 prompt 建议
        if (
          options.promptSuggestions &&
          !isEnvDefinedFalsy(process.env.ZY_CODE_ENABLE_PROMPT_SUGGESTION)
        ) {
          // TS 在 while 循环体内将 suggestionState 缩窄为 never；经 unknown 断言重置缩窄。
          const state = suggestionState as unknown as typeof suggestionState
          state.abortController?.abort()
          const localAbort = new AbortController()
          suggestionState.abortController = localAbort

          const cacheSafeParams = getLastCacheSafeParams()
          if (!cacheSafeParams) {
            logSuggestionSuppressed('sdk_no_params', undefined, undefined, 'sdk')
          } else {
            // 使用 ref 对象，使 IIFE 的 finally 能与自身 promise 比较而不形成自引用；自引用会
            // 干扰 TypeScript 流分析。
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
                // 若 result 因后台 agent 而暂缓，则也延迟发送，确保 prompt_suggestion 始终位于
                // result 之后。只有建议实际送达消费方时才设置 lastEmitted；若新 command 先到，
                // 延迟建议可能在投递前被丢弃。
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

        // 记录本 turn 的 headless profiler 指标并开始下一 turn
        // 内存优化：每个 turn 结束都采样一次，多 turn 对比可发现单调上涨的泄漏
        headlessProfilerMemorySample()
        logHeadlessProfilerTurn()
        logQueryProfileReport()
        headlessProfilerStartTurn()
      }
    }

    // 使用 do-while 清空 command，随后等待仍在运行的后台 agent。agent 完成后通知会入队，
    // 循环再次清空队列。
    do {
      // 在 command 队列前清空 SDK 事件（task_started、task_progress），使流中的进度事件先于
      // task_notification。
      for (const event of drainWireEvents()) {
        output.enqueue(event)
      }

      loopState.runPhase = 'draining_commands'
      await drainCommandQueue()

      // 退出前检查运行中的后台任务。排除 in_process_teammate：teammate 按设计长期存活，整个
      // 生命周期 status 都是 'running'，由关停协议清理而非转为 'completed'。在此等待会导致
      // 永久循环（gh-30008）。useBackgroundTaskNavigation.ts:55 已因同一原因排除；上方 L1839
      // 已缩窄为 type === 'local_agent'，不会受影响。
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
            // 尚无可处理 command，等待任务完成
            await sleep(100)
          }
          // 返回循环，清空新入队的 command
        }
      }
    } while (waitingForAgents)

    if (loopState.heldBackResult) {
      output.enqueue(loopState.heldBackResult)
      loopState.heldBackResult = null
      if (suggestionState.pendingSuggestion) {
        output.enqueue(suggestionState.pendingSuggestion)
        // 建议现已实际送达，记录下来以跟踪接受情况
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
    // 关停前发送错误 result 消息；直接写入 structuredIO 以确保立即送达
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
      // 即使无法发送错误 result，也继续关停
    }
    suggestionState.abortController?.abort()
    gracefulShutdownSync(1)
    return
  } finally {
    loopState.runPhase = 'finally_flush'
    // 进入空闲前 flush 待发送的内部事件
    await structuredIO.flushInternalEvents()
    loopState.runPhase = 'finally_post_flush'
    if (!isShuttingDown()) {
      notifySessionStateChanged('idle')
      // 清空队列，使 idle session_state_changed SDK 事件及后台 agent 清理期间发送的终态
      // task_notification 边界事件，在等待下个 command 前到达输出流。上方 do-while 只在
      // waitingForAgents 时清空；执行到此处后，下一次清空要等到下次 run() 开头，而输入空闲时
      // 不会触发。
      for (const event of drainWireEvents()) {
        output.enqueue(event)
      }
    }
    loopState.running = false
    // 处理完成并等待输入时启动空闲计时器
    idleTimeout.start()
  }

  // proactive tick：若 proactive 活跃且队列为空，则注入一个 tick
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

  // 释放 mutex 后重新检查队列。在最后一次 dequeue() 返回 undefined 与上方设置
  // `running = false` 之间，消息可能已到达并调用 run()；此时调用方看到 `running === true`
  // 会立即返回，导致消息滞留队列且无人处理。
  if (peek(isMainThread) !== undefined) {
    kickRun()
    return
  }

  // 检查并处理未读 teammate 消息，与交互式 REPL 模式中的 useInboxPoller 一致。持续轮询到
  // 没有消息为止，此时 teammate 仍可能在工作。
  {
    const currentAppState = getAppState()
    const teamContext = currentAppState.teamContext

    if (teamContext && isTeamLead(teamContext)) {
      const agentName = 'team-lead'

      // teammate 活跃期间持续轮询消息，因为等待期间他们仍可能发送消息；一直轮询到 team 关停。
      const POLL_INTERVAL_MS = 500

      while (true) {
        // 检查 teammate 是否仍活跃
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

          // 立即标记为已读，避免重复处理
          await markMessagesAsRead(agentName, refreshedState.teamContext?.teamName)

          // 处理 shutdown_approved 消息，从 team 文件移除 teammate；与交互模式中
          // useInboxPoller 的处理一致。
          const teamName = refreshedState.teamContext?.teamName
          for (const m of unread) {
            const shutdownApproval = isShutdownApproved(m.text)
            if (shutdownApproval && teamName) {
              const teammateToRemove = shutdownApproval.from
              logForDebugging(`[print.ts] Processing shutdown_approved from ${teammateToRemove}`)

              // 按名称查找 teammate ID
              const teammateId = refreshedState.teamContext?.teammates
                ? Object.entries(refreshedState.teamContext.teammates).find(
                    ([, t]) => t.name === teammateToRemove,
                  )?.[0]
                : undefined

              if (teammateId) {
                // 从 team 文件移除
                removeTeammateFromTeamFile(teamName, {
                  agentId: teammateId,
                  name: teammateToRemove,
                })
                logForDebugging(`[print.ts] Removed ${teammateToRemove} from team file`)

                // 解除分配给该 teammate 的任务
                await unassignTeammateTasks(teamName, teammateId, teammateToRemove, 'shutdown')

                // 从 AppState 的 teamContext 移除
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

          // 按 useInboxPoller 的方式格式化消息
          const formatted = unread
            .map(
              (m: { from: string; text: string; color?: string }) =>
                `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
            )
            .join('\n\n')

          // 入队并处理
          enqueue({
            mode: 'prompt',
            value: formatted,
            uuid: randomUUID(),
          })
          kickRun()
          return // run() will come back here after processing
        }

        // 没有消息时检查是否需要提示关停。若输入已关闭且 teammate 仍活跃，只注入一次关停 prompt。
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

        // 等待后再次检查
        await sleep(POLL_INTERVAL_MS)
      }
    }
  }

  if (loopState.inputClosed) {
    // 检查需要关停的活跃 swarm
    const hasActiveSwarm = await (async () => {
      // 等待所有仍在工作的进程内 team member 完成
      const currentAppState = getAppState()
      if (hasWorkingInProcessTeammates(currentAppState)) {
        await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
      }

      // 可能等待后重新获取状态
      const refreshedAppState = getAppState()
      const refreshedTeamContext = refreshedAppState.teamContext
      const hasTeamMembersNotCleanedUp =
        refreshedTeamContext && Object.keys(refreshedTeamContext.teammates).length > 0

      return hasTeamMembersNotCleanedUp || hasActiveInProcessTeammates(refreshedAppState)
    })()

    if (hasActiveSwarm) {
      // team member 已空闲或基于 pane 运行，注入 prompt 以关闭 team
      enqueue({
        mode: 'prompt',
        value: SHUTDOWN_TEAM_PROMPT,
        uuid: randomUUID(),
      })
      kickRun()
    } else {
      // 关闭输出流前等待正在进行的 push suggestion。
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
