import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { tSync } from '../i18n/index.js'
import { findToolByName, type Tools } from '../tool.js'
import { extractBashCommentLabel } from '../tools/BashTool/commentLabel.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import { getReplPrimitiveTools } from '../tools/REPLTool/primitiveTools.js'
import {
  type BranchAction,
  type CommitKind,
  detectGitOperation,
  type PrAction,
} from '../tools/shared/gitOperationTracking.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import type { ContentBlock } from '../types/llm.js'
import type {
  AssistantMessage,
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  GroupedToolUseMessage,
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
} from '../types/message.js'
import { getDisplayPath } from './file.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from './memoryFileDetection.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemOps = feature('TEAMMEM')
  ? (require('./teamMemoryOps.js') as typeof import('./teamMemoryOps.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 检查工具调用是否为搜索或读取操作的结果。
 */
export type SearchOrReadResult = {
  isCollapsible: boolean
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  /** 当目标为 memory 文件的 Write/Edit 操作时为 true */
  isMemoryWrite: boolean
  /**
   * 对于应被静默吸收进 collapse 分组的元操作为 true，
   * 不会递增任何计数（ToolSearch）。在详细模式下
   * 通过 groupMessages 迭代仍然可见。
   */
  isAbsorbedSilently: boolean
  /** 当为 MCP 工具时的 MCP server 名称 */
  mcpServerName?: string
  /** 全屏模式下非搜索/读取类的 Bash 命令 */
  isBash?: boolean
}

/**
 * 从 tool_use 输入中提取主要的文件/目录路径。
 * 同时处理 `file_path`（Read/Write/Edit）和 `path`（Grep/Glob）两种字段。
 */
function getFilePathFromToolInput(toolInput: unknown): string | undefined {
  const input = toolInput as
    | { file_path?: string; path?: string; pattern?: string; glob?: string }
    | undefined
  return input?.file_path ?? input?.path
}

/**
 * 检查搜索类工具调用是否以 memory 文件为目标，通过检查其 path、pattern 和 glob 判断。
 */
function isMemorySearch(toolInput: unknown): boolean {
  const input = toolInput as
    | { path?: string; pattern?: string; glob?: string; command?: string }
    | undefined
  if (!input) {
    return false
  }
  // 检查搜索路径是否指向 memory 文件或目录（Grep/Glob 工具）
  if (input.path) {
    if (isAutoManagedMemoryFile(input.path) || isMemoryDirectory(input.path)) {
      return true
    }
  }
  // 检查 glob 模式是否表明访问 memory 文件
  if (input.glob && isAutoManagedMemoryPattern(input.glob)) {
    return true
  }
  // 对于 shell 命令（bash grep/rg、PowerShell Select-String 等），
  // 检查命令是否以 memory 路径为目标
  if (input.command && isShellCommandTargetingMemory(input.command)) {
    return true
  }
  return false
}

/**
 * 检查 Write 或 Edit 工具调用是否以 memory 文件为目标，并应被折叠。
 */
function isMemoryWriteOrEdit(toolName: string, toolInput: unknown): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  const filePath = getFilePathFromToolInput(toolInput)
  return filePath !== undefined && isAutoManagedMemoryFile(filePath)
}

// 约 5 行 x 60 列。宽松的静态上限 - 渲染器让 Ink 自动换行。
const MAX_HINT_CHARS = 300

/**
 * 将 bash 命令格式化为 ⎿ 提示文本。删除空行，折叠连续行内空白，
 * 然后截断总长度。保留换行符以便渲染器在 ⎿ 下方缩进续行。
 */
function commandAsHint(command: string): string {
  const cleaned =
    '$ ' +
    command
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l !== '')
      .join('\n')
  return cleaned.length > MAX_HINT_CHARS ? `${cleaned.slice(0, MAX_HINT_CHARS - 1)}…` : cleaned
}

/**
 * 使用工具的 isSearchOrReadCommand 方法检查工具是否为搜索/读取操作。
 * 同时将 memory 文件的 Write/Edit 视为可折叠。
 * 返回该操作是否为搜索或读取的详细信息。
 */
export function getToolSearchOrReadInfo(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): SearchOrReadResult {
  // REPL 被静默吸收 - 其内部工具调用通过 newMessages 以虚拟消息
  // （isVirtual: true）的形式发出，并作为普通的 Read/Grep/Bash 消息
  // 流经本函数。REPL 包装器本身不贡献计数且不打断分组，
  // 因此连续的 REPL 调用会合并。
  if (toolName === REPL_TOOL_NAME) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: true,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // Memory 文件的写入/编辑是可折叠的
  if (isMemoryWriteOrEdit(toolName, toolInput)) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: true,
      isAbsorbedSilently: false,
    }
  }

  // 静默吸收的元操作：ToolSearch（延迟加载工具 schema）。
  // 不应打断 collapse 分组或贡献计数，但在详细模式下仍然可见。
  if (isFullscreenEnvEnabled() && toolName === TOOL_SEARCH_TOOL_NAME) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // 回退到 REPL 基础工具：在 REPL 模式下，Bash/Read/Grep 等
  // 已从执行工具列表中移除，但 REPL 以虚拟消息形式发出它们。
  // 若无此回退，它们将返回 isCollapsible: false 并从摘要行中消失。
  const tool = findToolByName(tools, toolName) ?? findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool?.isSearchOrReadCommand) {
    return {
      isCollapsible: false,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: false,
    }
  }
  // 工具的 isSearchOrReadCommand 方法通过 safeParse 自行处理输入校验，
  // 因此传入原始 input 是安全的。类型断言是必要的，因为 Tool[] 使用
  // 默认泛型，期望 { [x: string]: any }，但运行时我们接收到的是 unknown。
  const result = tool.isSearchOrReadCommand(toolInput as { [x: string]: unknown })
  const isList = result.isList ?? false
  const isCollapsible = result.isSearch || result.isRead || isList
  // 在全屏模式下，非搜索/读取类的 Bash 命令也作为独立类别可折叠
  // — 显示 "Ran N bash commands" 而非打断分组。
  return {
    isCollapsible:
      isCollapsible || (isFullscreenEnvEnabled() ? toolName === BASH_TOOL_NAME : false),
    isSearch: result.isSearch,
    isRead: result.isRead,
    isList,
    isREPL: false,
    isMemoryWrite: false,
    isAbsorbedSilently: false,
    ...(tool.isMcp && { mcpServerName: tool.mcpInfo?.serverName }),
    isBash: isFullscreenEnvEnabled() ? !isCollapsible && toolName === BASH_TOOL_NAME : undefined,
  }
}

