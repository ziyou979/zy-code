/**
 * 用于动态发现延迟加载工具的 Tool Search 工具函数。
 *
 * 启用后，延迟工具（MCP 和 shouldDefer 工具）会携带 defer_loading: true 发送，
 * 并通过 ToolSearchTool 发现，而非预先加载。
 */

import memoize from 'lodash-es/memoize.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import {
  getAPIProvider,
  isAnthropicBaseUrl,
  isAnthropicModel,
} from 'src/services/model/providers.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import type { Tool } from '../../tools/tool.js'
import { type ToolPermissionContext, type Tools, toolMatchesName } from '../../tools/tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} from '../../services/compact/analyzeContext.js'
import { count } from '../../utils/array.js'
import { getContextWindowForModel } from '../../services/context/modelContext.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { zodToJsonSchema } from '../api/zodToJsonSchema.js'

/**
 * 自动启用 tool search 的默认上下文窗口百分比。MCP 工具描述超过此百分比（按 token 计）时，
 * 启用 tool search。可通过 ENABLE_TOOL_SEARCH=auto:N 覆盖，其中 N 为 0-100。
 */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10 // 10%

/**
 * 解析 ENABLE_TOOL_SEARCH 环境变量中的 auto:N 语法。
 * 返回限制在 0-100 的百分比；如果不是 auto:N 格式或不是数字，则返回 null。
 */
function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith('auto:')) {
    return null
  }

  const percentStr = value.slice(5)
  const percent = parseInt(percentStr, 10)

  if (Number.isNaN(percent)) {
    logForDebugging(
      `Invalid ENABLE_TOOL_SEARCH value "${value}": expected auto:N where N is a number.`,
    )
    return null
  }

  // 限制到有效范围
  return Math.max(0, Math.min(100, percent))
}

/**
 * 检查 ENABLE_TOOL_SEARCH 是否设置为自动模式（auto 或 auto:N）。
 */
function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return value === 'auto' || value.startsWith('auto:')
}

/**
 * 从环境变量或默认值获取自动启用百分比。
 */
function getAutoToolSearchPercentage(): number {
  const value = process.env.ENABLE_TOOL_SEARCH
  if (!value) {
    return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
  }

  if (value === 'auto') {
    return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
  }

  const parsed = parseAutoPercentage(value)
  if (parsed !== null) {
    return parsed
  }

  return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
}

/**
 * MCP 工具定义（名称、描述和输入 schema）的近似每 token 字符数。
 * token 计数 API 不可用时作为回退方案。
 */
const CHARS_PER_TOKEN = 2.5

/**
 * 获取给定模型自动启用 tool search 的 token 阈值。
 */
function getAutoToolSearchTokenThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model)
  const percentage = getAutoToolSearchPercentage() / 100
  return Math.floor(contextWindow * percentage)
}

/**
 * 获取给定模型自动启用 tool search 的字符阈值。
 * token 计数 API 不可用时作为回退方案。
 */
export function getAutoToolSearchCharThreshold(model: string): number {
  return Math.floor(getAutoToolSearchTokenThreshold(model) * CHARS_PER_TOKEN)
}

/**
 * 使用 token 计数 API 获取所有延迟工具的 token 总数。
 * 按延迟工具名称记忆化；MCP 服务器连接/断开时缓存失效。
 * API 不可用时返回 null（调用方应回退到字符启发式）。
 */
const getDeferredToolTokenCount = memoize(
  async (
    tools: Tools,
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    const deferredTools = tools.filter((t) => isDeferredTool(t))
    if (deferredTools.length === 0) {
      return 0
    }

    try {
      const total = await countToolDefinitionTokens(
        deferredTools,
        getToolPermissionContext,
        { activeAgents: agents, allAgents: agents },
        model,
      )
      if (total === 0) {
        return null // API unavailable
      }
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      return null // Fall back to char heuristic
    }
  },
  (tools: Tools) =>
    tools
      .filter((t) => isDeferredTool(t))
      .map((t) => t.name)
      .join(','),
)

/**
 * Tool search 模式。决定如何呈现可延迟工具（MCP + shouldDefer）：
 *   - 'tst': Tool Search Tool — deferred tools discovered via ToolSearchTool (always enabled)
 *   - 'tst-auto': auto — tools deferred only when they exceed threshold
 *   - 'standard': tool search disabled — all tools exposed inline
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

/**
 * 根据 ENABLE_TOOL_SEARCH 确定 tool search 模式。
 *
 *   ENABLE_TOOL_SEARCH    Mode
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   (unset)               tst (default: always defer MCP and shouldDefer tools)
 */
