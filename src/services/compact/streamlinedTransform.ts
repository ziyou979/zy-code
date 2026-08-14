/**
 * 将 SDK 消息转换为 streamlined 输出模式。
 *
 * Streamlined 模式是一种“抗蒸馏”的输出格式：
 * - 完整保留文本消息
 * - 以累计数量汇总 tool 调用（出现文本时重置）
 * - 省略 thinking 内容
 * - 从 init 消息中移除 tool 列表和模型信息
 */

import { SHELL_TOOL_NAMES } from 'src/shell-eval/shared/shellToolUtils.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from 'src/tools/ListMcpResourcesTool/prompt.js'
import { LSP_TOOL_NAME } from 'src/tools/LSPTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { TASK_STOP_TOOL_NAME } from 'src/tools/TaskStopTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import type { WireAssistantMessage } from 'src/types/index.js'
import type { StdoutMessage } from 'src/types/wire/control.js'
import { extractTextContent } from 'src/services/messages/predicates.js'
import { capitalize } from 'src/utils/stringUtils.js'

type ToolCounts = {
  searches: number
  reads: number
  writes: number
  commands: number
  other: number
}

/**
 * 用于生成摘要的 tool 分类。
 */
const SEARCH_TOOLS = [GREP_TOOL_NAME, GLOB_TOOL_NAME, WEB_SEARCH_TOOL_NAME, LSP_TOOL_NAME]
const READ_TOOLS = [FILE_READ_TOOL_NAME, LIST_MCP_RESOURCES_TOOL_NAME]
const WRITE_TOOLS = [FILE_WRITE_TOOL_NAME, FILE_EDIT_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME]
const COMMAND_TOOLS = [...SHELL_TOOL_NAMES, 'Tmux', TASK_STOP_TOOL_NAME]

function categorizeToolName(toolName: string): keyof ToolCounts {
  if (SEARCH_TOOLS.some((t) => toolName.startsWith(t))) {
    return 'searches'
  }
  if (READ_TOOLS.some((t) => toolName.startsWith(t))) {
    return 'reads'
  }
  if (WRITE_TOOLS.some((t) => toolName.startsWith(t))) {
    return 'writes'
  }
  if (COMMAND_TOOLS.some((t) => toolName.startsWith(t))) {
    return 'commands'
  }
  return 'other'
}

function createEmptyToolCounts(): ToolCounts {
  return {
    searches: 0,
    reads: 0,
    writes: 0,
    commands: 0,
    other: 0,
  }
}

/**
 * 根据 tool 调用次数生成摘要文本。
 */
function getToolSummaryText(counts: ToolCounts): string | undefined {
  const parts: string[] = []

  // 使用与 collapseReadSearch.ts 相近的措辞。
  if (counts.searches > 0) {
    parts.push(`searched ${counts.searches} ${counts.searches === 1 ? 'pattern' : 'patterns'}`)
  }
  if (counts.reads > 0) {
    parts.push(`read ${counts.reads} ${counts.reads === 1 ? 'file' : 'files'}`)
  }
  if (counts.writes > 0) {
    parts.push(`wrote ${counts.writes} ${counts.writes === 1 ? 'file' : 'files'}`)
  }
  if (counts.commands > 0) {
    parts.push(`ran ${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`)
  }
  if (counts.other > 0) {
    parts.push(`${counts.other} other ${counts.other === 1 ? 'tool' : 'tools'}`)
  }

  if (parts.length === 0) {
    return undefined
  }

  return capitalize(parts.join(', '))
}

/**
 * 统计 assistant 消息中的 tool 调用，并累加到现有计数。
 */
function accumulateToolUses(message: WireAssistantMessage, counts: ToolCounts): void {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    if (block.type === 'tool_call' && 'name' in block) {
      const category = categorizeToolName(block.name as string)
      counts[category]++
    }
  }
}

/**
 * 创建有状态转换器，在两条文本消息之间累计 tool 调用次数。
 * 遇到包含文本内容的消息时重置计数。
 */
export function createStreamlinedTransformer(): (message: StdoutMessage) => StdoutMessage | null {
  let cumulativeCounts = createEmptyToolCounts()

  return function transformToStreamlined(message: StdoutMessage): StdoutMessage | null {
    switch (message.type) {
      case 'assistant': {
        const content = message.message.content
        const text = Array.isArray(content) ? extractTextContent(content, '\n').trim() : ''

        // 累加当前消息中的 tool 调用次数。
        accumulateToolUses(message, cumulativeCounts)

        if (text.length > 0) {
          // 文本消息：仅输出文本并重置计数。
          cumulativeCounts = createEmptyToolCounts()
          return {
            type: 'streamlined_text',
            text,
            session_id: message.session_id,
            uuid: message.uuid,
          }
        }

        // 仅含 tool 的消息：输出累计 tool 摘要。
        const toolSummary = getToolSummaryText(cumulativeCounts)
        if (!toolSummary) {
          return null
        }

        return {
          type: 'streamlined_tool_use_summary',
          tool_summary: toolSummary,
          session_id: message.session_id,
          uuid: message.uuid,
        }
      }

      case 'result':
        // result 消息包含 structured_output、permission_denials，保持原样。
        return message

      case 'system':
      case 'user':
      case 'stream_event':
      case 'tool_progress':
      case 'auth_status':
      case 'rate_limit_event':
      case 'control_response':
      case 'control_request':
      case 'control_cancel_request':
      case 'keep_alive':
        return null

      default:
        return null
    }
  }
}

/**
 * 检查消息是否应包含在 streamlined 输出中。
 * 可用于转换前的过滤。
 */
export function shouldIncludeInStreamlined(message: StdoutMessage): boolean {
  return message.type === 'assistant' || message.type === 'result'
}
