import { feature } from 'bun:bundle'
import { getSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from 'src/constants/prompts.js'
import { microcompactMessages } from 'src/services/compact/microCompact.js'
import { getCommandName } from '../commands.js'
import { getSystemContext } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import {
  findToolByName,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from '../tool.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import {
  getLimitedSkillToolCommands,
  getSkillToolInfo as getSlashCommandInfo,
} from '../tools/SkillTool/prompt.js'
import type { LLMMessage, ToolDefinition } from '../types/llm.js'
import type { AssistantMessage, AttachmentMessage, Message, UserMessage } from '../types/message.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './agentsMd.js'
import { toolToAPISchema } from './api.js'
import { getContextWindowForModel } from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy, isInternalBuild } from './envUtils.js'
import { errorMessage, toError } from './errors.js'
import { logError } from './log.js'
import { normalizeMessagesForAPI } from '../services/messages/index.js'
import type { SettingSource } from '../services/settings/constants.js'
import { jsonStringify } from './slowOperations.js'
import { buildEffectiveSystemPrompt } from './systemPrompt.js'
import type { Theme } from './theme.js'
import { getCurrentUsage } from './tokens.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const MANUAL_COMPACT_BUFFER_NAME = 'Compact buffer'

/**
 * 当存在工具时，API 附加的固定 token 开销。
 * API 在存在工具时每次调用会添加一段工具提示前言（约 500 token）。
 * 当我们通过 token 计数 API 逐个统计工具时，每次调用都会包含该开销，
 * 导致 N 个工具产生 N × 开销，而非 1 × 开销。
 * 我们从单个工具的计数中减去该开销，以展示准确的工具内容大小。
 */
export const TOOL_TOKEN_COUNT_OVERHEAD = 500

async function countTokensWithFallback(
  messages: LLMMessage[],
  tools: ToolDefinition[],
): Promise<number | null> {
  try {
    const result = await countMessagesTokensWithAPI(messages, tools)
    if (result !== null) {
      return result
    }
    logForDebugging(
      `countTokensWithFallback: API returned null, trying haiku fallback (${tools.length} tools)`,
    )
  } catch (err) {
    logForDebugging(`countTokensWithFallback: API failed: ${errorMessage(err)}`)
    logError(err)
  }

  try {
    const fallbackResult = await countTokensViaHaikuFallback(messages, tools)
    if (fallbackResult === null) {
      logForDebugging(
        `countTokensWithFallback: haiku fallback also returned null (${tools.length} tools)`,
      )
    }
    return fallbackResult
  } catch (err) {
    logForDebugging(`countTokensWithFallback: haiku fallback failed: ${errorMessage(err)}`)
    logError(err)
    return null
  }
}

interface ContextCategory {
  name: string
  tokens: number
  color: keyof Theme
  /** 为 true 时，这些 token 是延迟加载的，不计入 context 使用量 */
  isDeferred?: boolean
}

interface GridSquare {
  color: keyof Theme
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number // 0-1 表示该方格的填充程度
}

interface MemoryFile {
  path: string
  type: string
  tokens: number
}

interface McpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded?: boolean
}

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

interface Agent {
  agentType: string
  source: SettingSource | 'built-in' | 'plugin'
  tokens: number
}

interface SlashCommandInfo {
  readonly totalCommands: number
  readonly includedCommands: number
  readonly tokens: number
}

/** 用于 context 展示的单个 skill 详情 */
interface SkillFrontmatter {
  name: string
  source: SettingSource | 'plugin'
  tokens: number
}

/**
 * 包含在 context window 中的 skill 信息。
 */
interface SkillInfo {
  /** 可用 skill 的总数 */
  readonly totalSkills: number
  /** 在 token 预算内包含的 skill 数量 */
  readonly includedSkills: number
  /** skill 消耗的总 token 数 */
  readonly tokens: number
  /** 各个 skill 的详情 */
  readonly skillFrontmatter: SkillFrontmatter[]
}

export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  /** 仅内部使用：延迟加载的内置工具逐个分解 */
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  /** 仅内部使用：始终加载的内置工具逐个分解 */
  readonly systemTools?: SystemToolDetail[]
  /** 仅内部使用：system prompt 逐段分解 */
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  /** Skill 统计信息 */
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  /** 上次 API 响应中的实际 token 使用量（如有） */
  readonly apiUsage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  } | null
}

