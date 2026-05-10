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
      url += `&kl=${this.region}`
    }

    // 域过滤 — DuckDuckGo 不支持原生域过滤，但在查询中添加 site: 可以实现
    if (options?.allowedDomains && options.allowedDomains.length > 0) {
      const siteQueries = options.allowedDomains.map((d) => `site:${d}`)
      url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}+${siteQueries.join('+OR+')}`
      if (this.region) {
        url += `&kl=${this.region}`
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
  const snippetTexts = extractSnippetTexts(html)
  const resultLinkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi

  let linkMatch: RegExpExecArray | null
  while ((linkMatch = resultLinkRegex.exec(html)) !== null && results.length < maxResults) {
    const attributes = linkMatch[1] ?? ''
    const className = extractHtmlAttribute(attributes, 'class')
    if (!className.split(/\s+/).includes('result-link')) {
      continue
    }

    const title = decodeHTMLEntities(stripHtmlTags(linkMatch[2] ?? '')).trim()
    const href = extractHtmlAttribute(attributes, 'href')
    const url = extractDuckDuckGoTargetUrl(href)

    if (isInvalidSearchResult(title, url, blockedDomains)) {
      continue
    }

    const snippet = snippetTexts[results.length] ?? ''
    results.push({
      title,
      url,
      snippet: snippet || undefined,
    })
  }

  return results
}

function extractSnippetTexts(html: string): string[] {
  const snippetTexts: string[] = []
  const tableCellRegex = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi

  let tableCellMatch: RegExpExecArray | null
  while ((tableCellMatch = tableCellRegex.exec(html)) !== null) {
    const attributes = tableCellMatch[1] ?? ''
    const className = extractHtmlAttribute(attributes, 'class')
    if (!className.split(/\s+/).includes('result-snippet')) {
      continue
    }

    snippetTexts.push(decodeHTMLEntities(stripHtmlTags(tableCellMatch[2] ?? '')).trim())
  }

  return snippetTexts
}

function extractHtmlAttribute(attributes: string, attributeName: string): string {
  const attributeRegex = new RegExp(`${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i')
  const attributeMatch = attributes.match(attributeRegex)
  return decodeHTMLEntities(attributeMatch?.[2] ?? '')
}

function extractDuckDuckGoTargetUrl(href: string): string {
  if (!href) {
    return ''
  }

  const decodedHref = decodeHTMLEntities(href)
  const duckDuckGoTargetMatch = decodedHref.match(/[?&]uddg=([^&]+)/)
  if (duckDuckGoTargetMatch) {
    try {
      return decodeURIComponent(duckDuckGoTargetMatch[1])
    } catch {
      return decodedHref
    }
  }

  if (decodedHref.startsWith('//')) {
    return `https:${decodedHref}`
  }

  return decodedHref
}

function isInvalidSearchResult(
  title: string,
  url: string,
  blockedDomains?: string[],
): boolean {
  if (!title || !url || title.includes('Sponsored') || title.toLowerCase().includes('ad ')) {
    return true
  }

  if (!blockedDomains?.length) {
    return false
  }

  try {
    const hostname = new URL(url).hostname
    return blockedDomains.some((blockedDomain) => hostname.includes(blockedDomain))
  } catch {
    return false
  }
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
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
