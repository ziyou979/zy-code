import type { UUID } from 'node:crypto'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getFileExtensionForAnalytics,
  getFileExtensionsFromBashCommand,
  isToolDetailsLoggingEnabled,
  mcpToolDetailsForAnalytics,
  sanitizeToolNameForAnalytics,
} from 'src/services/analytics/metadata.js'
import type { HookProgress } from 'src/types/hooks/index.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type Tool,
  type ToolProgress,
  type ToolProgressData,
  type ToolResult,
  type ToolUseContext,
} from '../../tools/tool.js'
import { addToToolDuration } from '../../bootstrap/runtime/runtimeContext.js'
import type { BashToolInput } from '../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { parseGitCommitId } from '../../tools/shared/gitOperationTracking.js'
import type { ContentBlock, ToolResultBlock, UserContentBlock } from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  StopHookInfo,
} from '../../types/message.js'
import type { PermissionAllowDecision } from '../../types/permissions.js'
import { count } from '../../utils/array.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import {
  AbortError,
  errorMessage,
  getErrnoCode,
  ShellError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../services/session-storage/sessionActivity.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { formatError } from '../tool-runtime/toolErrors.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../services/mcp/toolResultStorage.js'
import { createAttachmentMessage } from '../attachments/attachments.js'
import { runPostToolUseFailureHooks, runPostToolUseHooks } from './toolHooks.js'
import { logOTelEvent } from '../telemetry/events.js'
import {
  addToolContentEvent,
  endToolExecutionSpan,
  endToolSpan,
} from '../telemetry/sessionTracing.js'
import {
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../mcp/mcpShared.js'
import { getMcpServerScopeFromToolName, isMcpTool } from '../mcp/utils.js'
import { createStopHookSummaryMessage, createUserMessage } from '../messages/constructors.js'
import type { McpServerType } from './toolExecution.js'

import {
  HOOK_TIMING_DISPLAY_THRESHOLD_MS,
  recordToolContentEvent,
  getFileExtensionForToolResult,
  maybeEnrichGitCommitId,
} from './toolTelemetry.js'
import { classifyToolError } from './toolResult.js'

const toolLog = createDebugLog('tools')

export { HOOK_TIMING_DISPLAY_THRESHOLD_MS }

export type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}

export function getNextImagePasteId(messages: Message[]): number {
  let maxId = 0
  for (const message of messages) {
    if (message.type === 'user' && message.imagePasteIds) {
      for (const id of message.imagePasteIds) {
        if (id > maxId) {
          maxId = id
        }
      }
    }
  }
  return maxId + 1
}

type ToolDecisionInfo = {
  source: string
  decision: 'accept' | 'reject'
  timestamp: number
}

type ExecuteToolCallWithResultHandlingArgs = {
  assistantMessage: AssistantMessage
  callInput: { [key: string]: unknown }
  canUseTool: CanUseToolFn
  decisionInfo: ToolDecisionInfo | undefined
  messageId: string
  mcpServerBaseUrl: string | undefined
  mcpServerType: McpServerType
  onToolProgress: (progress: ToolProgress<ToolProgressData> | ProgressMessage<HookProgress>) => void
  permissionDecision: PermissionAllowDecision<{ [key: string]: unknown }>
  preToolHookDurationMs: number
  processedInput: { [key: string]: unknown }
  requestId: string | undefined
  shouldPreventContinuation: boolean
  stopReason: string | undefined
  telemetryToolInput: string | undefined
  tool: Tool
  toolParameters: Record<string, unknown>
  toolUseContext: ToolUseContext
  toolUseID: string
}

function collectHookStopInfo(message: MessageUpdateLazy['message']): StopHookInfo | null {
  if (message.type !== 'attachment') {
    return null
  }
  const attachment = message.attachment
  if (
    !('command' in attachment) ||
    attachment.command === undefined ||
    !('durationMs' in attachment) ||
    attachment.durationMs === undefined
  ) {
    return null
  }
  return {
    hookName: String(attachment.command),
    status: 'success',
    command: attachment.command as string,
    durationMs: attachment.durationMs as number,
  }
}

