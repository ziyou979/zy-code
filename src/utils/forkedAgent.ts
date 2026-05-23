/**
 * 用于运行分叉代理查询循环并跟踪用量的辅助工具。
 *
 * 此工具确保分叉代理：
 * 1. 与父级共享相同的缓存关键参数，以保证提示词缓存命中
 * 2. 在整个查询循环中跟踪完整的用量指标
 * 3. 完成时通过 zy_fork_agent_query 事件记录指标
 * 4. 隔离可变状态，防止干扰主代理循环
 */

import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { PromptCommand } from '../commands.js'
import type { QuerySource } from '../constants/querySource.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { query } from '../query.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { accumulateUsage, updateUsage } from '../services/api/usageTracker.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../services/api/logging.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { AgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createChildAbortController } from './abortController.js'
import { logForDebugging } from './debug.js'
import { cloneFileStateCache } from './fileStateCache.js'
import type { REPLHookContext } from './hooks/postSamplingHooks.js'
import { createUserMessage, extractTextContent, getLastAssistantMessage } from './messages.js'
import { createDenialTrackingState } from './permissions/denialTracking.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { recordSidechainTranscript } from './sessionStorage.js'
import type { SystemPrompt } from './systemPromptType.js'
import { type ContentReplacementState, cloneContentReplacementState } from './toolResultStorage.js'
import { createAgentId } from './uuid.js'

/**
 * 分叉与父 API 请求之间必须相同的参数，以共享
 * 父级的提示词缓存。Anthropic API 缓存键由以下部分组成：
 * 系统提示词、工具、模型、消息（前缀）和思考配置。
 *
 * CacheSafeParams 携带前五项。思考配置派生自
 * 继承的 toolUseContext.options.thinkingConfig——但如果分叉
 * 设置了 maxOutputTokens，可能会无意中更改它，后者会在
 * zy.ts 中钳制 budget_tokens（仅对不使用自适应思考的旧模型）。
 * 参见 ForkedAgentParams 上 maxOutputTokens 的文档。
 */
export type CacheSafeParams = {
  /** 系统提示词 - 必须与父级匹配才能缓存命中 */
  systemPrompt: SystemPrompt
  /** 用户上下文 - 前置添加到消息，影响缓存 */
  userContext: { [k: string]: string }
  /** 系统上下文 - 附加到系统提示词，影响缓存 */
  systemContext: { [k: string]: string }
  /** 包含工具、模型和其他选项的工具使用上下文 */
  toolUseContext: ToolUseContext
  /** 用于提示词缓存共享的父级上下文消息 */
  forkContextMessages: Message[]
}

// 由 handleStopHooks 在每轮后写入的槽位，以便轮后分叉
//（promptSuggestion、postTurnSummary、/btw）共享主循环的
// 提示词缓存，而无需每个调用者传递参数。
let lastCacheSafeParams: CacheSafeParams | null = null

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
}

export type ForkedAgentParams = {
  /** 启动分叉查询循环的消息 */
  promptMessages: Message[]
  /** 必须与父级查询匹配的缓存安全参数 */
  cacheSafeParams: CacheSafeParams
  /** 分叉代理的权限检查函数 */
  canUseTool: CanUseToolFn
  /** 用于跟踪的来源标识符 */
  querySource: QuerySource
  /** 分析用标签（如 'session_memory'、'supervisor'） */
  forkLabel: string
  /** 子代理上下文的可选覆盖（如设置阶段的 readFileState） */
  overrides?: SubagentContextOverrides
  /**
   * 输出 token 的可选上限。注意：设置此项会同时更改 max_tokens
   * 和 budget_tokens（通过 zy.ts 中的钳制）。如果分叉使用 cacheSafeParams
   * 共享父级的提示词缓存，不同的 budget_tokens 会使缓存失效——
   * 思考配置是缓存键的一部分。仅在不以缓存共享为目标时
   * 设置此项（例如 compact 摘要）。
   */
  maxOutputTokens?: number
  /** 轮次（API 往返）数量的可选上限 */
  maxTurns?: number
  /** 每条消息到达时调用的可选回调（用于流式 UI） */
  onMessage?: (message: Message) => void
  /** 跳过 sidechain 转录记录（如用于 speculation 等临时工作） */
  skipTranscript?: boolean
  /** 跳过在最后一条消息上写入新的提示词缓存条目。用于
   *  即发即忘的分叉，未来没有请求会此前缀读取。 */
  skipCacheWrite?: boolean
}

