// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { toolMatchesName, type ToolUseContext } from '../../../tools/tool.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
} from '../../../tools/FileReadTool/FileReadTool.js'
import { FileTooLargeError } from '../../../services/file-persistence/readFileInRange.js'
import { countCharInString } from '../../../utils/stringUtils.js'
import { getFsImplementation } from '../../../services/infra/fsOperations.js'
import type { IDESelection } from '../../../hooks/useIdeSelection.js'
import { TODO_WRITE_TOOL_NAME } from '../../../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../../tools/TaskUpdateTool/constants.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { listTasks, getTaskListId, isTodoV2Enabled } from '../../tasks-service/tasks.js'
import { parse, relative } from 'node:path'
import { getCwd } from 'src/services/environment/cwd.js'
import { logError } from '../../../services/infra/log.js'
import { toError } from '../../../utils/errors.js'
import type { AttachmentMessage, Message } from 'src/types/message.js'
import { type QueuedCommand } from 'src/types/textInputTypes.js'
import { randomUUID } from 'node:crypto'
/* eslint-enable @typescript-eslint/no-require-imports */
import { MAX_LINES_TO_READ } from 'src/tools/FileReadTool/prompt.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import {
  getFileModificationTimeAsync,
  isFileWithinReadSizeLimit,
} from '../../../services/infra/file.js'
import {
  generateTaskAttachments,
  applyTaskOffsetsAndEvictions,
} from 'src/services/task-runtime/framework.js'
import { getTaskOutputPath } from 'src/services/task-runtime/diskOutput.js'
import { getSessionId } from '../../../bootstrap/runtime/runtimeContext.js'
import type { QuerySource } from '../../../constants/querySource.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from '../../hooks/asyncHookRegistry.js'
import { checkForLSPDiagnostics, clearAllLSPDiagnostics } from '../../lsp/lspDiagnosticRegistry.js'
import { logForDebugging } from '../../../services/infra/debug.js'
import { isThinkingMessage } from '../../messages/predicates.js'
import { jsonStringify } from '../../../services/infra/slowOperations.js'
import { isPDFExtension } from '../../attachments/pdfUtils.js'
import { getPDFPageCount } from '../../attachments/pdf.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../../../constants/apiLimits.js'
import { isInternalBuild } from '../../../services/infra/envUtils.js'
import {
  AlreadyReadFileAttachment,
  Attachment,
  BRIEF_TOOL_NAME,
  CompactFileReferenceAttachment,
  FileAttachment,
  PDFReferenceAttachment,
  TODO_REMINDER_CONFIG,
} from './types.js'
import { getAttachments } from './collection.js'
import { isFileReadDenied } from './skills.js'
/**
 * Get LSP diagnostic attachments from passive LSP servers.
 * Follows the AsyncHookRegistry pattern for consistent async attachment delivery.
 */
