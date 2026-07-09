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
// 搜索后端：通过 camofox-browser HTTP API 搜索（支持多引擎）
// ---------------------------------------------------------------------------

interface SearchResponseItem {
  title: string
  url: string
  content?: string
}

/**
 * 搜索引擎配置。
 * 所有引擎都通过 camofox-browser 打开页面，从 accessibility snapshot 解析。
 *
 * 可用性分类：
 * ✅ 稳定 — Bing、百度、搜狗（heading[level=3] 结构可解析）
 * ⚠️ 不可用 — Google（反爬检测）、DuckDuckGo（结果未进 aria tree）、
 *              360（仅侧边栏）、夸克（WAF）、神马/头条/Yandex/Kagi 等（页面不完整）
 */
const SEARCH_ENGINES = {
  bing: {
    label: 'Bing',
    url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    parser: parseBingSnapshot,
  },
  baidu: {
    label: '百度',
    url: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    parser: parseHeadingSnapshot,
  },
  sogou: {
    label: '搜狗',
    url: (q: string) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parser: parseHeadingSnapshot, // 与百度结构一致（heading[level=3]）
  },
} as const

type SearchEngine = keyof typeof SEARCH_ENGINES

/** 默认搜索引擎 */
const DEFAULT_ENGINE: SearchEngine = 'bing'

/** camofox-browser 访问凭证 */
const CAMOFOX_API_KEY = 'zy979'
const CAMOFOX_BASE = 'http://127.0.0.1:9377'

/** 对 camofox-browser 发 JSON 请求 */
async function camofoxFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${CAMOFOX_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CAMOFOX_API_KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 从 Bing 搜索结果页的 accessibility snapshot 中解析搜索结果。
 *
 * Bing snapshot 的格式（缩进树）：
 *   - main "Search Results":
 *     - text: About X results
 *     - list:
 *       - listitem:
 *         - link "domain" [eN]:
 *           - /url: <bing_redirect_url>
 *         - heading "title" [level=2]:
 *           - link "title" [eN]:
 *             - /url: <bing_redirect_url>
 *         - paragraph: description
 */
function parseBingSnapshot(snapshot: string, maxResults: number): SearchResponseItem[] {
  const results: SearchResponseItem[] = []
  const lines = snapshot.split('\n')

  // 找到 "main "Search Results"" 区域
  const hdrIdx = lines.findIndex((l) => l.trim().startsWith('- main "Search Results"'))
  if (hdrIdx === -1) return results
  const hdrIndent = lines[hdrIdx].search(/\S/)

  let curUrl = ''
  let curTitle = ''
  let curDesc = ''
  let inItem = false
  let isAd = false

  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.search(/\S/)
    if (indent === -1) continue
    const trimmed = line.trim()

    // 新顶层节 → 退出
    if (indent <= hdrIndent && trimmed.startsWith('-')) break

    // 新条目开始
    if (trimmed === '- listitem:') {
      // 保存上一条
      if (curUrl && curTitle && !isAd) {
        results.push({ title: curTitle, url: curUrl, content: curDesc || undefined })
      }
      curUrl = ''
      curTitle = ''
      curDesc = ''
      isAd = false
      inItem = true
      continue
    }

    if (!inItem) continue

    // 条目内有 list → 说明是广告（带站点链接的结构）
    if (trimmed === '- list:') {
      isAd = true
      continue
    }

    // 跳过广告
    if (isAd) continue

    // - /url: xxx 提取 URL
    const urlMatch = trimmed.match(/^-\s+\/url:\s+(.+)$/)
    if (urlMatch && !curUrl) {
      curUrl = decodeBingUrl(urlMatch[1])
      continue
    }

    // - heading "xxx" 提取标题
    const headingMatch = trimmed.match(/^-\s+heading\s+"([^"]+)"/)
    if (headingMatch && !curTitle) {
      curTitle = headingMatch[1]
      continue
    }

    // - paragraph: xxx 提取摘要
    const paraMatch = trimmed.match(/^-\s+paragraph:\s*(.+)$/)
    if (paraMatch && !curDesc) {
      curDesc = paraMatch[1]
    }
  }

  // 最后一条
  if (curUrl && curTitle && !isAd) {
    results.push({ title: curTitle, url: curUrl, content: curDesc || undefined })
  }

  return results.slice(0, maxResults)
}

/** 解码 Bing 跳转链接中的真实 URL（u 参数 = 可能有前缀的 base64） */
function decodeBingUrl(rawUrl: string): string {
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) return rawUrl

  try {
    const parsed = new URL(rawUrl)
    const encoded = parsed.searchParams.get('u')
    if (!encoded) return rawUrl

    // Bing 有时在 base64 前加 `a1` 等前缀，逐次截取尝试解码
    let decoded = tryDecodeBase64(encoded)
    if (decoded?.startsWith('http')) return decoded

    // 去掉前 2 字符再试
    if (encoded.length > 2) {
      decoded = tryDecodeBase64(encoded.slice(2))
      if (decoded?.startsWith('http')) return decoded
    }

    // 去掉前 4 字符再试
    if (encoded.length > 4) {
      decoded = tryDecodeBase64(encoded.slice(4))
      if (decoded?.startsWith('http')) return decoded
    }
  } catch {
    // URL 解析失败
  }

  return rawUrl
}

