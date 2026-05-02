/**
 * 将大型工具结果持久化到磁盘而非截断的工具。
 */

import type { ToolResultBlock } from '../types/llm.js'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../constants/toolLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { getErrnoCode, toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { getProjectDir } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'

// 会话内工具结果的子目录名
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// 用于包装持久化输出消息的 XML 标签
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

// 工具结果内容被清除但未持久化到文件时使用的消息
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * GrowthBook 覆盖映射：工具名 -> 持久化阈值（字符数）。
 * 当工具名存在于该映射中时，该值直接作为有效阈值使用，
 * 绕过与 50k 默认值的 Math.min() 钳制。
 * 不在映射中的工具使用硬编码的后备值。
 * Flag 默认为 {}（无覆盖 == 行为不变）。
 */
const PERSIST_THRESHOLD_OVERRIDE_FLAG = 'zy_satin_quoll'

/**
 * 解析工具的有效持久化阈值。
 * GrowthBook 覆盖值优先（如果存在）；否则回退到声明的每工具上限，
 * 并与全局默认值钳制。
 *
 * 防御性处理：GrowthBook 缓存返回 `cached !== undefined ? cached : default`，
 * 因此 flag 为 `null` 时会泄漏。我们通过可选链和 typeof 检查进行防护，
 * 使任何非对象 flag 值（null、string、number）回退到硬编码默认值，
 * 而不是在索引时抛出或返回 0。
 */
export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = 硬关闭。通过 maxTokens 读取自限制；将其
  // 输出持久到文件再让模型通过 Read 回读是循环的。
  // 在 GB 覆盖之前检查，因此 zy_satin_quoll 无法强制重新启用。
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  const overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, number> | null>(
    PERSIST_THRESHOLD_OVERRIDE_FLAG,
    {},
  )
  const override = overrides?.[toolName]
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override
  }
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}

// 将工具结果持久化到磁盘的结果
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

// 持久化失败时的错误结果
export type PersistToolResultError = {
  error: string
}

/**
 * 获取会话目录（projectDir/sessionId）
 */
function getSessionDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId())
}

/**
 * 获取此会话的工具结果目录（projectDir/sessionId/tool-results）
 */
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

// 引用消息的预览大小（字节）
export const PREVIEW_SIZE_BYTES = 2000

/**
 * 获取工具结果将被持久化的文件路径。
 */
