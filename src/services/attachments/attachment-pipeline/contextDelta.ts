// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { logEvent } from 'src/services/analytics/index.js'
import { toolMatchesName, type ToolUseContext } from '../../../tools/tool.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { uniq } from '../../utils/array.js'
import { readdir, stat } from 'node:fs/promises'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from '../../../tools/SkillTool/constants.js'
import { relative, resolve } from 'node:path'
import { getCwd } from 'src/utils/cwd.js'
import { logError } from '../../utils/log.js'
import { diagnosticTracker } from '../../diagnosticTracking.js'
import type { Message } from 'src/types/message.js'
import { getSkillToolCommands, getMcpSkillCommands } from '../../../commands/index.js'
import type { Command } from '../../../commands/types.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from '../../../bootstrap/runtime/runtimeContext.js'
import { formatCommandsWithinBudget } from '../../../tools/SkillTool/prompt.js'
import { getContextWindowForModel } from '../../context/modelContext.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { type FileStateCache } from '../../utils/fileStateCache.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { isAbortError } from '../../utils/errors.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { logForDebugging } from '../../utils/debug.js'
import { getUserMessageText } from '../../messages/predicates.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import { findRelevantMemories } from '../../../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../../../memdir/memoryAge.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../../memdir/paths.js'
import { getAgentMemoryDir } from '../../../tools/AgentTool/agentMemory.js'
import {
  Attachment,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_LINES,
  RELEVANT_MEMORIES_CONFIG,
  skillSearchModules,
} from './types.js'
import { getNestedMemoryAttachmentsForFile } from './modeReminders.js'
/**
 * 处理需要嵌套内存附件的路径并检查嵌套 AGENTS.md 文件
 * 使用 ToolUseContext 中的 nestedMemoryAttachmentTriggers 字段
 */
export async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 先检查触发器 — getAppState() 等待 React 渲染周期，
  // 而常见情况是空触发器集合。
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }
  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []
  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }
  toolUseContext.nestedMemoryAttachmentTriggers.clear()
  return attachments
}

export async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<Attachment[]> {
  // 如果 @-mention 了 agent，仅搜索其记忆目录（隔离）。
  // 否则搜索自动记忆目录。
  const memoryDirs = extractAgentMentions(input).flatMap((mention) => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find((def) => def.agentType === agentType)
    return agentDef?.memory ? [getAgentMemoryDir(agentType, agentDef.memory)] : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]
  const allResults = await Promise.all(
    dirs.map((dir) =>
      findRelevantMemories(input, dir, signal, recentTools, alreadySurfaced).catch(() => []),
    ),
  )
  // alreadySurfaced 在选择器内部过滤，使 Sonnet 的 5 槽预算用于新候选；
  // readFileState 捕获模型通过 FileReadTool 读取的文件。此处冗余的
  // alreadySurfaced 检查是双重保险（多目录结果可能重新引入选择器
  // 在其他目录中过滤的路径）。
  const selected = allResults
    .flat()
    .filter((m) => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)
  const memories = await readMemoriesForSurfacing(selected, signal)
  if (memories.length === 0) {
    return []
  }
  return [
    {
      type: 'relevant_memories' as const,
      memories,
    },
  ]
}

/**
 * 扫描消息中过去的 relevant_memories 附件。返回已展示路径集合
 *（用于选择器去重）和累计字节数（用于会话总量限流）。
 * 扫描消息而非在 toolUseContext 中追踪意味着 compact 自然地重置两者——
 * 旧附件从压缩后的 transcript 中消失，因此重新展示是有效的。
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of (
        m.attachment as unknown as { memories: Array<{ path: string; content: string }> }
      ).memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return {
    paths,
    totalBytes,
  }
}

/**
 * Reads a set of relevance-ranked memory files for injection as
 * <system-reminder> attachments. Enforces both MAX_MEMORY_LINES and
 * MAX_MEMORY_BYTES via readFileInRange's truncateOnByteLimit option.
 * Truncation surfaces partial
 * content with a note rather than dropping the file — findRelevantMemories
 * already picked this as most-relevant, so the frontmatter + opening context
 * is worth surfacing even if later lines are cut.
 *
 * Exported for direct testing without mocking the ranker + GB gates.
 */
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{
    path: string
    mtimeMs: number
  }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          {
            truncateOnByteLimit: true,
          },
        )
        const truncated = result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter((r) => r !== null)
}

