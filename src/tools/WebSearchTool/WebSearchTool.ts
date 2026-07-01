import { z } from 'zod/v4'
import { getMainLoopModel } from '../../services/model/model.js'
import { buildTool, type ToolCallProgress, type ToolDef } from '../../Tool.js'
import { hasExternalToolOverride } from '../externalToolLoader.js'
import type { ContentBlock } from '../../types/llm.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

const SEARCH_API_URL = 'http://127.0.0.1:8089'
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
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

/** 搜索结果对象 — 与旧版格式兼容 */
export interface SearchResult {
  toolCallId: string
  content: Array<{ title: string; url: string; snippet?: string }>
}

export type Output = {
  query: string
  results: Array<SearchResult | string>
  durationSeconds: number
}

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

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
    const { query, allowed_domains, blocked_domains } = input
    const maxResults = getMaxResults(input)

    if (onProgress) {
      onProgress({
        toolUseID: 'search-start',
        data: { type: 'query_update', query },
      })
    }

    try {
      logForDebugging(`[WebSearch] query="${query}"`)

      const searchResults = await executeSearch(query, allowed_domains, blocked_domains, maxResults)

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
// 内置搜索：请求 ZY Search API
// ---------------------------------------------------------------------------

interface SearchResponseItem {
  title: string
  url: string
  content?: string
}

async function executeSearch(
  query: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  maxResults = DEFAULT_MAX_RESULTS,
): Promise<SearchResponseItem[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'general',
    safesearch: '0',
  })

  if (allowedDomains?.length) {
    const siteQueries = allowedDomains.map((d) => `site:${d}`)
    params.set('q', `${query} ${siteQueries.join(' OR ')}`)
  }

  const url = `${SEARCH_API_URL}/search?${params.toString()}`

  logForDebugging(`[WebSearch] Fetching ${url}`)

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    throw new Error(`Web search failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  if (!data.results || !Array.isArray(data.results)) {
    return []
  }

  const results: SearchResponseItem[] = []

  for (const item of data.results) {
    if (results.length >= maxResults) break
    if (!item.title || !item.url) continue

    if (blockedDomains?.length) {
      try {
        const hostname = new URL(item.url).hostname
        if (blockedDomains.some((d) => hostname.includes(d))) continue
      } catch {
        // URL 解析失败，保留结果
      }
    }

    results.push({
      title: item.title.trim(),
      url: item.url,
      content: item.content?.trim(),
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// 从模型文本回复中解析搜索结果（通用回退方案）
// ---------------------------------------------------------------------------

function _parseResultsFromText(
  contentBlocks: ContentBlock[],
  _query: string,
  blockedDomains?: string[],
): SearchResponseItem[] {
  const results: SearchResponseItem[] = []

  const text = contentBlocks
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')

  if (!text) {
    return results
  }

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  let match
  while ((match = linkRegex.exec(text)) !== null) {
    const title = match[1].trim()
    const url = match[2].trim()

    if (!title || !url) continue

    if (blockedDomains?.length) {
      try {
        const hostname = new URL(url).hostname
        if (blockedDomains.some((d) => hostname.includes(d))) continue
      } catch {
        // ignore
      }
    }

    results.push({ title, url })
  }

  if (results.length === 0) {
    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
    let urlMatch
    while ((urlMatch = urlRegex.exec(text)) !== null) {
      const url = urlMatch[1]
      if (!url) continue

      if (blockedDomains?.length) {
        try {
          const hostname = new URL(url).hostname
          if (blockedDomains.some((d) => hostname.includes(d))) continue
        } catch {
          continue
        }
      }

      results.push({ title: url, url })
    }
  }

  return results
}

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(WebSearchTool)
