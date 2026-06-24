/**
 * 示例：使用 DuckDuckGo 作为 WebSearch 的外部工具
 *
 * 将此文件复制到 ~/.zy/tools/web-search.ts 即可覆盖内置 WebSearch。
 * 内置 WebSearch 会自动检测同名外部工具并禁用自身。
 *
 * 安装步骤：
 * 1. mkdir -p ~/.zy/tools
 * 2. cp web-search-duckduckgo.ts ~/.zy/tools/web-search.ts
 * 3. 重启 zy-code
 *
 * ExternalToolDefinition 接口：
 * - name: 工具名称（'WebSearch' 覆盖内置工具）
 * - description: 工具描述
 * - inputSchema: JSON Schema 格式的输入定义
 * - call: 执行函数，返回字符串或对象
 * - isReadOnly: 是否只读（默认 true）
 * - searchHint: ToolSearch 搜索关键词
 */
import type { ExternalToolDefinition } from '../../src/tools/externalToolAdapter'

interface SearchResult {
  title: string
  url: string
  snippet?: string
}

/**
 * 通过 DuckDuckGo Lite HTML 抓取获取搜索结果
 */
async function searchDuckDuckGo(query: string, maxResults = 8): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+')
  const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ZY-Code/1.0)',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`)
  }

  const html = await response.text()
  return parseHtml(html, maxResults)
}

function parseHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const snippets: string[] = []

  // 提取摘要
  const snippetRegex = /<td\b[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi
  let snippetMatch
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeEntities(stripTags(snippetMatch[1] || '')).trim())
  }

  // 提取链接
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let linkMatch
  while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const attrs = linkMatch[1] || ''
    if (!/class="result-link"/.test(attrs)) continue

    const title = decodeEntities(stripTags(linkMatch[2] || '')).trim()
    const hrefMatch = attrs.match(/href="([^"]+)"/)
    const href = hrefMatch ? decodeEntities(hrefMatch[1] || '') : ''

    // 从 DuckDuckGo 重定向 URL 中提取真实 URL
    const urlMatch = href.match(/[?&]uddg=([^&]+)/)
    const url = urlMatch ? decodeURIComponent(urlMatch[1] || '') : href

    if (!title || !url || title.includes('Sponsored')) continue

    results.push({
      title,
      url,
      snippet: snippets[results.length] || undefined,
    })
  }

  return results
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ─── ExternalToolDefinition ─────────────────────────────────────────

const webSearchTool: ExternalToolDefinition = {
  name: 'WebSearch', // 与内置工具同名 → 自动覆盖
  description: 'Search the web using DuckDuckGo. Returns results with title, URL, and snippet.',
  searchHint: 'search the web for current information',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to use',
        minLength: 2,
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of search results to return (default: 8, max: 20)',
        minimum: 1,
        maximum: 20,
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include search results from these domains',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Never include search results from these domains',
      },
    },
    required: ['query'],
  },

  async call(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string
    const maxResults = (args.max_results as number) || 8

    const results = await searchDuckDuckGo(query, maxResults)

    if (results.length === 0) {
      return 'No results found for this query.'
    }

    // 域名过滤
    let filtered = results
    if (args.blocked_domains) {
      const blocked = args.blocked_domains as string[]
      filtered = filtered.filter((r) => {
        try {
          const host = new URL(r.url).hostname
          return !blocked.some((d) => host.includes(d))
        } catch {
          return true
        }
      })
    }

    return JSON.stringify(
      {
        query,
        results: filtered,
        count: filtered.length,
      },
      null,
      2,
    )
  },
}

export default webSearchTool
