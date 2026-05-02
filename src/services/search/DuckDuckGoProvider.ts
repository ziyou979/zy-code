/**
 * DuckDuckGo 搜索 provider — 无需 API Key。
 *
 * 通过抓取 DuckDuckGo Lite 的 HTML 页面并解析结果。
 * 参考 clawhub.ai/jakelin/ddg-web-search 的设计。
 *
 * 注意：使用 Lite 版而非标准版，因为 Lite 版返回纯 HTML，
 * 更适合程序化解析，且不容易触发反爬机制。
 */
import type { SearchProvider, SearchResult, SearchOptions } from './types.js'

/** DuckDuckGo Lite 区域代码映射 */
const REGION_MAP: Record<string, string> = {
  'us-en': 'us-en',
  'uk-en': 'uk-en',
  'au-en': 'au-en',
  'de-de': 'de-de',
  'fr-fr': 'fr-fr',
  'zh-cn': 'cn-zh',
  'ja-jp': 'jp-jp',
  'ko-kr': 'kr-kr',
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly id = 'duckduckgo'

  private region?: string

  constructor(options?: { region?: string }) {
    this.region = options?.region
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 10

    // URL 编码查询参数，空格替换为 +
    const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+')

    // 构建 DuckDuckGo Lite URL
    let url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`

    // 添加区域参数
    if (this.region) {
      const ddgRegion = REGION_MAP[this.region] ?? this.region
      url += `&kl=${ddgRegion}`
    }

    // 域过滤 — DuckDuckGo 不支持原生域过滤，但在查询中添加 site: 可以实现
    if (options?.allowedDomains && options.allowedDomains.length > 0) {
      const siteQueries = options.allowedDomains.map((d) => `site:${d}`)
      url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}+${siteQueries.join('+OR+')}`
      if (this.region) {
        url += `&kl=${REGION_MAP[this.region] ?? this.region}`
      }
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZY-Code/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`)
    }

    const html = await response.text()
    return parseDuckDuckGoLiteHtml(html, maxResults, options?.blockedDomains)
  }
}

/**
 * 解析 DuckDuckGo Lite HTML 页面中的搜索结果。
 *
 * DDG Lite 的 HTML 结构大致如下：
 * - 结果在 <table> 中，每行一个结果
 * - 每个结果包含：标题（<a> 链接）、摘要（<td class="result-snippet">）、URL
 * - 广告条目标记为 "Sponsored link"，需要跳过
 */
function parseDuckDuckGoLiteHtml(
  html: string,
  maxResults: number,
  blockedDomains?: string[],
): SearchResult[] {
  const results: SearchResult[] = []

  // 匹配结果行中的链接和摘要
  // DDG Lite 的结果结构：
  // <a rel="nofollow" class="result-link" href="URL">Title</a>
  // <td class="result-snippet">Snippet</td>
  // <a class="result-url" href="URL">URL</a>

  // 匹配结果条目 — 标题链接
  const resultLinkRegex =
    /<a[^>]*rel="nofollow"[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]*)/g
  // 匹配摘要
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
  // 匹配实际 URL（DDG Lite 的 href 是 DDG 重定向链接，需要从后面的 result-url 获取真实 URL）
  const urlRegex = /<a[^>]*class="result-url"[^>]*href="([^"]+)"/g

  // 收集所有结果条目
  const linkMatches = [...html.matchAll(resultLinkRegex)]
  const snippetMatches = [...html.matchAll(snippetRegex)]
  const urlMatches = [...html.matchAll(urlRegex)]

  for (let i = 0; i < linkMatches.length && results.length < maxResults; i++) {
    const title = decodeHTMLEntities(linkMatches[i]?.[2] ?? '').trim()
    const ddgUrl = linkMatches[i]?.[1] ?? ''

    // 从 DDG 重定向 URL 中提取真实 URL
    // DDG Lite 的链接格式：/lite/?uddg=ENCODED_URL
    let realUrl = ''
    const uddgMatch = ddgUrl.match(/uddg=([^&"]+)/)
    if (uddgMatch) {
      try {
        realUrl = decodeURIComponent(uddgMatch[1])
      } catch {
        realUrl = ddgUrl
      }
    } else {
      // 尝试从 urlMatches 中获取
      realUrl = urlMatches[i]?.[1] ?? ddgUrl
    }

    // 跳过广告
    if (title.includes('Sponsored') || title.toLowerCase().includes('ad ')) continue

    // 跳过无效结果
    if (!title || !realUrl) continue

    // 检查域名阻止
    if (blockedDomains && blockedDomains.length > 0) {
      try {
        const hostname = new URL(realUrl).hostname
        if (blockedDomains.some((d) => hostname.includes(d))) continue
      } catch {
        // URL 解析失败，保留结果
      }
    }

    // 获取摘要
    const snippet = snippetMatches[i]
      ? decodeHTMLEntities(snippetMatches[i][1] ?? '')
          .replace(/<[^>]*>/g, '')
          .trim()
      : ''

    results.push({
      title,
      url: realUrl,
      snippet: snippet || undefined,
    })
  }

  // 如果正则匹配不到结果，尝试另一种解析方式（DDG Lite 的 HTML 结构可能变化）
  if (results.length === 0) {
    // 回退：使用更宽松的匹配
    const fallbackRegex = /<a[^>]*href="[^"]*uddg=([^"&]+)"[^>]*>([^<]+)<\/a>/g
    let match
    while ((match = fallbackRegex.exec(html)) !== null && results.length < maxResults) {
      try {
        const url = decodeURIComponent(match[1])
        const title = decodeHTMLEntities(match[2]).trim()

        if (!title || !url || title.includes('Sponsored')) continue

        // 检查域名阻止
        if (blockedDomains && blockedDomains.length > 0) {
          const hostname = new URL(url).hostname
          if (blockedDomains.some((d) => hostname.includes(d))) continue
        }

        results.push({ title, url })
      } catch {
        continue
      }
    }
  }

  return results
}

/** HTML 实体解码 */
function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