export type ForkedAgentResult = {
  /** 查询循环中生成的所有消息 */
  messages: Message[]
  /** 循环中所有 API 调用的累计用量 */
  totalUsage: NonNullableUsage
}

/**
 * 从 REPLHookContext 创建 CacheSafeParams。
 * 在从后采样钩子上下文分叉时使用此辅助工具。
 *
 * 要覆盖特定字段（如带克隆文件状态的 toolUseContext），
 * 展开结果并覆盖：`{ ...createCacheSafeParams(context), toolUseContext: clonedContext }`
 *
 * @param context - 来自后采样钩子的 REPLHookContext
 */
export function createCacheSafeParams(context: REPLHookContext): CacheSafeParams {
  return {
    systemPrompt: context.systemPrompt,
    userContext: context.userContext,
    systemContext: context.systemContext,
    toolUseContext: context.toolUseContext,
    forkContextMessages: context.messages,
  }
}

/**
 * 创建一个修改后的 getAppState，将允许的工具添加到权限上下文中。
 * 分叉技能/命令执行使用此来授予工具权限。
 */
export function createGetAppStateWithAllowedTools(
  baseGetAppState: ToolUseContext['getAppState'],
  allowedTools: string[],
): ToolUseContext['getAppState'] {
  if (allowedTools.length === 0) {
    return baseGetAppState
  }
  return () => {
    const appState = baseGetAppState()
    return {
      ...appState,
      toolPermissionContext: {
        ...appState.toolPermissionContext,
        alwaysAllowRules: {
          ...appState.toolPermissionContext.alwaysAllowRules,
          command: [
            ...new Set([
              ...(appState.toolPermissionContext.alwaysAllowRules.command || []),
              ...allowedTools,
            ]),
          ],
        },
      },
    }
  }
}

/**
 * 准备分叉命令上下文的结果。
 */
export type PreparedForkedContext = {
  /** 已替换参数的技能内容 */
  skillContent: string
  /** 带有允许工具的修改后的 getAppState */
  modifiedGetAppState: ToolUseContext['getAppState']
  /** 要使用的通用代理 */
  baseAgent: AgentDefinition
  /** 初始提示词消息 */
  promptMessages: Message[]
}

/**
 * 准备执行分叉命令/技能的上下文。
 * 这处理 SkillTool 和斜杠命令都需要的公共设置。
 */
export async function prepareForkedCommandContext(
  command: PromptCommand,
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  // 获取已替换 $ARGUMENTS 的技能内容
  const skillPrompt = await command.getPromptForCommand(args, context)
  const skillContent = skillPrompt
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')

  // 解析并准备允许的工具
  const allowedTools = parseToolListFromCLI(command.allowedTools ?? [])

  // 创建带有允许工具的修改后的上下文
  const modifiedGetAppState = createGetAppStateWithAllowedTools(context.getAppState, allowedTools)

  // 如果指定了 command.agent 则使用，否则使用 'general-purpose'
  const agentTypeName = command.agent ?? 'general-purpose'
  const agents = context.options.agentDefinitions.activeAgents
  const baseAgent =
    agents.find((a) => a.agentType === agentTypeName) ??
    agents.find((a) => a.agentType === 'general-purpose') ??
    agents[0]

  if (!baseAgent) {
    throw new Error('No agent available for forked execution')
  }

  // 准备提示词消息
  const promptMessages = [createUserMessage({ content: skillContent })]

  return {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages,
  }
}

/**
 * 从代理消息中提取结果文本。
 */
export function extractResultText(
  agentMessages: Message[],
  defaultText = 'Execution completed',
): string {
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (!lastAssistantMessage) {
    return defaultText
  }

  const content = Array.isArray(lastAssistantMessage.message.content)
    ? lastAssistantMessage.message.content
    : []
  const textContent = extractTextContent(content, '\n')

  return textContent || defaultText
}

/**
 * 创建子代理上下文的选项。
 *
 * 默认情况下，所有可变状态都是隔离的，以防止干扰父级。
 * 使用这些选项来：
 * - 覆盖特定字段（如自定义选项、agentId、消息）
 * - 显式选择共享特定回调（用于交互式子代理）
 */
