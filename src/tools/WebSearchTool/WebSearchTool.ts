import { z } from 'zod/v4'
import { getMainLoopModel } from '../../services/model/model.js'
import { buildTool, type ToolDef } from '../../tools/tool.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../services/infra/log.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { hasExternalToolOverride } from '../externalToolLoader.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import { runSearchChain, type SearchResponseItem } from './searchBackends.js'
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
        allowedDomains: allowed_domains,
        blockedDomains: blocked_domains,
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
// 搜索后端：本地 OpenSERP → 用户自己的托管 zy-search 网关（见 searchBackends.ts）
// ---------------------------------------------------------------------------

/** 搜索选项 */
interface SearchOptions {
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxResults?: number
  date?: string
}

/**
 * 按后端链执行搜索。全部后端不可用时抛错，由 call() 转成工具错误结果。
 */
async function executeSearch(options: SearchOptions): Promise<SearchResponseItem[]> {
  const { maxResults = DEFAULT_MAX_RESULTS } = options
  const { items, backend } = await runSearchChain({
    query: options.query,
    allowedDomains: options.allowedDomains,
    blockedDomains: options.blockedDomains,
    maxResults: Math.min(maxResults, MAX_ALLOWED_RESULTS),
    date: options.date,
  })
  logForDebugging(`[WebSearch] backend=${backend} results=${items.length}`)
  return items.slice(0, maxResults)
}

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(WebSearchTool)