/**
 * 相关内存块的头部字符串。导出供 messages.ts 使用，
 * 以便在存储的 header 缺失时作为恢复会话的回退。
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

/**
 * 内存相关性选择器预取句柄。Promise 在每个用户轮次启动一次，
 * 在主模型流式传输和工具执行期间运行。
 * 在收集点（工具执行后），调用者读取 settledAt 以按需消费或
 * 跳过-下次迭代重试——预取永不阻塞轮次。
 *
 * 可释放：query.ts 通过 `using` 绑定，因此 [Symbol.dispose] 在所有
 * generator 退出路径（return、throw、.return() 闭合）上触发——中止
 * 进行中的请求并发出终端遥测，无需对 while 循环内约 13 个 return
 * 位置逐一添加检测。
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null
  /** Set by the collect point in query.ts. -1 until consumed. */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

/**
 * 将相关内存搜索作为异步预取启动。
 * 从消息中提取最后一条真实用户 prompt（跳过 isMeta 系统注入），
 * 并发起非阻塞搜索。返回带有结算追踪的 Disposable 句柄。
 * 在 query.ts 中通过 `using` 绑定。
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (!isAutoMemoryEnabled() || !getFeatureValue_CACHED_MAY_BE_STALE('zy_moth_copse', false)) {
    return undefined
  }
  const lastUserMessage = messages.findLast((m) => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }
  const input = getUserMessageText(lastUserMessage)
  // 单字提示缺乏足够上下文来进行有意义的术语提取
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }
  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // 链接到轮次级 abort，使用户 Escape 能立即取消 sideQuery，
  // 而非仅在 queryLoop 退出时的 [Symbol.dispose] 取消。
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  ).catch((e) => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })
  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('zy_memdir_prefetch_collected', {
        hidden_by_first_iteration: handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt,
      })
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

export type ToolResultBlock = {
  type: 'tool_result'
  toolCallId: string
  is_error?: boolean
}

export function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResultBlock).type === 'tool_result' &&
    typeof (b as ToolResultBlock).toolCallId === 'string'
  )
}

/**
 * 检查用户消息的 content 是否包含 tool_result 块。
 * 这比检查 `toolUseResult === undefined` 更可靠，因为
 * 子 agent 工具结果消息在 `preserveToolUseResults` 为 false 时
 *（Explore agent 的默认值）会显式将 `toolUseResult` 设为 `undefined`。
 */
export function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock)
}

/**
 * 自上一个真实轮次边界以来成功执行（且从未报错）的工具。
 * 内存选择器用此来抑制关于正常工作的工具的文档——
 * 为模型已成功调用的工具展示参考资料是噪音。
 *
 * 任何错误 → 工具被排除（模型遇到困难，文档保持可用）。
 * 尚无结果 → 同样排除（结果未知）。
 *
 * tool_use 位于 assistant content 中；tool_result 位于 user content 中
 *（toolUseResult 已设置，isMeta 未定义）。两者都在扫描窗口内。
 * 反向扫描先看到 result 再看到 use，因此我们按 id 收集两者
 * 然后再解析。
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): readonly string[] {
  const useIdToName = new Map<string, string>()
  const resultByUseId = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) {
      continue
    }
    if (isHumanTurn(m) && m !== lastUserMessage) {
      break
    }
    if (m.type === 'assistant' && typeof m.message.content !== 'string') {
      for (const block of m.message.content) {
        if (block.type === 'tool_call') {
          useIdToName.set(block.id, block.name)
        }
      }
    } else if (m.type === 'user' && 'message' in m && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.toolCallId, block.is_error === true)
        }
      }
    }
  }
  const failed = new Set<string>()
  const succeeded = new Set<string>()
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id)
    if (errored === undefined) {
      continue
    }
    if (errored) {
      failed.add(name)
    } else {
      succeeded.add(name)
    }
  }
  return [...succeeded].filter((t) => !failed.has(t))
}

/**
 * 过滤预取的内存附件，排除模型已通过 FileRead/Write/Edit 工具调用
 *（本轮任何迭代）或上一轮的内存展示而存在于上下文中的内存——
 * 两者都通过累积的 readFileState 追踪。存活者随后在 readFileState 中标记，
 * 使后续轮次不会重新展示。
 *
 * 先过滤后标记的顺序是关键的：readMemoriesForSurfacing 之前在预取期间
 * 写入 readFileState，这意味着过滤器将每个预取选中的路径视为"已在上下文中"
 * 并全部丢弃（自引用过滤器）。将写入延迟到此处（过滤器运行之后），
 * 打破了该循环，同时仍能对任何迭代的工具调用进行去重。
 */
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map((attachment) => {
      if (attachment.type !== 'relevant_memories') {
        return attachment
      }
      const filtered = attachment.memories.filter((m) => !readFileState.has(m.path))
      for (const m of filtered) {
        readFileState.set(m.path, {
          content: m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
        })
      }
      return filtered.length > 0
        ? {
            ...attachment,
            memories: filtered,
          }
        : null
    })
    .filter((a): a is Attachment => a !== null)
}

