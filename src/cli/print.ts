// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { dirname } from 'node:path'
import { downloadUserSettings } from 'src/services/settings-sync/index.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import { type Command, formatDescriptionWithSource, getCommandName } from 'src/commands/index.js'
import { createStreamlinedTransformer } from 'src/services/compact/streamlinedTransform.js'
import { installStreamJsonStdoutGuard } from 'src/services/telemetry/streamJsonStdoutGuard.js'
import type { ToolPermissionContext } from 'src/tools/tool.js'
import type { ThinkingConfig } from 'src/services/messages/thinking.js'
import { assembleToolPool, filterToolsByDenyRules } from 'src/tools/tools.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { mergeAndFilterTools } from 'src/services/tool-runtime/toolPool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import { logForDiagnosticsNoPII } from 'src/services/telemetry/diagLogs.js'
import { toolMatchesName, type Tool, type Tools } from 'src/tools/tool.js'
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
} from 'src/services/input/messageQueueManager.js'
import {
  getSessionState,
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from 'src/services/session-state/sessionState.js'
import { externalMetadataToAppState } from 'src/state/onChangeAppState.js'
import { logError, logMCPDebug } from 'src/services/infra/log.js'
import { writeToStdout, registerProcessOutputErrorHandlers } from 'src/services/shell/process.js'
import type { Stream } from 'src/utils/stream.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import {
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/services/session-storage/conversationRecovery.js'
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
import type { PermissionPromptTool } from 'src/services/query/queryHelpers.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/services/file-persistence/fileStateCache.js'
import { extractReadFilesFromMessages } from 'src/services/query/queryHelpers.js'
import { registerHookEventHandler } from 'src/services/hooks/hookEvents.js'
import { gracefulShutdown, gracefulShutdownSync } from 'src/bootstrap/lifecycle/gracefulShutdown.js'
import { registerCleanup } from 'src/services/cleanup/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/services/session/idleTimeout.js'
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
import { getCwd } from 'src/services/environment/cwd.js'
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
} from 'src/services/session-storage/sessionStart.js'
import { DEFAULT_OUTPUT_STYLE_NAME, getAllOutputStyles } from 'src/constants/outputStyles.js'
import { TICK_TAG } from 'src/constants/xml.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import { settingsChangeDetector } from 'src/services/settings/changeDetector.js'
import { applySettingsChange } from 'src/services/settings/applySettingsChange.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
} from 'src/services/permissions/autoModePolicy.js'
import { isBypassPermissionsModeDisabled } from 'src/services/permissions/bypassPermissionPolicy.js'
import { transitionPermissionMode } from 'src/services/permissions/permissionModeTransitions.js'
import { type PromptVariant } from 'src/services/prompt-suggestion/promptSuggestion.js'
import { getAccountInformation } from 'src/services/auth/auth.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import type { HookCallbackMatcher } from 'src/types/hooks/index.js'
import { AwsAuthStatusManager } from 'src/services/api/awsAuthStatusManager.js'
import type { HookEvent } from 'src/types/index.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  getInitJsonSchema,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { createSyntheticOutputTool } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { parseSessionIdentifier } from 'src/services/session-storage/sessionUrl.js'
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
import { filterMcpServersByPolicy } from 'src/services/mcp/configResolution.js'
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
import { getModelEffortLevels } from 'src/services/effort/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/services/messages/thinking.js'
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
import { WORKLOAD_CRON } from 'src/services/swarm/workloadContext.js'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { UserContentBlock } from '../types/llm.js'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/services/file-persistence/fileHistory.js'
import {
  restoreAgentFromSession,
  restoreSessionStateFromLog,
} from 'src/services/session-storage/sessionRestore.js'
import { SandboxManager } from 'src/services/sandbox/sandboxAdapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  headlessProfilerMemorySample,
  logHeadlessProfilerTurn,
} from 'src/services/analytics/headlessProfiler.js'
import { asSessionId } from 'src/types/ids.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
import { skillChangeDetector } from '../services/skill-runtime/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../commands/index.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'
import { getRunningTasks } from '../services/task-runtime/framework.js'
import { isBackgroundTask } from '../tasks/types.js'
import { initializeGrowthBook } from '../services/analytics/growthbook.js'
import { errorMessage, toError } from '../utils/errors.js'
import { isExtractModeActive } from '../memdir/paths.js'
import { createHeadlessSession } from './headless/headlessSession.js'
import { createMcpRuntime, type DynamicMcpState } from './headless/mcpRuntime.js'
import { runTurnLoop, type TurnLoopDeps, type LoopState } from './headless/turnLoop.js'
import { runControlLoop } from './headless/controlLoop.js'

