import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import { getOauthConfig } from '../../constants/oauth.js'
import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryCompactModel } from '../../services/api/compactQueries.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../services/http/http.js'
import { logError } from '../../utils/log.js'
import { isBinaryContentType, persistBinaryContent } from '../../services/mcp/mcpOutputStorage.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

// 域名拦截相关的自定义错误类
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(tSync('webFetch.domainBlocked', { domain }))
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(tSync('webFetch.domainCheckFailed', { domain }))
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: tSync('webFetch.egressBlocked', { domain }),
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// 用于存储已获取 URL 内容的缓存项类型
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// URL 内容缓存：15 分钟 TTL，50MB 大小限制
// LRUCache 自动处理过期和淘汰
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

// 域名预检独立缓存。URL_CACHE 以 URL 为键，因此同一域名的两个路径
// 会触发两次相同的预检 HTTP 往返请求到 api.anthropic.com。
// 此缓存以主机名为键来避免该问题。仅缓存 'allowed' 状态——
// 被拦截/失败的下次尝试会重新检查。
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000, // 5 分钟——短于 URL_CACHE 的 TTL
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  DOMAIN_CHECK_CACHE.clear()
}

// 懒加载单例 —— 将 turndown → @mixmark-io/domino 的导入（约 1.4MB 堆内存）
// 推迟到第一次 HTML 获取时才加载，并在多次调用间复用同一实例
//（构造时会创建 15 个规则对象；.turndown() 是无状态的）。
// @types/turndown 只提供 `export =`（没有 .d.mts），所以 TS 将导入类型视为类本身，
// 而 Bun 将 CJS 包装为 { default } —— 因此需要类型断言。
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then((m) => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}
// PSR 曾要求将 URL 长度限制为 250 以降低数据外泄风险，
// 但这对一些客户的合法用例（如 JWT 签名 URL）过于严格。
// 我们已经要求用户对每个域名进行审批，这构成了主要安全边界。
// 此外 ZY Code 还有其他数据外泄渠道，此渠道风险相对较低，
// 因此移除该长度限制。-ab
const MAX_URL_LENGTH = 2000

// 根据 PSR 要求实现资源消耗控制：
// "为 Web Fetch 工具设置 CPU、内存和网络使用限制，
// 可以防止单个请求或用户压垮系统。"
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// 主 HTTP 请求超时（60 秒），防止在慢速/无响应服务器上无限挂起。
const FETCH_TIMEOUT_MS = 60_000

// 域名黑名单预检超时（10 秒）。
const DOMAIN_CHECK_TIMEOUT_MS = 10_000

// 限制同主机重定向跳数。恶意服务器可能返回重定向循环
// (/a → /b → /a …)，且每次跳转都会重置 FETCH_TIMEOUT_MS，
// 导致工具挂起直到用户中断。10 次与常见客户端默认值一致
// （axios=5，follow-redirects=21，Chrome=20）。
const MAX_REDIRECTS = 10

// 截断长度，避免消耗过多 token
export const MAX_MARKDOWN_LENGTH = 100_000

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // 此处无需检查协议，发起请求时会将 http 升级为 https

  // 只要不涉及 cookie 或内部域名，就应拦截带用户名/密码的 URL，
  // 尽管这类情况极其罕见。
  if (parsed.username || parsed.password) {
    return false
  }

  // 初步过滤：通过检查主机名是否可公开解析，排除特权/公司内部 URL
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

export async function checkDomainBlocklist(domain: string): Promise<DomainCheckResult> {
  // TODO 暂时跳过检测
  return { status: 'allowed' }
  // if (DOMAIN_CHECK_CACHE.has(domain)) {
  //   return { status: 'allowed' }
  // }
  // try {
  //   // 使用 ZY Code OAuth 配置中的基础 API URL 进行域名安全检查
  //   const response = await axios.get(
  //     `${getOauthConfig().BASE_API_URL}/api/web/domain_info?domain=${encodeURIComponent(domain)}`,
  //     { timeout: DOMAIN_CHECK_TIMEOUT_MS },
  //   )
  //   if (response.status === 200) {
  //     if (response.data.can_fetch === true) {
  //       DOMAIN_CHECK_CACHE.set(domain, true)
  //       return { status: 'allowed' }
  //     }
  //     return { status: 'blocked' }
  //   }
  //   // 非 200 状态但未抛出异常
  //   return {
  //     status: 'check_failed',
  //     error: new Error(`域名检查返回状态 ${response.status}`),
  //   }
  // } catch (e) {
  //   logError(e)
  //   return { status: 'check_failed', error: e as Error }
  // }
}