/**
 * 处理在文件操作期间发现的技能目录。
 * 使用 ToolUseContext 中的 dynamicSkillDirTriggers 字段
 */
export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []
  if (toolUseContext.dynamicSkillDirTriggers && toolUseContext.dynamicSkillDirTriggers.size > 0) {
    // 并行化：并发 readdir 所有技能目录
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async (skillDir) => {
        try {
          const entries = await readdir(skillDir, {
            withFileTypes: true,
          })
          const candidates = entries
            .filter((e) => e.isDirectory() || e.isSymbolicLink())
            .map((e) => e.name)
          // 并行化：并发 stat 所有 SKILL.md 候选
          const checked = await Promise.all(
            candidates.map(async (name) => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null // SKILL.md 不存在，跳过此项
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          // 忽略读取技能目录时的错误（例如目录不存在）
          return {
            skillDir,
            skillNames: [],
          }
        }
      }),
    )
    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }
    toolUseContext.dynamicSkillDirTriggers.clear()
  }
  return attachments
}

// 追踪已发送的技能以避免重复发送。按 agentId 键控
//（空字符串 = 主线程），使子代理获得自己的首轮列表 —
// 如果没有每代理作用域，主线程填充此 Set 会导致
// 每个子代理的 filterToBundledAndMcp 结果去重为空。
export const sentSkillNames = new Map<string, Set<string>>()

// 当技能集合真正改变时调用（插件重载、磁盘上技能文件变更），
// 使新技能被宣布。不在 compact 时调用 —
// compact 后重新注入成本约 4K tokens/event，收益甚微。
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

/**
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the
 * transcript.
 *
 * `sentSkillNames` is module-scope — process-local. Each `zy -p` spawn
 * starts with an empty Map, so without this every resume re-injects the
 * full ~600-token listing even though it's already in the conversation from
 * the prior process. Shows up on every --resume; particularly loud for
 * daemons that respawn frequently.
 *
 * Trade-off: skills added between sessions won't be announced until the
 * next non-resume session. Acceptable — skill_listing was never meant to
 * cover cross-process deltas, and the agent can still call them (they're
 * in the Skill tool's runtime registry regardless).
 */
export function suppressNextSkillListing(): void {
  suppressNext = true
}

export let suppressNext = false

// 当启用技能搜索且过滤后（bundled + MCP）列表超过此数量时，
// 回退到仅 bundled。保护重 MCP 用户（100+ 服务器）免于截断，
// 同时保持典型设置的首轮保证。
export const FILTERED_LISTING_MAX = 30