export async function countToolDefinitionTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
): Promise<number> {
  const toolSchemas = await Promise.all(
    tools.map((tool) =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  const result = await countTokensWithFallback([], toolSchemas)
  if (result === null || result === 0) {
    const toolNames = tools.map((t) => t.name).join(', ')
    logForDebugging(
      `countToolDefinitionTokens returned ${result} for ${tools.length} tools: ${toolNames.slice(0, 100)}${toolNames.length > 100 ? '...' : ''}`,
    )
  }
  return result ?? 0
}

/** 从 system prompt 段落的内容中提取一个可读名称 */
function extractSectionName(content: string): string {
  // 尝试查找第一个 markdown 标题
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1]!.trim()
  }
  // 回退为第一个非空行的截断预览
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

async function countSystemTokens(effectiveSystemPrompt: readonly string[]): Promise<{
  systemPromptTokens: number
  systemPromptSections: SystemPromptSectionDetail[]
}> {
  // 获取始终包含的系统上下文（gitStatus 等）
  const systemContext = await getSystemContext()

  // 构建命名条目：system prompt 各部分 + 系统上下文值
  // 跳过空字符串和全局缓存边界标记
  const namedEntries: Array<{ name: string; content: string }> = [
    ...effectiveSystemPrompt
      .filter((content) => content.length > 0 && content !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      .map((content) => ({ name: extractSectionName(content), content })),
    ...Object.entries(systemContext)
      .filter(([, content]) => content.length > 0)
      .map(([name, content]) => ({ name, content })),
  ]

  if (namedEntries.length < 1) {
    return { systemPromptTokens: 0, systemPromptSections: [] }
  }

  const systemTokenCounts = await Promise.all(
    namedEntries.map(({ content }) =>
      countTokensWithFallback(
        [{ role: 'user', content: [{ type: 'text' as const, text: content }] }],
        [],
      ),
    ),
  )

  const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map((entry, i) => ({
    name: entry.name,
    tokens: systemTokenCounts[i] || 0,
  }))

  const systemPromptTokens = systemTokenCounts.reduce(
    (sum: number, tokens) => sum + (tokens || 0),
    0,
  )

  return { systemPromptTokens, systemPromptSections }
}

async function countMemoryFileTokens(): Promise<{
  memoryFileDetails: MemoryFile[]
  agentsMdTokens: number
}> {
  // Simple 模式禁用了 AGENTS.md 加载，因此不报告其 token 数
  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    return { memoryFileDetails: [], agentsMdTokens: 0 }
  }

  const memoryFilesData = filterInjectedMemoryFiles(await getMemoryFiles())
  const memoryFileDetails: MemoryFile[] = []
  let agentsMdTokens = 0

  if (memoryFilesData.length < 1) {
    return {
      memoryFileDetails: [],
      agentsMdTokens: 0,
    }
  }

  const agentsMdTokenCounts = await Promise.all(
    memoryFilesData.map(async (file) => {
      const tokens = await countTokensWithFallback(
        [{ role: 'user', content: [{ type: 'text' as const, text: file.content }] }],
        [],
      )

      return { file, tokens: tokens || 0 }
    }),
  )

  for (const { file, tokens } of agentsMdTokenCounts) {
    agentsMdTokens += tokens
    memoryFileDetails.push({
      path: file.path,
      type: file.type,
      tokens,
    })
  }

  return { agentsMdTokens, memoryFileDetails }
}

async function countBuiltInToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
  messages?: Message[],
): Promise<{
  builtInToolTokens: number
  deferredBuiltinDetails: DeferredBuiltinTool[]
  deferredBuiltinTokens: number
  systemToolDetails: SystemToolDetail[]
}> {
  const builtInTools = tools.filter((tool) => !tool.isMcp)
  if (builtInTools.length < 1) {
    return {
      builtInToolTokens: 0,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails: [],
    }
  }

  // 检查工具搜索是否启用
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')
  const isDeferred = await isToolSearchEnabled(
    model ?? '',
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeBuiltIn',
  )

  // 使用动态 isDeferredTool 检查来区分始终加载和延迟加载的内置工具
  const alwaysLoadedTools = builtInTools.filter((t) => !isDeferredTool(t))
  const deferredBuiltinTools = builtInTools.filter((t) => isDeferredTool(t))

  // 统计始终加载的工具
  const alwaysLoadedTokens =
    alwaysLoadedTools.length > 0
      ? await countToolDefinitionTokens(
          alwaysLoadedTools,
          getToolPermissionContext,
          agentInfo,
          model,
        )
      : 0

  // 为始终加载的工具构建逐个分解（仅内部使用，按粗略 schema 大小估算
  // 对批量计数进行比例分配）。排除 SkillTool，因为其 token 在单独的
  // Skills 类别中展示。
  let systemToolDetails: SystemToolDetail[] = []
  if (isInternalBuild()) {
    const toolsForBreakdown = alwaysLoadedTools.filter((t) => !toolMatchesName(t, SKILL_TOOL_NAME))
    if (toolsForBreakdown.length > 0) {
      const estimates = toolsForBreakdown.map((t) =>
        roughTokenCountEstimation(jsonStringify(t.inputSchema ?? {})),
      )
      const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
      const distributable = Math.max(0, alwaysLoadedTokens - TOOL_TOKEN_COUNT_OVERHEAD)
      systemToolDetails = toolsForBreakdown
        .map((t, i) => ({
          name: t.name,
          tokens: Math.round((estimates[i]! / estimateTotal) * distributable),
        }))
        .sort((a, b) => b.tokens - a.tokens)
    }
  }

  // 逐个统计延迟加载的内置工具以获取详情
  const deferredBuiltinDetails: DeferredBuiltinTool[] = []
  let loadedDeferredTokens = 0
  let totalDeferredTokens = 0

  if (deferredBuiltinTools.length > 0 && isDeferred) {
    // 查找消息中已使用过的延迟加载工具
    const loadedToolNames = new Set<string>()
    if (messages) {
      const deferredToolNameSet = new Set(deferredBuiltinTools.map((t) => t.name))
      for (const msg of messages) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (
              block.type === 'tool_call' &&
              'name' in block &&
              typeof block.name === 'string' &&
              deferredToolNameSet.has(block.name)
            ) {
              loadedToolNames.add(block.name)
            }
          }
        }
      }
    }

    // 逐个统计延迟加载的工具
    const tokensByTool = await Promise.all(
      deferredBuiltinTools.map((t) =>
        countToolDefinitionTokens([t], getToolPermissionContext, agentInfo, model),
      ),
    )

    for (const [i, tool] of deferredBuiltinTools.entries()) {
      const tokens = Math.max(0, (tokensByTool[i] || 0) - TOOL_TOKEN_COUNT_OVERHEAD)
      const isLoaded = loadedToolNames.has(tool.name)
      deferredBuiltinDetails.push({
        name: tool.name,
        tokens,
        isLoaded,
      })
      totalDeferredTokens += tokens
      if (isLoaded) {
        loadedDeferredTokens += tokens
      }
    }
  } else if (deferredBuiltinTools.length > 0) {
    // 工具搜索未启用 - 将延迟加载工具按常规工具计数
    const deferredTokens = await countToolDefinitionTokens(
      deferredBuiltinTools,
      getToolPermissionContext,
      agentInfo,
      model,
    )
    return {
      builtInToolTokens: alwaysLoadedTokens + deferredTokens,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails,
    }
  }

  return {
    // 延迟加载时，只计算始终加载的工具 + 已加载的延迟工具
    builtInToolTokens: alwaysLoadedTokens + loadedDeferredTokens,
    deferredBuiltinDetails,
    deferredBuiltinTokens: totalDeferredTokens - loadedDeferredTokens,
    systemToolDetails,
  }
}

