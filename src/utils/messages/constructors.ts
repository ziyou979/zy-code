import { randomUUID, type UUID } from 'node:crypto'
import type { WireAssistantMessageError } from 'src/types/index.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { AnyObject, Progress, Tool } from '../../Tool.js'
import type {
  APIErrorLike,
  AssistantContentBlock,
  TokenUsage,
  ToolResultBlock,
  TokenUsage as Usage,
  UserContentBlock,
} from '../../types/llm.js'
import type {
  AssistantMessage,
  MessageOrigin,
  PartialCompactDirection,
  ProgressMessage,
  StopHookInfo,
  SystemAgentsKilledMessage,
  SystemAPIErrorMessage,
  SystemAwaySummaryMessage,
  SystemBridgeStatusMessage,
  SystemCompactBoundaryMessage,
  SystemInformationalMessage,
  SystemLocalCommandMessage,
  SystemMemorySavedMessage,
  SystemMessageLevel,
  SystemMicrocompactBoundaryMessage,
  SystemPermissionRetryMessage,
  SystemScheduledTaskFireMessage,
  SystemStopHookSummaryMessage,
  SystemTurnDurationMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { logForDebugging } from '../debug.js'
import { formatTokens } from '../format.js'
import { jsonStringify } from '../slowOperations.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  SYNTHETIC_MODEL,
} from './constants.js'
import { deriveUUID } from './predicates.js'

function baseCreateAssistantMessage({
  content,
  isApiErrorMessage = false,
  apiError,
  error,
  errorDetails,
  isVirtual,
  usage = {
    inputTokens: 0,
    outputTokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  } as TokenUsage,
}: {
  content: AssistantContentBlock[]
  isApiErrorMessage?: boolean
  apiError?: AssistantMessage['apiError']
  error?: WireAssistantMessageError
  errorDetails?: string
  isVirtual?: true
  usage?: Usage
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: SYNTHETIC_MODEL,
      role: 'assistant',
      stopReason: 'end_turn',
      usage,
      content,
      context_management: null,
    },
    requestId: undefined,
    apiError,
    error,
    errorDetails,
    isApiErrorMessage,
    isVirtual,
  }
}

export function createAssistantMessage({
  content,
  usage,
  isVirtual,
}: {
  content: string | AssistantContentBlock[]
  usage?: Usage
  isVirtual?: true
}): AssistantMessage {
  return baseCreateAssistantMessage({
    usage,
    content:
      typeof content === 'string'
        ? [
            {
              type: 'text' as const,
              text: content === '' ? NO_CONTENT_MESSAGE : content,
            } as AssistantContentBlock,
          ]
        : content,
    isVirtual,
  })
}

export function createAssistantAPIErrorMessage({
  content,
  apiError,
  error,
  errorDetails,
}: {
  content: string
  apiError?: AssistantMessage['apiError']
  error?: WireAssistantMessageError
  errorDetails?: string
}): AssistantMessage {
  return baseCreateAssistantMessage({
    content: [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
      } as AssistantContentBlock,
    ],
    isApiErrorMessage: true,
    apiError,
    error,
    errorDetails,
  })
}

export function createUserMessage({
  content,
  isMeta,
  isVisibleInTranscriptOnly,
  isVirtual,
  isCompactSummary,
  summarizeMetadata,
  toolUseResult,
  mcpMeta,
  uuid,
  timestamp,
  imagePasteIds,
  sourceToolAssistantUUID,
  permissionMode,
  origin,
}: {
  content: UserContentBlock[]
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  uuid?: UUID | string
  timestamp?: string
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  origin?: MessageOrigin
}): UserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: content.length > 0 ? content : [{ type: 'text', text: NO_CONTENT_MESSAGE }],
    },
    isMeta,
    isVisibleInTranscriptOnly,
    isVirtual,
    isCompactSummary,
    summarizeMetadata,
    uuid: (uuid as UUID | undefined) || randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    toolUseResult,
    mcpMeta,
    imagePasteIds,
    sourceToolAssistantUUID,
    permissionMode,
    origin,
  }
}