export function getToolSearchMode(model: string = getMainLoopModel() ?? ''): ToolSearchMode {
  // ZY_CODE_DISABLE_EXPERIMENTAL_BETAS 是 beta API 功能的紧急开关。Tool search 在
  // 工具定义和 tool_reference 内容块中发送 defer_loading，二者均要求 API 接受 beta
  // header。设置该开关后强制使用 'standard'，以确保没有 beta 结构进入网络，即使同时
  // 设置了 ENABLE_TOOL_SEARCH 也是如此。这为 isToolSearchEnabledOptimistic 启发式未
  // 覆盖的代理网关提供了显式逃生出口。
  // github.com/anthropics/zy-code/issues/20031
  if (isEnvTruthy(process.env.ZY_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  // defer_loading / tool_reference 由 advanced-tool-use beta 解锁,只对真 Claude
  // 模型有意义(按 model id 判断,而非 provider)。非 Claude 模型会拒绝这些 beta
  // 形状,故对它们关闭 tool search(降级为全量下发工具 schema——tool search 之前的行为)。
  if (!isAnthropicModel(model)) {
    return 'standard'
  }

  const value = process.env.ENABLE_TOOL_SEARCH

  // 处理 auto:N 语法，先检查边界情况
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) {
    return 'tst' // auto:0 = always enabled
  }
  if (autoPercent === 100) {
    return 'standard'
  }
  if (isAutoToolSearchMode(value)) {
    return 'tst-auto' // auto or auto:1-99
  }

  if (isEnvTruthy(value)) {
    return 'tst'
  }
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) {
    return 'standard'
  }
  return 'tst' // default: always defer MCP and shouldDefer tools
}

/**
 * 不支持 tool_reference 的模型的默认模式。
 * 除非在此显式列出，否则假定新模型支持 tool_reference。
 */
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = ['haiku']

/**
 * 获取不支持 tool_reference 的模型模式列表。
 * 可通过 GrowthBook 配置，以便无需改代码即可实时更新。
 */
function getUnsupportedToolReferencePatterns(): string[] {
  try {
    // 尝试从 GrowthBook 获取实时配置
    const patterns = getFeatureValue_CACHED_MAY_BE_STALE<string[] | null>(
      'zy_tool_search_unsupported_models',
      null,
    )
    if (patterns && Array.isArray(patterns) && patterns.length > 0) {
      return patterns
    }
  } catch {
    // GrowthBook 尚未就绪，使用默认值
  }
  return DEFAULT_UNSUPPORTED_MODEL_PATTERNS
}

/**
 * 检查模型是否支持 tool_reference 块（tool search 所需）。
 *
 * 这里使用负向测试：除非模型匹配不支持列表中的模式，否则假定其支持 tool_reference。
 * 这确保新模型默认可用，无需代码更改。
 *
 * 当前 Haiku 模型不支持 tool_reference。可通过 GrowthBook feature
 * 'zy_tool_search_unsupported_models' 更新。
 *
 * @param model The model name to check
 * @returns true if the model supports tool_reference, false otherwise
 */
export function modelSupportsToolReference(model: string): boolean {
  const normalizedModel = model.toLowerCase()
  const unsupportedPatterns = getUnsupportedToolReferencePatterns()

  // 检查模型是否匹配任一不支持模式
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false
    }
  }

  // 假定新模型支持 tool_reference
  return true
}

/**
 * 检查 tool search 是否*可能*启用（乐观检查）。
 *
 * 若 tool search 可能启用则返回 true，不检查模型支持或阈值等动态因素。用于：
 * - Including ToolSearchTool in base tools (so it's available if needed)
 * - Preserving tool_reference fields in messages (can be stripped later)
 * - Checking if ToolSearchTool should report itself as enabled
 *
 * 仅在 tool search 确定禁用（standard 模式）时返回 false。
 *
 * 对包含模型支持和阈值的确定性检查，请使用 isToolSearchEnabled()。
 */
let loggedOptimistic = false