function findSkillTool(tools: Tools): Tool | undefined {
  return findToolByName(tools, SKILL_TOOL_NAME)
}

async function countSlashCommandTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  slashCommandTokens: number
  commandInfo: { totalCommands: number; includedCommands: number }
}> {
  const info = await getSlashCommandInfo(getCwd())

  const slashCommandTool = findSkillTool(tools)
  if (!slashCommandTool) {
    return {
      slashCommandTokens: 0,
      commandInfo: { totalCommands: 0, includedCommands: 0 },
    }
  }

  const slashCommandTokens = await countToolDefinitionTokens(
    [slashCommandTool],
    getToolPermissionContext,
    agentInfo,
  )

  return {
    slashCommandTokens,
    commandInfo: {
      totalCommands: info.totalCommands,
      includedCommands: info.includedCommands,
    },
  }
}

async function countSkillTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  skillTokens: number
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
}> {
  try {
    const skills = await getLimitedSkillToolCommands(getCwd())

    const slashCommandTool = findSkillTool(tools)
    if (!slashCommandTool) {
      return {
        skillTokens: 0,
        skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
      }
    }

    // 注意：这里统计的是整个 SlashCommandTool（包括命令和 skill）。
    // 这与 countSlashCommandTokens() 统计的是同一个工具，但在此处单独
    // 跟踪用于展示目的。这些 token 不应被重复添加到 context 类别中。
    const skillTokens = await countToolDefinitionTokens(
      [slashCommandTool],
      getToolPermissionContext,
      agentInfo,
    )

    // 仅基于 frontmatter（name、description、whenToUse）计算每个 skill 的 token 估算值，
    // 因为完整内容仅在调用时才加载
    const skillFrontmatter: SkillFrontmatter[] = skills.map((skill) => ({
      name: getCommandName(skill),
      source: (skill.type === 'prompt' ? skill.source : 'plugin') as SettingSource | 'plugin',
      tokens: estimateSkillFrontmatterTokens(skill),
    }))

    return {
      skillTokens,
      skillInfo: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        skillFrontmatter,
      },
    }
  } catch (error) {
    logError(toError(error))

    // 返回零值，而非让整个 context 分析失败
    return {
      skillTokens: 0,
      skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
    }
  }
}

