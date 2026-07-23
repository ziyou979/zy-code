import {
  getFileExtensionForAnalytics,
  getFileExtensionsFromBashCommand,
} from 'src/services/analytics/metadata.js'
import type { Tool, ToolResult } from '../../tools/tool.js'
import type { BashToolInput } from '../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { parseGitCommitId } from '../../tools/shared/gitOperationTracking.js'
import { isToolDetailsLoggingEnabled } from 'src/services/analytics/metadata.js'
import { addToolContentEvent } from '../telemetry/sessionTracing.js'
import { createDebugLog } from '../../services/infra/debug.js'

const toolLog = createDebugLog('tools')

/** hook 总耗时达到此阈值（毫秒）才在行内展示计时汇总 */
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500

/**
 * 记录工具输出的内容事件到 telemetry。
 */
export function recordToolContentEvent(
  tool: Tool,
  processedInput: { [key: string]: unknown },
  result: ToolResult<unknown>,
): void {
  if (!result.data || typeof result.data !== 'object') {
    return
  }

  const contentAttributes: Record<string, string | number | boolean> = {}

  if (tool.name === FILE_READ_TOOL_NAME && 'content' in result.data) {
    if ('file_path' in processedInput) {
      contentAttributes.file_path = String(processedInput.file_path)
    }
    contentAttributes.content = String(result.data.content)
  }

  if (
    (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) &&
    'file_path' in processedInput
  ) {
    contentAttributes.file_path = String(processedInput.file_path)

    if (tool.name === FILE_EDIT_TOOL_NAME && 'diff' in result.data) {
      contentAttributes.diff = String(result.data.diff)
    }
    if (tool.name === FILE_WRITE_TOOL_NAME && 'content' in processedInput) {
      contentAttributes.content = String(processedInput.content)
    }
  }

  if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
    const bashInput = processedInput as BashToolInput
    contentAttributes.bash_command = bashInput.command
    if ('output' in result.data) {
      contentAttributes.output = String(result.data.output)
    }
  }

  if (Object.keys(contentAttributes).length > 0) {
    addToolContentEvent('tool.output', contentAttributes)
  }
}

/**
 * 获取工具结果的扩展名（用于 telemetry）。
 */
export function getFileExtensionForToolResult(
  tool: Tool,
  processedInput: { [key: string]: unknown },
): ReturnType<typeof getFileExtensionForAnalytics> {
  if (tool.name === FILE_READ_TOOL_NAME && 'file_path' in processedInput) {
    return getFileExtensionForAnalytics(String(processedInput.file_path))
  }
  if (
    (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) &&
    'file_path' in processedInput
  ) {
    return getFileExtensionForAnalytics(String(processedInput.file_path))
  }
  if (tool.name === NOTEBOOK_EDIT_TOOL_NAME && 'notebook_path' in processedInput) {
    return getFileExtensionForAnalytics(String(processedInput.notebook_path))
  }
  if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
    const bashInput = processedInput as BashToolInput
    return getFileExtensionsFromBashCommand(
      bashInput.command,
      bashInput._simulatedSedEdit?.filePath,
    )
  }
  return undefined
}

/**
 * 当工具执行包含 git commit 时，尝试提取 commit id 并补充到工具参数中。
 */
export function maybeEnrichGitCommitId(
  tool: Tool,
  processedInput: { [key: string]: unknown },
  result: ToolResult<unknown>,
  toolParameters: Record<string, unknown>,
): void {
  if (
    !isToolDetailsLoggingEnabled() ||
    (tool.name !== BASH_TOOL_NAME && tool.name !== POWERSHELL_TOOL_NAME) ||
    !('command' in processedInput) ||
    typeof processedInput.command !== 'string' ||
    !processedInput.command.match(/\bgit\s+commit\b/) ||
    !result.data ||
    typeof result.data !== 'object' ||
    !('stdout' in result.data)
  ) {
    return
  }
  const gitCommitId = parseGitCommitId(String(result.data.stdout))
  if (gitCommitId) {
    toolParameters.git_commit_id = gitCommitId
  }
}