export type SubagentContextOverrides = {
  /** 覆盖 options 对象（如自定义工具、模型） */
  options?: ToolUseContext['options']
  /** 覆盖 agentId（用于有自己 ID 的子代理） */
  agentId?: AgentId
  /** 覆盖 agentType（用于有特定类型的子代理） */
  agentType?: string
  /** 覆盖 messages 数组 */
  messages?: Message[]
  /** 覆盖 readFileState（如用新缓存而非克隆） */
  readFileState?: ToolUseContext['readFileState']
  /** 覆盖 abortController */
  abortController?: AbortController
  /** 覆盖 getAppState 函数 */
  getAppState?: ToolUseContext['getAppState']

  /**
   * 显式选择共享父级的 setAppState 回调。
   * 用于需要更新共享状态的交互式子代理。
   * @default false（隔离的无操作）
   */
  shareSetAppState?: boolean
  /**
   * 显式选择共享父级的 setResponseLength 回调。
   * 用于对父级响应指标有贡献的子代理。
   * @default false（隔离的无操作）
   */
  shareSetResponseLength?: boolean
  /**
   * 显式选择共享父级的 abortController。
   * 用于应与父级一起中止的交互式子代理。
   * 注意：仅当未提供 abortController 覆盖时适用。
   * @default false（链接到父级的新控制器）
   */
  shareAbortController?: boolean
  /** 要在每个用户轮次重新注入的关键系统提醒 */
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 为 true 时，即使钩子自动批准也必须始终调用 canUseTool。
   *  speculation 使用此项进行覆盖文件路径重写。 */
  requireCanUseTool?: boolean
  /** 覆盖替换状态 — resumeAgentBackground 使用此项传递
   * 从恢复的 sidechain 重建的状态，以便相同的结果
   * 被重新替换（提示词缓存稳定性）。 */
  contentReplacementState?: ContentReplacementState
}

/**
 * 为子代理创建隔离的 ToolUseContext。
 *
 * 默认情况下，所有可变状态都是隔离的以防止干扰：
 * - readFileState：从父级克隆
 * - abortController：链接到父级的新控制器（父级中止会传播）
 * - getAppState：包装以设置 shouldAvoidPermissionPrompts
 * - 所有变异回调（setAppState 等）：无操作
 * - 新的集合：nestedMemoryAttachmentTriggers、toolDecisions
 *
 * 调用者可以：
 * - 通过 overrides 参数覆盖特定字段
 * - 显式选择共享特定回调（shareSetAppState 等）
 *
 * @param parentContext - 用于创建子代理上下文的父级 ToolUseContext
 * @param overrides - 可选的覆盖和共享选项
 *
 * @example
 * // 完全隔离（用于会话内存等后台代理）
 * const ctx = createSubagentContext(parentContext)
 *
 * @example
 * // 自定义选项和 agentId（用于 AgentTool 异步代理）
 * const ctx = createSubagentContext(parentContext, {
 *   options: customOptions,
 *   agentId: newAgentId,
 *   messages: initialMessages,
 * })
 *
 * @example
 * // 共享部分状态的交互式子代理
 * const ctx = createSubagentContext(parentContext, {
 *   options: customOptions,
 *   agentId: newAgentId,
 *   shareSetAppState: true,
 *   shareSetResponseLength: true,
 *   shareAbortController: true,
 * })
 */
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  // 确定 abortController：显式覆盖 > 共享父级 > 新建子级
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController))

  // 确定 getAppState - 包装以设置 shouldAvoidPermissionPrompts，除非共享 abortController
  //（如果共享 abortController，则是可以显示 UI 的交互式代理）
  const getAppState: ToolUseContext['getAppState'] = overrides?.getAppState
    ? overrides.getAppState
    : overrides?.shareAbortController
      ? parentContext.getAppState
      : () => {
          const state = parentContext.getAppState()
          if (state.toolPermissionContext.shouldAvoidPermissionPrompts) {
            return state
          }
          return {
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              shouldAvoidPermissionPrompts: true,
            },
          }
        }

  return {
    // 可变状态 - 默认克隆以保持隔离
    // 如果提供了 overrides.readFileState 则克隆它，否则从父级克隆
    readFileState: cloneFileStateCache(overrides?.readFileState ?? parentContext.readFileState),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    // 每个子代理：跟踪发现暴露的技能用于 was_discovered 遥测（SkillTool.ts:116）
    discoveredSkillNames: new Set<string>(),
    toolDecisions: undefined,
    // 预算决策：覆盖 > 克隆父级 > undefined（功能关闭）。
    //
    // 默认克隆（非新建）：缓存共享分叉处理包含
    // 父级 tool_use_ids 的父级消息。新建状态会将它们
    // 视为未见并做出不同的替换决策 → 传输前缀不同
    // → 缓存未命中。克隆做出相同的决策 → 缓存命中。
    // 对于非分叉子代理，父级 UUID 永远不会匹配——
    // 克隆是无害的无操作。
    //
    // 覆盖：AgentTool resume（从 sidechain 记录重建）
    // 和 inProcessRunner（每个队友的持久循环状态）。
    contentReplacementState:
      overrides?.contentReplacementState ??
      (parentContext.contentReplacementState
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined),

    // 中止控制器
    abortController,

    // AppState 访问
    getAppState,
    setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {},
    // 任务注册/终止必须始终到达根存储，即使
    // setAppState 是无操作——否则异步代理的后台 bash 任务
    // 永远不会被注册和终止（PPID=1 僵尸进程）。
    setAppStateForTasks: parentContext.setAppStateForTasks ?? parentContext.setAppState,
    // 异步子代理的 setAppState 为无操作时，需要本地的拒绝跟踪状态，
    // 以便拒绝计数器在重试时能够正确累积。
    localDenialTracking: overrides?.shareSetAppState
      ? parentContext.localDenialTracking
      : createDenialTrackingState(),

    // 变更回调——默认为无操作
    setInProgressToolUseIDs: () => {},
    setResponseLength: overrides?.shareSetResponseLength
      ? parentContext.setResponseLength
      : () => {},
    updateFileHistoryState: () => {},
    // 归属范围限定且功能化（prev => next）——即使
    // setAppState 被存根化也可以安全共享。并发调用通过 React 状态队列组合。
    updateAttributionState: parentContext.updateAttributionState,

    // UI 回调——子代理为 undefined（无法控制父级 UI）
    addNotification: undefined,
    setToolJSX: undefined,
    setStreamMode: undefined,
    setSDKStatus: undefined,
    openMessageSelector: undefined,

    // 可被覆盖或从父级复制的字段
    options: overrides?.options ?? parentContext.options,
    messages: overrides?.messages ?? parentContext.messages,
    // 为子代理生成新的 agentId（每个子代理应有自己的 ID）
    agentId: overrides?.agentId ?? createAgentId(),
    agentType: overrides?.agentType,

    // 为子代理创建新的查询跟踪链，深度递增
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,
    },
    fileReadingLimits: parentContext.fileReadingLimits,
    userModified: parentContext.userModified,
    criticalSystemReminder_EXPERIMENTAL: overrides?.criticalSystemReminder_EXPERIMENTAL,
    requireCanUseTool: overrides?.requireCanUseTool,
  }
}