/**
 * 检查 tool_use 内容块是否为搜索/读取操作。
 * 如果是可折叠的搜索/读取则返回 { isSearch, isRead, isREPL }，否则返回 null。
 */
export function getSearchOrReadFromContent(
  content: { type: string; name?: string; input?: unknown } | undefined,
  tools: Tools,
): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (content?.type === 'tool_call' && content.name) {
    const info = getToolSearchOrReadInfo(content.name, content.input, tools)
    if (info.isCollapsible || info.isREPL) {
      return {
        isSearch: info.isSearch,
        isRead: info.isRead,
        isList: info.isList,
        isREPL: info.isREPL,
        isMemoryWrite: info.isMemoryWrite,
        isAbsorbedSilently: info.isAbsorbedSilently,
        mcpServerName: info.mcpServerName,
        isBash: info.isBash,
      }
    }
  }
  return null
}

/**
 * 检查工具是否为搜索/读取操作（用于向后兼容）。
 */
function isToolSearchOrRead(toolName: string, toolInput: unknown, tools: Tools): boolean {
  return getToolSearchOrReadInfo(toolName, toolInput, tools).isCollapsible
}

/**
 * 从消息中获取可折叠工具调用的工具名称、输入及搜索/读取信息。
 * 如果消息不是可折叠的工具调用则返回 null。
 */
function getCollapsibleToolInfo(
  msg: RenderableMessage,
  tools: Tools,
): {
  name: string
  input: unknown
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    const info = getSearchOrReadFromContent(content, tools)
    if (info && content && content.type === 'tool_call') {
      return { name: content.name, input: content.input, ...info }
    }
  }
  if (msg.type === 'grouped_tool_use') {
    // 对于分组工具调用，检查第一条消息的 input。
    // type === 'grouped_tool_use' 收窄为 GroupedToolUseMessage | GroupedToolUseMessageWithMessages，
    // 两者均有 .messages 和 .toolName。
    const firstContent = msg.messages[0]?.message.content[0]
    if (firstContent?.type === 'tool_call') {
      const info = getSearchOrReadFromContent(
        { type: 'tool_call', name: msg.toolName, input: firstContent.input },
        tools,
      )
      if (info) {
        return { name: msg.toolName, input: firstContent.input, ...info }
      }
    }
  }
  return null
}

/**
 * 检查消息是否为应打断分组的助手文本。
 */
function isTextBreaker(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content && content.type === 'text' && content.text.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * 检查消息是否为应打断分组的不可折叠工具调用。
 * 包括 Edit、Write 等工具调用。
 */
function isNonCollapsibleToolUse(msg: RenderableMessage, tools: Tools): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (
      content &&
      content.type === 'tool_call' &&
      !isToolSearchOrRead(content.name, content.input, tools)
    ) {
      return true
    }
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    if (
      firstContent?.type === 'tool_call' &&
      !isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    ) {
      return true
    }
  }
  return false
}

/**
 * 检查不可折叠工具是否为"静默"工具（UI 不可见）。
 * 静默工具的 renderToolUseMessage() 返回 null，在折叠摘要中不应打断分组，
 * 而应被静默吸收到当前分组中，避免产生孤立的纯思考折叠块。
 */
function isSilentNonCollapsibleToolUse(msg: RenderableMessage, tools: Tools): boolean {
  if (!isNonCollapsibleToolUse(msg, tools)) return false
  // 提取工具名
  let toolName: string | undefined
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_call') toolName = content.name
  } else if (msg.type === 'grouped_tool_use') {
    toolName = msg.toolName
  }
  if (!toolName) return false
  const tool = findToolByName(tools, toolName) ?? findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool) return false
  // 工具的 renderToolUseMessage 返回 null 意味着 UI 不可见。
  // 注意：renderToolUseMessage 是 Tool 的必需属性（无 ? ），每个工具都定义了它。
  // 检查属性 == null 只能判断属性是否存在（永远 false ），需要调用函数
  // 并判断返回值是否为 null 才能识别"静默工具"。
  // 必须使用消息中的真实 input（而非 {} ），因为 FileEditTool 等工具在
  // file_path 为空时会返回 null，导致被误识别为静默工具。
  let toolInput: unknown
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_call') toolInput = content.input
  } else if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    if (firstContent?.type === 'tool_call') toolInput = firstContent.input
  }
  try {
    const rendered = tool.renderToolUseMessage(toolInput as Record<string, unknown>, {
      theme: 'light',
      verbose: false,
    })
    return rendered === null
  } catch {
    // 某些工具的 renderToolUseMessage 可能因缺少必要 input 抛出异常，
    // 这种情况下视为非静默工具
    return false
  }
}