export async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 仅当代理有 Bash 工具可操作时 LSP 诊断才有用
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, BASH_TOOL_NAME))) {
    return []
  }
  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')
  try {
    const diagnosticSets = checkForLSPDiagnostics()
    if (diagnosticSets.length === 0) {
      return []
    }
    logForDebugging(`LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`)

    // 将每个诊断集转换为附件
    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // 从注册表清除已交付的诊断以防止内存泄漏
    // 遵循与 removeDeliveredAsyncHooks 相同的模式
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }
    logForDebugging(`LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`)
    return attachments
  } catch (error) {
    const err = toError(error)
    logError(new Error(`Failed to get LSP diagnostic attachments: ${err.message}`))
    // 返回空数组以允许其他附件继续进行
    return []
  }
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: {
    skipSkillDiscovery?: boolean
  },
): AsyncGenerator<AttachmentMessage, void> {
  // TODO：在上游计算此值
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )
  if (attachments.length === 0) {
    return
  }
  logEvent('zy_attachments', {
    attachment_types: attachments.map(
      (_) => _.type,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

/**
 * Generates a file attachment by reading a file with proper validation and truncation.
 * This is the core file reading logic shared between @-mentioned files and post-compact restoration.
 *
 * @param filename The absolute path to the file to read
 * @param toolUseContext The tool use context for calling FileReadTool
 * @param options Optional configuration for file reading
 * @returns A new_file attachment or null if the file couldn't be read
 */
/**
 * Check if a PDF file should be represented as a lightweight reference
 * instead of being inlined. Returns a PDFReferenceAttachment for large PDFs
 * (more than PDF_AT_MENTION_INLINE_THRESHOLD pages), or null otherwise.
 */
export async function tryGetPDFReference(filename: string): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) {
    return null
  }
  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    // 如果有页数则使用，否则回退到大小启发式（每页约 100KB）
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      logEvent('zy_pdf_reference_attachment', {
        pageCount: effectivePageCount,
        fileSize: stats.size,
        hadPdfinfo: pageCount !== null,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
    // 如果无法 stat 文件，返回 null 以继续正常读取
  }
  return null
}

export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  successEventName: string,
  errorEventName: string,
  mode: 'compact' | 'at-mention',
  options?: {
    offset?: number
    limit?: number
  },
): Promise<
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | null
> {
  const { offset, limit } = options ?? {}

  // 检查文件是否配置了拒绝规则
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // 读取前检查文件大小（跳过 PDF — 它们有自己的大小/页数处理）
  if (
    mode === 'at-mention' &&
    !isFileWithinReadSizeLimit(filename, getDefaultFileReadingLimits().maxSizeBytes)
  ) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      try {
        const stats = await getFsImplementation().stat(filename)
        logEvent('zy_attachment_file_too_large', {
          size_bytes: stats.size,
          mode,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        return null
      } catch {
        // 如果无法 stat 文件，继续正常读取（如果文件不存在，稍后会失败）
      }
    }
  }

  // 对于 @ 提及的大型 PDF，返回轻量引用而非内联
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  // 检查文件是否已在上下文中且为最新版本
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      // 检查文件自上次读取后是否已修改
      const mtimeMs = await getFileModificationTimeAsync(filename)

      // 处理时间戳格式不一致：
      // - FileReadTool 存储 Date.now()（读取时的当前时间）
      // - FileEdit/WriteTools 存储 mtimeMs（文件修改时间）
      //
      // 如果 timestamp > mtimeMs，它由 FileReadTool 使用 Date.now() 存储
      // 此时不应使用优化，因为无法可靠比较修改时间。
      // 仅当 timestamp <= mtimeMs 时使用优化，
      // 表示它由 FileEdit/WriteTool 使用实际 mtimeMs 存储。

      if (existingFileState.timestamp <= mtimeMs && mtimeMs === existingFileState.timestamp) {
        // 文件未修改，返回 already_read_file 附件
        // 这告诉系统文件已在上下文中，无需发送到 API
        logEvent(successEventName, {})
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines: countCharInString(existingFileState.content, '\n') + 1,
            },
          },
        }
      }
    } catch {
      // 如果无法 stat 文件，继续正常读取
    }
  }
  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit,
    }
    async function readTruncatedFile(): Promise<
      FileAttachment | CompactFileReferenceAttachment | AlreadyReadFileAttachment | null
    > {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename),
        }
      }

      // 读取截断文件前检查拒绝规则
      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }
      try {
        // 对于过大的文件仅读取前 MAX_LINES_TO_READ 行
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ,
        }
        const result = await FileReadTool.call(truncatedInput, toolUseContext)
        logEvent(successEventName, {})
        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename),
        }
      } catch {
        logEvent(errorEventName, {})
        return null
      }
    }

    // 验证文件路径有效
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }
    try {
      const result = await FileReadTool.call(fileInput, toolUseContext)
      logEvent(successEventName, {})
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename),
      }
    } catch (error) {
      if (error instanceof MaxFileReadTokenExceededError || error instanceof FileTooLargeError) {
        return await readTruncatedFile()
      }
      throw error
    }
  } catch {
    logEvent(errorEventName, {})
    return null
  }
}

export function createAttachmentMessage(attachment: Attachment): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as AttachmentMessage
}

