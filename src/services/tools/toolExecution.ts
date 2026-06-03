import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  extractMcpToolDetails,
  extractSkillName,
  extractToolInputForTelemetry,
  getFileExtensionForAnalytics,
  getFileExtensionsFromBashCommand,
  isToolDetailsLoggingEnabled,
  mcpToolDetailsForAnalytics,
  sanitizeToolNameForAnalytics,
} from 'src/services/analytics/metadata.js'
import type { HookProgress } from 'src/types/hooks/index.js'
import {
  addToToolDuration,
  getCodeEditToolDecisionCounter,
  getStatsStore,
} from '../../bootstrap/state.js'
import {
  buildCodeEditToolAttributes,
  isCodeEditingTool,
} from '../../hooks/toolPermission/permissionLogging.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { logOTelEvent } from '../../services/telemetry/events.js'
import {
  addToolContentEvent,
  endToolBlockedOnUserSpan,
  endToolExecutionSpan,
  endToolSpan,
  isBetaTracingEnabled,
  startToolBlockedOnUserSpan,
  startToolExecutionSpan,
  startToolSpan,
} from '../../services/telemetry/sessionTracing.js'
import {
  findToolByName,
  type Tool,
  type ToolProgress,
  type ToolProgressData,
  type ToolUseContext,
} from '../../Tool.js'
import type { BashToolInput } from '../../tools/BashTool/BashTool.js'
import { startSpeculativeClassifierCheck } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { parseGitCommitId } from '../../tools/shared/gitOperationTracking.js'
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import { getAllBaseTools } from '../../tools.js'
import type {
  ContentBlock,
  ToolCallBlock,
  ToolResultBlock,
  UserContentBlock,
} from '../../types/llm.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  StopHookInfo,
} from '../../types/message.js'
import { count } from '../../utils/array.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { createDebugLog } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import {
  AbortError,
  errorMessage,
  getErrnoCode,
  ShellError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { executePermissionDeniedHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  CANCEL_MESSAGE,
  createProgressMessage,
  createStopHookSummaryMessage,
  createToolResultStopMessage,
  createUserMessage,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import { startSessionActivity, stopSessionActivity } from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { Stream } from '../../utils/stream.js'
import { formatError, formatZodValidationError } from '../../utils/toolErrors.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../utils/toolResultStorage.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
} from '../../utils/toolSearch.js'
import {
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../mcp/mcpShared.js'
import { mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from '../mcp/normalization.js'
import type { MCPServerConnection } from '../mcp/types.js'
import { getLoggingSafeMcpBaseUrl, getMcpServerScopeFromToolName, isMcpTool } from '../mcp/utils.js'
import {
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from './toolHooks.js'

const toolLog = createDebugLog('tools')

/** hook 总耗时达到此阈值（毫秒）才在行内展示计时汇总 */
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500
/** hook/权限决策阻塞超过此时间时输出 debug 警告。与 BashTool 的
 * PROGRESS_THRESHOLD_MS 对齐 —— 折叠视图超过该时间会令人感觉卡住。 */
const SLOW_PHASE_LOG_THRESHOLD_MS = 2000

/**
 * 将工具执行错误分类为遵守遥测上传规范的字符串。
 *
 * 在压缩/外部构建中，`error.constructor.name` 会被压缩为
 * “nJT”、“Chq” 这样的短标识符 —— 对诊断毫无帮助。
 * 本函数改为提取结构化、遵守遥测上传规范的信息：
 * - TelemetrySafeError：使用其 telemetryMessage（已检查安全）
 * - Node.js fs 错误：记录错误码 (ENOENT、EACCES 等)
 * - 已知错误类型：使用未压缩的名称
 * - 其余回退：“Error”（优于三位的压缩名）
 */
export function classifyToolError(error: unknown): string {
  if (error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) {
    return error.telemetryMessage.slice(0, 200)
  }
  if (error instanceof Error) {
    // Node.js 文件系统错误带有 `code` 属性 (ENOENT、EACCES 等)。
    // 这些信息可安全记录，且比构造函数名更有用。
    const errnoCode = getErrnoCode(error)
    if (typeof errnoCode === 'string') {
      return `Error:${errnoCode}`
    }
    // ShellError、ImageSizeError 等具有稳定的 `.name` 属性，
    // 在压缩后仍可保留（在构造函数中设置）。
    if (error.name && error.name !== 'Error' && error.name.length > 3) {
      return error.name.slice(0, 60)
    }
    return 'Error'
  }
  return 'UnknownError'
}

/**
 * 将规则来源映射为 OTel 文档中定义的 `source` 词汇，与交互式路径的语义保持一致
 * (permissionLogging.ts:81)：session 范围的授权为临时，磁盘上的授权为永久，
 * 用户手写的 deny 则为 user_reject，与是否持久化无关。
 * 凡是不是用户本人写的 (cliArg、policySettings、projectSettings、flagSettings)都归为 config。
 */
function ruleSourceToOTelSource(ruleSource: string, behavior: 'allow' | 'deny'): string {
  switch (ruleSource) {
    case 'session':
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    case 'localSettings':
    case 'userSettings':
      return behavior === 'allow' ? 'user_permanent' : 'user_reject'
    default:
      return 'config'
  }
}

/**
 * 将 PermissionDecisionReason 映射为非交互式 tool_decision 路径中使用的 OTel `source` 标签，
 * 保证在文档词汇范围内 (config、hook、user_permanent、user_temporary、user_reject)。
 *
 * 对于 permissionPromptTool，SDK 宿主可能在 PermissionResult 上设置 decisionClassification，
 * 以明确告诉我们实际发生了什么（单次 vs 始终 vs 缓存命中 —— 仅凭 {behavior:'allow'}
 * 无法判别，宿主才知道）。若未提供，则保守回退：allow → user_temporary，
 * deny → user_reject。
 */
function decisionReasonToOTelSource(
  reason: PermissionDecisionReason | undefined,
  behavior: 'allow' | 'deny',
): string {
  if (!reason) {
    return 'config'
  }
  switch (reason.type) {
    case 'permissionPromptTool': {
      // toolResult 在 PermissionDecisionReason 上类型为 `unknown`，但实际携带的
      // 是 PermissionPromptToolResultSchema 解析后的 Output。运行时狭化即可，
      // 不必拓宽跨文件的类型。
      const toolResult = reason.toolResult as { decisionClassification?: string } | undefined
      const classified = toolResult?.decisionClassification
      if (
        classified === 'user_temporary' ||
        classified === 'user_permanent' ||
        classified === 'user_reject'
      ) {
        return classified
      }
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    }
    case 'rule':
      return ruleSourceToOTelSource(reason.rule.source, behavior)
    case 'hook':
      return 'hook'
    case 'mode':
    case 'classifier':
    case 'subcommandResults':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return 'config'
    default: {
      const _exhaustive: never = reason
      return 'config'
    }
  }
}

function getNextImagePasteId(messages: Message[]): number {
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

export type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}

export type McpServerType =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'sse-ide'
  | 'ws-ide'
  | 'zyai-proxy'
  | undefined

function findMcpServerConnection(
  toolName: string,
  mcpClients: MCPServerConnection[],
): MCPServerConnection | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return undefined
  }

  // mcpInfo.serverName 是已归一化名称（如 “zy_ai_Slack”），而 client.name
  // 是原始名称（如 “zy.ai Slack”）。比较前对两者均进行归一化。
  return mcpClients.find((client) => normalizeNameForMCP(client.name) === mcpInfo.serverName)
}

/**
 * 从工具名中提取 MCP 服务器的 transport 类型。
 * 对 MCP 工具返回服务器类型 (stdio、sse、http、ws、sdk 等)，
 * 对内置工具返回 undefined。
 */
function getMcpServerType(toolName: string, mcpClients: MCPServerConnection[]): McpServerType {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)

  if (serverConnection?.type === 'connected') {
    // 处理 stdio 配置中 type 字段可选的情况（默认为 'stdio'）
    return serverConnection.config.type ?? 'stdio'
  }

  return undefined
}

