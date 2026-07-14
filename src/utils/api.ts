import { createHash } from 'node:crypto'
import { getLanguageSection, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from 'src/constants/prompts.js'
import { getSystemContext, getUserContext } from 'src/context.js'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { prefetchAllMcpResources } from 'src/services/mcp/client.js'
import type { ScopedMcpServerConfig } from 'src/services/mcp/types.js'
import {
  getAPIProvider,
  isAnthropicBaseUrl,
  providerHasCapability,
} from 'src/services/model/providers.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { normalizeFileEditInput, stripTrailingWhitespace } from 'src/tools/FileEditTool/utils.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { getTools } from 'src/tools.js'
import type { AgentId } from 'src/types/ids.js'
import type { z } from 'zod/v4'
import { CLI_SYSPROMPT_PREFIXES } from '../constants/system.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Tool, ToolPermissionContext, Tools } from '../tool.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import type { ToolDefinition } from '../types/llm.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../services/swarm/agentSwarmsEnabled.js'
import { modelSupportsStructuredOutputs } from './betas.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { createUserMessage } from '../services/messages/index.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from '../services/permissions/filesystem.js'
import { getPlan, getPlanFilePath, persistFileSnapshotIfRemote } from './plans.js'
import { getPlatform } from '../services/shell/platform.js'
import { countFilesRoundedRg } from './ripgrep.js'
import { getModelPromptCachingMode } from '../services/settings/localModelCapabilities.js'
import { getInitialSettings } from '../services/settings/settings.js'
import { jsonStringify } from './slowOperations.js'
import type { SystemPrompt } from './systemPromptType.js'
import { type CachedSchema, getToolSchemaCache } from './toolSchemaCache.js'
import { windowsPathToPosixPath } from '../services/shell/windowsPaths.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

// 扩展的 ToolDefinition 类型，支持 strict 模式和 defer_loading
type ToolDefinitionWithExtras = ToolDefinition & {
  strict?: boolean
  defer_loading?: boolean
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
  eager_input_streaming?: boolean
}

export type SystemPromptBlock = {
  text: string
  shouldCache: boolean
}

// 当智能体集群未启用时，需要从工具模式中过滤的字段
const SWARM_FIELDS_BY_TOOL: Record<string, string[]> = {
  [EXIT_PLAN_MODE_TOOL_NAME]: ['launchSwarm', 'teammateCount'],
  [AGENT_TOOL_NAME]: ['name', 'team_name', 'mode'],
}

/**
 * 从工具输入模式中过滤与智能体集群相关的字段。
 * 当 isAgentSwarmsEnabled() 返回 false 时在运行时调用。
 */
function filterSwarmFieldsFromSchema(
  toolName: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const fieldsToRemove = SWARM_FIELDS_BY_TOOL[toolName]
  if (!fieldsToRemove || fieldsToRemove.length === 0) {
    return schema
  }

  // 克隆 schema 以避免修改原始对象
  const filtered = { ...schema }
  const props = filtered.properties
  if (props && typeof props === 'object') {
    const filteredProps = { ...(props as Record<string, unknown>) }
    for (const field of fieldsToRemove) {
      delete filteredProps[field]
    }
    filtered.properties = filteredProps
  }

  return filtered
}

export async function toolToAPISchema(
  tool: Tool,
  options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    model?: string
    /** 当为 true 时，将此工具标记为 defer_loading 以用于工具搜索 */
    deferLoading?: boolean
    cacheControl?: {
      type: 'ephemeral'
      scope?: 'global' | 'org'
      ttl?: '5m' | '1h'
    }
  },
): Promise<ToolDefinition> {
  // 会话稳定的基础模式：name、description、inputSchema、strict、
  // eager_input_streaming。这些在每个会话中计算一次并缓存，
  // 以防止会话中途的 GrowthBook 翻转（zy_tool_pear、zy_fgts）或
  // tool.prompt() 漂移导致序列化工具数组字节频繁变化。
  // 详见 toolSchemaCache.ts 的设计理由。
  //
  // 缓存键在存在 inputJSONSchema 时包含该字段。StructuredOutput 实例
  // 共享名称 'StructuredOutput'，但每次工作流调用携带不同的模式 ——
  // 仅使用名称作为键会返回过时的模式（错误率从 5.4% 升至 51%，见
  // PR#25424）。MCP 工具也设置 inputJSONSchema，但每个都有稳定的模式，
  // 因此包含它可以保持其 GB 翻转缓存稳定性。
  const cacheKey =
    'inputJSONSchema' in tool && tool.inputJSONSchema
      ? `${tool.name}:${jsonStringify(tool.inputJSONSchema)}`
      : tool.name
  const cache = getToolSchemaCache()
  let base: CachedSchema | undefined = cache.get(cacheKey)
  if (!base) {
    const strictToolsEnabled = checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_strict_tools')
    // 如果提供了工具的 JSON 模式则直接使用，否则转换 Zod 模式
    let inputSchema = (
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    ) as Record<string, unknown>

    // 当智能体集群未启用时过滤相关字段
    // 这确保外部非 EAP 用户在模式中看不到智能体集群功能
    if (!isAgentSwarmsEnabled()) {
      inputSchema = filterSwarmFieldsFromSchema(tool.name, inputSchema)
    }

    const toolPrompt = await tool.prompt({
      getToolPermissionContext: options.getToolPermissionContext,
      tools: options.tools,
      agents: options.agents,
      allowedAgentTypes: options.allowedAgentTypes,
    })

    // 将语言偏好附加到工具提示中，以便模型尊重
    // 用户的配置语言，即使在工具相关输出期间也是如此。
    const languageSection = getLanguageSection(getInitialSettings().language)
    const description = languageSection ? `${toolPrompt}\n\n${languageSection}` : toolPrompt

    base = {
      name: tool.name,
      description,
      inputSchema: inputSchema as {
        type: 'object'
        properties: Record<string, unknown>
        required?: string[]
      },
    }

    // 仅在以下情况下添加 strict：
    // 1. 功能标志已启用
    // 2. 工具具有 strict: true
    // 3. 提供了模型且支持它（并非所有模型都支持）
    //    （如果未提供模型，假设我们无法使用 strict 工具）
    if (
      strictToolsEnabled &&
      tool.strict === true &&
      options.model &&
      modelSupportsStructuredOutputs(options.model)
    ) {
      base.strict = true
    }

    // 通过每个工具的 API 字段启用细粒度工具流式传输。
    // 如果没有 FGTS，API 会在发送 input_json_delta 事件之前缓冲整个工具输入参数，
    // 导致大型工具输入时出现数分钟的挂起。
    // 仅限于直接 api.anthropic.com：代理（LiteLLM 等）和 Bedrock/Vertex
    // 在 Zy 4.5 中以 400 错误拒绝此字段。见 GH#32742，PR #21729。
    if (
      options.model &&
      getModelPromptCachingMode(options.model) === 'explicit' &&
      isAnthropicBaseUrl() &&
      (getFeatureValue_CACHED_MAY_BE_STALE('zy_fgts', false) ||
        isEnvTruthy(process.env.ZY_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING))
    ) {
      base.eager_input_streaming = true
    }

    cache.set(cacheKey, base)
  }

  // 每个请求的覆盖层：defer_loading 和 cache_control 因调用而异
  // （工具搜索每轮延迟不同的工具；缓存标记移动）。
  // 显式字段复制避免改变缓存的基础，并规避
  // ToolDefinition.cache_control 的 `| null` 与我们更窄类型的冲突。
  const schema: ToolDefinitionWithExtras = {
    name: base.name,
    description: base.description,
    inputSchema: base.inputSchema,
    ...(base.strict && { strict: true }),
    ...(base.eager_input_streaming && { eager_input_streaming: true }),
  }

  // 如果请求则添加 defer_loading（用于工具搜索功能）
  if (options.deferLoading) {
    schema.defer_loading = true
  }

  if (options.cacheControl) {
    schema.cache_control = options.cacheControl
  }

  // ZY_CODE_DISABLE_EXPERIMENTAL_BETAS 是实验性 API 形状的总开关。
  // 代理网关（ZY_CODE_BASE_URL → LiteLLM → Bedrock）会以
  // "Extra inputs are not permitted" 拒绝像 defer_loading 这样的字段。
  // 每个字段上方的门控分散且并非所有提供商都知道，因此这在所有工具
  // 模式经过的唯一瓶颈点处剥离不在基础工具允许列表中的所有内容
  // —— 包括未来添加的字段。
  // cache_control 在允许列表中：基础 {type: 'ephemeral'} 形状是
  // 标准提示缓存（Bedrock/Vertex 支持）；beta 子字段
  // （scope、ttl）已由 shouldIncludeExperimentalBetas 在上游进行门控，
  // 它独立尊重此总开关。
  // github.com/anthropics/zy-code/issues/20031
  if (isEnvTruthy(process.env.ZY_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    const allowed = new Set(['name', 'description', 'inputSchema', 'cache_control'])
    const stripped = Object.keys(schema).filter((k) => !allowed.has(k))
    if (stripped.length > 0) {
      logStripOnce(stripped)
      return {
        name: schema.name,
        description: schema.description,
        inputSchema: schema.inputSchema,
        ...(schema.cache_control && { cache_control: schema.cache_control }),
      }
    }
  }

  // 注意：我们转换为 ToolDefinition，但额外字段在运行时仍然存在
  // 并将在 API 请求中序列化，即使它们不在标准的
  // ToolDefinition 类型定义中。这对于 beta 功能是有意为之的。
  return schema as ToolDefinition
}

let loggedStrip = false
function logStripOnce(stripped: string[]): void {
  if (loggedStrip) {
    return
  }
  loggedStrip = true
  logForDebugging(
    `[betas] Stripped from tool schemas: [${stripped.join(', ')}] (ZY_CODE_DISABLE_EXPERIMENTAL_BETAS=1)`,
  )
}

/**
 * 记录关于首个块的统计信息以分析前缀匹配配置
 * （见 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/zy_code_system_prompt_prefixes）
 */
export function logAPIPrefix(systemPrompt: SystemPrompt): void {
  const [firstSyspromptBlock] = splitSysPromptPrefix(systemPrompt)
  const firstSystemPrompt = firstSyspromptBlock?.text
  logEvent('zy_sysprompt_block', {
    snippet: firstSystemPrompt?.slice(
      0,
      20,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    length: firstSystemPrompt?.length ?? 0,
    hash: (firstSystemPrompt
      ? createHash('sha256').update(firstSystemPrompt).digest('hex')
      : '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 按内容类型拆分系统提示块以进行缓存控制。
 *
 * 通用设计：基于边界标记将系统提示拆分为静态和动态部分。
 * 静态内容（边界前）适合缓存，动态内容（边界后）每次请求都变化。
 *
 * 返回最多 4 个块：
 * - 归属标头（shouldCache: false）- 每次请求可能不同
 * - 系统提示前缀（shouldCache: false）- 内容太小，缓存收益低
 * - 边界前的静态内容（shouldCache: true）- 大块稳定内容，保底缓存
 * - 边界后的动态内容（shouldCache: true）- 同一会话内基本不变，缓存整个系统提示
 *
 * 如果没有边界标记，将所有内容视为静态（shouldCache: true）
 */
export function splitSysPromptPrefix(systemPrompt: SystemPrompt): SystemPromptBlock[] {
  const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  let attributionHeader: string | undefined
  let systemPromptPrefix: string | undefined
  const staticBlocks: string[] = []
  const dynamicBlocks: string[] = []

  for (let i = 0; i < systemPrompt.length; i++) {
    const block = systemPrompt[i]
    if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
      continue
    }

    if (block.startsWith('x-anthropic-billing-header')) {
      attributionHeader = block
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block
    } else if (boundaryIndex === -1 || i < boundaryIndex) {
      staticBlocks.push(block)
    } else {
      dynamicBlocks.push(block)
    }
  }

  const result: SystemPromptBlock[] = []
  if (attributionHeader) {
    result.push({ text: attributionHeader, shouldCache: false })
  }
  if (systemPromptPrefix) {
    result.push({ text: systemPromptPrefix, shouldCache: false })
  }
  const staticJoined = staticBlocks.join('\n\n')
  if (staticJoined) {
    result.push({ text: staticJoined, shouldCache: true })
  }
  const dynamicJoined = dynamicBlocks.join('\n\n')
  if (dynamicJoined) {
    result.push({ text: dynamicJoined, shouldCache: true })
  }

  if (boundaryIndex !== -1) {
    logEvent('zy_sysprompt_boundary_found', {
      blockCount: result.length,
      staticBlockLength: staticJoined.length,
      dynamicBlockLength: dynamicJoined.length,
    })
  }

  return result
}

export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}

export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  if (Object.entries(context).length === 0) {
    return messages
  }

  return [
    createUserMessage({
      content: [
        {
          type: 'text' as const,
          text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(
            context,
          )
            .map(([key, value]) => `# ${key}\n${value}`)
            .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
        },
      ],
      isMeta: true,
    }),
    ...messages,
  ]
}

/**
 * 记录关于上下文和系统提示大小的指标
 */
export async function logContextMetrics(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
  toolPermissionContext: ToolPermissionContext,
): Promise<void> {
  // 如果日志记录被禁用则提前返回
  if (isAnalyticsDisabled()) {
    return
  }
  const [{ tools: mcpTools }, tools, userContext, systemContext] = await Promise.all([
    prefetchAllMcpResources(mcpConfigs),
    getTools(toolPermissionContext),
    getUserContext(),
    getSystemContext(),
  ])
  // 提取各个上下文的大小并计算总量
  const gitStatusSize = systemContext.gitStatus?.length ?? 0
  const agentsMdSize = userContext.agentsMd?.length ?? 0

  // 计算上下文总大小
  const totalContextSize = gitStatusSize + agentsMdSize

  // 使用 ripgrep 获取文件数量（为隐私考虑取最近的 10 的幂次）
  const currentDir = getCwd()
  const ignorePatternsByRoot = getFileReadIgnorePatterns(toolPermissionContext)
  const normalizedIgnorePatterns = normalizePatternsToPath(ignorePatternsByRoot, currentDir)
  const fileCount = await countFilesRoundedRg(
    currentDir,
    AbortSignal.timeout(1000),
    normalizedIgnorePatterns,
  )

  // 计算工具相关指标
  let mcpToolsCount = 0
  let mcpServersCount = 0
  let mcpToolsTokens = 0
  let nonMcpToolsCount = 0
  let nonMcpToolsTokens = 0

  const nonMcpTools = tools.filter((tool) => !tool.isMcp)
  mcpToolsCount = mcpTools.length
  nonMcpToolsCount = nonMcpTools.length

  // 从 MCP 工具名称中提取唯一的服务器名（格式：mcp__servername__toolname）
  const serverNames = new Set<string>()
  for (const tool of mcpTools) {
    const parts = tool.name.split('__')
    if (parts.length >= 3 && parts[1]) {
      serverNames.add(parts[1])
    }
  }
  mcpServersCount = serverNames.size

  // 在本地估算工具 token 数量用于分析（避免每个会话进行 N 次 API 调用）
  // 优先使用 inputJSONSchema（纯 JSON Schema），否则转换 Zod schema
  for (const tool of mcpTools) {
    const schema =
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    mcpToolsTokens += roughTokenCountEstimation(jsonStringify(schema))
  }
  for (const tool of nonMcpTools) {
    const schema =
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema
        : zodToJsonSchema(tool.inputSchema)
    nonMcpToolsTokens += roughTokenCountEstimation(jsonStringify(schema))
  }

  logEvent('zy_context_size', {
    git_status_size: gitStatusSize,
    agents_md_size: agentsMdSize,
    total_context_size: totalContextSize,
    project_file_count_rounded: fileCount,
    mcp_tools_count: mcpToolsCount,
    mcp_servers_count: mcpServersCount,
    mcp_tools_tokens: mcpToolsTokens,
    non_mcp_tools_count: nonMcpToolsCount,
    non_mcp_tools_tokens: nonMcpToolsTokens,
  })
}

// TODO: 将此推广到所有工具
export function normalizeToolInput<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
  agentId?: AgentId,
): z.infer<T['inputSchema']> {
  switch (tool.name) {
    case EXIT_PLAN_MODE_TOOL_NAME: {
      // 始终为 ExitPlanModeV2 注入计划内容和文件路径，以便 hooks/SDK 获取计划。
      // V2 工具从文件而非输入中读取计划，但 hooks/SDK
      const plan = getPlan(agentId)
      const planFilePath = getPlanFilePath(agentId)
      // 为 CCR 会话持久化文件快照，以确保计划在 Pod 回收后仍然存在
      void persistFileSnapshotIfRemote()
      return plan !== null ? { ...input, plan, planFilePath } : input
    }
    case BashTool.name: {
      // 已在上游验证，不会抛出异常
      const parsed = BashTool.inputSchema.parse(input)
      const { command, timeout, description } = parsed
      const cwd = getCwd()
      let normalizedCommand = command.replace(`cd ${cwd} && `, '')
      if (getPlatform() === 'windows') {
        normalizedCommand = normalizedCommand.replace(`cd ${windowsPathToPosixPath(cwd)} && `, '')
      }

      // 将 \\; 替换为 \;（find -exec 命令通常需要）
      normalizedCommand = normalizedCommand.replace(/\\\\;/g, '\\;')

      // 记录仅回显字符串的命令。这有助于我们了解 Zy 通过 bash 通信的频率
      if (/^echo\s+["']?[^|&;><]*["']?$/i.test(normalizedCommand.trim())) {
        logEvent('zy_bash_tool_simple_echo', {})
      }

      // 检查 run_in_background（如果设置了 ZY_CODE_DISABLE_BACKGROUND_TASKS，模式中可能不存在）
      const run_in_background = 'run_in_background' in parsed ? parsed.run_in_background : undefined

      // 安全：转换是安全的，因为输入已通过上面的 .parse() 验证。
      // TypeScript 无法基于 switch(tool.name) 缩小泛型 T 的范围，因此它
      // 不知道返回类型匹配 T['inputSchema']。这是泛型的根本性
      // TS 限制，不进行重大重构无法绕过。
      return {
        command: normalizedCommand,
        description,
        ...(timeout !== undefined && { timeout }),
        ...(description !== undefined && { description }),
        ...(run_in_background !== undefined && { run_in_background }),
        ...('dangerouslyDisableSandbox' in parsed &&
          parsed.dangerouslyDisableSandbox !== undefined && {
            dangerouslyDisableSandbox: parsed.dangerouslyDisableSandbox,
          }),
      } as z.infer<T['inputSchema']>
    }
    case FileEditTool.name: {
      // 已在上游验证，不会抛出异常
      const parsedInput = FileEditTool.inputSchema.parse(input)

      // 这是 zy 无法看到的 token 的变通方法
      const { file_path, edits } = normalizeFileEditInput({
        file_path: parsedInput.file_path,
        edits: [
          {
            old_string: parsedInput.old_string,
            new_string: parsedInput.new_string,
            replace_all: parsedInput.replace_all,
          },
        ],
      })

      // 安全：参见上面 BashTool 中的注释
      return {
        replace_all: edits[0]!.replace_all,
        file_path,
        old_string: edits[0]!.old_string,
        new_string: edits[0]!.new_string,
      } as z.infer<T['inputSchema']>
    }
    case FileWriteTool.name: {
      // 已在上游验证，不会抛出异常
      const parsedInput = FileWriteTool.inputSchema.parse(input)

      // Markdown 使用两个尾随空格作为硬换行符 — 不要去除。
      const isMarkdown = /\.(md|mdx)$/i.test(parsedInput.file_path)

      // 安全：参见上面 BashTool 中的注释
      return {
        file_path: parsedInput.file_path,
        content: isMarkdown ? parsedInput.content : stripTrailingWhitespace(parsedInput.content),
      } as z.infer<T['inputSchema']>
    }
    case TASK_OUTPUT_TOOL_NAME: {
      // 规范化来自 AgentOutputTool/BashOutputTool 的遗留参数名
      const legacyInput = input as Record<string, unknown>
      const taskId = legacyInput.task_id ?? legacyInput.agentId ?? legacyInput.bash_id
      const timeout =
        legacyInput.timeout ??
        (typeof legacyInput.wait_up_to === 'number' ? legacyInput.wait_up_to * 1000 : undefined)
      // 安全：参见上面 BashTool 中的注释
      return {
        task_id: taskId ?? '',
        block: legacyInput.block ?? true,
        timeout: timeout ?? 30000,
      } as z.infer<T['inputSchema']>
    }
    default:
      return input
  }
}

// 去除 normalizeToolInput 在发送到 API 前添加的字段
// （例如，ExitPlanModeV2 的 plan 字段，它具有空的输入模式）
export function normalizeToolInputForAPI<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
): z.infer<T['inputSchema']> {
  switch (tool.name) {
    case EXIT_PLAN_MODE_TOOL_NAME: {
      // 发送到 API 前去除注入的字段（模式期望空对象）
      if (input && typeof input === 'object' && ('plan' in input || 'planFilePath' in input)) {
        const { plan, planFilePath, ...rest } = input as Record<string, unknown>
        return rest as z.infer<T['inputSchema']>
      }
      return input
    }
    case FileEditTool.name: {
      // 从旧会话中去除合成的 old_string/new_string/replace_all
      // 这些会话是从 PR #20357 之前编写的转录文件中恢复的，当时
      // normalizeToolInput 曾合成这些字段。需要这样做，以便旧的 --resume
      // 转录文件不会向 API 发送整个文件的副本。新会话
      // 不需要这个（合成已移至发射时）。
      if (input && typeof input === 'object' && 'edits' in input) {
        const { old_string, new_string, replace_all, ...rest } = input as Record<string, unknown>
        return rest as z.infer<T['inputSchema']>
      }
      return input
    }
    default:
      return input
  }
}
