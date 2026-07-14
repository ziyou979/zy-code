import { z } from 'zod/v4'
import { getMainLoopModel } from '../../services/model/model.js'
import { buildTool, type ToolDef } from '../../tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import type { PermissionResult } from '../../services/permissions/permissionResult.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { hasExternalToolOverride } from '../externalToolLoader.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

const DEFAULT_MAX_RESULTS = 8
const MAX_ALLOWED_RESULTS = 20

function maxResultsSchema() {
  return semanticNumber(z.number().int().min(1).max(MAX_ALLOWED_RESULTS).optional()).describe(
    'Maximum number of search results to return',
  )
}

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
    max_results: maxResultsSchema(),
    maxResults: maxResultsSchema(),
    date_range: z
      .string()
      .optional()
      .describe(
        'Date range filter (e.g., "20250101..20250105", or "past_day", "past_week", "past_month", "past_year")',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

/** 搜索结果对象 */
export interface SearchResult {
  toolCallId: string
  content: Array<{ title: string; url: string; snippet?: string }>
}

export type Output = {
  query: string
  results: Array<SearchResult | string>
  durationSeconds: number
}

import type { WebSearchProgress } from '../../types/tools.js'

function getMaxResults(input: Input): number {
  return input.max_results ?? input.maxResults ?? DEFAULT_MAX_RESULTS
}

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `ZY code wants to search the web for: ${input.query}`
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
    if (!getMainLoopModel()) {
      return false
    }
    // 当用户在 ~/.zy/tools/ 注册同名外部工具时，自动禁用内置版本
    return !hasExternalToolOverride(WEB_SEARCH_TOOL_NAME)
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
  async call(input, _context, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const { query, allowed_domains, blocked_domains, date_range } = input
    const maxResults = getMaxResults(input)

    // 域名过滤器转为 site:/-site: 拼入 query，搜索引擎原生处理
    let effectiveQuery = query
    if (allowed_domains?.length) {
      effectiveQuery = `${query} ${allowed_domains.map((d) => `site:${d}`).join(' OR ')}`
    } else if (blocked_domains?.length) {
      effectiveQuery = `${query} ${blocked_domains.map((d) => `-site:${d}`).join(' AND ')}`
    }

    if (onProgress) {
      onProgress({
        toolUseID: 'search-start',
        data: { type: 'query_update', query: effectiveQuery },
      })
    }

    try {
      logForDebugging(`[WebSearch] query="${effectiveQuery}"`)

      const searchResults = await executeSearch({
        query: effectiveQuery,
        maxResults,
        date: date_range,
      })

      logForDebugging(
        `[WebSearch] Got ${searchResults.length} results in ${((performance.now() - startTime) / 1000).toFixed(2)}s`,
      )

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

      const durationSeconds = (performance.now() - startTime) / 1000
      const results: Array<SearchResult | string> = []

      if (searchResults.length > 0) {
        results.push({
          toolCallId: `search-${Date.now()}`,
          content: searchResults.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          })),
        })
      } else {
        results.push('No results found for this query.')
      }

      return { data: { query, results, durationSeconds } }
    } catch (error) {
      logError(error)
      logForDebugging(
        `[WebSearch] Error: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )

      const durationSeconds = (performance.now() - startTime) / 1000
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

    ;(results ?? []).forEach((result) => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        formattedOutput += `${result}\n\n`
      } else {
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })

    formattedOutput +=
      '\nREMINDER: You MUST include the sources links in your response to the user using markdown hyperlinks.'

    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)

// ---------------------------------------------------------------------------
// 搜索后端：通过 OpenSerp HTTP API（http://127.0.0.1:7000）搜索
// ---------------------------------------------------------------------------

interface SearchResponseItem {
  title: string
  url: string
  content?: string
}

/** OpenSerp 单条搜索结果结构 */
interface OpenSerpResult {
  title: string
  url: string
  snippet?: string
  domain?: string
}

/** OpenSerp /mega/search 响应结构 */
interface OpenSerpMegaResponse {
  query: { text: string }
  meta: {
    took_ms: number
    engines_failed?: string[]
  }
  results: OpenSerpResult[]
}

const OPENSERP_BASE = 'http://127.0.0.1:7000'

/** 默认多引擎组合，按可用性与覆盖度排序 */
const MEGA_ENGINES = ['bing', 'baidu', 'ecosia', 'duck', 'google']

const RETRYABLE = new Set([408, 429, 500, 502, 503])
const MAX_RETRIES = 4

/**
 * 带指数退避重试的 fetch 包装，参考 OpenSERP 官方客户端模式。
 * - 重试状态码：408（超时）、429（限流）、500/502/503（服务端）
 * - 优先使用 Retry-After 响应头，否则指数退避 + 随机抖动
 */
async function fetchWithRetry(url: string, maxAttempts = MAX_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })

    if (res.ok) return res

    if (!RETRYABLE.has(res.status) || attempt === maxAttempts) {
      return res
    }

    const retryAfter = Number(res.headers.get('Retry-After') ?? 0)
    const waitMs = retryAfter
      ? retryAfter * 1000
      : Math.min(2 ** attempt * 250, 8000) + Math.random() * 250

    logForDebugging(
      `[WebSearch] Retry ${attempt}/${maxAttempts} after ${res.status}, waiting ${waitMs.toFixed(0)}ms`,
    )
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  throw new Error('Unexpected: retry loop exhausted without returning')
}

/** OpenSERP 搜索选项 */
interface SearchOptions {
  query: string
  maxResults?: number
  date?: string
}

/**
 * 通过 OpenSerp /mega/search 执行搜索。
 * 多引擎并行聚合，自动从用户设置推断语言。
 */
async function executeSearch(options: SearchOptions): Promise<SearchResponseItem[]> {
  const { query, maxResults = DEFAULT_MAX_RESULTS, date } = options

  const params = new URLSearchParams({
    text: query,
    limit: String(Math.min(maxResults, MAX_ALLOWED_RESULTS)),
    engines: MEGA_ENGINES.join(','),
    mode: 'balanced',
    dedupe: 'true',
    merge: 'true',
    filter: 'true',
    features: 'false', // 只需普通搜索结果，不需要 SERP feature
  })

  if (date) params.set('date', date)

  try {
    const res = await fetchWithRetry(`${OPENSERP_BASE}/mega/search?${params}`)

    if (!res.ok) {
      logForDebugging(
        `[WebSearch] OpenSerp returned ${res.status} for query="${query}": ${await res.text().catch(() => '')}`,
      )
      return []
    }

    const data = (await res.json()) as OpenSerpMegaResponse

    const searchItems: SearchResponseItem[] = data.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.snippet,
    }))

    return searchItems.slice(0, maxResults)
  } catch (error) {
    logForDebugging(
      `[WebSearch] OpenSerp fetch error: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(WebSearchTool)