export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${id}.${ext}`)
}

/**
 * 确保会话特定的工具结果目录存在
 */
export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // 目录可能已存在
  }
}

/**
 * 将工具结果持久化到磁盘并返回关于持久化文件的信息
 *
 * @param content - 要持久化的工具结果内容（字符串或内容块数组）
 * @param toolUseId - 产生结果的工具使用 ID
 * @returns 关于持久化文件的信息，包括文件路径和预览
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlock['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)

  // 检查非文本内容 - 我们只能持久化文本块
  if (isJson) {
    const hasNonTextContent = content.some((block) => block.type !== 'text')
    if (hasNonTextContent) {
      return {
        error: 'Cannot persist tool results containing non-text content',
      }
    }
  }

  await ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, isJson)
  const contentStr = isJson ? jsonStringify(content, null, 2) : content

  // tool_use_id 在每次调用中唯一，且内容对于给定 id 是确定性的，
  // 因此如果文件已存在则跳过。这防止了 microcompact 回放原始消息时
  // 在每次 API 轮次重写相同内容。使用 'wx' 而非 stat-then-write 竞争。
  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(`Persisted tool result to ${filepath} (${formatFileSize(contentStr.length)})`)
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logError(toError(error))
      return { error: getFileSystemErrorMessage(toError(error)) }
    }
    // EEXIST：已在之前的轮次中持久化，继续到预览生成
  }

  // 生成预览
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES)

  return {
    filepath,
    originalSize: contentStr.length,
    isJson,
    preview,
    hasMore,
  }
}

/**
 * 为大型工具结果构建带有预览的消息
 */
export function buildLargeToolResultMessage(result: PersistedToolResult): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
  message += result.preview
  message += result.hasMore ? '\n...\n' : '\n'
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}

/**
 * 处理工具结果以包含在消息中。
 * 将结果映射为 API 格式并将大型结果持久化到磁盘。
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlock: (result: T, toolUseID: string) => ToolResultBlock
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlock> {
  const toolResultBlock = tool.mapToolResultToToolResultBlock(toolUseResult, toolUseID)
  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  )
}

/**
 * 处理已映射的工具结果块。对大型结果应用持久化，
 * 无需重新调用 mapToolResultToToolResultBlock。
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlock,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlock> {
  return maybePersistLargeToolResult(
    toolResultBlock,
    toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars),
  )
}

/**
 * 当 tool_result 的内容为空或实际为空时返回 true。涵盖：
 * undefined/null/''、仅空白字符的字符串、空数组，以及仅包含
 * 空/空白文本块的数组。非文本块（图片、tool_reference）视为非空。
 */
export function isToolResultContentEmpty(content: ToolResultBlock['content']): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    (block) =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

/**
 * 通过将大型工具结果持久化到磁盘而非截断来处理。
 * 如果不需要持久化则返回原始块，否则返回修改后的块，
 * 内容被替换为对持久化文件的引用。
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlock,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlock> {
  // 先检查大小再进行任何异步工作 - 大多数工具结果都很小
  const content = toolResultBlock.content

  // inc-4586: 提示词末尾的空 tool_result 内容会导致某些模型
  // （尤其是 capybara）发出 \n\nHuman: 停止序列并以零输出来结束轮次。
  // 服务器渲染器在工具结果后不插入 \n\nAssistant: 标记，
  // 因此裸露的 </function_results>\n\n 会模式匹配为轮次边界。
  // 多个工具可能合法产生空输出（静默成功的 shell 命令、
  // 返回 content:[] 的 MCP 服务器、REPL 语句等）。
  // 注入一个短标记，让模型总有东西可以响应。
  if (isToolResultContentEmpty(content)) {
    logEvent('zy_tool_empty_result', {
      toolName: sanitizeToolNameForAnalytics(toolName),
    })
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    }
  }
  // 在空值检查后缩小范围 - 此后内容非空
  if (!content) {
    return toolResultBlock
  }

  // 跳过图片内容块的持久化 - 它们需要原样发送给 ZY
  if (hasImageBlock(content)) {
    return toolResultBlock
  }

  const size = contentSize(content)

  // 如果提供了工具特定的阈值则使用，否则回退到全局限制
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES
  if (size <= threshold) {
    return toolResultBlock
  }

  // 将整个内容作为一个单元进行持久化
  const result = await persistToolResult(content, toolResultBlock.toolCallId)
  if (isPersistError(result)) {
    // 如果持久化失败，返回原始块不变
    return toolResultBlock
  }

  const message = buildLargeToolResultMessage(result)

  // 记录分析数据
  logEvent('zy_tool_result_persisted', {
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalSizeBytes: result.originalSize,
    persistedSizeBytes: message.length,
    estimatedOriginalTokens: Math.ceil(result.originalSize / BYTES_PER_TOKEN),
    estimatedPersistedTokens: Math.ceil(message.length / BYTES_PER_TOKEN),
    thresholdUsed: threshold,
  })

  return { ...toolResultBlock, content: message }
}

/**
 * 生成内容的预览，尽可能在新行边界处截断。
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false }
  }

  // 在限制内找到最后一个换行符，避免从中间切断
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')

  // 如果找到了距离限制足够近的换行符，则使用它
  // 否则回退到精确限制
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes

  return { preview: content.slice(0, cutPoint), hasMore: true }
}

/**
 * 类型守卫，检查持久化结果是否为错误
 */
export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

// --- 消息级别的工具结果聚合预算 ---
//
// 跨轮次跟踪替换状态，以便 enforceToolResultBudget 每次做出
// 相同的选择（保留提示词缓存前缀）。

/**
 * 每个对话线程的工具结果聚合预算状态。
 * 状态必须稳定以保留提示词缓存：
 *   - seenIds: 已通过预算检查的结果（已替换或未替换）。
 *     一旦见过，结果的命运在对话中即冻结。
 *   - replacements: seenIds 的子集，已持久化到磁盘并替换为预览，
 *     映射到向模型显示的确切预览字符串。重新应用是 Map 查找——
 *     无文件 I/O，保证字节级一致，不会失败。
 *
 * 生命周期：每个对话线程一个实例，携带在 ToolUseContext 上。
 * 主线程：REPL 初始化一次，永不重置——/clear、rewind、resume
 * 或 compact 后的过期条目永远不会被查找（tool_use_ids 是 UUID），
 * 因此它们是无害的。子代理：createSubagentContext 默认克隆父级
 * 状态（像 agentSummary 这样的缓存共享分叉需要相同的决策），
 * 或者 resumeAgentBackground 传递一个从 sidechain 记录重建的实例。
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

/**
 * 为缓存共享分叉（如 agentSummary）克隆替换状态。
 * 分叉需要在分叉时与源相同的状态，以便
 * enforceToolResultBudget 做出相同的选择 → 相同的传输前缀 →
 * 提示词缓存命中。修改克隆不会影响源。
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}

/**
 * 解析每条消息的聚合预算限制。GrowthBook 覆盖
 * (zy_hawthorn_window) 在存在且为有限正数时优先；
 * 否则回退到硬编码常量。防御性 typeof/finite
 * 检查：GrowthBook 的缓存返回 `cached !== undefined ? cached : default`，
 * 因此 flag 为 null/string/NaN 时会泄漏。
 */
export function getPerMessageBudgetLimit(): number {
  const override = getFeatureValue_CACHED_MAY_BE_STALE<number | null>('zy_hawthorn_window', null)
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/**
 * 为新对话线程分配替换状态。
 *
 * 封装了 feature-flag 门控 + 重建与新建的选择：
 *   - Flag 关闭 → undefined（query.ts 完全跳过执行）
 *   - 无 initialMessages（冷启动）→ 新建
 *   - 存在 initialMessages → 重建（冻结所有候选 ID，使
 *     预算永远不会替换模型已经见过但未替换的内容）。
 *     空或缺失的记录冻结所有内容；非空记录还会填充
 *     replacements Map 以实现字节级一致的重新应用。
 */
export function provisionContentReplacementState(
  initialMessages?: Message[],
  initialContentReplacements?: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  const enabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_hawthorn_steeple', false)
  if (!enabled) return undefined
  if (initialMessages) {
    return reconstructContentReplacementState(initialMessages, initialContentReplacements ?? [])
  }
  return createContentReplacementState()
}

/**
 * 一次内容替换决策的可序列化记录。写入
 * 转录作为 ContentReplacementEntry，以便决策在 resume 后保留。
 * 通过 `kind` 区分，以便未来的替换机制（用户文本、
 * 卸载的图片）可以共享相同的转录条目类型。
 *
 * `replacement` 是模型看到的确切字符串——存储而非在 resume 时
 * 派生，因此预览模板、大小格式化或路径布局的代码更改
 * 不会静默破坏提示词缓存。
 */
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type ToolResultReplacementRecord = Extract<ContentReplacementRecord, { kind: 'tool-result' }>

type ToolResultCandidate = {
  toolUseId: string
  content: NonNullable<ToolResultBlock['content']>
  size: number
}

type CandidatePartition = {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>
  frozen: ToolResultCandidate[]
  fresh: ToolResultCandidate[]
}

function isContentAlreadyCompacted(content: ToolResultBlock['content']): boolean {
  // 所有预算生成的内容都以标签开头（buildLargeToolResultMessage）。
  // `.startsWith()` 避免标签出现在内容其他位置时的误报
  // （例如，读取这个源文件）。
  return typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)
}

function hasImageBlock(content: NonNullable<ToolResultBlock['content']>): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => typeof b === 'object' && 'type' in b && b.type === 'image')
  )
}

function contentSize(content: NonNullable<ToolResultBlock['content']>): number {
  if (typeof content === 'string') return content.length
  // 直接对文本块长度求和。与序列化相比略微少计
  // （无 JSON 框架），但预算本身是粗略的 token 启发式。
  // 避免在每次执行时分配内容大小的字符串。
  return content.reduce((sum, b) => sum + (b.type === 'text' ? b.text.length : 0), 0)
}

/**
 * 遍历消息并从 assistant 的 tool_use 块构建 tool_use_id → tool_name 映射。
 * tool_use 总是在其 tool_result 之前（模型调用，然后结果到达），
 * 因此当预算执行看到结果时，其名称已经可知。
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_call') {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

/**
 * 从单个用户消息中提取候选 tool_result 块：
 * 非空、非图片、且尚未通过标签压缩的块
 * （即受每工具限制或同一 query 调用的早期迭代处理）。
 * 对于没有合格块的消息返回 []。
 */
function collectCandidatesFromMessage(message: Message): ToolResultCandidate[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return []
  }
  return message.message.content.flatMap((block) => {
    if (block.type !== 'tool_result' || !block.content) return []
    if (isContentAlreadyCompacted(block.content)) return []
    if (hasImageBlock(block.content)) return []
    return [
      {
        toolUseId: block.toolCallId,
        content: block.content,
        size: contentSize(block.content),
      },
    ]
  })
}

/**
 * 按 API 级别的用户消息分组提取候选 tool_result 块。
 *
 * normalizeMessagesForAPI 将连续的用户消息合并为一个
 * （Bedrock 兼容；直接 API 在服务端做同样的事），因此
 * 以 N 个独立用户消息到达的并行工具结果在线上变为
 * 一个用户消息。预算必须用相同方式分组，否则
 * 会看到 N 条低于预算的消息而非一条超预算的消息，
 * 在最关键的时候无法执行。
 *
 * "组" 是未被 assistant 消息分隔的用户消息的最大连续段。
 * 只有 assistant 消息创建线级别边界——normalizeMessagesForAPI
 * 完全过滤 progress 并将 attachment/system(local_command) 合并
 * 到相邻的用户块中，因此这些类型在这里也不会打破组。
 *
 * 这对于并行工具期间的中止路径很重要：agent_progress 消息
 * （非临时的，持久化在 REPL 状态中）可以穿插在新的
 * tool_result 消息之间。如果我们按 progress 刷新，那些
 * tool_results 会分裂为低于预算的组，未经替换就通过，
 * 被冻结，然后被 normalizeMessagesForAPI 合并为一条
 * 超预算的线上消息——使此功能失效。
 *
 * 只返回至少有一个合格候选的组。
 */
function collectCandidatesByMessage(messages: Message[]): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = []
  let current: ToolResultCandidate[] = []

  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  // 跟踪所有已见过的 assistant message.id——相同 ID 的片段会被
  // normalizeMessagesForAPI 合并（messages.ts ~2126 通过 `continue`
  // 遍历过不同 ID 的 assistant），因此任何之前见过的 ID 的再次出现
  // 不能创建组边界。两种场景：
  //   • 连续的：streamingToolExecution 每个 content_block_stop 生成
  //     一个 AssistantMessage（相同 id）；快速工具在块之间排水；
  //     abort/hook-stop 留下 [asst(X), user(trA), asst(X), user(trB)]。
  //   • 交错的：coordinator/teammate 流混合不同的响应，
  //     所以 [asst(X), user(trA), asst(Y), user(trB), asst(X), user(trC)]。
  // 在这两种情况下，normalizeMessagesForAPI 将 X 片段合并为一个线上
  // assistant，其后续的 tool_results 合并为一个线上用户消息——
  // 因此预算也必须将它们视为一个组。
  const seenAsstIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user') {
      current.push(...collectCandidatesFromMessage(message))
    } else if (message.type === 'assistant') {
      if (!seenAsstIds.has(message.message.id)) {
        flush()
        seenAsstIds.add(message.message.id)
      }
    }
    // progress/attachment/system 被 normalizeMessagesForAPI 过滤或合并——
    // 它们不创建线上边界。
  }
  flush()

  return groups
}

/**
 * 根据之前的决策状态对候选进行分区：
 *  - mustReapply：之前已替换 → 重新应用缓存的替换以保持前缀稳定
 *  - frozen：之前见过但未替换 → 禁止触碰（现在替换会改变
 *    已缓存的前缀）
 *  - fresh：从未见过 → 符合新的替换决策条件
 */
function partitionByPriorDecision(
  candidates: ToolResultCandidate[],
  state: ContentReplacementState,
): CandidatePartition {
  return candidates.reduce<CandidatePartition>(
    (acc, c) => {
      const replacement = state.replacements.get(c.toolUseId)
      if (replacement !== undefined) {
        acc.mustReapply.push({ ...c, replacement })
      } else if (state.seenIds.has(c.toolUseId)) {
        acc.frozen.push(c)
      } else {
        acc.fresh.push(c)
      }
      return acc
    },
    { mustReapply: [], frozen: [], fresh: [] },
  )
}

/**
 * 选择最大的 fresh 结果进行替换，直到模型可见的总量
 * （frozen + 剩余的 fresh）达到或低于预算，或耗尽 fresh。
 * 如果仅 frozen 结果就超过预算，我们接受超量——
 * microcompact 最终会清除它们。
 */
function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  const selected: ToolResultCandidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break
    selected.push(c)
    // 我们不知道持久化后的替换大小，但预览约 ~2K，
    // 到达此路径的结果要大得多，因此减去完整大小
    // 对于选择目的是一个接近的近似值。
    remaining -= c.size
  }
  return selected
}

/**
 * 返回一个新的 Message[]，其中 tool_result 块的 id 出现在
 * replacementMap 中的内容已被替换。没有替换的消息和块
 * 通过引用传递。
 */
function replaceToolResultContents(
  messages: Message[],
  replacementMap: Map<string, string>,
): Message[] {
  return messages.map((message) => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    const content = message.message.content
    const needsReplace = content.some(
      (b) => b.type === 'tool_result' && replacementMap.has(b.toolCallId),
    )
    if (!needsReplace) return message
    return {
      ...message,
      message: {
        ...message.message,
        content: content.map((block) => {
          if (block.type !== 'tool_result') return block
          const replacement = replacementMap.get(block.toolCallId)
          return replacement === undefined ? block : { ...block, content: replacement }
        }),
      },
    }
  })
}

async function buildReplacement(
  candidate: ToolResultCandidate,
): Promise<{ content: string; originalSize: number } | null> {
  const result = await persistToolResult(candidate.content, candidate.toolUseId)
  if (isPersistError(result)) return null
  return {
    content: buildLargeToolResultMessage(result),
    originalSize: result.originalSize,
  }
}

/**
 * 对聚合工具结果大小执行每条消息的预算。
 *
 * 对于 tool_result 块合计超过每条消息限制（见
 * getPerMessageBudgetLimit）的每条用户消息，该消息中最大的
 * FRESH（从未见过）结果被持久化到磁盘并替换为预览。
 * 消息独立评估——一条消息中的 150K 结果和另一条消息中的
 * 150K 结果都低于预算且不受影响。
 *
 * 状态通过 `state` 中的 tool_use_id 跟踪。一旦结果被见过，
 * 其命运即冻结：之前替换过的结果每轮从缓存的预览字符串
 * 重新应用相同的替换（零 I/O、字节级一致），之前未替换的
 * 结果永远不会在之后替换（会破坏提示词缓存）。
 *
 * 每轮最多添加一条带有 tool_result 块的新用户消息，
 * 因此每消息循环通常最多执行一次预算检查；
 * 所有之前的消息只是重新应用缓存的替换。
 *
 * @param state — 可变：seenIds 和 replacements 就地更新
 *   以记录本次调用做出的选择。调用者在轮次中持有稳定的
 *   引用；返回新对象需要在每次查询后进行容易出错的引用更新。
 *
 * 返回 `{ messages, newlyReplaced }`：
 *   - messages: 不需要替换时为相同的数组实例
 *   - newlyReplaced: 本次调用进行的替换（非重新应用）。
 *     调用者将这些持久化到转录中以供 resume 重建。
 */
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(),
): Promise<{
  messages: Message[]
  newlyReplaced: ToolResultReplacementRecord[]
}> {
  const candidatesByMessage = collectCandidatesByMessage(messages)
  const nameByToolUseId = skipToolNames.size > 0 ? buildToolNameMap(messages) : undefined
  const shouldSkip = (id: string): boolean =>
    nameByToolUseId !== undefined && skipToolNames.has(nameByToolUseId.get(id) ?? '')
  // 每次调用解析一次。会话中的 flag 更改只影响 FRESH
  // 消息（之前的决策通过 seenIds/replacements 冻结），因此
  // 已见过内容的提示词缓存无论怎样都保留。
  const limit = getPerMessageBudgetLimit()

  // 独立遍历每个 API 级别的消息组。对于之前处理过的消息
  // （seenIds 中的所有 ID），这只是重新应用缓存的替换。对于
  // 本轮添加的单条新消息，它运行预算检查。
  const replacementMap = new Map<string, string>()
  const toPersist: ToolResultCandidate[] = []
  let reappliedCount = 0
  let messagesOverBudget = 0

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state)

    // 重新应用：纯 Map 查找。无文件 I/O，字节级一致，不会失败。
    mustReapply.forEach((c) => replacementMap.set(c.toolUseId, c.replacement))
    reappliedCount += mustReapply.length

    // Fresh 意味着这是一条新消息。检查其每条消息的预算。
    // （之前处理过的消息 fresh.length === 0，因为所有
    // 它的 ID 在首次见过时已添加到 seenIds。）
    if (fresh.length === 0) {
      // mustReapply/frozen 已在第一次遍历时加入 seenIds——
      // 重新添加是无操作但保持显式不变量。
      candidates.forEach((c) => state.seenIds.add(c.toolUseId))
      continue
    }

    // maxResultSizeChars 为 Infinity 的工具（Read）——永不持久化。
    // 标记为 seen（frozen）使决策跨轮生效。它们不计入
    // freshSize；如果这让组低于预算但线上消息仍然很大，
    // 这是约定——Read 自己的 maxTokens 是边界，而非这个包装器。
    const skipped = fresh.filter((c) => shouldSkip(c.toolUseId))
    skipped.forEach((c) => state.seenIds.add(c.toolUseId))
    const eligible = fresh.filter((c) => !shouldSkip(c.toolUseId))

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0)
    const freshSize = eligible.reduce((sum, c) => sum + c.size, 0)

    const selected =
      frozenSize + freshSize > limit ? selectFreshToReplace(eligible, frozenSize, limit) : []

    // 将不需要持久化的候选标记为已见（同步）。选中
    // 持久化的 ID 在 await 之后才标记为已见，与
    // replacements.set 一起——保持这对在观察下的原子性，
    // 这样没有并发读者（当子代理共享状态时）会看到
    // X 在 seenIds 中但 X 不在 replacements 中，否则会将 X
    // 误分类为 frozen 并发送完整内容，而主线程发送预览
    // 导致缓存未命中。
    const selectedIds = new Set(selected.map((c) => c.toolUseId))
    candidates
      .filter((c) => !selectedIds.has(c.toolUseId))
      .forEach((c) => state.seenIds.add(c.toolUseId))

    if (selected.length === 0) continue
    messagesOverBudget++
    toPersist.push(...selected)
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] }
  }

  // Fresh: 对所有消息中选中的候选并发持久化。
  // 实际上 toPersist 每轮来自单条消息。
  const freshReplacements = await Promise.all(
    toPersist.map(async (c) => [c, await buildReplacement(c)] as const),
  )
  const newlyReplaced: ToolResultReplacementRecord[] = []
  let replacedSize = 0
  for (const [candidate, replacement] of freshReplacements) {
    // 在这里标记为 seen，在 await 之后，与 replacements.set 原子操作
    // 用于成功情况。对于持久化失败（replacement === null），
    // ID 是已见过但未替换的——原始内容已发送给模型，
    // 因此将其视为 frozen 是正确的。
    state.seenIds.add(candidate.toolUseId)
    if (replacement === null) continue
    replacedSize += candidate.size
    replacementMap.set(candidate.toolUseId, replacement.content)
    state.replacements.set(candidate.toolUseId, replacement.content)
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement: replacement.content,
    })
    logEvent('zy_tool_result_persisted_message_budget', {
      originalSizeBytes: replacement.originalSize,
      persistedSizeBytes: replacement.content.length,
      estimatedOriginalTokens: Math.ceil(replacement.originalSize / BYTES_PER_TOKEN),
      estimatedPersistedTokens: Math.ceil(replacement.content.length / BYTES_PER_TOKEN),
    })
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] }
  }

  if (newlyReplaced.length > 0) {
    logForDebugging(
      `Per-message budget: persisted ${newlyReplaced.length} tool results ` +
        `across ${messagesOverBudget} over-budget message(s), ` +
        `shed ~${formatFileSize(replacedSize)}, ${reappliedCount} re-applied`,
    )
    logEvent('zy_message_level_tool_result_budget_enforced', {
      resultsPersisted: newlyReplaced.length,
      messagesOverBudget,
      replacedSizeBytes: replacedSize,
      reapplied: reappliedCount,
    })
  }

  return {
    messages: replaceToolResultContents(messages, replacementMap),
    newlyReplaced,
  }
}

/**
 * 聚合预算的查询循环集成点。
 *
 * 以 `state` 为门控（undefined 表示功能禁用 → 无操作返回），
 * 执行强制，并为新替换触发可选的转录写入回调。
 * 调用者（query.ts）拥有持久化门控——它只为在 resume 时
 * 回读记录的 querySource 传递回调
 * （repl_main_thread*, agent:*）；临时的 runForkedAgent 调用者
 * （agentSummary、sessionMemory、/btw、compact）传递 undefined。
 *
 * @returns 应用了替换的 messages，或当功能关闭或未发生替换时
 *   不变的输入数组。
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages
  const result = await enforceToolResultBudget(messages, state, skipToolNames)
  if (result.newlyReplaced.length > 0) {
    writeToTranscript?.(result.newlyReplaced)
  }
  return result.messages
}

/**
 * 从转录中加载的内容替换记录重建替换状态。
 * 用于 resume，以便预算做出与原始会话中相同的选择
 * （提示词缓存稳定性）。
 *
 * 接受来自 LogOption 的完整 ContentReplacementRecord[]
 * （可能包含未来的非工具结果类型）；这里仅应用工具结果记录。
 *
 *   - replacements: 直接从存储的替换字符串填充。
 *     不在消息中的 ID 的记录（例如 compact 后）被跳过——
 *     它们反正也是惰性的。
 *   - seenIds: 加载消息中的每个候选 tool_use_id。
 *     结果在转录中意味着它已发送给模型，所以它被见过。
 *     这会冻结未替换的结果，防止未来被替换。
 *   - inheritedReplacements: 为 fork-子代理 resume 填补空白。
 *     分叉的原始运行通过 mustReapply 应用从父级继承的替换
 *     （从未持久化——不是 newlyReplaced）。在 resume 时 sidechain
 *     有原始内容但没有记录，因此仅靠记录会将其分类为 frozen。
 *     父级的实时状态仍有映射；复制记录未覆盖的消息中的 ID。
 *     对于非 fork resume 是无操作（父级 ID 不在子代理的消息中）。
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = new Set(
    collectCandidatesByMessage(messages)
      .flat()
      .map((c) => c.toolUseId),
  )

  for (const id of candidateIds) {
    state.seenIds.add(id)
  }
  for (const r of records) {
    if (r.kind === 'tool-result' && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement)
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement)
      }
    }
  }
  return state
}

/**
 * AgentTool-resume 变体：封装 feature-flag 门控 + 父级
 * 空白填补，使 AgentTool.call 和 resumeAgentBackground 共享
 * 一个实现。当 parentState 为 undefined 时返回 undefined
 * （功能关闭）；否则从 sidechain 记录重建，用父级的
 * 实时替换填补 fork 继承的 mustReapply 条目的空白。
 *
 * 保持在 AgentTool.tsx 之外——该文件处于 feature() DCE 复杂度
 * 临界点，无法容忍 +1 行源代码而不静默破坏
 * 测试中的 feature('TRANSCRIPT_CLASSIFIER') 评估。
 */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  return reconstructContentReplacementState(
    resumedMessages,
    sidechainRecords,
    parentState.replacements,
  )
}

/**
 * 从文件系统错误获取人类可读的错误消息
 */
function getFileSystemErrorMessage(error: Error): string {
  // Node.js 文件系统错误有一个 'code' 属性
  // eslint-disable-next-line no-restricted-syntax -- 使用 .path，不只是 .code
  const nodeError = error as NodeJS.ErrnoException
  if (nodeError.code) {
    switch (nodeError.code) {
      case 'ENOENT':
        return `Directory not found: ${nodeError.path ?? 'unknown path'}`
      case 'EACCES':
        return `Permission denied: ${nodeError.path ?? 'unknown path'}`
      case 'ENOSPC':
        return 'No space left on device'
      case 'EROFS':
        return 'Read-only file system'
      case 'EMFILE':
        return 'Too many open files'
      case 'EEXIST':
        return `File already exists: ${nodeError.path ?? 'unknown path'}`
      default:
        return `${nodeError.code}: ${nodeError.message}`
    }
  }
  return error.message
}