/** 尝试 base64 解码 */
function tryDecodeBase64(s: string): string | null {
  try {
    return Buffer.from(s, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

/**
 * 从搜索引擎的 accessibility snapshot 中解析 heading[level=3] 结构的结果。
 *
 * 适用于百度、搜狗等使用 heading[level=3] 标记搜索结果的引擎。
 * 格式：
 *   - heading "title" [level=3]:
 *     - link "title" [eN]:
 *       - /url: http://.../link?url=TARGET_URL
 *   - text / emphasis: description
 */
function parseHeadingSnapshot(snapshot: string, maxResults: number): SearchResponseItem[] {
  const results: SearchResponseItem[] = []
  const lines = snapshot.split('\n')

  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    const trimmed = lines[i].trim()

    // heading[level=3] = 搜索结果标题
    const headingMatch = trimmed.match(/^-\s+heading\s+"([^"]+)"\s*\[level=3\]/)
    if (!headingMatch) continue

    const title = headingMatch[1]
    let url = ''
    let desc = ''

    // 向后找该 heading 下的 /url: 和 description
    const headingIndent = lines[i].search(/\S/)
    for (let j = i + 1; j < lines.length; j++) {
      const nextTrimmed = lines[j].trim()
      const nextIndent = lines[j].search(/\S/)

      // 遇到同层或更高层的 heading → 停止
      if (nextIndent <= headingIndent && nextTrimmed.startsWith('-')) break

      // 提取 URL（百度用 full URL，搜狗用相对路径 /link?url=...）
      if (!url) {
        const urlMatch = nextTrimmed.match(/^-\s+\/url:\s+(.+)$/)
        if (urlMatch) {
          url = decodeSearchUrl(urlMatch[1])
        }
      }

      // 提取摘要（取第一个非空非标题的文本行）
      if (!desc && nextTrimmed.startsWith('- text:') && !nextTrimmed.includes(title.slice(0, 10))) {
        desc = nextTrimmed.replace(/^-\s+text:\s*/, '').slice(0, 200)
      }
    }

    if (title && url) {
      results.push({ title, url, content: desc || undefined })
    }
  }

  return results
}

/**
 * 解码百度/搜狗跳转链接中的真实 URL。
 * 百度：http://www.baidu.com/link?url=REAL_URL&...
 * 搜狗：/link?url=REAL_URL&...（相对路径）
 */
function decodeSearchUrl(rawUrl: string, baseHost?: string): string {
  // 相对路径 → 补全为绝对 URL
  if (rawUrl.startsWith('/')) {
    const base = baseHost || 'https://www.sogou.com'
    rawUrl = base + rawUrl
  }
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) return rawUrl
  try {
    const parsed = new URL(rawUrl)
    const target = parsed.searchParams.get('url')
    if (target) return target
  } catch {}
  return rawUrl
}

/** 解码 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ---------------------------------------------------------------------------
// 执行搜索
// ---------------------------------------------------------------------------

/**
 * 通过 camofox-browser 执行搜索。
 * 创建浏览器标签页 → 导航到搜索引擎 → 获取 snapshot → 解析结果。
 */
async function executeSearch(
  query: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
  maxResults = DEFAULT_MAX_RESULTS,
): Promise<SearchResponseItem[]> {
  const engineName: SearchEngine = DEFAULT_ENGINE
  const engine = SEARCH_ENGINES[engineName]

  // 检查 camofox-browser 是否在运行
  const health = await camofoxFetch('GET', '/health')
  if (!health) {
    logForDebugging('[WebSearch] camofox-browser not reachable')
    return []
  }

  // 创建标签页并导航到搜索引擎
  const searchUrl = engine.url(query)
  const tab = await camofoxFetch('POST', '/tabs', {
    userId: 'zy-code',
    sessionKey: `zy-search-${Date.now()}`,
    url: searchUrl,
  })
  if (!tab || !tab.tabId) {
    logForDebugging('[WebSearch] Failed to create tab')
    return []
  }

  // 等待页面加载
  await new Promise((r) => setTimeout(r, engineName === 'bing' ? 5000 : 6000))

  // 获取 snapshot
  const snapshot = await camofoxFetch('GET', `/tabs/${tab.tabId}/snapshot?userId=zy-code`)
  if (!snapshot || !snapshot.snapshot) {
    logForDebugging('[WebSearch] No snapshot returned')
    return []
  }

  // 解析结果
  const results = SEARCH_ENGINES[engineName].parser(snapshot.snapshot as string, maxResults)

  // 域名过滤
  if (blockedDomains?.length || allowedDomains?.length) {
    return results.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname
        if (blockedDomains?.length && blockedDomains.some((d) => hostname.includes(d))) return false
        if (allowedDomains?.length && !allowedDomains.some((d) => hostname.includes(d))) return false
      } catch {}
      return true
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