export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=false`,
      )
    }
    return false
  }

  // tool_reference 是 beta 内容类型，第三方 API 网关
  // (ZY_CODE_BASE_URL proxies) typically don't support. When the provider
  // 为 'anthropic' 但 base URL 指向其他位置时，代理会拒绝
  // tool_reference 块并返回 400。Vertex/Bedrock/Foundry 不受影响，
  // 因为它们有自己的 endpoints 和 beta headers。
  // https://github.com/anthropics/zy-code/issues/30912
  //
  // 但某些代理确实支持 tool_reference（LiteLLM passthrough、Cloudflare AI Gateway、
  // 转发 beta headers 的企业网关）。一刀切禁用会破坏这些用户的 defer_loading：所有 MCP
  // 工具都会加载进主上下文而非按需加载（gh-31936 / CC-457，可能是 CC-330
  // “v2.1.70 defer_loading regression”的真正原因）。此守卫仅在 ENABLE_TOOL_SEARCH
  // 未设置/为空（默认行为）时适用。设置任意非空值（'true'、'auto'、'auto:N'）表示用户
  // 显式配置了 tool search，并断言其配置支持它。falsy 检查（而非 === undefined）与
  // getToolSearchMode() 一致，后者也把 "" 视为未设置。
  if (
    !process.env.ENABLE_TOOL_SEARCH &&
    getAPIProvider() === 'anthropic' &&
    !isAnthropicBaseUrl()
  ) {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] disabled: ZY_CODE_BASE_URL=${process.env.ZY_CODE_BASE_URL} is not a direct ZY API host. Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your proxy forwards tool_reference blocks.`,
      )
    }
    return false
  }

  if (!loggedOptimistic) {
    loggedOptimistic = true
    logForDebugging(
      `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=true`,
    )
  }
  return true
}

/**
 * 检查提供的工具列表中是否存在 ToolSearchTool。
 * ToolSearchTool 不可用时（例如通过 disallowedTools 禁用），tool search 无法工作，
 * 应被禁用。
 *
 * @param tools Array of tools with a 'name' property
 * @returns true if ToolSearchTool is in the tools list, false otherwise
 */