export function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  // 反向迭代以查找最近的事件（TodoWrite 提醒检查）
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // 跳过思考消息
        continue
      }

      // 在计数器递增之前检查 TodoWrite 使用情况
      //（我们不希望将 TodoWrite 消息本身计为"写入后 1 轮"）
      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) => block.type === 'tool_call' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      // 在找到事件之前递增 assistant 轮次计数
      if (lastTodoWriteIndex === -1) {
        assistantTurnsSinceWrite++
      }
      if (lastReminderIndex === -1) {
        assistantTurnsSinceReminder++
      }
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'todo_reminder'
    ) {
      lastReminderIndex = i
    }
    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }
  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 如果 TodoWrite 工具不可用则跳过
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, TODO_WRITE_TOOL_NAME))) {
    return []
  }

  // 当 SendUserMessage 在工具集中时，它是主要通信渠道，
  // 模型总是被告知使用它（#20467）。TodoWrite 变成辅助渠道 —
  // 提示模型使用它会与 brief 工作流冲突。工具本身保持可用；
  // 此处仅门控"你很久没用它了"的提醒。
  const briefToolName = BRIEF_TOOL_NAME
  if (
    briefToolName &&
    toolUseContext.options.tools.some((t) => toolMatchesName(t, briefToolName))
  ) {
    return []
  }

  // 如果未提供消息则跳过
  if (!messages || messages.length === 0) {
    return []
  }
  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } = getTodoReminderTurnCounts(messages)

  // 检查是否应显示提醒
  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []
    return [
      {
        type: 'todo_reminder',
        content: todos,
        itemCount: todos.length,
      },
    ]
  }
  return []
}

export function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  // 反向迭代以查找最近的事件（TodoWrite 提醒检查）
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // 跳过思考消息
        continue
      }

      // 在计数器递增之前检查 TaskCreate 或 TaskUpdate 使用情况
      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) =>
            block.type === 'tool_call' &&
            (block.name === TASK_CREATE_TOOL_NAME || block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      // 在找到事件之前递增 assistant 轮次计数
      if (lastTaskManagementIndex === -1) {
        assistantTurnsSinceTaskManagement++
      }
      if (lastReminderIndex === -1) {
        assistantTurnsSinceReminder++
      }
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'task_reminder'
    ) {
      lastReminderIndex = i
    }
    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }
  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

export async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  // 跳过 ant 用户
  if (isInternalBuild()) {
    return []
  }

  // 当 SendUserMessage 在工具集中时，它是主要通信渠道，
  // 模型总是被告知使用它（#20467）。TaskUpdate 变成辅助渠道 —
  // 提示模型使用它会与 brief 工作流冲突。工具本身保持可用；
  // 此处仅门控提醒。
  const briefToolName = BRIEF_TOOL_NAME
  if (
    briefToolName &&
    toolUseContext.options.tools.some((t) => toolMatchesName(t, briefToolName))
  ) {
    return []
  }

  // 如果 TaskUpdate 工具不可用则跳过
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, TASK_UPDATE_TOOL_NAME))) {
    return []
  }

  // 如果未提供消息则跳过
  if (!messages || messages.length === 0) {
    return []
  }
  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  // 检查是否应显示提醒
  if (
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())
    return [
      {
        type: 'task_reminder',
        content: tasks,
        itemCount: tasks.length,
      },
    ]
  }
  return []
}

/**
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
export async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)
  applyTaskOffsetsAndEvictions(toolUseContext.setAppState, updatedTaskOffsets, evictedTaskIds)

  // 将 TaskAttachment 转换为 Attachment 格式
  return attachments.map((taskAttachment) => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

export async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()
  if (responses.length === 0) {
    return []
  }
  logForDebugging(`Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`)
  const attachments = responses.map(
    ({
      processId,
      response,
      hookName,
      hookEvent,
      toolName,
      pluginId,
      stdout,
      stderr,
      exitCode,
    }) => {
      logForDebugging(
        `Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`,
      )
      return {
        type: 'async_hook_response' as const,
        processId,
        hookName,
        hookEvent,
        toolName,
        response,
        stdout,
        stderr,
        exitCode,
      }
    },
  )

  // 从注册表移除已交付的 hook 以防止重新处理
  if (responses.length > 0) {
    const processIds = responses.map((r) => r.processId)
    removeDeliveredAsyncHooks(processIds)
    logForDebugging(`Hooks: Removed ${processIds.length} delivered hooks from registry`)
  }
  logForDebugging(`Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`)
  return attachments
}