function isPreToolHookSummary(msg: RenderableMessage): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' && msg.subtype === 'stop_hook_summary' && msg.hookLabel === 'PreToolUse'
  )
}

/**
 * 检查消息是否为普通 thinking 块（非 redacted_thinking）。
 */
function isThinkingBlock(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    return content?.type === 'thinking' && !!content.thinking?.trim()
  }
  return false
}

/**
 * 从 assistant 消息中提取 thinking 文本。
 */
function extractThinkingText(msg: RenderableMessage): string | undefined {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'thinking') return content.thinking
  }
  return undefined
}

/**
 * 检查消息是否应被跳过（不打断分组，直接透传）。
 * 包括 redacted_thinking、附件、系统消息等。
 */
function shouldSkipMessage(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    // redacted_thinking 是加密内容，无可见文本，跳过
    if (content && content.type === 'redacted_thinking') {
      return true
    }
  }
  // 跳过附件消息
  if (msg.type === 'attachment') {
    return true
  }
  // 跳过系统消息
  if (msg.type === 'system') {
    return true
  }
  return false
}

/**
 * 类型谓词：检查消息是否为可折叠的工具调用。
 */
function isCollapsibleToolUse(msg: RenderableMessage, tools: Tools): msg is CollapsibleMessage {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    return (
      !!content &&
      content.type === 'tool_call' &&
      isToolSearchOrRead(content.name, content.input, tools)
    )
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    return (
      firstContent?.type === 'tool_call' &&
      isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    )
  }
  return false
}

/**
 * 类型谓词：检查消息是否为可折叠工具的工具结果。
 * 仅当消息中所有工具结果都属于已追踪的可折叠工具时返回 true。
 */
function isCollapsibleToolResult(
  msg: RenderableMessage,
  collapsibleToolUseIds: Set<string>,
): msg is CollapsibleMessage {
  if (msg.type === 'user') {
    const toolResults = (msg.message.content as ContentBlock[]).filter(
      (c): c is { type: 'tool_result'; toolCallId: string } => c.type === 'tool_result',
    )
    // 仅当存在工具结果且所有结果都属于可折叠工具时返回 true
    return (
      toolResults.length > 0 && toolResults.every((r) => collapsibleToolUseIds.has(r.toolCallId))
    )
  }
  return false
}

/**
 * 检查工具结果是否全部属于已被标记为静默吸收的 tool_use。
 */
function isSilentToolResult(
  msg: RenderableMessage,
  absorbedSilentToolUseIds: Set<string>,
): boolean {
  if (msg.type !== 'user') {
    return false
  }
  const toolResults = (msg.message.content as ContentBlock[]).filter(
    (c): c is { type: 'tool_result'; toolCallId: string } => c.type === 'tool_result',
  )
  return (
    toolResults.length > 0 && toolResults.every((r) => absorbedSilentToolUseIds.has(r.toolCallId))
  )
}

/**
 * 从单条消息中获取所有工具调用 ID（处理分组工具调用）。
 */
function getToolUseIdsFromMessage(msg: RenderableMessage): string[] {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content && content.type === 'tool_call') {
      return [content.id]
    }
  }
  if (msg.type === 'grouped_tool_use') {
    return msg.messages
      .map((m) => {
        const content = m.message.content[0]
        return content?.type === 'tool_call' ? content.id : ''
      })
      .filter(Boolean)
  }
  return []
}

/**
 * 从已折叠的读取/搜索分组中获取所有工具调用 ID。
 */
export function getToolUseIdsFromCollapsedGroup(message: CollapsedReadSearchGroup): string[] {
  const ids: string[] = []
  for (const msg of message.messages ?? []) {
    ids.push(...getToolUseIdsFromMessage(msg))
  }
  return ids
}

/**
 * 检查折叠分组中是否有任何工具正在执行中。
 */
export function hasAnyToolInProgress(
  message: CollapsedReadSearchGroup,
  inProgressToolUseIDs: Set<string>,
): boolean {
  return getToolUseIdsFromCollapsedGroup(message).some((id) => inProgressToolUseIDs.has(id))
}

/**
 * 获取用于显示的底层 Message（时间戳/模型）。
 * 处理折叠分组中嵌套的 GroupedToolUseMessage。
 * 返回 AssistantMessage 或 UserMessage（不会是 GroupedToolUseMessage）。
 */
export function getDisplayMessageFromCollapsed(
  message: CollapsedReadSearchGroup,
): Exclude<CollapsibleMessage, { type: 'grouped_tool_use' }> {
  const firstMsg = message.displayMessage
  if (!firstMsg) {
    throw new Error('CollapsedReadSearchGroup has no displayMessage')
  }
  const msgType: string = firstMsg.type
  if (msgType === 'grouped_tool_use') {
    return (firstMsg as unknown as GroupedToolUseMessage).displayMessage
  }
  return firstMsg as Exclude<CollapsibleMessage, { type: 'grouped_tool_use' }>
}