/**
 * 检查重定向是否安全可跟随
 * 允许以下重定向：
 * - 在主机名中添加或移除 "www."
 * - 保持 origin 不变但更改路径/查询参数
 * - 或同时满足以上两者
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // 检查主机名条件
    // 1. 允许添加 www.：example.com -> www.example.com
    // 2. 允许移除 www.：www.example.com -> example.com
    // 3. 允许相同主机（带或不带 www.）：路径可以变化
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * 辅助函数：处理带自定义重定向控制的 URL 获取
 * 如果重定向通过 redirectChecker 检查，则递归跟随
 *
 * 根据 PSR 要求：
 * "不要自动跟随重定向，因为跟随重定向可能让攻击者利用
 * 可信域名的开放重定向漏洞，迫使用户在不知情的情况下向恶意域名发起请求。"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(tSync('webFetch.tooManyRedirects', { maxRedirects: String(MAX_REDIRECTS) }))
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error(tSync('webFetch.redirectMissingLocation'))
      }

      // 将相对 URL 解析为基于原始 URL 的绝对 URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      if (redirectChecker(url, redirectUrl)) {
        // 递归跟随允许的重定向
        return getWithPermittedRedirects(redirectUrl, signal, redirectChecker, depth + 1)
      } else {
        // 将重定向信息返回给调用方
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // 检测出口代理拦截：代理返回 403 且带有
    // X-Proxy-Error: blocked-by-allowlist 头时表示出口受限
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error(tSync('webFetch.invalidUrl'))
  }

  // 检查缓存（LRUCache 自动处理 TTL）
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // 检查用户是否选择跳过黑名单检查
    // 这是为具有限制性安全策略的企业客户准备的，
    // 这些策略可能会阻止到 zy.ai 的出站连接
    const settings = getInitialSettings()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname)
      switch (checkResult.status) {
        case 'allowed':
          // 继续获取
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }

    if (isInternalBuild()) {
      logEvent('zy_web_fetch_host', {
        hostname: hostname as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch (e) {
    if (e instanceof DomainBlockedError || e instanceof DomainCheckFailedError) {
      // 预期的面向用户的失败——直接抛出，不作为内部错误记录
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  const rawBuffer = Buffer.from(response.data)
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  const contentType = String(response.headers['content-type'] ?? '')

  // 二进制内容：将原始字节保存到磁盘并附带合适的扩展名，以便 ZY
  // 后续检查文件。我们仍然继续执行下方的 utf-8 解码 + Haiku 路径——
  // 特别是对于 PDF，解码后的字符串包含足够的 ASCII 结构（/Title、文本流等），
  // Haiku 可以对其进行摘要，保存的文件只是补充而非替代。
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // 非 HTML 内容——直接使用原始文本。解码后字符串的 UTF-8 字节长度
    // 等于 rawBuffer.length（无效字节会被替换为 U+FFFD，对缓存淘汰统计
    // 影响可忽略），因此跳过 O(n) 的 Buffer.byteLength 扫描。
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // 将获取到的内容存入缓存。注意缓存键使用原始 URL，
  // 而非升级或重定向后的 URL。
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // lru-cache 要求正整数；空响应时钳位到 1。
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // 截断内容以避免副模型返回 "Prompt is too long" 错误
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? `${markdownContent.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(truncatedContent, prompt, isPreapprovedDomain)
  const assistantMessage = await queryCompactModel({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: {
      // @ts-expect-error
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // 需要将中止信号向上冒泡，使工具调用抛出异常，
  // 从而向服务器返回 is_error tool_use 块，并在 UI 中渲染红点。
  if (signal.aborted) {
    throw new AbortError()
  }

  const content = assistantMessage.message.content
  if (content.length > 0) {
    const contentBlock = content[0]
    if ('text' in contentBlock) {
      return contentBlock.text
    }
  }
  return tSync('webFetch.noResponseFromModel')
}