/**
 * Filter skills to bundled (Anthropic-curated) + MCP (user-connected) only.
 * Used when skill-search is enabled to resolve the turn-0 gap for subagents:
 * these sources are small, intent-signaled, and won't hit the truncation budget.
 * User/project/plugin skills (the long tail — 200+) go through discovery instead.
 *
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(
    (cmd) => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp',
  )
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter((cmd) => cmd.loadedFrom === 'bundled')
  }
  return filtered
}

export async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  // 跳过没有 Skill 工具的代理的技能列表 — 它们无法直接使用技能。
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, SKILL_TOOL_NAME))) {
    return []
  }
  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(toolUseContext.getAppState().mcp.commands)
  let allCommands =
    mcpSkills.length > 0 ? uniqBy([...localCommands, ...mcpSkills], 'name') : localCommands

  // 当技能搜索活跃时，过滤到 bundled + MCP 而非完全抑制。
  // 解决首轮缺口：主线程通过 getTurnZeroSkillDiscovery（阻塞）获得首轮发现，
  // 但子代理使用异步 subagent_spawn 信号（工具后收集，首轮可见）。
  // Bundled + MCP 小巧且有意图信号；用户/项目/插件技能通过发现获取。
  // feature() 优先用于 DCE — 否则属性访问字符串会泄露，即使对 null 使用 ?.。
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH')
      ? skillSearchModules?.featureCheck?.isSkillSearchEnabled()
      : false
  ) {
    allCommands = filterToBundledAndMcp(allCommands)
  }
  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // 恢复路径：之前的进程已注入列表；它在 transcript 中。
  // 将当前所有内容标记为已发送，因此仅恢复后的增量
  //（后来通过 /reload-plugins 等加载的技能）会被宣布。
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  // 查找尚未发送的技能
  const newSkills = allCommands.filter((cmd: Command) => !sent.has(cmd.name))
  if (newSkills.length === 0) {
    return []
  }

  // 如果尚未发送任何技能，这是初始批次
  const isInitial = sent.size === 0

  // 标记为已发送
  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }
  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`,
  )

  // 使用现有逻辑在预算内格式化
  const contextWindowTokens = getContextWindowForModel(toolUseContext.options.mainLoopModel)
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)
  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}

// getSkillDiscoveryAttachment 已移至 skillSearch/prefetch.ts 中作为
// getTurnZeroSkillDiscovery — 将 'skill_discovery' 字符串字面量保留在
// 特性门控模块内，使其不会泄露到外部构建中。

export function extractAtMentionedFiles(content: string): string[] {
  // 提取带有 @ 符号的文件名，包括行范围语法：@file.txt#L10-20
  // 也支持带空格文件的引号路径：@"my/file with spaces.txt"
  // 示例："foo bar @baz moo" 会提取 "baz"
  // 示例：'check @"my file.txt" please' 会提取 "my file.txt"

  // 两种模式：引号路径和普通路径
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g
  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  // 先提取引号提及（跳过 agent 提及如 @"code-reviewer (agent)"）
  let match
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]) // 引号内的内容
    }
  }

  // 提取普通提及
  const regularMatchArray = content.match(regularAtMentionRegex) || []
  regularMatchArray.forEach((match) => {
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    const filename = match.slice(match.indexOf('@') + 1)
    // 如果以引号开头则不包含（已作为引号处理）
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  // 合并并去重
  return uniq([...quotedMatches, ...regularMatches])
}

export function extractMcpResourceMentions(content: string): string[] {
  // 提取带有 @ 符号的 MCP 资源，格式为 @server:uri
  // 示例："@server1:resource/path" 会提取 "server1:resource/path"
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g
  const matches = content.match(atMentionRegex) || []

  // 从每个匹配中移除前缀（@ 之前的所有内容）
  return uniq(matches.map((match) => match.slice(match.indexOf('@') + 1)))
}

export function extractAgentMentions(content: string): string[] {
  // 提取两种格式的 agent 提及：
  // 1. @agent-<agent-type>（旧版/手动输入）
  //    示例："@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)"（来自自动完成选择）
  //    示例：'@"code-reviewer (agent)"' → "code-reviewer"
  // 支持冒号、点和 @-符号用于插件作用域 agent，如 "@agent-asana:project-status-updater"
  const results: string[] = []

  // 匹配引号格式：@"<type> (agent)"
  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
  let match
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  // 匹配非引号格式：@agent-<type>
  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g
  const unquotedMatches = content.match(unquotedAgentRegex) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }
  return uniq(results)
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(mention: string): AtMentionedFileLines {
  // 解析如 "file.txt#L10-20"、"file.txt#heading" 或仅 "file.txt" 的提及
  // 支持行范围（#L10、#L10-20）并剥离非行范围片段（#heading）
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)
  if (!match) {
    return {
      filename: mention,
    }
  }
  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart
  return {
    filename: filename ?? mention,
    lineStart,
    lineEnd,
  }
}

export async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 仅当代理有 Bash 工具可操作时诊断才有用
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, BASH_TOOL_NAME))) {
    return []
  }

  // 从追踪器获取新诊断（通过 MCP 的 IDE 诊断）
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }
  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}
