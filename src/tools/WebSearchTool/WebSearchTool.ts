import type { ContentBlock } from '../../types/llm.js'
import type { SearchOptions, SearchResult as ServiceSearchResult } from '../../services/search/index.js'
import { createFallbackSearchProvider } from '../../services/search/index.js'
import { getAPIProvider, modelHasCapability } from '../../utils/model/providers.js'

import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { queryModelWithStreaming } from '../../services/api/zy.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

/** 搜索结果对象 — 与旧版格式兼容 */
export interface SearchResult {
  toolCallId: string
  content: Array<{ title: string; url: string }>
}

export type Output = {
  query: string
  results: Array<SearchResult | string>
  durationSeconds: number
}

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

import type { WebSearchProgress } from '../../types/tools.js'

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `ZY wants to search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    const model = getMainLoopModel()
    return modelHasCapability(model, 'web_search')
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async prompt() {
    return getWebSearchPrompt()
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  extractSearchText() {
    return ''
  },
  async validateInput(input) {
    const { query, allowed_domains, blocked_domains } = input
    if (!query.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    if (allowed_domains?.length && blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const { query, allowed_domains, blocked_domains } = input

    // 发送进度：搜索开始
    if (onProgress) {
      onProgress({
        toolUseID: 'search-start',
        data: {
          type: 'query_update',
          query,
        },
      })
    }

    try {
      // 根据 provider 选择搜索后端
      const provider = getAPIProvider()
      logForDebugging(`[WebSearch] provider=${provider}, query="${query}"`)

      let searchResults: ServiceSearchResult[]

      if (provider === 'anthropic') {
        logForDebugging('[WebSearch] Using Anthropic web_search_20260209')
        // Anthropic：通过 web_search_20260209 beta tool 让服务端执行搜索
        searchResults = await searchViaAnthropic(query, allowed_domains, blocked_domains, context, onProgress)
      } else if (provider === 'dashscope') {
        logForDebugging('[WebSearch] Using DashScope enable_search')
        // 百炼：通过 enable_search 参数让服务端执行搜索
        searchResults = await searchViaDashScope(query, allowed_domains, blocked_domains, context, onProgress)
      } else if (provider === 'openai') {
        logForDebugging('[WebSearch] Using OpenAI web_search_preview')
        // OpenAI：通过 web_search_preview 内置工具让服务端执行搜索
        searchResults = await searchViaOpenAI(query, allowed_domains, blocked_domains, context, onProgress)
      } else {
        logForDebugging('[WebSearch] Using local DuckDuckGo fallback')
        // 其他 provider：本地 DuckDuckGo 兜底
        searchResults = await searchViaLocalProvider(query, allowed_domains, blocked_domains, onProgress)
      }

      logForDebugging(`[WebSearch] Got ${searchResults.length} results in ${((performance.now() - startTime) / 1000).toFixed(2)}s`)

      const endTime = performance.now()
      const durationSeconds = (endTime - startTime) / 1000

      // 格式化为兼容输出格式
      const results: Array<SearchResult | string> = []

      if (searchResults.length > 0) {
        results.push({
          toolCallId: `search-${Date.now()}`,
          content: searchResults.map(r => ({ title: r.title, url: r.url })),
        })
      } else {
        results.push('No results found for this query.')
      }

      return {
        data: {
          query,
          results,
          durationSeconds,
        },
      }
    } catch (error) {
      logError(error)
      logForDebugging(`[WebSearch] Error: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' })

      const endTime = performance.now()
      const durationSeconds = (endTime - startTime) / 1000

      const errorMessage = error instanceof Error ? error.message : 'Unknown search error'

      return {
        data: {
          query,
          results: [`Web search error: ${errorMessage}`],
          durationSeconds,
        },
      }
    }
  },
  mapToolResultToToolResultBlock(output, toolUseID) {
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

    ;(results ?? []).forEach(result => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        formattedOutput += result + '\n\n'
      } else {
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })

    formattedOutput +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)