export function prepareUserContent({
  inputString,
  precedingInputBlocks,
}: {
  inputString: string
  precedingInputBlocks: UserContentBlock[]
}): UserContentBlock[] {
  if (precedingInputBlocks.length === 0) {
    return [{ type: 'text', text: inputString }]
  }

  return [
    ...precedingInputBlocks,
    {
      text: inputString,
      type: 'text' as const,
    },
  ]
}

/**
 * 将输入字符串立即转为 TextBlock 数组（入口归一化）。
 * 与 prepareUserContent 不同，此函数始终返回 UserContentBlock[]，
 * 确保消息创建即为标准形态，无需下游 normalize 补救。
 */
export function prepareUserContentBlocks({
  inputString,
  precedingInputBlocks,
}: {
  inputString: string
  precedingInputBlocks: UserContentBlock[]
}): UserContentBlock[] {
  return [
    ...precedingInputBlocks,
    {
      text: inputString,
      type: 'text' as const,
    },
  ]
}

export function createUserInterruptionMessage({
  toolUse = false,
}: {
  toolUse?: boolean
}): UserMessage {
  const content = toolUse ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE

  return createUserMessage({
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  })
}

/**
 * 为本地命令（bash、slash）创建合成用户警告消息。
 * 每次必须新建，因为 uuid 须唯一。
 */
