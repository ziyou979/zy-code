/**
 * DuckDuckGo 搜索外部工具 — 覆盖内置 WebSearch。
 *
 * 使用方式：
 *   将此文件复制到 ~/.zy/tools/web-search-duckduckgo.ts，重启 zy-code 即可生效。
 *   内置 WebSearch 会检测到同名外部工具并自动禁用。
 *
 * 接口规范（ExternalToolDefinition）：
 *   - name: string          工具名称，'WebSearch' 覆盖内置
 *   - description: string   工具描述
 *   - inputSchema: object   JSON Schema 输入定义
 *   - call: function        执行函数，返回 string 或 object
 *   - isReadOnly?: boolean  是否只读（默认 true）
 *   - searchHint?: string   ToolSearch 关键词提示
 *   - userFacingInput?: fn  用户可读的入参展示（可选，默认 key=value）
 *   - userFacingOutput?: fn 用户可读的出参展示（可选，默认原始输出）
 */

interface SearchResult {
  title: string
  url: string
  snippet?: string
}

/**
 * 带重试的 DuckDuckGo Lite 搜索。
 *
 * 关键技巧：必须发送完整的浏览器级请求头（特别是 Sec-Fetch-*），
 * 否则 Cloudflare 会返回验证挑战页而非实际搜索结果。
 * 参考 duckduckgo-search 库的重试模式（3 次重试 + 3 秒退避）。
 */
async function searchDuckDuckGo(query: string, maxResults = 8): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+')
  const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`

  // 完整浏览器请求头 — Cloudflare 据此区分真实用户与脚本
  const browserHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  }

  let lastError: Error | null = null

  // 最多重试 3 次，应对间歇性 Cloudflare 验证
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: browserHeaders,
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        throw new Error(`DuckDuckGo search failed: ${response.status}`)
      }

      const html = await response.text()

      // 检查是否返回了验证挑战页
      if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
        throw new Error('Cloudflare challenge triggered, retrying...')
      }

      // 检查是否实际包含搜索结果
      const results = parseHtml(html, maxResults)
      if (results.length > 0) {
        return results
      }

      // 无结果不一定是失败，但 DDG 可能返回空结果
      return results
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }

  throw lastError ?? new Error('Search failed after 3 retries')
}

function parseHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const snippets: string[] = []

  // 提取摘要 — 兼容单引号/双引号
  const snippetRegex = /<td\b[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi
  let snippetMatch
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeEntities(stripTags(snippetMatch[1] || '')).trim())
  }

  // 提取链接 — 兼容单引号/双引号、属性顺序不定
  const linkRegex = /<a\b([^>]*?)class=["']result-link["']([^>]*)>([\s\S]*?)<\/a>/gi
  let linkMatch
  while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const allAttrs = (linkMatch[1] || '') + ' ' + (linkMatch[2] || '')
    const title = decodeEntities(stripTags(linkMatch[3] || '')).trim()

    // 提取 href（兼容单引号/双引号）
    const hrefMatch = allAttrs.match(/href\s*=\s*["']([^"']+)["']/)
    const href = hrefMatch ? decodeEntities(hrefMatch[1] || '') : ''

    // DDG Lite 用 uddg 参数编码真实 URL
    const urlMatch = href.match(/[?&]uddg=([^&]+)/)
    const url = urlMatch ? decodeURIComponent(urlMatch[1] || '') : href.replace(/^\/\//, 'https://')

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
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ─── ExternalToolDefinition ─────────────────────────────────────────

export default {
  name: 'WebSearch',
  description: 'Search the web using DuckDuckGo. Returns results with title, URL, and snippet.',
  searchHint: 'search the web for current information',
  isReadOnly: true,
  // 设为 false 可快捷关闭此工具，无需删除文件
  enabled: false,
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

  /** 用户可读的入参展示 */
  userFacingInput(input: Record<string, unknown>): string | null {
    const query = (input.query as string) || ''
    const extra = Object.entries(input)
      .filter(([k]) => k !== 'query')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    return `搜索: ${query}${extra ? ` (${extra})` : ''}`
  },

  /** 用户可读的出参展示 */
  userFacingOutput(output: string): string | null {
    try {
      const data = JSON.parse(output)
      if (data.results?.length > 0) {
        const top = data.results.slice(0, 3).map((r: { title: string }) => r.title)
        return `找到 ${data.count} 条结果${top.length > 0 ? `：${top.join('、')}` : ''}`
      }
    } catch {
      // 非 JSON 输出（错误信息等），回退默认显示
    }
    if (output.includes('No results found')) {
      return '未找到结果'
    }
    return null // 回退到适配器默认展示
  },

  async call(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string
    const maxResults = (args.max_results as number) || 8

    let results = await searchDuckDuckGo(query, maxResults)

    // 域名过滤
    if (args.blocked_domains) {
      const blocked = args.blocked_domains as string[]
      results = results.filter((r) => {
        try {
          const host = new URL(r.url).hostname
          return !blocked.some((d) => host.includes(d))
        } catch {
          return true
        }
      })
    }

    if (args.allowed_domains) {
      const allowed = args.allowed_domains as string[]
      results = results.filter((r) => {
        try {
          const host = new URL(r.url).hostname
          return allowed.some((d) => host.includes(d))
        } catch {
          return true
        }
      })
    }

    if (results.length === 0) {
      return 'No results found for this query.'
    }

    return JSON.stringify({ query, results, count: results.length }, null, 2)
  },
}