// ---------------------------------------------------------------------------
// Anthropic 原生搜索：web_search_20260209 beta tool
// ---------------------------------------------------------------------------

async function searchViaAnthropic(
  query: string,
  allowed_domains?: string[],
  blocked_domains?: string[],
  context?: any,
  onProgress?: any,
): Promise<ServiceSearchResult[]> {
  const userMessage = createUserMessage({
    content: `Perform a web search for: ${query}. Return ONLY the search results without any commentary.`,
  })

  // 构建 Anthropic web_search_20260209 tool schema
  const toolSchema: Record<string, unknown> = {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 8,
  }
  if (allowed_domains && allowed_domains.length > 0) {
    toolSchema.allowed_domains = allowed_domains
  }
  if (blocked_domains && blocked_domains.length > 0) {
    toolSchema.blocked_domains = blocked_domains
  }

  logForDebugging(`[WebSearch:Anthropic] Sending sub-query with beta=web_search_20260209, model=${context?.options?.mainLoopModel ?? getMainLoopModel()}`)

  const queryStream = queryModelWithStreaming({
    messages: [userMessage],
    systemPrompt: asSystemPrompt([
      'You are an assistant for performing a web search. Use the web search tool to find results and return them in a structured format with titles, URLs, and snippets.',
    ]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: context?.abortController?.signal ?? new AbortController().signal,
    options: {
      getToolPermissionContext: async () => context?.getAppState?.()?.toolPermissionContext ?? {},
      model: context?.options?.mainLoopModel ?? getMainLoopModel(),
      isNonInteractiveSession: context?.options?.isNonInteractiveSession ?? false,
      hasAppendSystemPrompt: !!context?.options?.appendSystemPrompt,
      querySource: 'web_search_tool' as any,
      agents: context?.options?.agentDefinitions?.activeAgents ?? [],
      mcpTools: [],
      agentId: context?.agentId,
      // 通过 Anthropic 的 web_search_20260209 beta 注入搜索工具
      providerExtras: {
        anthropic: {
          betas: ['web_search_20260209'],
          _extraToolSchemas: [toolSchema],
        },
      },
    },
  })

  const allContentBlocks: ContentBlock[] = []
  let blockCount = 0

  for await (const event of queryStream) {
    if (event.type === 'assistant') {
      allContentBlocks.push(...event.message.content)
      blockCount += event.message.content.length
      continue
    }
  }

  logForDebugging(`[WebSearch:Anthropic] Received ${blockCount} content blocks`)

  // 从模型回复中解析搜索结果
  return parseResultsFromText(allContentBlocks, query, blocked_domains)
}

// ---------------------------------------------------------------------------
// 百炼 DashScope 原生搜索：enable_search + search_options
// ---------------------------------------------------------------------------

async function searchViaDashScope(
  query: string,
  allowed_domains?: string[],
  blocked_domains?: string[],
  context?: any,
  onProgress?: any,
): Promise<ServiceSearchResult[]> {
  const userMessage = createUserMessage({
    content: `Perform a web search for: ${query}. Return ONLY the search results without any commentary.`,
  })

  // 百炼的 enable_search 是非 OpenAI 标准参数，通过 extra_body 传入
  // 参考：https://help.aliyun.com/zh/model-studio/web-search.md
  const extraBodyParams: Record<string, unknown> = {
    enable_search: true,
  }

  // 域名过滤 — 百炼支持 search_options.assigned_site_list
  if (allowed_domains && allowed_domains.length > 0) {
    extraBodyParams.search_options = {
      assigned_site_list: allowed_domains.slice(0, 25), // 百炼最多 25 个域名
    }
  }

  const queryStream = queryModelWithStreaming({
    messages: [userMessage],
    systemPrompt: asSystemPrompt([
      'You are an assistant for performing a web search. Extract and return all search results from the API response.',
    ]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: context?.abortController?.signal ?? new AbortController().signal,
    options: {
      getToolPermissionContext: async () => context?.getAppState?.()?.toolPermissionContext ?? {},
      model: context?.options?.mainLoopModel ?? getMainLoopModel(),
      isNonInteractiveSession: context?.options?.isNonInteractiveSession ?? false,
      hasAppendSystemPrompt: !!context?.options?.appendSystemPrompt,
      querySource: 'web_search_tool' as any,
      agents: context?.options?.agentDefinitions?.activeAgents ?? [],
      mcpTools: [],
      agentId: context?.agentId,
      // 通过 providerExtras 传入百炼的 enable_search
      providerExtras: {
        openai: extraBodyParams,
      },
    },
  })

  logForDebugging(`[WebSearch:DashScope] Sending sub-query with enable_search=true, model=${context?.options?.mainLoopModel ?? getMainLoopModel()}`)

  // 收集搜索结果 — 百炼在 response 的 search_info.search_results 中返回
  const allContentBlocks: ContentBlock[] = []
  let searchInfoResults: ServiceSearchResult[] = []

  for await (const event of queryStream) {
    if (event.type === 'assistant') {
      allContentBlocks.push(...event.message.content)
      // 尝试从 assistant message 的 extras 中提取 search_info
      const raw = event.message as any
      if (raw?.extras?.searchInfo) {
        searchInfoResults = parseSearchInfoFromExtras(raw.extras.searchInfo)
        logForDebugging(`[WebSearch:DashScope] Found search_info in extras: ${searchInfoResults.length} results`)
      }
      continue
    }
  }

  logForDebugging(`[WebSearch:DashScope] Got ${searchInfoResults.length} results from extras, ${allContentBlocks.length} content blocks`)

  // 如果从 extras 中拿到搜索结果，直接使用
  if (searchInfoResults.length > 0) {
    if (onProgress) {
      onProgress({
        toolUseID: 'search-results',
        data: {
          type: 'search_results_received',
          resultCount: searchInfoResults.length,
          query,
        },
      })
    }
    return searchInfoResults
  }

  // 否则从模型的文本回复中解析搜索结果
  return parseResultsFromText(allContentBlocks, query, blocked_domains)
}

/** 从百炼 API 的 search_info 附加字段中解析搜索结果 */
function parseSearchInfoFromExtras(searchInfo: any): ServiceSearchResult[] {
  const rawResults = searchInfo?.search_results ?? []
  return rawResults
    .filter((r: any) => r.title && r.url)
    .map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content || undefined,
    }))
}