function applyUpdatedToolOutputOverride(
  toolResultEntry: MessageUpdateLazy | undefined,
  updatedToolOutputOverride: string | undefined,
): void {
  if (updatedToolOutputOverride === undefined || !toolResultEntry) {
    return
  }

  type ContentItem = { type?: string; content?: string | unknown[] }
  const message = toolResultEntry.message as {
    type: string
    message?: { content?: ContentItem[] }
  }
  const content = message.type === 'user' ? message.message?.content : undefined
  if (!Array.isArray(content)) {
    return
  }
  const block = content.find((item) => item?.type === 'tool_result')
  if (block) {
    block.content = updatedToolOutputOverride
  }
}

function handleMcpAuthError(toolUseContext: ToolUseContext, error: McpAuthError): void {
  toolUseContext.setAppState((prevState) => {
    const serverName = error.serverName
    const existingClientIndex = prevState.mcp.clients.findIndex(
      (client) => client.name === serverName,
    )
    if (existingClientIndex === -1) {
      return prevState
    }
    const existingClient = prevState.mcp.clients[existingClientIndex]
    if (!existingClient || existingClient.type !== 'connected') {
      return prevState
    }
    const updatedClients = [...prevState.mcp.clients]
    updatedClients[existingClientIndex] = {
      name: serverName,
      type: 'needs-auth' as const,
      config: existingClient.config,
    }
    return {
      ...prevState,
      mcp: {
        ...prevState.mcp,
        clients: updatedClients,
      },
    }
  })
}