export function createSyntheticUserCaveatMessage(): UserMessage {
  return createUserMessage({
    content: [
      {
        type: 'text' as const,
        text: `<${LOCAL_COMMAND_CAVEAT_TAG}>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
      },
    ],
    isMeta: true,
  })
}

export function formatCommandInputTags(commandName: string, args: string): string {
  return `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>`
}

/**
 * 构建 SDK set_model 控制处理器注入的面包屑追踪，
 * 让模型可见会话中的切换。形状与 CLI 的 /model 命令一致。
 */
export function createModelSwitchBreadcrumbs(
  modelArg: string,
  resolvedDisplay: string,
): UserMessage[] {
  return [
    createSyntheticUserCaveatMessage(),
    createUserMessage({
      content: [{ type: 'text' as const, text: formatCommandInputTags('model', modelArg) }],
    }),
    createUserMessage({
      content: [
        {
          type: 'text' as const,
          text: `<${LOCAL_COMMAND_STDOUT_TAG}>Set model to ${resolvedDisplay}</${LOCAL_COMMAND_STDOUT_TAG}>`,
        },
      ],
    }),
  ]
}

export function createProgressMessage<P extends Progress>({
  toolUseID,
  parentToolUseID,
  data,
  index = 0,
}: {
  toolUseID: string
  parentToolUseID: string
  data: P
  index?: number
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: deriveUUID(toolUseID, index),
    timestamp: new Date().toISOString(),
  }
}

export function createToolResultStopMessage(toolUseID: string): ToolResultBlock {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    isError: true,
    toolCallId: toolUseID,
  }
}

export function createToolResultMessage<Output>(
  tool: Tool<AnyObject, Output>,
  toolUseResult: Output,
): UserMessage {
  try {
    const result = tool.mapToolResultToToolResultBlock(toolUseResult, '1')

    if (Array.isArray(result.content) && result.content.some((block) => block.type === 'image')) {
      return createUserMessage({
        content: result.content as UserContentBlock[],
        isMeta: true,
      })
    }

    // 对于字符串内容，使用原始字符串 — jsonStringify 会转义 \n→\\n，
    // 每行浪费约 1 token（2000 行 @-file 浪费约 1000 token）。
    // 结构重要的数组/对象保留 jsonStringify。
    const contentStr =
      typeof result.content === 'string' ? result.content : jsonStringify(result.content)
    return createUserMessage({
      content: [
        { type: 'text' as const, text: `Result of calling the ${tool.name} tool:\n${contentStr}` },
      ],
      isMeta: true,
    })
  } catch {
    return createUserMessage({
      content: [{ type: 'text' as const, text: `Result of calling the ${tool.name} tool: Error` }],
      isMeta: true,
    })
  }
}

export function createToolUseMessage(
  toolName: string,
  input: { [key: string]: string | number },
): UserMessage {
  return createUserMessage({
    content: [
      {
        type: 'text' as const,
        text: `Called the ${toolName} tool with the following input: ${jsonStringify(input)}`,
      },
    ],
    isMeta: true,
  })
}

export function createSystemMessage(
  content: string,
  level: SystemMessageLevel,
  toolUseID?: string,
  preventContinuation?: boolean,
): SystemInformationalMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content,
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    toolUseID,
    level,
    ...(preventContinuation && { preventContinuation }),
  }
}

export function createPermissionRetryMessage(commands: string[]): SystemPermissionRetryMessage {
  return {
    type: 'system',
    subtype: 'permission_retry',
    content: `Allowed ${commands.join(', ')}`,
    commands,
    level: 'info',
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createWireStatusMessage(
  url: string,
  upgradeNudge?: string,
): SystemBridgeStatusMessage {
  return {
    type: 'system',
    subtype: 'bridge_status',
    content: `/remote-control is active. Code in CLI or at ${url}`,
    url,
    upgradeNudge,
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createScheduledTaskFireMessage(content: string): SystemScheduledTaskFireMessage {
  return {
    type: 'system',
    subtype: 'scheduled_task_fire',
    content,
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createStopHookSummaryMessage(
  hookCount: number,
  hookInfos: StopHookInfo[],
  hookErrors: string[],
  preventedContinuation: boolean,
  stopReason: string | undefined,
  hasOutput: boolean,
  level: SystemMessageLevel,
  toolUseID?: string,
  hookLabel?: string,
  totalDurationMs?: number,
): SystemStopHookSummaryMessage {
  return {
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount,
    hookInfos,
    hookErrors,
    preventedContinuation,
    stopReason,
    hasOutput,
    level,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    toolUseID,
    hookLabel,
    totalDurationMs,
  } as any
}

export function createTurnDurationMessage(
  durationMs: number,
  budget?: { tokens: number; limit: number; nudges: number },
  messageCount?: number,
): SystemTurnDurationMessage {
  return {
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    budgetTokens: budget?.tokens,
    budgetLimit: budget?.limit,
    budgetNudges: budget?.nudges,
    messageCount,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false as const,
  }
}

export function createAwaySummaryMessage(content: string): SystemAwaySummaryMessage {
  return {
    type: 'system',
    subtype: 'away_summary',
    content,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false as const,
  }
}

export function createMemorySavedMessage(writtenPaths: string[]): SystemMemorySavedMessage {
  return {
    type: 'system',
    subtype: 'memory_saved',
    writtenPaths,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false as const,
    teamCount: 0,
  }
}

export function createAgentsKilledMessage(): SystemAgentsKilledMessage {
  return {
    type: 'system',
    subtype: 'agents_killed',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false as const,
  }
}

export function createCommandInputMessage(content: string): SystemLocalCommandMessage {
  return {
    type: 'system',
    subtype: 'local_command',
    content,
    level: 'info',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    isMeta: false as const,
  }
}

export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  lastPreCompactMessageUuid?: UUID,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: `Conversation compacted`,
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger,
      preTokens,
      userContext,
      messagesSummarized,
    },
    ...(lastPreCompactMessageUuid && {
      logicalParentUuid: lastPreCompactMessageUuid,
    }),
  }
}

export function createMicrocompactBoundaryMessage(
  trigger: 'auto',
  preTokens: number,
  tokensSaved: number,
  compactedToolIds: string[],
  clearedAttachmentUUIDs: string[],
): SystemMicrocompactBoundaryMessage {
  logForDebugging(
    `[microcompact] saved ~${formatTokens(tokensSaved)} tokens (cleared ${compactedToolIds.length} tool results)`,
  )
  return {
    type: 'system',
    subtype: 'microcompact_boundary',
    content: 'Context microcompacted',
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    microcompactMetadata: {
      trigger,
      preTokens,
      tokensSaved,
      compactedToolIds,
      clearedAttachmentUUIDs,
    },
  }
}

export function createSystemAPIErrorMessage(
  error: APIErrorLike,
  retryInMs: number,
  retryAttempt: number,
  maxRetries: number,
): SystemAPIErrorMessage {
  return {
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    cause: (error as any).cause instanceof Error ? (error as any).cause : undefined,
    error: error as any,
    retryInMs,
    retryAttempt,
    maxRetries,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary',
    summary,
    precedingToolUseIds,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