export function isToolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return tools.some((tool) => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

/**
 * 按字符数计算延迟工具描述的总大小。
 * 包含名称、描述文本和输入 schema，以匹配实际发送给 API 的内容。
 */
async function calculateDeferredToolDescriptionChars(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
): Promise<number> {
  const deferredTools = tools.filter((t) => isDeferredTool(t))
  if (deferredTools.length === 0) {
    return 0
  }

  const sizes = await Promise.all(
    deferredTools.map(async (tool) => {
      const description = await tool.prompt({
        getToolPermissionContext,
        tools,
        agents,
      })
      const inputSchema = tool.inputJSONSchema
        ? jsonStringify(tool.inputJSONSchema)
        : tool.inputSchema
          ? jsonStringify(zodToJsonSchema(tool.inputSchema))
          : ''
      return tool.name.length + description.length + inputSchema.length
    }),
  )

  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * 检查特定请求是否启用了 tool search（带 tool_reference 的 MCP 工具延迟加载）。
 *
 * 这是包含以下内容的确定性检查：
 * - MCP mode (Tst, TstAuto, McpCli, Standard)
 * - Model compatibility (haiku doesn't support tool_reference)
 * - ToolSearchTool availability (must be in tools list)
 * - Threshold check for TstAuto mode
 *
 * 在所有上下文均可用的实际 API 调用中使用此函数。
 *
 * @param model The model to check for tool_reference support
 * @param tools Array of available tools (including MCP tools)
 * @param getToolPermissionContext Function to get tool permission context
 * @param agents Array of agent definitions
 * @param source Optional identifier for the caller (for debugging)
 * @returns true if tool search should be enabled for this request
 */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
): Promise<boolean> {
  const mcpToolCount = count(tools, (t) => t.isMcp)

  // 用于记录模式决策事件的辅助函数
  function logModeDecision(
    enabled: boolean,
    mode: ToolSearchMode,
    reason: string,
    extraProps?: Record<string, number>,
  ): void {
    logEvent('zy_tool_search_mode_decision', {
      enabled,
      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason: reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 记录实际被检查的模型，而非会话主模型。这对调试子代理 tool search 决策很重要，
      // 因为子代理模型（例如 haiku）可能不同于会话模型（例如 opus）。
      checkedModel: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      mcpToolCount,
      userType: (process.env.USER_TYPE ??
        'external') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...extraProps,
    })
  }

  // 检查模型是否支持 tool_reference
  if (!modelSupportsToolReference(model)) {
    logForDebugging(
      `Tool search disabled for model '${model}': model does not support tool_reference blocks. ` +
        `This feature is only available on ZY Code Sonnet 4+, Opus 4+, and newer models.`,
    )
    logModeDecision(false, 'standard', 'model_unsupported')
    return false
  }

  // 检查 ToolSearchTool 是否可用（遵循 disallowedTools）
  if (!isToolSearchToolAvailable(tools)) {
    logForDebugging(
      `Tool search disabled: ToolSearchTool is not available (may have been disallowed via disallowedTools).`,
    )
    logModeDecision(false, 'standard', 'mcp_search_unavailable')
    return false
  }

  const mode = getToolSearchMode(model)

  switch (mode) {
    case 'tst':
      logModeDecision(true, mode, 'tst_enabled')
      return true

    case 'tst-auto': {
      const { enabled, debugDescription, metrics } = await checkAutoThreshold(
        tools,
        getToolPermissionContext,
        agents,
        model,
      )

      if (enabled) {
        logForDebugging(
          `Auto tool search enabled: ${debugDescription}${source ? ` [source: ${source}]` : ''}`,
        )
        logModeDecision(true, mode, 'auto_above_threshold', metrics)
        return true
      }

      logForDebugging(
        `Auto tool search disabled: ${debugDescription}${source ? ` [source: ${source}]` : ''}`,
      )
      logModeDecision(false, mode, 'auto_below_threshold', metrics)
      return false
    }

    case 'standard':
      logModeDecision(false, mode, 'standard_mode')
      return false
  }
}

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types, so we need runtime checks.
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * Type guard for tool_reference block with tool_name.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

/**
 * Type representing a tool_result block with array content.
 * Used for extracting tool_reference blocks from ToolSearchTool results.
 */
type ToolResultBlock = {
  type: 'tool_result'
  content: unknown[]
}

/**
 * Type guard for tool_result blocks with array content.
 */
function isToolResultBlockWithContent(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    Array.isArray((obj as { content: unknown }).content)
  )
}

/**
 * Extract tool names from tool_reference blocks in message history.
 *
 * When dynamic tool loading is enabled, MCP tools are not predeclared in the
 * tools array. Instead, they are discovered via ToolSearchTool which returns
 * tool_reference blocks. This function scans the message history to find all
 * tool names that have been referenced, so we can include only those tools
 * in subsequent API requests.
 *
 * This approach:
 * - Eliminates the need to predeclare all MCP tools upfront
 * - Removes limits on total quantity of MCP tools
 *
 * Compaction replaces tool_reference-bearing messages with a summary, so it
 * snapshots the discovered set onto compactMetadata.preCompactDiscoveredTools
 * on the boundary marker; this scan reads it back. Snip instead protects the
 * tool_reference-carrying messages from removal.
 *
 * @param messages Array of messages that may contain tool_result blocks with tool_reference content
 * @returns Set of tool names that have been discovered via tool_reference blocks
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discoveredTools = new Set<string>()
  let carriedFromBoundary = 0

  for (const msg of messages) {
    // Compact boundary carries the pre-compact discovered set. Inline type
    // check rather than isCompactBoundaryMessage — utils/messages.ts imports
    // from this file, so importing back would be circular.
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) {
          discoveredTools.add(name)
        }
        carriedFromBoundary += carried.length
      }
      continue
    }

    // Only user messages contain tool_result blocks (responses to tool_use)
    if (msg.type !== 'user') {
      continue
    }

    const content = msg.message?.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const block of content) {
      // tool_reference blocks only appear inside tool_result content, specifically
      // in results from ToolSearchTool. The API expands these references into full
      // tool definitions in the model's context.
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name)
          }
        }
      }
    }
  }

  if (discoveredTools.size > 0) {
    logForDebugging(
      `Dynamic tool loading: found ${discoveredTools.size} discovered tools in message history` +
        (carriedFromBoundary > 0 ? ` (${carriedFromBoundary} carried from compact boundary)` : ''),
    )
  }

  return discoveredTools
}

export type DeferredToolsDelta = {
  addedNames: string[]
  /** Rendered lines for addedNames; the scan reconstructs from names. */
  addedLines: string[]
  removedNames: string[]
}