/**
 * 通过工具名查找其服务器连接，并提取 MCP 服务器的 base URL。
 * 对 stdio 服务器、内置工具或服务器未连接时返回 undefined。
 */
function getMcpServerBaseUrlFromToolName(
  toolName: string,
  mcpClients: MCPServerConnection[],
): string | undefined {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)
  if (serverConnection?.type !== 'connected') {
    return undefined
  }
  return getLoggingSafeMcpBaseUrl(serverConnection.config)
}

// 会话级脚本调用计数器（ZY_CODE_SCRIPT_CAPS）
let _sessionScriptCallCount = 0
const SCRIPT_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/** 重置脚本调用计数（用于测试或新会话） */
export function resetScriptCallCount(): void {
  _sessionScriptCallCount = 0
}

export async function* runToolUse(
  toolUse: ToolCallBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name

  // ZY_CODE_SCRIPT_CAPS: 会话级脚本调用次数限制
  if (SCRIPT_TOOL_NAMES.has(toolName)) {
    const capsStr = process.env.ZY_CODE_SCRIPT_CAPS
    const scriptCap = capsStr ? parseInt(capsStr, 10) : 0
    if (scriptCap > 0) {
      _sessionScriptCallCount++
      if (_sessionScriptCallCount > scriptCap) {
        toolLog(
          `Script call cap exceeded: ${_sessionScriptCallCount}/${scriptCap}, rejecting ${toolName}`,
          { level: 'warn' },
        )
        yield {
          message: createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>Error: Script call limit exceeded (${scriptCap} per session). Set ZY_CODE_SCRIPT_CAPS to increase or remove the limit.</tool_use_error>`,
                isError: true,
                toolCallId: toolUse.id,
              },
            ],
            toolUseResult: `Error: Script call limit exceeded (${scriptCap} per session)`,
            sourceToolAssistantUUID: assistantMessage.uuid as any,
          }),
        }
        return
      }
    }
  }

  // 先在可用工具（模型看得到的）中查找
  let tool = findToolByName(toolUseContext.options.tools, toolName)

  // 若未找到，检查是否是被别名调用的废弃工具
  // （例如旧志调用 “KillShell”，现为 “TaskStop” 的别名）
  // 仅当名称是别名、而非主名称时才回退
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    // 仅在通过别名（废弃名称）查找到时才使用回退
    if (fallbackTool?.aliases?.includes(toolName)) {
      tool = fallbackTool
    }
  }
  const messageId = assistantMessage.message.id ?? ''
  const requestId = assistantMessage.requestId
  const mcpServerType = getMcpServerType(toolName, toolUseContext.options.mcpClients)
  const mcpServerBaseUrl = getMcpServerBaseUrlFromToolName(
    toolName,
    toolUseContext.options.mcpClients,
  )

  // 检查工具是否存在
  if (!tool) {
    const sanitizedToolName = sanitizeToolNameForAnalytics(toolName)
    toolLog(`Unknown tool ${toolName}: ${toolUse.id}`, { level: 'warn' })
    logEvent('zy_tool_use_error', {
      error:
        `No such tool available: ${sanitizedToolName}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizedToolName,
      toolUseID: toolUse.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      isMcp: toolName.startsWith('mcp__'),
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
      ...mcpToolDetailsForAnalytics(toolName, mcpServerType, mcpServerBaseUrl),
    })
    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
            isError: true,
            toolCallId: toolUse.id,
          },
        ],
        toolUseResult: `Error: No such tool available: ${toolName}`,
        sourceToolAssistantUUID: assistantMessage.uuid as any,
      }),
    }
    return
  }

  const toolInput = toolUse.input as { [key: string]: string }
  try {
    if (toolUseContext.abortController.signal.aborted) {
      logEvent('zy_tool_use_cancelled', {
        toolName: sanitizeToolNameForAnalytics(tool.name),
        toolUseID: toolUse.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
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
      const content = createToolResultStopMessage(toolUse.id)
      content.content = withMemoryCorrectionHint(CANCEL_MESSAGE)
      yield {
        message: createUserMessage({
          content: [content],
          toolUseResult: CANCEL_MESSAGE,
          sourceToolAssistantUUID: assistantMessage.uuid as any,
        }),
      }
      return
    }

    for await (const update of streamedCheckPermissionsAndCallTool(
      tool,
      toolUse.id,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      messageId,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      yield update
    }
  } catch (error) {
    logError(error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    const toolInfo = tool ? ` (${tool.name})` : ''
    const detailedError = `Error calling tool${toolInfo}: ${errorMessage}`

    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: `<tool_use_error>${detailedError}</tool_use_error>`,
            isError: true,
            toolCallId: toolUse.id,
          },
        ],
        toolUseResult: detailedError,
        sourceToolAssistantUUID: assistantMessage.uuid as any,
      }),
    }
  }
}

function streamedCheckPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
): AsyncIterable<MessageUpdateLazy> {
  // 这里有点 hack，目的是将进度事件与最终结果
  // 合并到同一个异步迭代器中。
  //
  // 理想上进度上报与工具调用上报应该通过两套机制分别完成。
  const stream = new Stream<MessageUpdateLazy>()
  // 跟踪进度消息的索引以保证 UUID 稳定。
  // UUID 不稳定会导致 React key 不稳定 → 组件重新挂载 →
  // Ink 渲染异常（陈旧 DOM 节点产生文本重叠）。
  let progressIndex = 0
  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
    (progress) => {
      logEvent('zy_tool_use_progress', {
        messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
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
      stream.enqueue({
        message: createProgressMessage({
          toolUseID: progress.toolUseID,
          parentToolUseID: toolUseID,
          data: progress.data,
          index: progressIndex++,
        }),
      })
    },
  )
    .then((results) => {
      for (const result of results) {
        stream.enqueue(result)
      }
    })
    .catch((error) => {
      stream.error(error)
    })
    .finally(() => {
      stream.done()
    })
  return stream
}

/**
 * 当某个延迟加载的工具不在已发现工具集合中时，追加到 Zod 错误中。
 * 在调用时会重新运行 zy.ts 的 schema-filter 扫描以检测不匹配。
 * 原始 Zod 错误（如 "expected array, got string"）不会提示模型重新加载工具；
 * 这里增加的提示起到该作用。若 schema 已发送，返回 null。
 */
export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
): string | null {
  // 乐观门控 —— 重现 zy.ts 中完整的 useToolSearch
  // 计算过于脆弱。这两道门控可避免指向不可调用的 ToolSearch；
  // 偶尔误报（例如 Haiku、阈值以下的 tst-auto）只会在本已失败的路径上
  // 多费一个往返。
  if (!isToolSearchEnabledOptimistic()) {
    return null
  }
  if (!isToolSearchToolAvailable(tools)) {
    return null
  }
  if (!isDeferredTool(tool)) {
    return null
  }
  const discovered = extractDiscoveredToolNames(messages)
  if (discovered.has(tool.name)) {
    return null
  }
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}