export async function executeToolCallWithResultHandling({
  assistantMessage,
  callInput,
  canUseTool,
  decisionInfo,
  messageId,
  mcpServerBaseUrl,
  mcpServerType,
  onToolProgress,
  permissionDecision,
  preToolHookDurationMs,
  processedInput,
  requestId,
  shouldPreventContinuation,
  stopReason,
  telemetryToolInput,
  tool,
  toolParameters,
  toolUseContext,
  toolUseID,
}: ExecuteToolCallWithResultHandlingArgs): Promise<MessageUpdateLazy[]> {
  const resultingMessages: MessageUpdateLazy[] = []
  startSessionActivity('tool_exec')
  const startTime = Date.now()

  try {
    const result = await tool.call(
      callInput,
      {
        ...toolUseContext,
        toolUseId: toolUseID,
        userModified: permissionDecision.userModified ?? false,
      },
      canUseTool,
      assistantMessage,
      (progress) => {
        onToolProgress({
          toolUseID: progress.toolUseID,
          data: progress.data,
        })
      },
    )
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)
    toolLog(`${tool.name} completed ${durationMs}ms toolUseId=${toolUseID}`)

    recordToolContentEvent(tool, processedInput, result)

    if (typeof result === 'object' && 'structured_output' in result) {
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'structured_output',
          data: result.structured_output,
        }),
      })
    }

    endToolExecutionSpan({ success: true })
    const toolResultStr =
      result.data && typeof result.data === 'object'
        ? jsonStringify(result.data)
        : String(result.data ?? '')
    endToolSpan(toolResultStr)

    const mappedToolResultBlock = tool.mapToolResultToToolResultBlock(result.data, toolUseID)
    const mappedContent = mappedToolResultBlock.content
    const toolResultSizeBytes = !mappedContent
      ? 0
      : typeof mappedContent === 'string'
        ? mappedContent.length
        : jsonStringify(mappedContent).length

    const fileExtension = getFileExtensionForToolResult(tool, processedInput)

    logEvent('zy_tool_use_success', {
      messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      isMcp: tool.isMcp ?? false,
      durationMs,
      preToolHookDurationMs,
      toolResultSizeBytes,
      ...(fileExtension !== undefined && { fileExtension }),

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType: mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId: requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
    })

    maybeEnrichGitCommitId(tool, processedInput, result, toolParameters)

    const mcpServerScope = isMcpTool(tool) ? getMcpServerScopeFromToolName(tool.name) : null
    void logOTelEvent('tool_result', {
      tool_name: sanitizeToolNameForAnalytics(tool.name),
      success: 'true',
      duration_ms: String(durationMs),
      ...(Object.keys(toolParameters).length > 0 && {
        tool_parameters: jsonStringify(toolParameters),
      }),
      ...(telemetryToolInput && { tool_input: telemetryToolInput }),
      tool_result_size_bytes: String(toolResultSizeBytes),
      ...(decisionInfo && {
        decision_source: decisionInfo.source,
        decision_type: decisionInfo.decision,
      }),
      ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
    })

    let toolOutput = result.data
    const hookResults: MessageUpdateLazy[] = []
    const toolContextModifier = result.contextModifier
    const mcpMeta = result.mcpMeta

    async function addToolResult(toolUseResult: unknown, preMappedBlock?: ToolResultBlock) {
      const MCP_META_MAX_RESULT_SIZE_CAP = 500_000
      const metaMaxSize =
        typeof mcpMeta?._meta?.maxResultSizeChars === 'number' &&
        mcpMeta._meta.maxResultSizeChars > 0
          ? mcpMeta._meta.maxResultSizeChars
          : undefined
      const effectiveMaxResultSize = metaMaxSize
        ? Math.min(metaMaxSize, MCP_META_MAX_RESULT_SIZE_CAP)
        : tool.maxResultSizeChars
      if (metaMaxSize) {
        toolLog(
          `MCP _meta maxResultSizeChars override: requested=${metaMaxSize}, effective=${effectiveMaxResultSize} (cap=${MCP_META_MAX_RESULT_SIZE_CAP})`,
        )
      }

      const toolResultBlock = preMappedBlock
        ? await processPreMappedToolResultBlock(preMappedBlock, tool.name, effectiveMaxResultSize)
        : await processToolResultBlock(
            { ...tool, maxResultSizeChars: effectiveMaxResultSize },
            toolUseResult,
            toolUseID,
          )

      const contentBlocks: UserContentBlock[] = [toolResultBlock]
      if (permissionDecision.acceptFeedback) {
        contentBlocks.push({
          type: 'text',
          text: permissionDecision.acceptFeedback,
        })
      }

      const allowContentBlocks = permissionDecision.contentBlocks
      if (allowContentBlocks?.length) {
        contentBlocks.push(...(allowContentBlocks as UserContentBlock[]))
      }

      let allowImageIds: number[] | undefined
      if (allowContentBlocks?.length) {
        const imageCount = count(
          allowContentBlocks,
          (block: ContentBlock) => block.type === 'image',
        )
        if (imageCount > 0) {
          const startId = getNextImagePasteId(toolUseContext.messages)
          allowImageIds = Array.from({ length: imageCount }, (_, index) => startId + index)
        }
      }

      resultingMessages.push({
        message: createUserMessage({
          content: contentBlocks,
          imagePasteIds: allowImageIds,
          toolUseResult:
            toolUseContext.agentId &&
            !toolUseContext.preserveToolUseResults &&
            !tool.briefStandalone
              ? undefined
              : toolUseResult,
          mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
          // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
          sourceToolAssistantUUID: assistantMessage.uuid as UUID,
        }),
        contextModifier: toolContextModifier
          ? {
              toolUseID,
              modifyContext: toolContextModifier,
            }
          : undefined,
      })
    }

    let updatedToolOutputOverride: string | undefined
    let toolResultEntry: MessageUpdateLazy | undefined

    if (!isMcpTool(tool)) {
      await addToolResult(toolOutput, mappedToolResultBlock)
      toolResultEntry = resultingMessages[resultingMessages.length - 1]
    }

    const postToolHookInfos: StopHookInfo[] = []
    const postToolHookStart = Date.now()
    for await (const hookResult of runPostToolUseHooks(
      toolUseContext,
      tool,
      toolUseID,
      messageId,
      processedInput,
      toolOutput,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
      durationMs,
    )) {
      if ('updatedToolOutput' in hookResult) {
        updatedToolOutputOverride = hookResult.updatedToolOutput
      } else if ('updatedMCPToolOutput' in hookResult) {
        if (isMcpTool(tool)) {
          toolOutput = hookResult.updatedMCPToolOutput
        }
      } else if (isMcpTool(tool)) {
        hookResults.push(hookResult)
        const info = collectHookStopInfo(hookResult.message)
        if (info) {
          postToolHookInfos.push(info)
        }
      } else {
        resultingMessages.push(hookResult)
        const info = collectHookStopInfo(hookResult.message)
        if (info) {
          postToolHookInfos.push(info)
        }
      }
    }
    const postToolHookDurationMs = Date.now() - postToolHookStart
    if (postToolHookDurationMs >= 2000) {
      toolLog(
        `Slow PostToolUse hooks: ${postToolHookDurationMs}ms for ${tool.name} (${postToolHookInfos.length} hooks)`,
        { level: 'info' },
      )
    }

    if (isMcpTool(tool)) {
      await addToolResult(toolOutput)
      toolResultEntry = resultingMessages[resultingMessages.length - 1]
    }

    applyUpdatedToolOutputOverride(toolResultEntry, updatedToolOutputOverride)

    if (isInternalBuild() && postToolHookInfos.length > 0) {
      if (postToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
        resultingMessages.push({
          message: createStopHookSummaryMessage(
            postToolHookInfos.length,
            postToolHookInfos,
            [],
            false,
            undefined,
            false,
            'suggestion',
            undefined,
            'PostToolUse',
            postToolHookDurationMs,
          ),
        })
      }
    }

    if (result.newMessages && result.newMessages.length > 0) {
      for (const message of result.newMessages) {
        resultingMessages.push({ message })
      }
    }

    if (shouldPreventContinuation) {
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'hook_stopped_continuation',
          message: stopReason || 'Execution stopped by hook',
          hookName: `PreToolUse:${tool.name}`,
          toolUseID,
          hookEvent: 'PreToolUse',
        }),
      })
    }

    for (const hookResult of hookResults) {
      resultingMessages.push(hookResult)
    }
    return resultingMessages
  } catch (error) {
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)

    endToolExecutionSpan({
      success: false,
      error: errorMessage(error),
    })
    endToolSpan()

    if (error instanceof McpAuthError) {
      handleMcpAuthError(toolUseContext, error)
    }

    if (!(error instanceof AbortError)) {
      const errorMsg = errorMessage(error)
      toolLog(
        `${tool.name} error ${durationMs}ms toolUseId=${toolUseID}: ${errorMsg.slice(0, 200)}`,
      )
      if (!(error instanceof ShellError)) {
        logError(error)
      }
      logEvent('zy_tool_use_error', {
        messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
        error: classifyToolError(
          error,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: tool.isMcp ?? false,

        queryChainId: toolUseContext.queryTracking
          ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && {
          mcpServerType:
            mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(mcpServerBaseUrl && {
          mcpServerBaseUrl:
            mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(requestId && {
          requestId: requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
      })

      const mcpServerScope = isMcpTool(tool) ? getMcpServerScopeFromToolName(tool.name) : null
      void logOTelEvent('tool_result', {
        tool_name: sanitizeToolNameForAnalytics(tool.name),
        use_id: toolUseID,
        success: 'false',
        duration_ms: String(durationMs),
        error: errorMessage(error),
        ...(Object.keys(toolParameters).length > 0 && {
          tool_parameters: jsonStringify(toolParameters),
        }),
        ...(telemetryToolInput && { tool_input: telemetryToolInput }),
        ...(decisionInfo && {
          decision_source: decisionInfo.source,
          decision_type: decisionInfo.decision,
        }),
        ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
      })
    }

    const content = formatError(error)
    const isInterrupt = error instanceof AbortError
    const hookMessages: MessageUpdateLazy<AttachmentMessage | ProgressMessage<HookProgress>>[] = []
    for await (const hookResult of runPostToolUseFailureHooks(
      toolUseContext,
      tool,
      toolUseID,
      messageId,
      processedInput,
      content,
      isInterrupt,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      hookMessages.push(hookResult)
    }

    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content,
              isError: true,
              toolCallId: toolUseID,
            },
          ],
          toolUseResult: `Error: ${content}`,
          mcpMeta: toolUseContext.agentId
            ? undefined
            : error instanceof McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
              ? error.mcpMeta
              : undefined,
          // biome-ignore lint/suspicious/noExplicitAny: 服务层类型适配
          sourceToolAssistantUUID: assistantMessage.uuid as UUID,
        }),
      },
      ...hookMessages,
    ]
  } finally {
    stopSessionActivity('tool_exec')
    if (decisionInfo) {
      toolUseContext.toolDecisions?.delete(toolUseID)
    }
  }
}