// 死代码消除：条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
export const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
const cronSchedulerModule = feature('AGENT_TRIGGERS')
  ? (require('../services/jobs/cronScheduler.js') as typeof import('../services/jobs/cronScheduler.js'))
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

// 跟踪当前会话运行期间收到的消息 UUID
const MAX_RECEIVED_UUIDS = 10_000
export const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

export function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
    // 达到容量时淘汰最早项
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
 * 将多个排队 command 的 prompt 值合并为一个。字符串以换行连接；若任一值为 block 数组，
 * 则将所有值规范为 block 后连接。
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
 * `next` 能否与 `head` 批量合并到同一次 ask()。只有 prompt 模式 command 才能批处理，并且要求
 * workload tag 相同，以正确归因合并后的 turn；isMeta flag 也必须相同，避免 proactive tick
 * 合并进用户 prompt 后，在 head 展开到合并 command 时丢失 transcript 隐藏标记。
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

  // 立即启动用户 settings 下载，使其与下方 MCP/tool 设置重叠。managed settings 已在 main.tsx
  // preAction 中启动；此处给用户 settings 类似的提前量。plugin 安装读取 enabledPlugins 前，
  // installPluginsAndApplyMcpInBackground 会等待缓存的 promise。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.ZY_CODE_REMOTE) || getIsRemoteMode())
  ) {
    void downloadUserSettings()
  }

  // headless 模式没有 React 树，因此 useSettingsChange hook 不会运行。直接订阅，使 settings
  // 变化（包括 managed settings 与策略更新）得到完整应用。
  settingsChangeDetector.subscribe((source) => {
    applySettingsChange(source, setAppState)
  })

  // proactive 激活现由 main.tsx 在 getTools() 前处理，使 SleepTool 能通过 isEnabled() 过滤。
  // 此回退覆盖已设置 ZY_CODE_PROACTIVE 但 main.tsx 检查未触发的情况，例如 SDK transport 在
  // argv 解析后才注入环境变量。
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.ZY_CODE_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // 为首个 turn 启动 headless profiler
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // 初始化 GrowthBook，使功能开关在 headless 模式生效。否则磁盘缓存为空，所有开关都会回退到
  // 默认值。
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

  // 为 SDK client 输出 NDJSON 时，任何意外写入 stdout 的内容（debug 输出、依赖 console.log、
  // 库 banner）都会破坏 client 的逐行 JSON parser。安装防护，将非 JSON 行转到 stderr，保持流
  // 干净。必须在下方首次 structuredIO.write 前运行。
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044：用户显式设置 sandbox.enabled=true 但缺少依赖时，isSandboxingEnabled() 会静默返回
  // false。展示原因，使用户知道安全配置并未生效。
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
  // 初始化 sandbox，并提供 callback，通过 can_use_tool control_request 协议将网络权限请求转发到
  // SDK host。必须在 structuredIO 创建后执行，才能发送请求。
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

  // SessionStart hook 可发送 initialUserMessage，作为 headless orchestrator 会话的首个用户 turn。
  // 此类会话 stdin 为空，只有 additionalContext（attachment 而非 turn）会使 REPL 无内容可响应。
  // hook promise 已在 loadInitialMessages 内等待，因此执行到此处时模块级 pending 值已设置。
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

    // 从恢复的会话还原 agent 设置；若当前 --agent 参数或 settings agent 已覆盖，则 main.tsx
    // 已设置 mainThreadAgentType。
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState((prev) => ({ ...prev, agent: restoredAgent.agentType }))
      // 为非内置 agent 应用其 system prompt，与 main.tsx 初始 --agent 路径一致
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        const agentSystemPrompt = restoredAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }
      // 再次持久化 agent 设置，使以后恢复时保持该 agent
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync 会安排异步关停并设置 process.exitCode。若由 loadInitialMessages 错误
  // 路径触发，则提前返回，避免进程退出期间继续执行无用工作。
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // 处理 --rewind-files：还原文件系统并立即退出
  if (options.rewindFiles) {
    // 文件历史快照只为用户消息创建，因此目标必须是用户消息
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

    // rewind 完成，成功退出
    process.stdout.write(`Files rewound to state at message ${options.rewindFiles}\n`)
    gracefulShutdownSync(0)
    return
  }

  // 检查是否需要输入 prompt；使用有效 session ID/JSONL 文件恢复或使用 SDK URL 时跳过
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

  // 过滤 deny list 中的 MCP tool
  const allowedMcpTools = filterToolsByDenyRules(appState.mcp.tools, appState.toolPermissionContext)
  let filteredTools = [...tools, ...allowedMcpTools]

  // 使用 SDK URL 时始终通过 stdio 权限 prompt 委托给 SDK
  const effectivePermissionPromptToolName = options.sdkUrl
    ? 'stdio'
    : options.permissionPromptToolName

  // 权限 prompt 显示时的 callback
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
  // 从可用 tool 列表中移除权限 prompt tool。
    filteredTools = filteredTools.filter(
      (tool) => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // 安装错误 handler，平稳处理 broken pipe，例如父进程退出
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // 生成 model 选项前确保 model 字符串已初始化。对 Bedrock 用户，会等待 profile 请求以获得正确
  // region 字符串。
  await ensureModelStringsInitialized()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS inbox store 注册延迟到定义 `run` 后，以便将 `run` 作为 onEnqueue callback 传入。

  // 只有 `json` + `verbose` 需要完整数组（见下方 jsonStringify(messages)）。stream-json
  //（SDK/CCR）与默认文本输出只读取最后一条消息以确定退出码或最终结果，避免整个会话都在内存中
  // 累积每条消息。
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: WireMessage[] = []
  let lastMessage: WireMessage | undefined
  // 使用 stream-json 且 ZY_CODE_STREAMLINED_OUTPUT=true 时，streamlined 模式会转换消息。构建
  // flag 将其排除在外部构建外，环境变量则供 ant 构建在运行时选择启用。
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
      // streamlined 模式：转换消息并立即流式发送
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
      // 非流模式不应收到控制消息或流事件。也过滤 streamlined 类型，因为它们只由 transformer
      // 产生。排除 SDK 专用 system 事件，使 lastMessage 保持为 result；finally 块中 result 后的
      // session_state_changed(idle) 与迟到 task_notification drain 不会覆盖它。
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
      // 上方已记录
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

  // 记录最终 turn 的 headless 延迟指标
  // 内存优化：采样最终 turn 的内存使用，便于发现长会话退化
  headlessProfilerMemorySample()
  logHeadlessProfilerTurn()

  // 关停前等待正在进行的 memory extraction。响应已在上方 flush，因此不会增加用户可见延迟，
  // 只会推迟进程退出，避免 gracefulShutdownSync 的 5 秒 failsafe 在执行中途终止 fork agent。
  // 由 isExtractModeActive 控制，使 zy_slate_thimble 开关端到端控制非交互式提取。
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
  // 与 sendRequest() 使用同一队列，所有内容共用一个 FIFO。
  const output = structuredIO.outbound

  // -p 模式下按 Ctrl+C：中止正在执行的查询，再优雅关停。gracefulShutdown 会持久化会话状态并
  // flush analytics，同时设置 failsafe 定时器，在清理挂起时强制退出。
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

  // SIGTERM 时输出 run() 状态，使卡住会话的 healthsweep 无需读取 transcript 即可识别
  // do/while(waitingForAgents) 轮询。
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

  // 将中心 onChangeAppState 模式差异 hook 绑定到 SDK 输出流。任何修改
  // toolPermissionContext.mode 的代码路径都会触发，包括 Shift+Tab、ExitPlanMode 对话框、/plan
  // slash command、rewind、bridge set_permission_mode、query 循环、stop_task，而非仅限此前经过
  // 专用 wrapper 的两条路径。wrapper 函数体完全重复：既在此入队又调用
  // notifySessionMetadataChanged，而 onChangeAppState 现已覆盖两者；保留会导致状态消息发送两次。
  setPermissionModeChangedListener((newMode) => {
      // 只为 SDK 暴露的模式发送。
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

  // prompt 建议跟踪（push model）
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

  // 启用时设置 AWS 认证状态 listener
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

  // 设置 rate limit 状态 listener，为所有状态变化发送 WireRateLimitEvent。发送包括 'allowed'
  // 在内的所有状态，确保 rate limit 重置时消费方能清除警告。上游 emitStatusChange 已通过
  // isEqual 去重。
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

  // client 通过 seed_read_state control request 提供的 readFileState 种子。stdin IIFE 与 ask()
  // 并发运行；turn 中途到达的种子会因 ask() 的先 clone 后 replace（QueryEngine.ts finally 块）
  // 而丢失。
  // 因此不能直接写入 readFileState。种子先存入此处，再合并进 getReadFileCache 的视图
  //（冲突时以 readFileState 为准，种子只填补空缺），随后在 setReadFileCache 中重新应用并清空。
  // 每个种子只生效一次：仅跨过一次克隆替换周期，之后成为普通 readFileState 条目，
  // 与其他条目一样会在 compact 时被清除。
  const pendingSeeds = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  // 重启时自动恢复被中断的轮次，让 CC 从断点继续，无需 SDK 重发提示词。
  const resumeInterruptedTurnEnv = process.env.ZY_CODE_RESUME_INTERRUPTED_TURN
  if (turnInterruptionState && turnInterruptionState.kind !== 'none' && resumeInterruptedTurnEnv) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // 移除中断消息及其哨兵后重新入队，确保模型恰好看到一次。若在轮次中途被中断，
    // 反序列化层会追加一条合成的“从中断处继续”消息，将其转换为 interrupted_prompt。
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

  // ask() 与 get_context_usage 控制请求共用的工具组装逻辑。
  // 通过闭包读取 mcp.sdkTools/mcp.dynamicMcpState，让两处调用都能看到稍后接入的服务器。
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

  // 远程控制（SDK 控制消息）所用的桥接句柄。
  // 与 REPL 的 useReplBridge hook 一致：启用 `remote_control` 时创建，禁用时销毁。
  // 桥接句柄与转发游标收进共享容器(Phase 5a):controlLoop(写)、turnLoop(经
  // getBridgeHandle 读)、forwardMessagesToBridge(读写)三处共享同一引用,外提后
  // 值拷贝会读到陈旧值。
  // lastForwardedIndex 是 session.messages 的游标，用于记录已转发的位置；
  // 差量算法与 useReplBridge 的 lastWrittenIndexRef 相同。
  const bridgeState = {
    handle: null as ReplWireHandle | null,
    lastForwardedIndex: 0,
  }

  // 将 session.messages 中的新消息转发至桥接。
  // 每轮执行期间会增量调用（使 zy.ai 能看到进度，并在等待权限时保持活跃），轮次结束后再调用一次。
  //
  // writeMessages 自带基于 UUID 的去重（initialMessageUUIDs、recentPostedUUIDs）；
  // 此处的索引游标作为前置过滤，避免每次调用都以 O(n) 复杂度重扫已发送消息。
  function forwardMessagesToBridge(): void {
    if (!bridgeState.handle) {
      return
    }
    // 防止 session.messages 因 compact 截断而缩短。
    const startIndex = Math.min(bridgeState.lastForwardedIndex, session.messages.length)
    const newMessages = session.messages
      .slice(startIndex)
      .filter((m) => m.type === 'user' || m.type === 'assistant')
    bridgeState.lastForwardedIndex = session.messages.length
    if (newMessages.length > 0) {
      bridgeState.handle.writeMessages(newMessages)
    }
  }

  // 为所有 headless 用户在后台安装插件。
  // 安装 extraKnownMarketplaces 中的 marketplace，以及已启用但缺失的插件。
  // ZY_CODE_SYNC_PLUGIN_INSTALL=true 时，会在首次查询前于 run() 中等待安装完成，
  // 确保第一次 ask() 即可使用插件。
  // --bare / SIMPLE 模式跳过插件安装；脚本调用不会在会话中途新增插件，
  // 下次交互式运行时再完成同步。
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.ZY_CODE_SYNC_PLUGIN_INSTALL)) {
      mcp.pluginInstallPromise = mcp.installPluginsAndApplyMcpInBackground()
    } else {
      void mcp.installPluginsAndApplyMcpInBackground()
    }
  }

  // 空闲超时管理。
  const idleTimeout = createIdleTimeoutManager(() => !loopState.running)

  // 订阅 skill 变更以支持热重载。
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then((newCommands) => {
      mcp.currentCommands = newCommands
    })
  })

  // 主动模式：调度一次 tick，让模型自主持续循环。
  // setTimeout(0) 会先把执行权交还事件循环，使待处理的 stdin 消息
  //（中断、用户消息）能在 tick 触发前得到处理。
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

  // 收到 `now` 优先级消息时中止当前操作。
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

  // 注册 UDS 收件箱回调，使 headless 模式通过 UDS socket 收到消息时启动查询循环。
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setOnEnqueue } = require('../services/bridge/udsMessaging.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setOnEnqueue(() => {
      if (!loopState.inputClosed) {
        void run()
      }
    })
  }

  // Cron 调度器：在 SDK/-p 模式下执行 scheduled_tasks.json 中的任务。
  // 行为与 REPL 的 useScheduledTasks hook 对齐。触发的提示词入队后会直接启动 run()；
  // 与 REPL 不同，此处没有在空闲入队时负责消费队列的订阅者。run() 的互斥机制保证
  // 活跃轮次内调用仍然安全：该次调用不执行，run() 结束时的复查会拾取已入队命令。
  let cronScheduler: import('../services/jobs/cronScheduler.js').CronScheduler | null = null
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
          // 系统生成；与 useScheduledTasks.ts 中的 REPL 实现保持一致。
          // 若不设置，在 -p 模式轮次中途触发 cron 时，messages.ts 对 metaProp 的求值结果为 {}，
          // 提示词会泄漏到可见会话记录中。
          isMeta: true,
          // 此值会传至计费请求头归因块中的 cc_workload=，使 API 能以较低 QoS 服务 cron 请求。
          // drainCommandQueue 每轮读取该值，并提升到 bootstrap 状态供 ask() 调用使用。
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
 * 创建包含自定义权限提示工具的 CanUseToolFn。
 * 将 permissionPromptTool 转换为可供 ask.tsx 使用的 CanUseToolFn。
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

    // 工具已获准或被拒绝时，直接返回结果。
    if (mainPermissionResult.behavior === 'allow' || mainPermissionResult.behavior === 'deny') {
      return mainPermissionResult
    }

    // 让权限提示工具与中止信号竞争。
    //
    // 权限提示工具可能因等待用户输入（如 stdin 或 UI 对话框）而无限阻塞。
    // 用户触发中断（Ctrl+C）时，即使工具仍在阻塞也必须检测到。
    // 若没有此竞争，中止检查只能等工具完成后才运行；而工具若一直等待不会到来的输入，
    // 就可能永远无法完成。
    //
    // 第二次检查 combinedSignal.aborted，用于处理 Promise.race 已结束、
    // 但代码尚未执行到检查处时触发 abort 的竞态。
    const { signal: combinedSignal, cleanup: cleanupAbortListener } = createCombinedAbortSignal(
      toolUseContext.abortController.signal,
    )

    // 开始竞争前先检查是否已中止。
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

    // TypeScript 类型收窄：通过中止检查后，raceResult 必为 ToolResult。
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