async function checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
  onToolProgress: (
    progress: ToolProgress<ToolProgressData> | ProgressMessage<HookProgress>,
  ) => void,
): Promise<MessageUpdateLazy[]> {
  // 使用 zod 验证输入类型（令人意外的是，模型并不总能生成合法输入）
  const parsedInput = tool.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    let errorContent = formatZodValidationError(tool.name, parsedInput.error)

    const schemaHint = buildSchemaNotSentHint(
      tool,
      toolUseContext.messages,
      toolUseContext.options.tools,
    )
    if (schemaHint) {
      logEvent('zy_deferred_tool_schema_not_sent', {
        toolName: sanitizeToolNameForAnalytics(tool.name),
        isMcp: tool.isMcp ?? false,
      })
      errorContent += schemaHint
    }

    toolLog(`${tool.name} input error: ${errorContent.slice(0, 200)}`, { level: 'warn' })
    logEvent('zy_tool_use_error', {
      error: 'InputValidationError' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errorDetails: errorContent.slice(
        0,
        2000,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      isMcp: tool.isMcp ?? false,

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
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
              isError: true,
              toolCallId: toolUseID,
            },
          ],
          toolUseResult: `InputValidationError: ${parsedInput.error.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid as any,
        }),
      },
    ]
  }

  // 验证输入值。每个工具有自己的验证逻辑
  const isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext)
  if (isValidCall?.result === false) {
    toolLog(`${tool.name} validation error: ${isValidCall.message?.slice(0, 200)}`, {
      level: 'warn',
    })
    logEvent('zy_tool_use_error', {
      messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      error: isValidCall.message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errorCode: isValidCall.errorCode,
      isMcp: tool.isMcp ?? false,

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
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: `<tool_use_error>${isValidCall.message}</tool_use_error>`,
              isError: true,
              toolCallId: toolUseID,
            },
          ],
          toolUseResult: `Error: ${isValidCall.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid as any,
        }),
      },
    ]
  }
  // 推测性地提前启动 bash allow 分类器检查，让它与工具前 hook、
  // deny/ask 分类器以及权限对话框准备并行运行。UI 指示器
  // (setClassifierChecking) 在这里不设置 —— 在 interactiveHandler.ts 中
  // 仅在权限检查返回 `ask` 且存在 pendingClassifierCheck 时才设置。
  // 这避免了对于通过前缀规则自动允许的命令闪现
  // “classifier running” 状态。
  if (tool.name === BASH_TOOL_NAME && parsedInput.data && 'command' in parsedInput.data) {
    const appState = toolUseContext.getAppState()
    startSpeculativeClassifierCheck(
      (parsedInput.data as BashToolInput).command,
      appState.toolPermissionContext,
      toolUseContext.abortController.signal,
      toolUseContext.options.isNonInteractiveSession,
    )
  }

  const resultingMessages = []

  // 纵深防御：从模型提供的 Bash 输入中去掉 _simulatedSedEdit。
  // 该字段仅限内部使用 —— 必须只能由权限系统
  // (SedEditPermissionRequest) 在用户同意后注入。如果模型提供了它，
  // schema 的 strictObject 本应拒绝，但这里仍作为防御层进行剥离，
  // 以防未来回归。
  let processedInput = parsedInput.data
  if (
    tool.name === BASH_TOOL_NAME &&
    processedInput &&
    typeof processedInput === 'object' &&
    '_simulatedSedEdit' in processedInput
  ) {
    const { _simulatedSedEdit: _, ...rest } = processedInput as typeof processedInput & {
      _simulatedSedEdit: unknown
    }
    processedInput = rest as typeof processedInput
  }

  // 在浅拷贝上回填遗留/派生字段，使 hook/canUseTool 能看到这些字段，
  // 同时不影响 tool.call()。SendMessageTool 会加字段；file 类工具
  // 会用 expandPath 覆盖 file_path —— 该修改不应传入 call()，因为工具
  // 结果会逐字嵌入输入路径（例如 “File created successfully at: {path}”），
  // 修改会变动序列化会话志与 VCR 指纹哈希。若 hook/权限后续返回
  // 新的 updatedInput，下面 callInput 会收敛过去 —— 该替换是有意为之
  // 且应抵达 call()。
  let callInput = processedInput
  const backfilledClone =
    tool.backfillObservableInput && typeof processedInput === 'object' && processedInput !== null
      ? ({ ...processedInput } as typeof processedInput)
      : null
  if (backfilledClone) {
    tool.backfillObservableInput!(backfilledClone as Record<string, unknown>)
    processedInput = backfilledClone
  }

  let shouldPreventContinuation = false
  let stopReason: string | undefined
  let hookPermissionResult: PermissionResult | undefined
  const preToolHookInfos: StopHookInfo[] = []
  const preToolHookStart = Date.now()
  for await (const result of runPreToolUseHooks(
    toolUseContext,
    tool,
    processedInput,
    toolUseID,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    switch (result.type) {
      case 'message':
        if (result.message.message.type === 'progress') {
          onToolProgress(result.message.message)
        } else {
          resultingMessages.push(result.message)
          const att = result.message.message.attachment
          if (
            att &&
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            preToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            } as any)
          }
        }
        break
      case 'hookPermissionResult':
        hookPermissionResult = result.hookPermissionResult
        break
      case 'hookUpdatedInput':
        // hook 提供了 updatedInput 但未作出权限决策（透传场景）
        // 更新 processedInput 以供后续常规权限流程使用
        processedInput = result.updatedInput
        break
      case 'preventContinuation':
        shouldPreventContinuation = result.shouldPreventContinuation
        break
      case 'stopReason':
        stopReason = result.stopReason
        break
      case 'additionalContext':
        resultingMessages.push(result.message)
        break
      case 'stop':
        getStatsStore()?.observe('pre_tool_hook_duration_ms', Date.now() - preToolHookStart)
        resultingMessages.push({
          message: createUserMessage({
            content: [createToolResultStopMessage(toolUseID)],
            toolUseResult: `Error: ${stopReason}`,
            sourceToolAssistantUUID: assistantMessage.uuid as any,
          }),
        })
        return resultingMessages
    }
  }
  const preToolHookDurationMs = Date.now() - preToolHookStart
  getStatsStore()?.observe('pre_tool_hook_duration_ms', preToolHookDurationMs)
  if (preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
    toolLog(
      `Slow PreToolUse hooks: ${preToolHookDurationMs}ms for ${tool.name} (${preToolHookInfos.length} hooks)`,
      { level: 'info' },
    )
  }

  // 在工具执行期间立即发出 PreToolUse 汇总，使其可见。
  // 使用壁钟时间（而非各 hook 耗时之和），因为 hook 会并行执行。
  if (isInternalBuild() && preToolHookInfos.length > 0) {
    if (preToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
      resultingMessages.push({
        message: createStopHookSummaryMessage(
          preToolHookInfos.length,
          preToolHookInfos,
          [],
          false,
          undefined,
          false,
          'suggestion' as any,
          undefined,
          'PreToolUse',
          preToolHookDurationMs,
        ),
      })
    }
  }

  const toolAttributes: Record<string, string | number | boolean> = {}
  if (processedInput && typeof processedInput === 'object') {
    if (tool.name === FILE_READ_TOOL_NAME && 'file_path' in processedInput) {
      toolAttributes.file_path = String(processedInput.file_path)
    } else if (
      (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) &&
      'file_path' in processedInput
    ) {
      toolAttributes.file_path = String(processedInput.file_path)
    } else if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
      const bashInput = processedInput as BashToolInput
      toolAttributes.full_command = bashInput.command
    }
  }

  toolLog(`${tool.name} start toolUseId=${toolUseID}`)

  startToolSpan(
    tool.name,
    toolAttributes,
    isBetaTracingEnabled() ? jsonStringify(processedInput) : undefined,
  )
  startToolBlockedOnUserSpan()

  // 检查是否有权限使用工具，若没有则向用户申请
  const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
  const permissionStart = Date.now()

  const resolved = await resolveHookPermissionDecision(
    hookPermissionResult,
    tool,
    processedInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    toolUseID,
  )
  const permissionDecision = resolved.decision
  processedInput = resolved.input
  const permissionDurationMs = Date.now() - permissionStart
  // 在 auto 模式下，canUseTool 会等待分类器 (side_query) —— 如果该过程较慢，
  // 折叠视图会显示 “Running…” 但没有 (Ns) 计时，因为 bash_progress 还未开始。
  // 仅对 auto：默认模式下该计时器会包含交互式对话框的等待时间（用户思考时间），
  // 那只是噪声。
  if (permissionDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS && permissionMode === 'auto') {
    toolLog(
      `Slow permission decision: ${permissionDurationMs}ms for ${tool.name} ` +
        `(mode=${permissionMode}, behavior=${permissionDecision.behavior})`,
      { level: 'info' },
    )
  }

  // 发送 tool_decision OTel 事件与代码编辑器工具计数器，仅在交互式权限路径
  // 未记录过时才发（无头模式会绕过权限记录，所以我们需要在此处
  // 同时发出通用事件与代码编辑器计数器）
  if (permissionDecision.behavior !== 'ask' && !toolUseContext.toolDecisions?.has(toolUseID)) {
    const decision = permissionDecision.behavior === 'allow' ? 'accept' : 'reject'
    const source = decisionReasonToOTelSource(
      permissionDecision.decisionReason,
      permissionDecision.behavior,
    )
    void logOTelEvent('tool_decision', {
      decision,
      source,
      tool_name: sanitizeToolNameForAnalytics(tool.name),
    })

    // 为无头模式增加代码编辑器工具决策计数器
    if (isCodeEditingTool(tool.name)) {
      void buildCodeEditToolAttributes(tool, processedInput, decision, source).then((attributes) =>
        getCodeEditToolDecisionCounter()?.add(1, attributes),
      )
    }
  }

  // 如果权限是由 PermissionRequest hook 授予/拒绝，额外补一条消息
  if (
    permissionDecision.decisionReason?.type === 'hook' &&
    permissionDecision.decisionReason.hookName === 'PermissionRequest' &&
    permissionDecision.behavior !== 'ask'
  ) {
    resultingMessages.push({
      message: createAttachmentMessage({
        type: 'hook_permission_decision',
        decision: permissionDecision.behavior,
        toolUseID,
        hookEvent: 'PermissionRequest',
      }),
    })
  }

  if (permissionDecision.behavior !== 'allow') {
    toolLog(
      `${tool.name} permission: denied (reason=${permissionDecision.decisionReason?.type ?? 'unknown'})`,
    )
    const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)
    endToolBlockedOnUserSpan('reject', decisionInfo?.source || 'unknown')
    endToolSpan()

    logEvent('zy_tool_use_can_use_tool_rejected', {
      messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),

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
    let errorMessage = permissionDecision.message
    // 仅在没有详细 hook 消息时，才使用通用的 “Execution stopped” 提示
    if (shouldPreventContinuation && !errorMessage) {
      errorMessage = `Execution stopped by PreToolUse hook${stopReason ? `: ${stopReason}` : ''}`
    }

    // 构造顶层 content：tool_result（仅文本以兼容 is_error） + 并列的图片
    const messageContent: UserContentBlock[] = [
      {
        type: 'tool_result',
        content: errorMessage,
        isError: true,
        toolCallId: toolUseID,
      },
    ]

    // 图片块放在顶层（不能放在 tool_result 内，tool_result 在 is_error 时拒绝非文本）
    const rejectContentBlocks =
      permissionDecision.behavior === 'ask' ? permissionDecision.contentBlocks : undefined
    if (rejectContentBlocks?.length) {
      messageContent.push(...(rejectContentBlocks as UserContentBlock[]))
    }

    // 按顺序生成 imagePasteIds，使每张图片以不同标签渲染
    let rejectImageIds: number[] | undefined
    if (rejectContentBlocks?.length) {
      const imageCount = count(rejectContentBlocks, (b: ContentBlock) => b.type === 'image')
      if (imageCount > 0) {
        const startId = getNextImagePasteId(toolUseContext.messages)
        rejectImageIds = Array.from({ length: imageCount }, (_, i) => startId + i)
      }
    }

    resultingMessages.push({
      message: createUserMessage({
        content: messageContent,
        imagePasteIds: rejectImageIds,
        toolUseResult: `Error: ${errorMessage}`,
        sourceToolAssistantUUID: assistantMessage.uuid as any,
      }),
    })

    // 在 auto 模式下分类器拒绝时运行 PermissionDenied hook。
    // 如果 hook 返回 {retry: true}，告诉模型可以重试。
    if (
      true &&
      permissionDecision.decisionReason?.type === 'classifier' &&
      permissionDecision.decisionReason.classifier === 'auto-mode'
    ) {
      let hookSaysRetry = false
      for await (const result of executePermissionDeniedHooks(
        tool.name,
        toolUseID,
        processedInput,
        permissionDecision.decisionReason.reason ?? 'Permission denied',
        toolUseContext,
        permissionMode,
        toolUseContext.abortController.signal,
      )) {
        if (result.retry) {
          hookSaysRetry = true
        }
      }
      if (hookSaysRetry) {
        resultingMessages.push({
          message: createUserMessage({
            content: [
              {
                type: 'text' as const,
                text: 'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
              },
            ],
            isMeta: true,
          }),
        })
      }
    }

    return resultingMessages
  }
  toolLog(
    `${tool.name} permission: allow (reason=${permissionDecision.decisionReason?.type ?? 'unknown'})`,
  )
  logEvent('zy_tool_use_can_use_tool_allowed', {
    messageID: messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolName: sanitizeToolNameForAnalytics(tool.name),

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

  // 使用权限提供的 updatedInput（若有）
  // （当 undefined 时不覆盖 —— processedInput 可能已被透传 hook 修改过）
  if (permissionDecision.updatedInput !== undefined) {
    processedInput = permissionDecision.updatedInput
  }

  // 准备在 tool_result 事件中记录的工具参数。
  // 受 OTEL_LOG_TOOL_DETAILS 门控，工具参数可能含敏感内容
  // (bash 命令、MCP 服务器名称等)，默认不记录。
  const telemetryToolInput = extractToolInputForTelemetry(processedInput)
  let toolParameters: Record<string, unknown> = {}
  if (isToolDetailsLoggingEnabled()) {
    if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
      const bashInput = processedInput as BashToolInput
      const commandParts = bashInput.command.trim().split(/\s+/)
      const bashCommand = commandParts[0] || ''

      toolParameters = {
        bash_command: bashCommand,
        full_command: bashInput.command,
        ...(bashInput.timeout !== undefined && {
          timeout: bashInput.timeout,
        }),
        ...(bashInput.description !== undefined && {
          description: bashInput.description,
        }),
        ...('dangerouslyDisableSandbox' in bashInput && {
          dangerouslyDisableSandbox: bashInput.dangerouslyDisableSandbox,
        }),
      }
    }

    const mcpDetails = extractMcpToolDetails(tool.name)
    if (mcpDetails) {
      toolParameters.mcp_server_name = mcpDetails.serverName
      toolParameters.mcp_tool_name = mcpDetails.mcpToolName
    }
    const skillName = extractSkillName(tool.name, processedInput)
    if (skillName) {
      toolParameters.skill_name = skillName
    }
  }

  const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)
  endToolBlockedOnUserSpan(decisionInfo?.decision || 'unknown', decisionInfo?.source || 'unknown')
  startToolExecutionSpan()

  const startTime = Date.now()

  startSessionActivity('tool_exec')
  // 若 processedInput 仍指向回填克隆，说明没有 hook/权限替换过它——
  // 传入未回填的 callInput，让 call() 看到模型原始的字段值。否则收敛到 hook 提供的输入。
  // 权限/hook 流程可能返回从回填克隆派生的新对象（例如通过
  // inputSchema.parse）。若其 file_path 与回填后的值一致，则还原
  // 为模型原始值，使工具结果中嵌入的路径与模型传入的一致，
  // 以保持会话志/VCR 哈希稳定。其他 hook 修改会原样透传。
  if (
    backfilledClone &&
    processedInput !== callInput &&
    typeof processedInput === 'object' &&
    processedInput !== null &&
    'file_path' in processedInput &&
    'file_path' in (callInput as Record<string, unknown>) &&
    (processedInput as Record<string, unknown>).file_path ===
      (backfilledClone as Record<string, unknown>).file_path
  ) {
    callInput = {
      ...processedInput,
      file_path: (callInput as Record<string, unknown>).file_path,
    } as typeof processedInput
  } else if (processedInput !== backfilledClone) {
    callInput = processedInput
  }
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

    // 启用时将工具 content/output 作为 span 事件记录
    if (result.data && typeof result.data === 'object') {
      const contentAttributes: Record<string, string | number | boolean> = {}

      // Read 工具：捕获 file_path 与 content
      if (tool.name === FILE_READ_TOOL_NAME && 'content' in result.data) {
        if ('file_path' in processedInput) {
          contentAttributes.file_path = String(processedInput.file_path)
        }
        contentAttributes.content = String(result.data.content)
      }

      // Edit/Write 工具：捕获 file_path 与 diff
      if (
        (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) &&
        'file_path' in processedInput
      ) {
        contentAttributes.file_path = String(processedInput.file_path)

        // 对 Edit，捕获实际发生的变更
        if (tool.name === FILE_EDIT_TOOL_NAME && 'diff' in result.data) {
          contentAttributes.diff = String(result.data.diff)
        }
        // 对 Write，捕获写入的内容
        if (tool.name === FILE_WRITE_TOOL_NAME && 'content' in processedInput) {
          contentAttributes.content = String(processedInput.content)
        }
      }

      // Bash 工具：捕获命令
      if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
        const bashInput = processedInput as BashToolInput
        contentAttributes.bash_command = bashInput.command
        // 可用时同时捕获输出
        if ('output' in result.data) {
          contentAttributes.output = String(result.data.output)
        }
      }

      if (Object.keys(contentAttributes).length > 0) {
        addToolContentEvent('tool.output', contentAttributes)
      }
    }

    // 如果存在，从工具结果中捕获结构化输出
    if (typeof result === 'object' && 'structured_output' in result) {
      // 将结构化输出存入 attachment 消息
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'structured_output',
          data: result.structured_output,
        }),
      })
    }

    endToolExecutionSpan({ success: true })
    // 传入工具结果用于 new_context 记录
    const toolResultStr =
      result.data && typeof result.data === 'object'
        ? jsonStringify(result.data)
        : String(result.data ?? '')
    endToolSpan(toolResultStr)

    // 将工具结果一次性映射为 API 格式并缓存。该块会被
    // addToolResult 复用（跳过重复映射），同时在这里提供遥测指标。
    const mappedToolResultBlock = tool.mapToolResultToToolResultBlock(result.data, toolUseID)
    const mappedContent = mappedToolResultBlock.content
    const toolResultSizeBytes = !mappedContent
      ? 0
      : typeof mappedContent === 'string'
        ? mappedContent.length
        : jsonStringify(mappedContent).length

    // 为文件类工具提取文件后缀
    let fileExtension: ReturnType<typeof getFileExtensionForAnalytics>
    if (processedInput && typeof processedInput === 'object') {
      if (
        (tool.name === FILE_READ_TOOL_NAME ||
          tool.name === FILE_EDIT_TOOL_NAME ||
          tool.name === FILE_WRITE_TOOL_NAME) &&
        'file_path' in processedInput
      ) {
        fileExtension = getFileExtensionForAnalytics(String(processedInput.file_path))
      } else if (tool.name === NOTEBOOK_EDIT_TOOL_NAME && 'notebook_path' in processedInput) {
        fileExtension = getFileExtensionForAnalytics(String(processedInput.notebook_path))
      } else if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
        const bashInput = processedInput as BashToolInput
        fileExtension = getFileExtensionsFromBashCommand(
          bashInput.command,
          bashInput._simulatedSedEdit?.filePath,
        )
      }
    }

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

    // 从成功的 git commit 输出中提取 git commit ID，富化工具参数
    if (
      isToolDetailsLoggingEnabled() &&
      (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) &&
      'command' in processedInput &&
      typeof processedInput.command === 'string' &&
      processedInput.command.match(/\bgit\s+commit\b/) &&
      result.data &&
      typeof result.data === 'object' &&
      'stdout' in result.data
    ) {
      const gitCommitId = parseGitCommitId(String(result.data.stdout))
      if (gitCommitId) {
        toolParameters.git_commit_id = gitCommitId
      }
    }

    // 为 OTLP 发送带有工具参数与决策上下文的 tool_result 事件
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

    // Run PostToolUse hooks
    let toolOutput = result.data
    const hookResults = []
    const toolContextModifier = result.contextModifier
    const mcpMeta = result.mcpMeta

    async function addToolResult(toolUseResult: unknown, preMappedBlock?: ToolResultBlock) {
      // MCP 工具可通过 _meta.maxResultSizeChars 动态覆盖结果大小上限（最多 500K）
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

      // 如果预映射块可用则使用（非 MCP 工具且 hook 未修改输出的场景），
      // 否则从头映射。
      const toolResultBlock = preMappedBlock
        ? await processPreMappedToolResultBlock(preMappedBlock, tool.name, effectiveMaxResultSize)
        : await processToolResultBlock(
            { ...tool, maxResultSizeChars: effectiveMaxResultSize },
            toolUseResult,
            toolUseID,
          )

      // 构造 content 块——先是工具结果，然后是可选的反馈
      const contentBlocks: UserContentBlock[] = [toolResultBlock]
      // 若用户在同意时提供了反馈，附加 accept feedback
      // (acceptFeedback 仅在 PermissionAllowDecision 上存在，这里能保证包含)
      if ('acceptFeedback' in permissionDecision && permissionDecision.acceptFeedback) {
        contentBlocks.push({
          type: 'text',
          text: permissionDecision.acceptFeedback,
        })
      }

      // 附加权限决策中的 content 块（例如粘贴的图片）
      const allowContentBlocks =
        'contentBlocks' in permissionDecision ? permissionDecision.contentBlocks : undefined
      if (allowContentBlocks?.length) {
        contentBlocks.push(...(allowContentBlocks as UserContentBlock[]))
      }

      // 按顺序生成 imagePasteIds，使每张图片以不同标签渲染
      let allowImageIds: number[] | undefined
      if (allowContentBlocks?.length) {
        const imageCount = count(allowContentBlocks, (b: ContentBlock) => b.type === 'image')
        if (imageCount > 0) {
          const startId = getNextImagePasteId(toolUseContext.messages)
          allowImageIds = Array.from({ length: imageCount }, (_, i) => startId + i)
        }
      }

      resultingMessages.push({
        message: createUserMessage({
          content: contentBlocks,
          imagePasteIds: allowImageIds,
          toolUseResult:
            toolUseContext.agentId && !toolUseContext.preserveToolUseResults
              ? undefined
              : toolUseResult,
          mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
          sourceToolAssistantUUID: assistantMessage.uuid as any,
        }),
        contextModifier: toolContextModifier
          ? {
              toolUseID: toolUseID,
              modifyContext: toolContextModifier,
            }
          : undefined,
      })
    }

    // PostToolUse hook 的通用结果覆盖（updatedToolOutput，全工具，string）。在循环里捕获，
    // 循环结束后改写已入队的 tool_result 块内容（resultingMessages 末尾才返回，改写安全）。
    let updatedToolOutputOverride: string | undefined
    let toolResultEntry: (typeof resultingMessages)[number] | undefined

    // TODO(hackyon)：重构以避免 MCP 工具与其他工具体验不一致
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
        // 通用结果覆盖（全工具）。优先于 updatedMCPToolOutput（在末尾改写最终块内容）。
        updatedToolOutputOverride = hookResult.updatedToolOutput
      } else if ('updatedMCPToolOutput' in hookResult) {
        if (isMcpTool(tool)) {
          toolOutput = hookResult.updatedMCPToolOutput
        }
      } else if (isMcpTool(tool)) {
        hookResults.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            } as any)
          }
        }
      } else {
        resultingMessages.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            } as any)
          }
        }
      }
    }
    const postToolHookDurationMs = Date.now() - postToolHookStart
    if (postToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
      toolLog(
        `Slow PostToolUse hooks: ${postToolHookDurationMs}ms for ${tool.name} (${postToolHookInfos.length} hooks)`,
        { level: 'info' },
      )
    }

    if (isMcpTool(tool)) {
      await addToolResult(toolOutput)
      toolResultEntry = resultingMessages[resultingMessages.length - 1]
    }

    // 应用 PostToolUse hook 的通用结果覆盖：改写 tool_result 块的文本内容。
    // updatedToolOutput 优先于 updatedMCPToolOutput（最后改写最终块）。
    if (updatedToolOutputOverride !== undefined && toolResultEntry) {
      const content = (toolResultEntry.message as any)?.message?.content
      if (Array.isArray(content)) {
        const block = content.find((b: { type?: string }) => b?.type === 'tool_result')
        if (block) {
          block.content = updatedToolOutputOverride
        }
      }
    }

    // 当 PostToolUse hook 总耗时超过 500ms 时，在工具结果下方内联显示其耗时。
    // 使用 wall-clock 时间（而非各 hook 时长之和），因为 hooks 是并行执行的。
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
            'suggestion' as any,
            undefined,
            'PostToolUse',
            postToolHookDurationMs,
          ),
        })
      }
    }

    // 如果工具提供了新消息，将它们加入待返回列表。
    if (result.newMessages && result.newMessages.length > 0) {
      for (const message of result.newMessages) {
        resultingMessages.push({ message })
      }
    }
    // 如果在工具成功执行后 hook 表示需要阻止继续，产出一条 stop reason 消息
    if (shouldPreventContinuation) {
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'hook_stopped_continuation',
          message: stopReason || 'Execution stopped by hook',
          hookName: `PreToolUse:${tool.name}`,
          toolUseID: toolUseID,
          hookEvent: 'PreToolUse',
        }),
      })
    }

    // 在其他消息发送后，再产出剩余的 hook 结果
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

    // 通过将客户端状态更新为 'needs-auth' 来处理 MCP 认证错误
    // 这会更新 /mcp 显示，提示该 server 需要重新授权
    if (error instanceof McpAuthError) {
      toolUseContext.setAppState((prevState) => {
        const serverName = error.serverName
        const existingClientIndex = prevState.mcp.clients.findIndex((c) => c.name === serverName)
        if (existingClientIndex === -1) {
          return prevState
        }
        const existingClient = prevState.mcp.clients[existingClientIndex]
        // 仅在客户端原本处于 connected 状态时更新（避免覆盖其他状态）
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
      // 为 OTLP 发送带有工具参数与决策上下文的 tool_result 错误事件
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

    // 判断是否为用户中断
    const isInterrupt = error instanceof AbortError

    // 运行 PostToolUseFailure hook
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
          sourceToolAssistantUUID: assistantMessage.uuid as any,
        }),
      },
      ...hookMessages,
    ]
  } finally {
    stopSessionActivity('tool_exec')
    // 清理决策信息，仅在记录后执行
    if (decisionInfo) {
      toolUseContext.toolDecisions?.delete(toolUseID)
    }
  }
}