/**
 * 统计消息中的工具调用数量（处理分组工具调用）。
 */
function countToolUses(msg: RenderableMessage): number {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.length
  }
  return 1
}

/**
 * 从消息中的读取工具输入提取文件路径。
 * 返回文件路径数组（如果同一文件在一个分组消息中被多次读取，可能包含重复项）。
 */
function getFilePathsFromReadMessage(msg: RenderableMessage): string[] {
  const paths: string[] = []

  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content && content.type === 'tool_call') {
      const input = content.input as { file_path?: string } | undefined
      if (input?.file_path) {
        paths.push(input.file_path)
      }
    }
  } else if (msg.type === 'grouped_tool_use') {
    for (const m of (msg as GroupedToolUseMessage).messages) {
      const content = m.message.content[0]
      if (content && content.type === 'tool_call') {
        const input = content.input as { file_path?: string } | undefined
        if (input?.file_path) {
          paths.push(input.file_path)
        }
      }
    }
  }

  return paths
}

/**
 * 扫描 bash 工具结果中的 commit SHA 和 PR URL，并推入分组累加器。
 * 仅对 tool_use_id 已记录在 bashCommands 中（非搜索/读取类 bash）的结果调用。
 */
function scanBashResultForGitOps(msg: RenderableMessage, group: GroupAccumulator): void {
  if (msg.type !== 'user') {
    return
  }
  const out = msg.toolUseResult as { stdout?: string; stderr?: string } | undefined
  if (!out?.stdout && !out?.stderr) {
    return
  }
  // git push 将 ref 更新写入 stderr — 两个输出流都需扫描。
  const combined = `${out.stdout ?? ''}\n${out.stderr ?? ''}`
  for (const c of msg.message.content) {
    if (c.type !== 'tool_result') {
      continue
    }
    const command = group.bashCommands?.get(c.toolCallId)
    if (!command) {
      continue
    }
    const { commit, push, branch, pr } = detectGitOperation(command, combined)
    if (commit) {
      group.commits?.push(commit)
    }
    if (push) {
      group.pushes?.push(push)
    }
    if (branch) {
      group.branches?.push(branch)
    }
    if (pr) {
      group.prs?.push(pr)
    }
    if (commit || push || branch || pr) {
      group.gitOpBashCount = (group.gitOpBashCount ?? 0) + 1
    }
  }
}