// ---------------------------------------------------------------------------
// OpenAI 原生搜索：web_search_preview 内置工具
// ---------------------------------------------------------------------------

async function searchViaOpenAI(
  query: string,
  allowed_domains?: string[],
  blocked_domains?: string[],
  context?: any,
  onProgress?: any,
): Promise<ServiceSearchResult[]> {
  const userMessage = createUserMessage({
    content: `Search the web for: ${query}. Return ONLY the search results with titles, URLs, and snippets. Do not add any commentary.`,
  })

  // OpenAI 的 web_search_preview 通过 providerExtras 传入
  // 格式参考：https://platform.openai.com/docs/guides/tools-web-search
  const webSearchTool: Record<string, unknown> = {
    type: 'web_search_preview',
  }

  // 域名过滤 — OpenAI 支持 allowed_domains
  if (allowed_domains && allowed_domains.length > 0) {
    webSearchTool.user_location = { type: 'approximate' }
    // OpenAI Chat Completions 的 web_search 通过 search_context_size 控制
    webSearchTool.search_context_size = 'medium'
  }

  logForDebugging(`[WebSearch:OpenAI] Sending sub-query with web_search_preview tool, model=${context?.options?.mainLoopModel ?? getMainLoopModel()}`)

  const queryStream = queryModelWithStreaming({
    messages: [userMessage],
    systemPrompt: asSystemPrompt([
      'You are an assistant for performing a web search. Use the web search tool to find results and return them.',
    ]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: context?.abortController?.signal ?? new AbortController().signal,
    options: {
      getToolPermissionContext: async () => context?.getAppState?.()?.toolPermissionContext ?? {},
      model: context?.options?.mainLoopModel ?? getMainLoopModel(),
      isNonInteractiveSession: context?.options?.isNonInteractiveSession ?? false,
      hasAppendSystemPrompt: !!context?.options?.appendSystemPrompt,
      querySource: 'web_search_tool' as any,
      agents: context?.options?.agentDefinitions?.activeAgents ?? [],
      mcpTools: [],
      agentId: context?.agentId,
      // 通过 providerExtras 传入 OpenAI 的 web_search 工具
      providerExtras: {
        openai: {
          // 将 web_search 工具注入到 tools 数组中
          _web_search_tool: webSearchTool,
        },
      },
    },
  })

  const allContentBlocks: ContentBlock[] = []
  let blockCount = 0

  for await (const event of queryStream) {
    if (event.type === 'assistant') {
      allContentBlocks.push(...event.message.content)
      blockCount += event.message.content.length
      continue
    }
  }

  logForDebugging(`[WebSearch:OpenAI] Received ${blockCount} content blocks`)

  // 从模型回复中解析搜索结果
  return parseResultsFromText(allContentBlocks, query, blocked_domains)
}

// ---------------------------------------------------------------------------
// 本地 DuckDuckGo 兜底搜索
// ---------------------------------------------------------------------------

async function searchViaLocalProvider(
  query: string,
  allowed_domains?: string[],
  blocked_domains?: string[],
  onProgress?: any,
): Promise<ServiceSearchResult[]> {
  logForDebugging('[WebSearch:Local] Using DuckDuckGo fallback')

  const provider = createFallbackSearchProvider()

  const searchOptions: SearchOptions = {
    maxResults: 8,
    allowedDomains: allowed_domains,
    blockedDomains: blocked_domains,
  }

  const searchResults = await provider.search(query, searchOptions)

  logForDebugging(`[WebSearch:Local] Got ${searchResults.length} results from ${provider.id}`)

  if (onProgress) {
    onProgress({
      toolUseID: 'search-results',
      data: {
        type: 'search_results_received',
        resultCount: searchResults.length,
        query,
      },
    })
  }

  return searchResults
}

// ---------------------------------------------------------------------------
// 从模型文本回复中解析搜索结果（通用回退方案）
// ---------------------------------------------------------------------------

function parseResultsFromText(
  contentBlocks: ContentBlock[],
  _query: string,
  blockedDomains?: string[],
): ServiceSearchResult[] {
  const results: ServiceSearchResult[] = []

  // 拼接所有文本块
  const text = contentBlocks
    .filter(b => b.type === 'text')
    .map(b => (b as any).text ?? '')
    .join('\n')

  if (!text) return results

  // 尝试从文本中提取 URL 和标题
  // 模型通常会以 markdown 链接格式返回：[Title](URL)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  let match
  while ((match = linkRegex.exec(text)) !== null) {
    const title = match[1].trim()
    const url = match[2].trim()

    if (!title || !url) continue

    // 域名黑名单过滤
    if (blockedDomains && blockedDomains.length > 0) {
      try {
        const hostname = new URL(url).hostname
        if (blockedDomains.some(d => hostname.includes(d))) continue
      } catch {
        // URL 解析失败，保留结果
      }
    }

    results.push({ title, url })
  }

  // 如果没有找到 markdown 链接，尝试提取裸 URL
  if (results.length === 0) {
    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
    let urlMatch
    while ((urlMatch = urlRegex.exec(text)) !== null) {
      const url = urlMatch[1]
      if (!url) continue

      if (blockedDomains && blockedDomains.length > 0) {
        try {
          const hostname = new URL(url).hostname
          if (blockedDomains.some(d => hostname.includes(d))) continue
        } catch {
          continue
        }
      }

      results.push({ title: url, url })
    }
  }

  return results
}