// 导出供测试使用。此前 getMcpTools() 为空时（各服务器连接尚未填充 appState），
// 该函数会在构造阶段崩溃，属于回归测试覆盖点。
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
  // 延迟查找：print 模式下 MCP 会逐个连接服务器，初始化时工具可能尚未进入 appState。
  // 首次调用（第一次权限提示）时再解析，此时连接通常已有时间完成。
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

  // 从 stdin 应用 systemPrompt/appendSystemPrompt，避免触及 ARG_MAX 限制。
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  // 从 stdin 合并 agents，避免触及 ARG_MAX 限制。
  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // 合并 SDK agents 后重新解析主线程 agent，使 --agent 能引用 SDK 定义的 agent。
  if (options.agent) {
    // 若 main.tsx 已找到此 agent（由文件系统定义），则 systemPrompt/model/initialPrompt
    // 已经应用；此处跳过以免重复应用。
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find((a) => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      // 更新 bootstrap 状态中的主线程 agent 类型。
      setMainThreadAgentType(mainThreadAgent.agentType)

      // 用户未指定自定义系统提示词时，应用 agent 的系统提示词。
      // SDK agents 始终是自定义 agent（非内置），因此 getSystemPrompt() 不接收参数。
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // 用户未指定模型且 agent 自带模型时，应用该模型。
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // SDK 定义的 agents 通过 init 到达，因此 main.tsx 查找时无法看到。
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // 文件系统定义的 agent（已由 main.tsx 解析）。inputPrompt 为字符串时，
      // main.tsx 会处理 initialPrompt；但 inputPrompt 为 AsyncIterable（SDK stream-json）时
      // 无法拼接，因此在此回退为 prependUserMessage。
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const settings = getInitialSettings()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const availableOutputStyles = await getAllOutputStyles(getCwd())

  // 获取账户信息。
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
      // `inherit` 是内部哨兵值；对外 API 中统一转为 undefined。
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
      // 使用第三方提供商时 getAccountInformation() 返回 undefined，因此其他字段均缺失。
      // apiProvider 用于区分“未登录”（直连 API 且 tokenSource:none）与“第三方提供商不适用登录”。
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

  // initialize 消息后检查认证状态。后续变更会收到通知，但初始状态也需要发送。
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
  // 检查是否正尝试切换到 bypassPermissions 模式。
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

  // 检查是否在没有分类器门控的情况下尝试切换到 auto 模式。
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

  // 允许切换模式。
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
 * 处理 IDE 触发的 channel 启用。根据连接的 pluginSource 推导 ChannelEntry
 *（IDE 无法伪造 kind/marketplace，因为这里只接受服务器名称），将其追加到会话的
 * allowedChannels 后执行完整门控。门控失败则回滚追加；成功则注册通知处理器，
 * 以 priority:'next' 将 channel 消息入队，由 drainCommandQueue 在轮次之间取出。
 *
 * 此处有意不注册 useManageMCPConnections 为交互模式设置的 zy/channel/permission
 * 处理器。该处理器用于解析 handleInteractivePermission 内等待中的对话框，
 * 但 print.ts 从不调用 handleInteractivePermission。SDK 权限进入 `ask` 后，
 * 会通过 stdio 转给使用方的 canUseTool 回调，CLI 端没有可由远程“yes tbxkq”解析的
 * 对话框。若 IDE 需要通过 channel 转发工具审批，应由 IDE 对接自己的 pending-map。
 *（此能力还受 zy_harbor_permissions 单独门控，交互模式目前也尚未提供。）
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

  // 只有 `connected` 客户端具备用于注册处理器的 .capabilities 和 .client。
  // 调用处展开连接池的方式与 mcp_status 保持一致。
  const connection = connectionPool.find((c) => c.name === serverName && c.type === 'connected')
  if (!connection || connection.type !== 'connected') {
    return respondError(`server ${serverName} is not connected`)
  }

  const pluginSource = connection.config.pluginSource
  const parsed = pluginSource ? parsePluginIdentifier(pluginSource) : undefined
  if (!parsed?.marketplace) {
    // 缺少 pluginSource，或 source 中没有 @，都不可能通过以 {plugin, marketplace}
    // 为键的允许列表；直接以门控原本会给出的同一原因短路返回。
    return respondError(
      `server ${serverName} is not plugin-sourced; channel_enable requires a marketplace plugin`,
    )
  }

  const entry: ChannelEntry = {
    kind: 'plugin',
    name: parsed.name,
    marketplace: parsed.marketplace,
  }
  // 保持幂等：重复启用时不要再次追加。
  const prior = getAllowedChannels()
  const already = prior.some(
    (e) => e.kind === 'plugin' && e.name === entry.name && e.marketplace === entry.marketplace,
  )
  if (!already) {
    setAllowedChannels([...prior, entry])
  }

  const gate = gateChannelServer(serverName, connection.capabilities, pluginSource)
  if (gate.action === 'skip') {
    // 回滚时只移除本次追加的条目。
    if (!already) {
      setAllowedChannels(prior)
    }
    return respondError(gate.reason)
  }

  const pluginId =
    `${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  logMCPDebug(serverName, 'Channel notifications registered')
  logEvent('zy_mcp_channel_enable', { plugin: pluginId })

  // 入队结构与 useManageMCPConnections 中的交互式注册块一致。
  // drainCommandQueue 会在轮次间处理；channel 消息以 `next` 优先级排队，
  // 模型会在消息到达后的下一轮看到它。
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
 * mcp_reconnect / mcp_toggle 创建新客户端后，重新注册 channel 通知处理器。
 * handleChannelEnable 将处理器绑定在旧客户端对象上；allowedChannels 会跨重连保留，
 * 处理器绑定却不会。若不重新注册，重连后的 channel 消息会被静默丢弃，
 * 而 IDE 仍以为 channel 处于活跃状态。
 *
 * 与交互式 CLI 在 useManageMCPConnections 中的 onConnectionAttempt 一致，
 * 每次建立新连接都会重新执行门控。调用处同时配套调用 registerElicitationHandlers。
 *
 * 若服务器从未启用 channel，则不执行任何操作：gateChannelServer 内部调用
 * findChannelEntry，未列入清单的服务器会返回 skip/session，因此重连非 channel
 * MCP 服务器只多一次 feature flag 检查。
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
 * 根据 outputFormat 以正确格式输出错误消息。
 * 使用 stream-json 时将 JSON 写入 stdout，否则将纯文本写入 stderr。
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
 * 从消息数组中移除被中断的用户消息及其合成 assistant 哨兵。
 * gateway 触发重启时用于清理消息历史，再将中断的提示词重新入队。
 *
 * @internal 导出供测试使用。
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: UserMessage,
): void {
  const idx = messages.findIndex((m) => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // 移除用户消息及紧随其后的哨兵；若 idx 已是末尾元素，splice 也能安全处理。
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
  // 处理 print 模式下的 continue。
  if (options.continue) {
    try {
      logEvent('zy_continue_print', {})

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* file path */,
      )
      if (result) {
        // 让 coordinator 模式与恢复会话的模式保持一致。
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(result.mode)
          if (warning) {
            process.stderr.write(`${warning}\n`)
            // 刷新 agent 定义以反映模式切换。
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

        // 复用已恢复会话的 ID。
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

        // 恢复会话元数据，以便退出时由 reAppendSessionMetadata 重新追加。
        restoreSessionMetadata(
          options.forkSession ? { ...result, worktreeSession: undefined } : result,
        )

        // 为已恢复会话写入模式条目。
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

  // 处理 print 模式下的 teleport。
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

  // 处理 print 模式下的 resume（接受会话 ID 或 URL）。
  // URL 仅供内部使用。
  if (options.resume) {
    try {
      logEvent('zy_resume_print', {})

      // print 模式要求提供有效的会话 ID、JSONL 文件或 URL。
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

      // 加载前先从远端填充本地会话记录。
      if (isEnvTruthy(process.env.ZY_CODE_)) {
        // 填充时一并等待恢复完成，使 SSE 追赶写入恢复后的状态，而非全新默认状态。
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
        // v1：从 Session Ingress 获取会话日志。
        await hydrateRemoteSession(parsedSessionId.sessionId, parsedSessionId.ingressUrl)
      }

      // 使用指定会话 ID 加载对话。
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile || undefined,
      )

      // hydrateFromCCRv2InternalEvents 会为新会话写入空的会话记录文件
      //（零事件时执行 writeFile(sessionFile, '')），因此 loadConversationForResume
      // 返回 {messages: []} 而非 null。空记录应与 null 同等处理，确保仍触发 SessionStart。
      if (!result || result.messages.length === 0) {
        // 通过 URL 或 CCR v2 恢复时，若填充结果为空则从空会话开始。
        if (parsedSessionId.isUrl || isEnvTruthy(process.env.ZY_CODE_)) {
          // 当前实际启动的是新会话，因此执行 SessionStart hooks。
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

      // 处理 resumeSessionAt 功能。
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

      // 让 coordinator 模式与恢复会话的模式保持一致。
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          process.stderr.write(`${warning}\n`)
          // 刷新 agent 定义以反映模式切换。
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

      // 复用已恢复会话的 ID。
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

      // 恢复会话元数据，以便退出时由 reAppendSessionMetadata 重新追加。
      restoreSessionMetadata(
        options.forkSession ? { ...result, worktreeSession: undefined } : result,
      )

      // 为已恢复会话写入模式条目。
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

  // 等待 main.tsx 启动的 SessionStart hooks promise；若尚未启动则重新执行。
  // 例如 --continue 找不到既有会话时会进入此处，而 main.tsx 对 continue 有防护，
  // 此时 sessionStartHooksPromise 为 undefined。
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
      // 统一转换为流式输入。
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
      // 空字符串对应空流。
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  // 提供 sdkUrl 时使用 RemoteIO，否则使用普通 StructuredIO。
  return options.sdkUrl
    ? new RemoteIO(options.sdkUrl, inputStream, options.replayUserMessages)
    : new StructuredIO(inputStream, options.replayUserMessages)
}

/**
 * 处理意外收到的权限响应：在会话记录中查找未解决的工具调用，并将其入队执行。
 *
 * 权限已入队时返回 true，否则返回 false。
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

    // 防止重复处理同一个孤立 tool_use。若无此防护，重复送达的 control_response
    //（例如 WebSocket 重连造成）会使同一工具执行多次，在消息数组中生成重复的
    // tool_use ID 并引发 API 400 错误；一旦损坏，每次重试还会继续累积重复项。
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
 * 将进程传输配置转换为带作用域的配置。
 * 两种类型在结构上兼容，只需补充 scope。
 */
function toScopedConfig(config: McpServerConfigForProcessTransport): ScopedMcpServerConfig {
  // McpServerConfigForProcessTransport 是 McpServerConfig 的子集，
  // 不包含 sse-ide、ws-ide 等 IDE 专用类型；补充 scope 后即可成为有效的
  // ScopedMcpServerConfig。
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

/**
 * 运行于 SDK 进程中的 MCP 服务器状态。
 */
export type WireMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/**
 * handleMcpSetServers 的结果，包含新状态和响应数据。
 */
export type McpSetServersResult = {
  response: WireControlMcpSetServersResponse
  newWireState: WireMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

/**
 * 处理 mcp_set_servers 请求，同时涵盖 SDK 服务器和基于进程的服务器。
 * SDK 服务器运行在 SDK 进程中；基于进程的服务器由 CLI 启动。
 *
 * 应用企业 allowedMcpServers/deniedMcpServers 策略，与 --mcp-config 使用同一过滤器
 *（参见 main.tsx 对 filterMcpServersByPolicy 的调用）。若无此处理，SDK V2
 * Query.setMcpServers() 会成为另一条绕过策略的路径。被阻止的服务器会写入
 * response.errors，让 SDK 使用方了解未添加的原因。
 */
export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: WireMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  // 对基于进程的服务器（stdio/http/sse）强制执行企业 MCP 策略。
  // 与 main.tsx 中的 --mcp-config 过滤一致，两条用户可控注入路径必须采用同一门控。
  // type:'sdk' 的服务器不受此限（由 SDK 管理，CLI 不会为其启动进程或建立连接；
  // 参见 filterMcpServersByPolicy 的 JSDoc）。被阻止的服务器会写入 response.errors，
  // 让 SDK 调用方了解原因。
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  const policyErrors: Record<string, string> = {}
  for (const name of blocked) {
    policyErrors[name] = 'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  // 分离 SDK 服务器与基于进程的服务器。
  const sdkServers: Record<string, McpSdkServerConfig> = {}
  const processServers: Record<string, McpServerConfigForProcessTransport> = {}

  for (const [name, config] of Object.entries(allowedServers)) {
    if (config.type === 'sdk') {
      sdkServers[name] = config
    } else {
      processServers[name] = config
    }
  }

  // 处理 SDK 服务器。
  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

  // 移除目标状态中已不存在的 SDK 服务器。
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

  // 以 pending 状态添加新的 SDK 服务器；下次查询运行 updateSdkMcp() 时，
  // 它们会升级为 connected。
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

  // 处理基于进程的服务器。
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
 * 将当前动态 MCP 服务器集合与新的目标状态对齐，处理新增、移除及配置变更。
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

  // 检查同名服务器的配置是否发生变化。
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

  // 移除旧服务器，包括即将被替换的服务器。
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
      // 清除记忆化缓存。
      await clearServerCache(name, config)
    }

    // 移除此服务器提供的工具。
    const prefix = `mcp__${name}__`
    newTools = newTools.filter((t) => !t.name.startsWith(prefix))

    // 从客户端列表移除。
    newClients = newClients.filter((c) => c.name !== name)

    // 记录真正的移除；替换不计入其中。
    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  // 添加新服务器，包括替换项。
  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) {
      continue
    }
    const scopedConfig = toScopedConfig(config)

    // SDK 服务器由 SDK 进程而非 CLI 管理；这里只记录，不尝试连接。
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

  // 构建新配置。
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

  // 使用新工具更新 AppState。
  setAppState((prev) => {
    // 获取所有动态服务器名称，包括现有项和新增项。
    const allDynamicServerNames = new Set([
      ...Object.keys(currentState.configs),
      ...Object.keys(newConfigs),
    ])

    // 移除旧的动态工具。
    const nonDynamicTools = prev.mcp.tools.filter((t) => {
      for (const serverName of allDynamicServerNames) {
        if (t.name.startsWith(`mcp__${serverName}__`)) {
          return false
        }
      }
      return true
    })

    // 移除旧的动态客户端。
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