type GroupAccumulator = {
  messages: CollapsibleMessage[]
  searchCount: number
  readFilePaths: Set<string>
  // 没有文件路径的读取操作计数（例如 Bash cat 命令）
  readOperationCount: number
  // 目录列表操作计数（ls、tree、du）
  listCount: number
  toolUseIds: Set<string>
  // Memory 文件操作计数（与常规计数分开追踪）
  memorySearchCount: number
  memoryReadFilePaths: Set<string>
  memoryWriteCount: number
  // 团队 memory 文件操作计数（分开追踪）
  teamMemorySearchCount?: number
  teamMemoryReadFilePaths?: Set<string>
  teamMemoryWriteCount?: number
  // 非 memory 搜索模式，显示在折叠摘要下方
  nonMemSearchArgs: string[]
  /** 最近添加的非 memory 操作，预格式化用于显示 */
  latestDisplayHint: string | undefined
  /** 最近一次可展示的活动类型，用于活跃折叠块在 thinking/tool 间切换提示 */
  latestDisplayKind?: 'thinking' | 'tool'
  // MCP 工具调用（分开追踪，以便显示 "Queried slack" 而非 "Read N files"）
  mcpCallCount?: number
  mcpServerNames?: Set<string>
  // 非搜索/读取类 Bash 命令（分开追踪，用于 "Ran N bash commands"）
  bashCount?: number
  // Bash tool_use_id -> command 字符串映射，以便扫描工具结果中的
  // commit SHA / PR URL（展示为 "committed abc123, created PR #42"）
  bashCommands?: Map<string, string>
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  gitOpBashCount?: number
  // 从 hook 摘要消息中吸收的 PreToolUse hook 耗时
  hookTotalMs: number
  hookCount: number
  hookInfos: StopHookInfo[]
  // 从相邻消息 timestamp 差值计算的 thinking 时长
  thoughtForMs?: number
  // 最近一次 thinking 文本摘要
  latestThinkingSummary?: string
  // 吸收到本分组中的 relevant_memories 附件（自动注入的
  // memory，非显式 Read 调用）。路径同步到 readFilePaths +
  // memoryReadFilePaths，以确保内联 "recalled N memories" 文本准确。
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

function createEmptyGroup(): GroupAccumulator {
  const group: GroupAccumulator = {
    messages: [],
    searchCount: 0,
    readFilePaths: new Set(),
    readOperationCount: 0,
    listCount: 0,
    toolUseIds: new Set(),
    memorySearchCount: 0,
    memoryReadFilePaths: new Set(),
    memoryWriteCount: 0,
    nonMemSearchArgs: [],
    latestDisplayHint: undefined,
    hookTotalMs: 0,
    hookCount: 0,
    hookInfos: [],
  }
  if (feature('TEAMMEM')) {
    group.teamMemorySearchCount = 0
    group.teamMemoryReadFilePaths = new Set()
    group.teamMemoryWriteCount = 0
  }
  group.mcpCallCount = 0
  group.mcpServerNames = new Set()
  if (isFullscreenEnvEnabled()) {
    group.bashCount = 0
    group.bashCommands = new Map()
    group.commits = []
    group.pushes = []
    group.branches = []
    group.prs = []
    group.gitOpBashCount = 0
  }
  return group
}

function createCollapsedGroup(group: GroupAccumulator): CollapsedReadSearchGroup {
  const firstMsg = group.messages[0]!
  // 当存在基于文件路径的读取时，仅使用唯一文件数（Set.size）。
  // 在此基础上叠加 bash 操作计数会导致重复计算 — 例如 Read(README.md)
  // 后跟 Bash(wc -l README.md) 应显示为 1 个文件，而非 2 个。
  // 仅在没有文件路径读取（纯 bash）时回退为操作计数。
  const totalReadCount =
    group.readFilePaths.size > 0 ? group.readFilePaths.size : group.readOperationCount
  // memoryReadFilePaths 是 readFilePaths 的子集（两者都由 Read 工具调用填充），
  // 因此从下方的 totalReadCount 中减去此计数是安全的。
  // 吸收的 relevant_memories 附件不在 readFilePaths 中 —
  // 在减法之后单独添加，以确保 readCount 正确。
  const toolMemoryReadCount = group.memoryReadFilePaths.size
  const memoryReadCount = toolMemoryReadCount + (group.relevantMemories?.length ?? 0)
  // 非 memory 读取文件路径：排除 memory 和团队 memory 路径
  const teamMemReadPaths = feature('TEAMMEM') ? group.teamMemoryReadFilePaths : undefined
  const nonMemReadFilePaths = [...group.readFilePaths].filter(
    (p) => !group.memoryReadFilePaths.has(p) && !(teamMemReadPaths?.has(p) ?? false),
  )
  const teamMemSearchCount = feature('TEAMMEM') ? (group.teamMemorySearchCount ?? 0) : 0
  const teamMemReadCount = feature('TEAMMEM') ? (group.teamMemoryReadFilePaths?.size ?? 0) : 0
  const teamMemWriteCount = feature('TEAMMEM') ? (group.teamMemoryWriteCount ?? 0) : 0
  const result: CollapsedReadSearchGroup = {
    type: 'collapsed_read_search' as const,
    content: '',
    collapsedCount: group.messages.length,
    // 减去 memory + 团队 memory 计数，使常规计数仅反映非 memory 操作
    searchCount: Math.max(0, group.searchCount - group.memorySearchCount - teamMemSearchCount),
    readCount: Math.max(0, totalReadCount - toolMemoryReadCount - teamMemReadCount),
    listCount: group.listCount,
    // REPL 操作故意不折叠（见第 32 行的 isCollapsible: false），
    // 因此折叠分组中 replCount 始终为 0。保留 replCount 字段是为了
    // AgentTool/UI.tsx 中的子代理进度显示，它有独立的代码路径。
    replCount: 0,
    memorySearchCount: group.memorySearchCount,
    memoryReadCount,
    memoryWriteCount: group.memoryWriteCount,
    teamMemorySearchCount: feature('TEAMMEM') ? teamMemSearchCount : 0,
    teamMemoryReadCount: feature('TEAMMEM') ? teamMemReadCount : 0,
    teamMemoryWriteCount: feature('TEAMMEM') ? teamMemWriteCount : 0,
    readFilePaths: nonMemReadFilePaths,
    searchArgs: group.nonMemSearchArgs,
    latestDisplayHint: group.latestDisplayHint,
    messages: group.messages as CollapsedReadSearchGroup['messages'],
    displayMessage: firstMsg as CollapsedReadSearchGroup['displayMessage'],
    uuid: `collapsed-${firstMsg.uuid}` as UUID,
    timestamp: firstMsg.timestamp,
    // 可选字段：根据条件填充
    ...((group.mcpCallCount ?? 0) > 0 && {
      mcpCallCount: group.mcpCallCount,
      mcpServerNames: [...(group.mcpServerNames ?? [])],
    }),
    ...(isFullscreenEnvEnabled() &&
      (group.bashCount ?? 0) > 0 && {
        bashCount: group.bashCount,
        gitOpBashCount: group.gitOpBashCount,
      }),
    ...(isFullscreenEnvEnabled() && (group.commits?.length ?? 0) > 0 && { commits: group.commits }),
    ...(isFullscreenEnvEnabled() && (group.pushes?.length ?? 0) > 0 && { pushes: group.pushes }),
    ...(isFullscreenEnvEnabled() &&
      (group.branches?.length ?? 0) > 0 && { branches: group.branches }),
    ...(isFullscreenEnvEnabled() && (group.prs?.length ?? 0) > 0 && { prs: group.prs }),
    ...(group.hookCount > 0 && {
      hookTotalMs: group.hookTotalMs,
      hookCount: group.hookCount,
      hookInfos: group.hookInfos,
    }),
    ...(group.relevantMemories &&
      group.relevantMemories.length > 0 && {
        relevantMemories: group.relevantMemories,
      }),
    ...(group.thoughtForMs !== undefined && { thoughtForMs: group.thoughtForMs }),
    ...(group.latestThinkingSummary !== undefined && {
      latestThinkingSummary: group.latestThinkingSummary,
    }),
    ...(group.latestDisplayKind !== undefined && {
      latestDisplayKind: group.latestDisplayKind,
    }),
  }
  return result
}

/**
 * 将连续的 Read/Search 操作折叠为摘要分组。
 *
 * 规则：
 * - 将连续的搜索/读取工具调用分组（Grep、Glob、Read 及 Bash 搜索/读取命令）
 * - 将对应的工具结果包含在分组中
 * - 当助手文本出现时打断分组
 */
export function collapseReadSearchGroups(
  messages: RenderableMessage[],
  tools: Tools,
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let currentGroup = createEmptyGroup()
  let deferredSkippable: RenderableMessage[] = []
  let pendingThinkingDurationMs: number | undefined
  const absorbedSilentToolUseIds = new Set<string>()

  function flushGroup(): void {
    if (currentGroup.messages.length === 0) {
      return
    }
    const group = createCollapsedGroup(currentGroup)
    // thinkingDurationMs 来自实时状态机，比 timestamp 差值更可信。
    // timestamp 只作为历史消息没有显式时长时的兜底。
    const existingMs = pendingThinkingDurationMs ?? 0
    const computedMs = group.thoughtForMs ?? 0
    if (existingMs > 0 || computedMs > 0) {
      group.thinkingDurationMs = existingMs > 0 ? existingMs : computedMs
      pendingThinkingDurationMs = undefined
    }
    result.push(group)
    for (const deferred of deferredSkippable) {
      result.push(deferred)
    }
    deferredSkippable = []
    currentGroup = createEmptyGroup()
  }

  let lastTimestamp: string | undefined
  for (const msg of messages) {
    // 在类型窄化前提取 thinking duration，以便附加到后续的折叠分组
    // 累加而非覆盖：一次 turn 中多段 thinking（被 tool_use 打断）全部计入
    if (msg.type === 'assistant' && msg.thinkingDurationMs) {
      const capped = Math.min(msg.thinkingDurationMs, 600_000)
      pendingThinkingDurationMs = (pendingThinkingDurationMs ?? 0) + capped
    }

    // 将普通 thinking 块保留在折叠分组中，展开 verbose 模式时可见
    if (isThinkingBlock(msg)) {
      if (msg.type === 'assistant') {
        const thinkingText = extractThinkingText(msg)
        if (thinkingText) {
          currentGroup.latestThinkingSummary = thinkingText.trim().replace(/\s+/g, ' ')
          currentGroup.latestDisplayKind = 'thinking'
        }
        if (lastTimestamp !== undefined && msg.timestamp) {
          const elapsed = Date.parse(msg.timestamp) - Date.parse(lastTimestamp)
          if (Number.isFinite(elapsed) && elapsed > 0) {
            currentGroup.thoughtForMs =
              (currentGroup.thoughtForMs ?? 0) + Math.min(elapsed, 600_000)
          }
        }
        currentGroup.messages.push(msg)
      }
      lastTimestamp = msg.timestamp
      continue
    }

    if (isCollapsibleToolUse(msg, tools)) {
      // 这是一个可折叠的工具调用 - 类型谓词将类型收窄为 CollapsibleMessage
      const toolInfo = getCollapsibleToolInfo(msg, tools)!

      if (toolInfo.isMemoryWrite) {
        // Memory 文件写入/编辑 — 检查是否为团队 memory
        const count = countToolUses(msg)
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemoryWriteOrEdit(toolInfo.name, toolInfo.input)
        ) {
          currentGroup.teamMemoryWriteCount = (currentGroup.teamMemoryWriteCount ?? 0) + count
        } else {
          currentGroup.memoryWriteCount += count
        }
      } else if (toolInfo.isAbsorbedSilently) {
        // ToolSearch 被静默吸收 — 无计数，无摘要文本。
        // 在默认视图中隐藏，但在详细模式（Ctrl+O）下通过
        // CollapsedReadSearchContent 的 groupMessages 迭代可见。
      } else if (toolInfo.mcpServerName) {
        // MCP 搜索/读取 — 分开计数，使摘要显示
        // "Queried slack N times" 而非 "Read N files"。
        const count = countToolUses(msg)
        currentGroup.mcpCallCount = (currentGroup.mcpCallCount ?? 0) + count
        currentGroup.mcpServerNames?.add(toolInfo.mcpServerName)
        const input = toolInfo.input as { query?: string } | undefined
        if (input?.query) {
          currentGroup.latestDisplayHint = `"${input.query}"`
          currentGroup.latestDisplayKind = 'tool'
        }
      } else if (isFullscreenEnvEnabled() && toolInfo.isBash) {
        // 非搜索/读取类 Bash 命令 — 分开计数，使摘要显示
        // "Ran N bash commands" 而非打断分组。
        const count = countToolUses(msg)
        currentGroup.bashCount = (currentGroup.bashCount ?? 0) + count
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          // 优先使用提取的 `# comment`（如果存在）— 这是 Zy 为用户编写的注释，
          // 与 comment-as-label 工具调用渲染使用相同的触发逻辑。
          currentGroup.latestDisplayHint =
            extractBashCommentLabel(input.command) ?? commandAsHint(input.command)
          currentGroup.latestDisplayKind = 'tool'
          // 记录 tool_use_id -> command，以便后续到达的结果
          // 可被扫描提取 commit SHA / PR URL。
          for (const id of getToolUseIdsFromMessage(msg)) {
            currentGroup.bashCommands?.set(id, input.command)
          }
        }
      } else if (toolInfo.isList) {
        // 目录列表类 bash 命令（ls、tree、du）— 分开计数，
        // 使摘要显示 "Listed N directories" 而非 "Read N files"。
        currentGroup.listCount += countToolUses(msg)
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          currentGroup.latestDisplayHint = commandAsHint(input.command)
          currentGroup.latestDisplayKind = 'tool'
        }
      } else if (toolInfo.isSearch) {
        // 使用工具的 isSearch 标志来正确分类 bash 搜索命令
        const count = countToolUses(msg)
        currentGroup.searchCount += count
        // 检查搜索是否以 memory 文件为目标（通过 path 或 glob 模式）
        if (feature('TEAMMEM') && teamMemOps?.isTeamMemorySearch(toolInfo.input)) {
          currentGroup.teamMemorySearchCount = (currentGroup.teamMemorySearchCount ?? 0) + count
        } else if (isMemorySearch(toolInfo.input)) {
          currentGroup.memorySearchCount += count
        } else {
          // 常规（非 memory）搜索 — 收集 pattern 用于显示
          const input = toolInfo.input as { pattern?: string } | undefined
          if (input?.pattern) {
            currentGroup.nonMemSearchArgs.push(input.pattern)
            currentGroup.latestDisplayHint = `"${input.pattern}"`
            currentGroup.latestDisplayKind = 'tool'
          }
        }
      } else {
        // 对于读取操作，追踪唯一文件路径而非计数操作次数
        const filePaths = getFilePathsFromReadMessage(msg)
        for (const filePath of filePaths) {
          currentGroup.readFilePaths.add(filePath)
          if (feature('TEAMMEM') && teamMemOps?.isTeamMemFile(filePath)) {
            currentGroup.teamMemoryReadFilePaths?.add(filePath)
          } else if (isAutoManagedMemoryFile(filePath)) {
            currentGroup.memoryReadFilePaths.add(filePath)
          } else {
            // 非 memory 文件读取 — 更新显示提示
            currentGroup.latestDisplayHint = getDisplayPath(filePath)
            currentGroup.latestDisplayKind = 'tool'
          }
        }
        // 如果未找到文件路径（例如 Bash 读取命令如 ls、cat），则计数操作次数
        if (filePaths.length === 0) {
          currentGroup.readOperationCount += countToolUses(msg)
          // 使用 Bash 命令作为显示提示（截断以提高可读性）
          const input = toolInfo.input as { command?: string } | undefined
          if (input?.command) {
            currentGroup.latestDisplayHint = commandAsHint(input.command)
            currentGroup.latestDisplayKind = 'tool'
          }
        }
      }

      // 追踪工具调用 ID 以匹配结果
      for (const id of getToolUseIdsFromMessage(msg)) {
        currentGroup.toolUseIds.add(id)
      }

      currentGroup.messages.push(msg)
    } else if (isSilentToolResult(msg, absorbedSilentToolUseIds)) {
      // 静默工具的 tool_result：不打断分组，不加入 messages，直接吸收
    } else if (isCollapsibleToolResult(msg, currentGroup.toolUseIds)) {
      currentGroup.messages.push(msg)
      // 扫描 bash 结果中的 commit SHA / PR URL 以在摘要中展示
      if (isFullscreenEnvEnabled() && currentGroup.bashCommands?.size) {
        scanBashResultForGitOps(msg, currentGroup)
      }
    } else if (currentGroup.messages.length > 0 && isPreToolHookSummary(msg)) {
      // 将 PreToolUse hook 摘要吸收到分组中，而非延迟输出
      currentGroup.hookCount += msg.hookCount!
      currentGroup.hookTotalMs +=
        msg.totalDurationMs ?? msg.hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
      currentGroup.hookInfos.push(...msg.hookInfos)
    } else if (
      currentGroup.messages.length > 0 &&
      msg.type === 'attachment' &&
      msg.attachment.type === 'relevant_memories'
    ) {
      // 吸收自动注入的 memory 附件，使 "recalled N memories" 与
      // "ran N bash commands" 内联渲染，而非作为独立的 ⏺ 块。
      // 不要将路径添加到 readFilePaths/memoryReadFilePaths —
      // 那会污染 readOperationCount 回退（纯 bash 读取没有路径；
      // 添加 memory 路径会使 readFilePaths.size > 0 并抑制回退）。
      // createCollapsedGroup 在 readCount 减法之后将 .length 添加到
      // memoryReadCount。
      currentGroup.relevantMemories ??= []
      const memAtt = msg.attachment as unknown as {
        memories: { path: string; content: string; mtimeMs: number }[]
      }
      currentGroup.relevantMemories.push(...memAtt.memories)
    } else if (shouldSkipMessage(msg)) {
      // 对于可跳过的消息（thinking、附件、系统消息）不刷新分组。
      // 如果分组正在进行中，将这些消息延迟到折叠分组之后输出。
      // 这保证了折叠徽章出现在第一个工具调用的位置，
      // 不会被中间的可跳过消息挤开。
      // 例外：nested_memory 附件即使在分组期间也直接透传，
      // 使 ⎿ Loaded 行紧密聚集，而非被徽章的 marginTop 分割。
      if (
        currentGroup.messages.length > 0 &&
        !(msg.type === 'attachment' && msg.attachment.type === 'nested_memory')
      ) {
        deferredSkippable.push(msg)
      } else {
        result.push(msg)
      }
    } else if (isTextBreaker(msg)) {
      // 助手文本打断分组
      flushGroup()
      result.push(msg)
    } else if (isSilentNonCollapsibleToolUse(msg, tools)) {
      // 静默工具（UI 不可见）：不增加计数，不打断分组，不加入 group.messages。
      // 追踪 toolUseId 以跳过对应的 tool_result。
      for (const id of getToolUseIdsFromMessage(msg)) {
        absorbedSilentToolUseIds.add(id)
      }
    } else if (isNonCollapsibleToolUse(msg, tools)) {
      // 不可折叠的工具调用打断分组
      flushGroup()
      result.push(msg)
    } else {
      // 包含不可折叠工具结果的用户消息打断分组
      flushGroup()
      result.push(msg)
    }
    lastTimestamp = msg.timestamp
  }

  flushGroup()
  return result
}

