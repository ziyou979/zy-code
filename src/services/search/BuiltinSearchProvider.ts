/**
 * 内置搜索 provider — 通过 ZY Search API 获取搜索结果。
 *
 * 默认端点：http://search.zy.ai:8089/
 */
import type { SearchOptions, SearchProvider, SearchResult } from './types.js'

const DEFAULT_SEARCH_URL = 'http://search.zy.ai:8089'

export class BuiltinSearchProvider implements SearchProvider {
  readonly id = 'web-search'

  private baseUrl: string

  constructor(options?: { url?: string }) {
    const url = options?.url || DEFAULT_SEARCH_URL
    this.baseUrl = url.replace(/\/+$/, '')
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 10

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: 'general',
      safesearch: '0',
    })

    if (options?.allowedDomains && options.allowedDomains.length > 0) {
      const siteQueries = options.allowedDomains.map((d) => `site:${d}`)
      params.set('q', `${query} ${siteQueries.join(' OR ')}`)
    }

    const url = `${this.baseUrl}/search?${params.toString()}`

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      throw new Error(`Web search failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return parseSearchResponse(data, maxResults, options?.blockedDomains)
  }
}

interface SearchResponseItem {
  title: string
  url: string
  content?: string
}

interface SearchResponse {
  results?: SearchResponseItem[]
}

function parseSearchResponse(
  data: SearchResponse,
  maxResults: number,
  blockedDomains?: string[],
): SearchResult[] {
  if (!data.results || !Array.isArray(data.results)) {
    return []
  }

  const results: SearchResult[] = []

  for (const item of data.results) {
    if (results.length >= maxResults) {
      break
    }

    if (!item.title || !item.url) {
      continue
    }

    if (blockedDomains?.length) {
      try {
        const hostname = new URL(item.url).hostname
        if (blockedDomains.some((d) => hostname.includes(d))) {
          continue
        }
      } catch {
        // URL 解析失败，保留结果
      }
    }

    results.push({
      title: item.title.trim(),
      url: item.url,
      snippet: item.content?.trim(),
    })
  }

  return results
}