export async function countMcpToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: McpTool[]
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const mcpTools = tools.filter((tool) => tool.isMcp)
  const mcpToolDetails: McpTool[] = []
  // 对所有 MCP 工具进行单次批量 API 调用（而非 N 次单独调用）
  const totalTokensRaw = await countToolDefinitionTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    model,
  )
  // 减去单次开销，因为我们做了一次批量调用
  const totalTokens = Math.max(0, (totalTokensRaw || 0) - TOOL_TOKEN_COUNT_OVERHEAD)

  // 使用本地估算来计算每个工具的比例用于展示。
  // 包含 name + description + input schema 以匹配 toolToAPISchema 发送的内容——
  // 否则具有相似 schema 但不同 description 的工具会得到相同的计数
  //（MCP 工具共享相同的基础 Zod inputSchema）。
  const estimates = await Promise.all(
    mcpTools.map(async (t) =>
      roughTokenCountEstimation(
        jsonStringify({
          name: t.name,
          description: await t.prompt({
            getToolPermissionContext,
            tools,
            agents: agentInfo?.activeAgents ?? [],
          }),
          inputSchema: t.inputJSONSchema ?? {},
        }),
      ),
    ),
  )
  const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
  const mcpToolTokensByTool = estimates.map((e) => Math.round((e / estimateTotal) * totalTokens))

  // 检查工具搜索是否启用——如果启用，MCP 工具将被延迟加载
  // isToolSearchEnabled 内部处理了 TstAuto 模式的阈值计算
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')

  const isDeferred = await isToolSearchEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeMcp',
  )

  // 查找消息中已使用过的 MCP 工具（通过 ToolSearchTool 加载的）
  const loadedMcpToolNames = new Set<string>()
  if (isDeferred && messages) {
    const mcpToolNameSet = new Set(mcpTools.map((t) => t.name))
    for (const msg of messages) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (
            block.type === 'tool_call' &&
            'name' in block &&
            typeof block.name === 'string' &&
            mcpToolNameSet.has(block.name)
          ) {
            loadedMcpToolNames.add(block.name)
          }
        }
      }
    }
  }

  // 构建带有 isLoaded 标志的工具详情
  for (const [i, tool] of mcpTools.entries()) {
    mcpToolDetails.push({
      name: tool.name,
      serverName: tool.name.split('__')[1] || 'unknown',
      tokens: mcpToolTokensByTool[i]!,
      isLoaded: loadedMcpToolNames.has(tool.name) || !isDeferredTool(tool),
    })
  }

  // 计算已加载与延迟加载的 token 数
  let loadedTokens = 0
  let deferredTokens = 0
  for (const detail of mcpToolDetails) {
    if (detail.isLoaded) {
      loadedTokens += detail.tokens
    } else if (isDeferred) {
      deferredTokens += detail.tokens
    }
  }

  return {
    // 延迟加载但部分工具已加载时，计算已加载的 token 数
    mcpToolTokens: isDeferred ? loadedTokens : totalTokens,
    mcpToolDetails,
    // 单独跟踪延迟加载的 token 数用于展示
    deferredToolTokens: deferredTokens,
    loadedMcpToolNames,
  }
}