/**
 * Call-site discriminator for the zy_deferred_tools_pool_change event.
 * The scan runs from several sites with different expected-prior semantics
 * (inc-4747):
 *   - attachments_main: main-thread getAttachments → prior=0 is a BUG on fire-2+
 *   - attachments_subagent: subagent getAttachments → prior=0 is EXPECTED
 *     (fresh conversation, initialMessages has no DTD)
 *   - compact_full: compact.ts passes [] → prior=0 is EXPECTED
 *   - compact_partial: compact.ts passes messagesToKeep → depends on what survived
 *   - reactive_compact: reactiveCompact.ts passes preservedMessages → same
 * Without this the 96%-prior=0 stat is dominated by EXPECTED buckets and
 * the real main-thread cross-turn bug (if any) is invisible in BQ.
 */
export type DeferredToolsDeltaScanContext = {
  callSite:
    | 'attachments_main'
    | 'attachments_subagent'
    | 'compact_full'
    | 'compact_partial'
    | 'reactive_compact'
  querySource?: string
}

/**
 * True → announce deferred tools via persisted delta attachments.
 * False → zy.ts keeps its per-call <available-deferred-tools>
 * header prepend (the attachment does not fire).
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return isInternalBuild() || getFeatureValue_CACHED_MAY_BE_STALE('zy_glacier_2xr', false)
}

/**
 * Diff the current deferred-tool pool against what's already been
 * announced in this conversation (reconstructed by scanning for prior
 * deferred_tools_delta attachments). Returns null if nothing changed.
 *
 * A name that was announced but has since stopped being deferred — yet
 * is still in the base pool — is NOT reported as removed. It's now
 * loaded directly, so telling the model "no longer available" would be
 * wrong.
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let dtdCount = 0
  const attachmentTypesSeen = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'attachment') {
      continue
    }
    attachmentCount++
    attachmentTypesSeen.add(msg.attachment.type)
    if (msg.attachment.type !== 'deferred_tools_delta') {
      continue
    }
    dtdCount++
    const delta = msg.attachment as unknown as { addedNames: string[]; removedNames: string[] }
    for (const n of delta.addedNames) {
      announced.add(n)
    }
    for (const n of delta.removedNames) {
      announced.delete(n)
    }
  }

  const deferred: Tool[] = tools.filter(isDeferredTool)
  const deferredNames = new Set(deferred.map((t) => t.name))
  const poolNames = new Set(tools.map((t) => t.name))

  const added = deferred.filter((t) => !announced.has(t.name))
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) {
      continue
    }
    if (!poolNames.has(n)) {
      removed.push(n)
    }
    // else: undeferred — silent
  }

  if (added.length === 0 && removed.length === 0) {
    return null
  }

  // Diagnostic for the inc-4747 scan-finds-nothing bug. Round-1 fields
  // (messagesLength/attachmentCount/dtdCount from #23167) showed 45.6% of
  // events have attachments-but-no-DTD, but those numbers are confounded:
  // subagent first-fires and compact-path scans have EXPECTED prior=0 and
  // dominate the stat. callSite/querySource/attachmentTypesSeen split the
  // buckets so the real main-thread cross-turn failure is isolable in BQ.
  logEvent('zy_deferred_tools_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    messagesLength: messages.length,
    attachmentCount,
    dtdCount,
    callSite: (scanContext?.callSite ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: (scanContext?.querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    attachmentTypesSeen: [...attachmentTypesSeen]
      .sort()
      .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    addedNames: added.map((t) => t.name).sort(),
    addedLines: added.map(formatDeferredToolLine).sort(),
    removedNames: removed.sort(),
  }
}

/**
 * Check whether deferred tools exceed the auto-threshold for enabling TST.
 * Tries exact token count first; falls back to character-based heuristic.
 */
async function checkAutoThreshold(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  model: string,
): Promise<{
  enabled: boolean
  debugDescription: string
  metrics: Record<string, number>
}> {
  // Try exact token count first (cached, one API call per toolset change)
  const deferredToolTokens = await getDeferredToolTokenCount(
    tools,
    getToolPermissionContext,
    agents,
    model,
  )

  if (deferredToolTokens !== null) {
    const threshold = getAutoToolSearchTokenThreshold(model)
    return {
      enabled: deferredToolTokens >= threshold,
      debugDescription:
        `${deferredToolTokens} tokens (threshold: ${threshold}, ` +
        `${getAutoToolSearchPercentage()}% of context)`,
      metrics: { deferredToolTokens, threshold },
    }
  }

  // Fallback: character-based heuristic when token API is unavailable
  const deferredToolDescriptionChars = await calculateDeferredToolDescriptionChars(
    tools,
    getToolPermissionContext,
    agents,
  )
  const charThreshold = getAutoToolSearchCharThreshold(model)
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoToolSearchPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  }
}