/**
 * 运行分叉代理查询循环并跟踪缓存命中指标。
 *
 * 此函数：
 * 1. 使用与父级相同的缓存安全参数以启用提示词缓存
 * 2. 累积所有查询迭代的用量
 * 3. 完成时记录 zy_fork_agent_query 及完整用量
 *
 * @example
 * ```typescript
 * const result = await runForkedAgent({
 *   promptMessages: [createUserMessage({ content: userPrompt })],
 *   cacheSafeParams: {
 *     systemPrompt,
 *     userContext,
 *     systemContext,
 *     toolUseContext: clonedToolUseContext,
 *     forkContextMessages: messages,
 *   },
 *   canUseTool,
 *   querySource: 'session_memory',
 *   forkLabel: 'session_memory',
 * })
 * ```
 */
export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,
  canUseTool,
  querySource,
  forkLabel,
  overrides,
  maxOutputTokens,
  maxTurns,
  onMessage,
  skipTranscript,
  skipCacheWrite,
}: ForkedAgentParams): Promise<ForkedAgentResult> {
  const startTime = Date.now()
  const outputMessages: Message[] = []
  let totalUsage: NonNullableUsage = { ...EMPTY_USAGE }

  const { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages } =
    cacheSafeParams

  // 创建隔离上下文以防止修改父级状态
  const isolatedToolUseContext = createSubagentContext(toolUseContext, overrides)

  // 此处不要过滤 incompleteToolCalls——它会在部分工具批次时丢弃整个 assistant，
  // 导致配对的 tool_result 成为孤儿（API 400）。悬空的 tool_uses 会在下游
  // 由 zy.ts 中的 ensureToolResultPairing 修复，与主线程相同——
  // 修复后的前缀一致，保持缓存命中。
  const initialMessages: Message[] = [...forkContextMessages, ...promptMessages]

  // 生成 agent ID 并记录初始消息用于转录
  // 设置 skipTranscript 时，跳过 agent ID 创建和所有转录 I/O
  const agentId = skipTranscript ? undefined : createAgentId(forkLabel)
  let lastRecordedUuid: UUID | null = null
  if (agentId) {
    await recordSidechainTranscript(initialMessages, agentId).catch((err) =>
      logForDebugging(`Forked agent [${forkLabel}] failed to record initial transcript: ${err}`),
    )
    // 跟踪最后记录的消息 UUID 用于父级链连续性
    lastRecordedUuid =
      initialMessages.length > 0 ? (initialMessages[initialMessages.length - 1]!.uuid as any) : null
  }

  // 使用隔离上下文运行查询循环（保留缓存安全参数）
  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool,
      toolUseContext: isolatedToolUseContext,
      querySource,
      maxOutputTokensOverride: maxOutputTokens,
      maxTurns,
      skipCacheWrite,
    })) {
      // 从 message_delta 流事件中提取真实用量（每次 API 调用的最终用量）
      if (message.type === 'stream_event') {
        if ('event' in message && message.event?.type === 'message_delta' && message.event.usage) {
          const turnUsage = updateUsage({ ...EMPTY_USAGE }, message.event.usage as any)
          totalUsage = accumulateUsage(totalUsage, turnUsage)
        }
        continue
      }
      if (message.type === 'stream_request_start') {
        continue
      }

      logForDebugging(`Forked agent [${forkLabel}] received message: type=${message.type}`)

      outputMessages.push(message as Message)
      onMessage?.(message as Message)

      // 记录可记录消息类型的转录（与 runAgent.ts 相同的模式）
      const msg = message as Message
      if (agentId && (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'progress')) {
        await recordSidechainTranscript([msg], agentId, lastRecordedUuid).catch((err) =>
          logForDebugging(`Forked agent [${forkLabel}] failed to record transcript: ${err}`),
        )
        if (msg.type !== 'progress') {
          lastRecordedUuid = msg.uuid as any
        }
      }
    }
  } finally {
    // 释放克隆的文件状态缓存内存（与 runAgent.ts 相同的模式）
    isolatedToolUseContext.readFileState.clear()
    // 释放克隆的分叉上下文消息
    initialMessages.length = 0
  }

  logForDebugging(
    `Forked agent [${forkLabel}] finished: ${outputMessages.length} messages, types=[${outputMessages.map((m) => m.type).join(', ')}], totalUsage: input=${totalUsage.inputTokens} output=${totalUsage.outputTokens} cacheRead=${totalUsage.cacheReadInputTokens} cacheCreate=${totalUsage.cacheCreationInputTokens}`,
  )

  const durationMs = Date.now() - startTime

  // 记录分叉查询指标，包含完整的 NonNullableUsage
  logForkAgentQueryEvent({
    forkLabel,
    querySource,
    durationMs,
    messageCount: outputMessages.length,
    totalUsage,
    queryTracking: toolUseContext.queryTracking,
  })

  return {
    messages: outputMessages,
    totalUsage,
  }
}