async function countCustomAgentTokens(agentDefinitions: {
  activeAgents: AgentDefinition[]
}): Promise<{
  agentTokens: number
  agentDetails: Agent[]
}> {
  const customAgents = agentDefinitions.activeAgents.filter((a) => a.source !== 'built-in')
  const agentDetails: Agent[] = []
  let agentTokens = 0

  const tokenCounts = await Promise.all(
    customAgents.map((agent) =>
      countTokensWithFallback(
        [
          {
            role: 'user',
            content: [
              { type: 'text' as const, text: [agent.agentType, agent.whenToUse].join(' ') },
            ],
          },
        ],
        [],
      ),
    ),
  )

  for (const [i, agent] of customAgents.entries()) {
    const tokens = tokenCounts[i] || 0
    agentTokens += tokens || 0
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source,
      tokens: tokens || 0,
    })
  }
  return { agentTokens, agentDetails }
}

type MessageBreakdown = {
  totalTokens: number
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  toolCallsByType: Map<string, number>
  toolResultsByType: Map<string, number>
  attachmentsByType: Map<string, number>
}

function processAssistantMessage(msg: AssistantMessage, breakdown: MessageBreakdown): void {
  // 逐个处理每个内容块
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_call') {
      breakdown.toolCallTokens += blockTokens
      const toolName = ('name' in block ? block.name : undefined) || 'unknown'
      breakdown.toolCallsByType.set(
        toolName,
        (breakdown.toolCallsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // 文本块或其他非工具内容
      breakdown.assistantMessageTokens += blockTokens
    }
  }
}

function processUserMessage(
  msg: UserMessage,
  breakdown: MessageBreakdown,
  toolUseIdToName: Map<string, string>,
): void {
  // 同时处理字符串和数组格式的内容
  if (typeof msg.message.content === 'string') {
    // 简单字符串内容
    const tokens = roughTokenCountEstimation(msg.message.content)
    breakdown.userMessageTokens += tokens
    return
  }

  // 逐个处理每个内容块
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_result') {
      breakdown.toolResultTokens += blockTokens
      const toolUseId = 'tool_use_id' in block ? block.toolCallId : undefined
      const toolName = (toolUseId ? toolUseIdToName.get(toolUseId) : undefined) || 'unknown'
      breakdown.toolResultsByType.set(
        toolName,
        (breakdown.toolResultsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // 文本块或其他非工具内容
      breakdown.userMessageTokens += blockTokens
    }
  }
}

function processAttachment(msg: AttachmentMessage, breakdown: MessageBreakdown): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  const attachType = msg.attachment.type || 'unknown'
  breakdown.attachmentsByType.set(
    attachType,
    (breakdown.attachmentsByType.get(attachType) || 0) + tokens,
  )
}

async function approximateMessageTokens(messages: Message[]): Promise<MessageBreakdown> {
  const microcompactResult = await microcompactMessages(messages, undefined)

  // 初始化统计追踪
  const breakdown: MessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  // 构建 tool_use_id 到 tool_name 的映射以便查找
  const toolUseIdToName = new Map<string, string>()
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_call') {
          const toolUseId = 'id' in block ? block.id : undefined
          const toolName = ('name' in block ? block.name : undefined) || 'unknown'
          if (toolUseId) {
            toolUseIdToName.set(toolUseId, toolName)
          }
        }
      }
    }
  }

  // 逐条处理消息以获取详细分解
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      processAssistantMessage(msg, breakdown)
    } else if (msg.type === 'user') {
      processUserMessage(msg, breakdown, toolUseIdToName)
    } else if (msg.type === 'attachment') {
      processAttachment(msg, breakdown)
    }
  }

  // 使用 API 精确计算总 token 数
  const approximateMessageTokens = await countTokensWithFallback(
    normalizeMessagesForAPI(microcompactResult.messages).map((_) => {
      if (_.type === 'assistant') {
        return {
          // 重要：去除 id 等字段——计数 API 在包含这些字段时会报错
          role: 'assistant',
          content: _.message.content,
        }
      }
      return _.message
    }) as LLMMessage[],
    [],
  )

  breakdown.totalTokens = approximateMessageTokens ?? 0
  return breakdown
}