/**
 * 辅助函数：根据状态选择正确的 i18n key。
 */
function summaryKey(prefix: string, isActive: boolean, isFirst: boolean): string {
  const phase = isActive ? 'active' : 'done'
  const position = isFirst ? 'first' : 'sub'
  return `summary.${prefix}.${phase}.${position}`
}

/**
 * 生成搜索/读取/REPL 计数的摘要文本。
 * @param searchCount 搜索操作数量
 * @param readCount 读取操作数量
 * @param isActive 分组是否仍在进行中（使用现在时）还是已完成（使用过去时）
 * @param replCount REPL 执行次数（可选）
 * @param memoryCounts 可选的 memory 文件操作计数
 * @returns 摘要文本，如 "Searching for 3 patterns, reading 2 files, REPL'd 5 times..."
 */
export function getSearchReadSummaryText(
  searchCount: number,
  readCount: number,
  isActive: boolean,
  replCount: number = 0,
  memoryCounts?: {
    memorySearchCount: number
    memoryReadCount: number
    memoryWriteCount: number
    teamMemorySearchCount?: number
    teamMemoryReadCount?: number
    teamMemoryWriteCount?: number
  },
  listCount: number = 0,
): string {
  const parts: string[] = []

  // 优先处理 memory 操作
  if (memoryCounts) {
    const { memorySearchCount, memoryReadCount, memoryWriteCount } = memoryCounts
    if (memoryReadCount > 0) {
      const key = summaryKey('memoryRead', isActive, parts.length === 0)
      const unit = tSync(memoryReadCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
        count: memoryReadCount,
      })
      parts.push(tSync(key, { count: memoryReadCount, unit }))
    }
    if (memorySearchCount > 0) {
      const key = summaryKey('memorySearch', isActive, parts.length === 0)
      parts.push(tSync(key))
    }
    if (memoryWriteCount > 0) {
      const key = summaryKey('memoryWrite', isActive, parts.length === 0)
      const unit = tSync(memoryWriteCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
        count: memoryWriteCount,
      })
      parts.push(tSync(key, { count: memoryWriteCount, unit }))
    }
    // 团队 memory 操作
    if (feature('TEAMMEM') && teamMemOps) {
      teamMemOps.appendTeamMemorySummaryParts(memoryCounts, isActive, parts)
    }
  }

  if (searchCount > 0) {
    const key = summaryKey('search', isActive, parts.length === 0)
    const unit = tSync(
      searchCount === 1 ? 'summary.search.pattern_one' : 'summary.search.pattern_other',
      { count: searchCount },
    )
    parts.push(tSync(key, { count: searchCount, unit }))
  }

  if (readCount > 0) {
    const key = summaryKey('read', isActive, parts.length === 0)
    const unit = tSync(readCount === 1 ? 'summary.read.file_one' : 'summary.read.file_other', {
      count: readCount,
    })
    parts.push(tSync(key, { count: readCount, unit }))
  }

  if (listCount > 0) {
    const key = summaryKey('list', isActive, parts.length === 0)
    const unit = tSync(
      listCount === 1 ? 'summary.list.directory_one' : 'summary.list.directory_other',
      { count: listCount },
    )
    parts.push(tSync(key, { count: listCount, unit }))
  }

  if (replCount > 0) {
    const key = isActive ? 'summary.repl.active' : 'summary.repl.done'
    const unit = tSync(replCount === 1 ? 'summary.repl.time_one' : 'summary.repl.time_other', {
      count: replCount,
    })
    parts.push(tSync(key, { count: replCount, unit }))
  }

  const text = parts.join(', ')
  return isActive ? `${text}…` : text
}

/**
 * 将最近的工具活动列表汇总为紧凑的描述。
 * 使用记录时预计算的 isSearch/isRead 分类，将尾部连续的搜索/读取操作汇总。
 * 对于不可折叠的工具调用，回退到最后一个活动的描述。
 */
export function summarizeRecentActivities(
  activities: readonly {
    activityDescription?: string
    isSearch?: boolean
    isRead?: boolean
  }[],
): string | undefined {
  if (activities.length === 0) {
    return undefined
  }
  // 从列表末尾统计尾部连续的搜索/读取活动
  let searchCount = 0
  let readCount = 0
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!
    if (activity.isSearch) {
      searchCount++
    } else if (activity.isRead) {
      readCount++
    } else {
      break
    }
  }
  const collapsibleCount = searchCount + readCount
  if (collapsibleCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true)
  }
  // 回退到最近一个有描述的活动（某些工具如 SendMessage
  // 未实现 getActivityDescription，因此向后搜索）
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]?.activityDescription) {
      return activities[i]!.activityDescription
    }
  }
  return undefined
}