/**
 * 记录 zy_fork_agent_query 事件，包含完整的 NonNullableUsage 字段。
 */
function logForkAgentQueryEvent({
  forkLabel,
  querySource,
  durationMs,
  messageCount,
  totalUsage,
  queryTracking,
}: {
  forkLabel: string
  querySource: QuerySource
  durationMs: number
  messageCount: number
  totalUsage: NonNullableUsage
  queryTracking?: { chainId: string; depth: number }
}): void {
  // 计算缓存命中率
  const totalInputTokens =
    totalUsage.inputTokens + totalUsage.cacheCreationInputTokens + totalUsage.cacheReadInputTokens
  const cacheHitRate = totalInputTokens > 0 ? totalUsage.cacheReadInputTokens / totalInputTokens : 0

  logEvent('zy_fork_agent_query', {
    // 元数据
    forkLabel: forkLabel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    durationMs,
    messageCount,

    // NonNullableUsage 字段
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cacheReadInputTokens: totalUsage.cacheReadInputTokens,
    cacheCreationInputTokens: totalUsage.cacheCreationInputTokens,
    serviceTier: (totalUsage as any)
      .service_tier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    cacheCreationEphemeral1hTokens: (totalUsage as any).cache_creation?.ephemeral_1h_input_tokens,
    cacheCreationEphemeral5mTokens: (totalUsage as any).cache_creation?.ephemeral_5m_input_tokens,

    // 派生指标
    cacheHitRate,

    // 查询跟踪
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
  })
}