export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  /** microcompact 之前的原始消息，用于提取 API 使用量 */
  originalMessages?: Message[],
): Promise<ContextData> {
  const runtimeModel = model
  // 获取 context window 大小
  const contextWindow = getContextWindowForModel(runtimeModel)

  // 使用共享工具函数构建有效的 system prompt
  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? {
      options: {} as ToolUseContext['options'],
    },
    customSystemPrompt: toolUseContext?.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: toolUseContext?.options.appendSystemPrompt,
  })

  // 不应因 skill 而失败的关键操作
  const [
    { systemPromptTokens, systemPromptSections },
    { agentsMdTokens, memoryFileDetails },
    { builtInToolTokens, deferredBuiltinDetails, deferredBuiltinTokens, systemToolDetails },
    { mcpToolTokens, mcpToolDetails, deferredToolTokens },
    { agentTokens, agentDetails },
    { slashCommandTokens, commandInfo },
    messageBreakdown,
  ] = await Promise.all([
    countSystemTokens(effectiveSystemPrompt),
    countMemoryFileTokens(),
    countBuiltInToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countMcpToolTokens(tools, getToolPermissionContext, agentDefinitions, runtimeModel, messages),
    countCustomAgentTokens(agentDefinitions),
    countSlashCommandTokens(tools, getToolPermissionContext, agentDefinitions),
    approximateMessageTokens(messages),
  ])

  // 单独统计 skill（带错误隔离）
  const skillResult = await countSkillTokens(tools, getToolPermissionContext, agentDefinitions)
  const skillInfo = skillResult.skillInfo
  // 使用各个 skill token 估算值的总和（与详情中展示的一致），
  // 而非包含工具 schema 开销的 skillResult.skillTokens
  const skillFrontmatterTokens = skillInfo.skillFrontmatter.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  )

  const messageTokens = messageBreakdown.totalTokens

  // 检查 autocompact 是否启用并计算阈值
  const isAutoCompact = isAutoCompactEnabled()
  const autoCompactThreshold = isAutoCompact
    ? getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
    : undefined

  // 创建类别
  const cats: ContextCategory[] = []

  // System prompt 始终排在第一位（固定开销）
  if (systemPromptTokens > 0) {
    cats.push({
      name: 'System prompt',
      tokens: systemPromptTokens,
      color: 'promptBorder',
    })
  }

  // 内置工具紧随 system prompt 之后（skill 在下方单独展示）
  // 内部用户通过 systemToolDetails 获取逐工具分解
  const systemToolsTokens = builtInToolTokens - skillFrontmatterTokens
  if (systemToolsTokens > 0) {
    cats.push({
      name: isInternalBuild() ? '[INNER-ONLY] System tools' : 'System tools',
      tokens: systemToolsTokens,
      color: 'inactive',
    })
  }

  // MCP 工具在系统工具之后
  if (mcpToolTokens > 0) {
    cats.push({
      name: 'MCP tools',
      tokens: mcpToolTokens,
      color: 'cyan_FOR_SUBAGENTS_ONLY',
    })
  }

  // 展示延迟加载的 MCP 工具（工具搜索启用时）
  // 这些不计入 context 使用量，但展示出来增加可见性
  if (deferredToolTokens > 0) {
    cats.push({
      name: 'MCP tools (deferred)',
      tokens: deferredToolTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // 展示延迟加载的内置工具（工具搜索启用时）
  if (deferredBuiltinTokens > 0) {
    cats.push({
      name: 'System tools (deferred)',
      tokens: deferredBuiltinTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // 自定义 agent 在 MCP 工具之后
  if (agentTokens > 0) {
    cats.push({
      name: 'Custom agents',
      tokens: agentTokens,
      color: 'permission',
    })
  }

  // 记忆文件在自定义 agent 之后
  if (agentsMdTokens > 0) {
    cats.push({
      name: 'Memory files',
      tokens: agentsMdTokens,
      color: 'zy',
    })
  }

  // Skill 在记忆文件之后
  if (skillFrontmatterTokens > 0) {
    cats.push({
      name: 'Skills',
      tokens: skillFrontmatterTokens,
      color: 'warning',
    })
  }

  if (messageTokens !== null && messageTokens > 0) {
    cats.push({
      name: 'Messages',
      tokens: messageTokens,
      color: 'purple_FOR_SUBAGENTS_ONLY',
    })
  }

  // 计算实际内容使用量（添加预留缓冲区之前）
  // 从使用量计算中排除延迟加载的类别
  const actualUsage = cats.reduce((sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens), 0)

  // 消息之后的预留空间（不计入展示给用户的 actualUsage 中）。
  // 在仅响应式模式 (cobalt_raccoon) 下，主动 autocompact 永远不会触发，
  // 预留缓冲区会产生误导——完全跳过并让空闲空间填满网格。
  // feature() 守卫确保标志字符串不出现在外部构建中。
  // context-collapse (marble_origami) 同理——collapse 管理阈值阶梯，
  // autocompact 在 shouldAutoCompact 中被抑制，
  // 因此此处展示的 33k 缓冲区也会产生误导。
  let reservedTokens = 0
  let skipReservedBuffer = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('zy_cobalt_raccoon', false)) {
      skipReservedBuffer = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      skipReservedBuffer = true
    }
  }
  if (skipReservedBuffer) {
    // 不推入缓冲区类别——响应式压缩是透明的，
    // 不需要在网格中展示可见的预留空间。
  } else if (isAutoCompact && autoCompactThreshold !== undefined) {
    // Autocompact 缓冲区（来自有效 context）
    reservedTokens = contextWindow - autoCompactThreshold
    cats.push({
      name: RESERVED_CATEGORY_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  } else if (!isAutoCompact) {
    // Compact 缓冲区预留（从实际 context 上限中预留 3k）
    reservedTokens = MANUAL_COMPACT_BUFFER_TOKENS
    cats.push({
      name: MANUAL_COMPACT_BUFFER_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  }

  // 计算空闲空间（同时减去实际使用量和预留缓冲区）
  const freeTokens = Math.max(0, contextWindow - actualUsage - reservedTokens)

  cats.push({
    name: 'Free space',
    tokens: freeTokens,
    color: 'promptBorder',
  })

  // 用于展示的总量（除空闲空间外的所有部分）
  const totalIncludingReserved = actualUsage

  // 从原始消息中提取 API 使用量（如有）以匹配状态栏
  // 使用与状态栏相同的数据源以保持一致性
  const apiUsage = getCurrentUsage(originalMessages ?? messages)

  // 当 API 使用量可用时，使用它作为总量以匹配状态栏计算
  // 状态栏使用：inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  const totalFromAPI = apiUsage
    ? apiUsage.inputTokens + apiUsage.cacheCreationInputTokens + apiUsage.cacheReadInputTokens
    : null

  // 优先使用 API 总量，否则回退到估算总量
  const finalTotalTokens = totalFromAPI ?? totalIncludingReserved

  // 根据模型 context window 和终端宽度预计算网格
  // 窄屏（< 80 列）：200k 模型使用 5x5，1M+ 模型使用 5x10
  // 正常屏幕：200k 模型使用 10x10，1M+ 模型使用 20x10
  const isNarrowScreen = terminalWidth && terminalWidth < 80
  const GRID_WIDTH = contextWindow >= 1000000 ? (isNarrowScreen ? 5 : 20) : isNarrowScreen ? 5 : 10
  const GRID_HEIGHT = contextWindow >= 1000000 ? 10 : isNarrowScreen ? 5 : 10
  const TOTAL_SQUARES = GRID_WIDTH * GRID_HEIGHT

  // 过滤掉延迟加载的类别——它们不占用实际 context 空间
  //（例如，工具搜索启用时的 MCP 工具）
  const nonDeferredCats = cats.filter((cat) => !cat.isDeferred)

  // 计算每个类别的方格数（使用 rawEffectiveMax 进行可视化以展示完整 context）
  const categorySquares = nonDeferredCats.map((cat) => ({
    ...cat,
    squares:
      cat.name === 'Free space'
        ? Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)
        : Math.max(1, Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)),
    percentageOfTotal: Math.round((cat.tokens / contextWindow) * 100),
  }))

  // 为类别创建网格方格的辅助函数
  function createCategorySquares(category: (typeof categorySquares)[0]): GridSquare[] {
    const squares: GridSquare[] = []
    const exactSquares = (category.tokens / contextWindow) * TOTAL_SQUARES
    const wholeSquares = Math.floor(exactSquares)
    const fractionalPart = exactSquares - wholeSquares

    for (let i = 0; i < category.squares; i++) {
      // 确定填充度：完整方格为 1.0，部分方格获取小数值
      let squareFullness = 1.0
      if (i === wholeSquares && fractionalPart > 0) {
        // 这是部分填充的方格
        squareFullness = fractionalPart
      }

      squares.push({
        color: category.color,
        isFilled: true,
        categoryName: category.name,
        tokens: category.tokens,
        percentage: category.percentageOfTotal,
        squareFullness,
      })
    }

    return squares
  }

  // 将网格构建为带有完整元数据的方格数组
  const gridSquares: GridSquare[] = []

  // 将预留类别分离到末尾放置（autocompact 或手动 compact 缓冲区）
  const reservedCategory = categorySquares.find(
    (cat) => cat.name === RESERVED_CATEGORY_NAME || cat.name === MANUAL_COMPACT_BUFFER_NAME,
  )
  const nonReservedCategories = categorySquares.filter(
    (cat) =>
      cat.name !== RESERVED_CATEGORY_NAME &&
      cat.name !== MANUAL_COMPACT_BUFFER_NAME &&
      cat.name !== 'Free space',
  )

  // 先添加所有非预留、非空闲空间的方格
  for (const cat of nonReservedCategories) {
    const squares = createCategorySquares(cat)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // 计算预留所需的方格数
  const reservedSquareCount = reservedCategory ? reservedCategory.squares : 0

  // 用空闲空间填充，在末尾为预留留出位置
  const freeSpaceCat = cats.find((c) => c.name === 'Free space')
  const freeSpaceTarget = TOTAL_SQUARES - reservedSquareCount

  while (gridSquares.length < freeSpaceTarget) {
    gridSquares.push({
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'Free space',
      tokens: freeSpaceCat?.tokens || 0,
      percentage: freeSpaceCat ? Math.round((freeSpaceCat.tokens / contextWindow) * 100) : 0,
      squareFullness: 1.0, // 空闲空间始终为"满"
    })
  }

  // 在末尾添加预留方格
  if (reservedCategory) {
    const squares = createCategorySquares(reservedCategory)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // 转换为行用于渲染
  const gridRows: GridSquare[][] = []
  for (let i = 0; i < GRID_HEIGHT; i++) {
    gridRows.push(gridSquares.slice(i * GRID_WIDTH, (i + 1) * GRID_WIDTH))
  }

  // 格式化消息分解（用于所有用户的 context 建议）
  // 合并工具调用和结果，然后取前 5 个
  const toolsMap = new Map<string, { callTokens: number; resultTokens: number }>()

  // 添加调用 token
  for (const [name, tokens] of messageBreakdown.toolCallsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, callTokens: tokens })
  }

  // 添加结果 token
  for (const [name, tokens] of messageBreakdown.toolResultsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, resultTokens: tokens })
  }

  // 转换为数组并按总 token 数排序（调用 + 结果）
  const toolsByTypeArray = Array.from(toolsMap.entries())
    .map(([name, { callTokens, resultTokens }]) => ({
      name,
      callTokens,
      resultTokens,
    }))
    .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens))

  const attachmentsByTypeArray = Array.from(messageBreakdown.attachmentsByType.entries())
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  const formattedMessageBreakdown = {
    toolCallTokens: messageBreakdown.toolCallTokens,
    toolResultTokens: messageBreakdown.toolResultTokens,
    attachmentTokens: messageBreakdown.attachmentTokens,
    assistantMessageTokens: messageBreakdown.assistantMessageTokens,
    userMessageTokens: messageBreakdown.userMessageTokens,
    toolCallsByType: toolsByTypeArray,
    attachmentsByType: attachmentsByTypeArray,
  }

  return {
    categories: cats,
    totalTokens: finalTotalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: Math.round((finalTotalTokens / contextWindow) * 100),
    gridRows,
    model: runtimeModel,
    memoryFiles: memoryFileDetails,
    mcpTools: mcpToolDetails,
    deferredBuiltinTools: isInternalBuild() ? deferredBuiltinDetails : undefined,
    systemTools: isInternalBuild() ? systemToolDetails : undefined,
    systemPromptSections: isInternalBuild() ? systemPromptSections : undefined,
    agents: agentDetails,
    slashCommands:
      slashCommandTokens > 0
        ? {
            totalCommands: commandInfo.totalCommands,
            includedCommands: commandInfo.includedCommands,
            tokens: slashCommandTokens,
          }
        : undefined,
    skills:
      skillFrontmatterTokens > 0
        ? {
            totalSkills: skillInfo.totalSkills,
            includedSkills: skillInfo.includedSkills,
            tokens: skillFrontmatterTokens,
            skillFrontmatter: skillInfo.skillFrontmatter,
          }
        : undefined,
    autoCompactThreshold,
    isAutoCompactEnabled: isAutoCompact,
    messageBreakdown: formattedMessageBreakdown,
    apiUsage,
  }
}
