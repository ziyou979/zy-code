/**
 * WebSearch 后端链：按顺序尝试，前一个不可用时自动回退到下一个。
 *
 *   1. 本地 OpenSERP（默认 http://127.0.0.1:7000，可用 ZY_OPENSERP_URL / webSearch.openserpUrl 覆盖）
 *   2. 用户自己的托管网关 zy-search（仅当配置了 ZY_SEARCH_URL + ZY_SEARCH_KEY /
 *      webSearch.hostedUrl + webSearch.hostedKey）
 *   3. 全部不可用 → 抛出带配置指引的错误
 *
 * 有意不接入任何第三方搜索 API：搜索只走自建的 OpenSERP 或用户自己的网关。
 *
 * 安全约束：
 * - URL 与 key 只从环境变量和可信 settings 源（user / flag / policy）读取；
 *   仓库可控的 projectSettings / localSettings 被有意忽略，避免恶意仓库把用户的
 *   key 或查询重定向到第三方服务器。
 * - key 只出现在请求头里，绝不进 URL、日志或错误信息（日志前统一 redact）。
 */

import { getSettingsForSource } from '../../services/settings/settings.js'
import { logForDebugging } from '../../services/infra/debug.js'

export interface SearchResponseItem {
  title: string
  url: string
  content?: string
}

export interface SearchRequest {
  /** 已经拼好 site:/-site: 的查询，供原生支持搜索语法的后端使用 */
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxResults: number
  /** "YYYYMMDD..YYYYMMDD" 或 past_day|past_week|past_month|past_year */
  date?: string
}

export interface WebSearchSettings {
  openserpUrl?: string
  hostedUrl?: string
  hostedKey?: string
}

export interface ResolvedWebSearchConfig {
  openserpUrl: string
  hosted?: { url: string; key: string }
  /** 配置了 key 但缺少托管地址时的提示 */
  hostedMisconfigured?: string
}

export const DEFAULT_OPENSERP_URL = 'http://127.0.0.1:7000'
/**
 * 官方托管网关地址。网关上线前保持为空：此时需要通过 ZY_SEARCH_URL /
 * webSearch.hostedUrl 显式指定地址，避免指向一个尚不存在（可能被抢注）的域名。
 */
export const DEFAULT_HOSTED_SEARCH_URL: string | undefined = undefined

const DUCKDUCKGO_HINT =
  'Or replace WebSearch with a no-key external tool: copy examples/external-tools/web-search-duckduckgo.ts to ~/.zy/tools/web-search.ts (or .zy/tools/) and run /reload-tools.'

// ---------------------------------------------------------------------------
// 配置解析

/** 只信任这些 settings 源；projectSettings / localSettings 由仓库控制，故排除。 */
const TRUSTED_SOURCES = ['policySettings', 'flagSettings', 'userSettings'] as const

function readTrustedWebSearchSettings(): WebSearchSettings {
  const merged: WebSearchSettings = {}
  // 优先级：policy > flag > user（先写入者胜出）
  for (const source of TRUSTED_SOURCES) {
    const ws = (getSettingsForSource(source) as { webSearch?: WebSearchSettings } | null)?.webSearch
    if (!ws || typeof ws !== 'object') {
      continue
    }
    for (const key of ['openserpUrl', 'hostedUrl', 'hostedKey'] as const) {
      const value = ws[key]
      if (merged[key] === undefined && typeof value === 'string' && value.trim()) {
        merged[key] = value.trim()
      }
    }
  }
  return merged
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

function isLoopbackUrl(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

/**
 * 纯函数：由环境变量与可信 settings 解析出后端链配置。环境变量优先。
 */
export function resolveWebSearchConfig(
  env: Record<string, string | undefined>,
  settings: WebSearchSettings,
): ResolvedWebSearchConfig {
  const openserpUrl = (
    nonEmpty(env.ZY_OPENSERP_URL) ??
    settings.openserpUrl ??
    DEFAULT_OPENSERP_URL
  ).replace(/\/+$/, '')
  const hostedKey = nonEmpty(env.ZY_SEARCH_KEY) ?? settings.hostedKey
  const hostedUrlRaw =
    nonEmpty(env.ZY_SEARCH_URL) ?? settings.hostedUrl ?? DEFAULT_HOSTED_SEARCH_URL
  const result: ResolvedWebSearchConfig = { openserpUrl }
  if (hostedKey) {
    if (!hostedUrlRaw) {
      result.hostedMisconfigured =
        'ZY_SEARCH_KEY is set but no hosted search URL is configured (set ZY_SEARCH_URL).'
    } else {
      let parsed: URL | undefined
      try {
        parsed = new URL(hostedUrlRaw)
      } catch {
        result.hostedMisconfigured = 'ZY_SEARCH_URL is not a valid URL.'
      }
      if (parsed) {
        // key 只允许通过 https 发送（本机调试地址除外）
        if (
          parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && isLoopbackUrl(parsed))
        ) {
          result.hostedMisconfigured =
            'ZY_SEARCH_URL must use https:// (the key would otherwise be sent in clear text).'
        } else {
          result.hosted = { url: hostedUrlRaw.replace(/\/+$/, ''), key: hostedKey }
        }
      }
    }
  }
  return result
}

export function getWebSearchConfig(): ResolvedWebSearchConfig {
  return resolveWebSearchConfig(process.env, readTrustedWebSearchSettings())
}

// ---------------------------------------------------------------------------
// 工具函数

/** 把文本中出现的任何密钥替换掉，作为日志/错误信息的最后一道防线。 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('[REDACTED]')
    }
  }
  return out
}

/** 后端级失败：链会继续尝试下一个后端。 */
export class SearchBackendError extends Error {
  constructor(
    readonly backend: string,
    message: string,
  ) {
    super(message)
    this.name = 'SearchBackendError'
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

/**
 * 带指数退避的 fetch。仅当 Retry-After 不超过 maxRetryAfterSec 时才等待重试，
 * 避免把"今日额度用完"之类的长等待变成卡住的会话。
 */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { maxAttempts: number; timeoutMs: number; maxRetryAfterSec?: number; label: string },
): Promise<Response> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) })
    if (res.ok || !RETRYABLE.has(res.status) || attempt === opts.maxAttempts) {
      return res
    }

    const retryAfter = Number(res.headers.get('Retry-After') ?? 0)
    if (retryAfter > (opts.maxRetryAfterSec ?? 8)) {
      return res
    }
    const waitMs = retryAfter
      ? retryAfter * 1000
      : Math.min(2 ** attempt * 250, 8000) + Math.random() * 250
    logForDebugging(
      `[WebSearch] ${opts.label}: retry ${attempt}/${opts.maxAttempts} after ${res.status}, waiting ${waitMs.toFixed(0)}ms`,
    )
    await res.body?.cancel().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  throw new Error('Unexpected: retry loop exhausted without returning')
}

// ---------------------------------------------------------------------------
// OpenSERP（本地与托管网关共用同一协议）

/** OpenSerp 单条搜索结果结构 */
interface OpenSerpResult {
  title: string
  url: string
  snippet?: string
  domain?: string
}

/** OpenSerp /mega/search 响应结构 */
interface OpenSerpMegaResponse {
  query?: { text: string }
  meta?: {
    took_ms: number
    engines_failed?: string[]
  }
  results?: OpenSerpResult[]
}

/** 默认多引擎组合，按可用性与覆盖度排序（仅本地 OpenSERP；托管网关会强制自己的引擎列表） */
const MEGA_ENGINES = ['bing', 'baidu', 'ecosia', 'duck', 'google']

function openSerpParams(req: SearchRequest): URLSearchParams {
  const params = new URLSearchParams({
    text: req.query,
    limit: String(req.maxResults),
    engines: MEGA_ENGINES.join(','),
    mode: 'balanced',
    dedupe: 'true',
    merge: 'true',
    filter: 'true',
    features: 'false', // 只需普通搜索结果，不需要 SERP feature
  })
  if (req.date) {
    params.set('date', req.date)
  }
  return params
}

function mapOpenSerp(data: OpenSerpMegaResponse, backend: string): SearchResponseItem[] {
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0 && (data.meta?.engines_failed?.length ?? 0) > 0) {
    // 所有引擎都失败（验证码、限流等）：视为后端不可用，交给下一个后端
    throw new SearchBackendError(
      backend,
      `all engines failed (${data.meta!.engines_failed!.join(', ')})`,
    )
  }
  return results
    .filter((r) => r && typeof r.url === 'string')
    .map((r) => ({ title: r.title ?? r.url, url: r.url, content: r.snippet }))
}

async function readGatewayError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string }
    if (body?.message) {
      return `${res.status} ${body.error ?? ''}: ${body.message}`.replace(/\s+:/, ':')
    }
  } catch {
    // ignore
  }
  return `HTTP ${res.status}`
}

export async function searchLocalOpenSerp(
  req: SearchRequest,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<SearchResponseItem[]> {
  const label = 'local OpenSERP'
  let res: Response
  try {
    res = await fetchWithRetry(
      fetchImpl,
      `${baseUrl}/mega/search?${openSerpParams(req)}`,
      {},
      {
        maxAttempts: 4,
        timeoutMs: 30_000,
        label,
      },
    )
  } catch (error) {
    throw new SearchBackendError(label, `not reachable at ${baseUrl} (${errorMessage(error)})`)
  }
  if (!res.ok) {
    throw new SearchBackendError(label, `returned HTTP ${res.status}`)
  }
  return mapOpenSerp((await res.json()) as OpenSerpMegaResponse, label)
}

export async function searchHostedGateway(
  req: SearchRequest,
  hosted: { url: string; key: string },
  fetchImpl: typeof fetch,
): Promise<SearchResponseItem[]> {
  const label = 'hosted zy-search'
  // 网关强制引擎与模式，这里只发它接受的参数
  const params = new URLSearchParams({ text: req.query, limit: String(req.maxResults) })
  if (req.date) {
    params.set('date', req.date)
  }
  let res: Response
  try {
    res = await fetchWithRetry(
      fetchImpl,
      `${hosted.url}/mega/search?${params}`,
      { headers: { Authorization: `Bearer ${hosted.key}`, Accept: 'application/json' } },
      { maxAttempts: 2, timeoutMs: 40_000, maxRetryAfterSec: 5, label },
    )
  } catch (error) {
    throw new SearchBackendError(label, `not reachable (${errorMessage(error)})`)
  }
  if (!res.ok) {
    const detail = await readGatewayError(res)
    const hint =
      res.status === 401 ? ' (key unknown or revoked: log in again to get a new key)' : ''
    throw new SearchBackendError(label, `${detail}${hint}`)
  }
  return mapOpenSerp((await res.json()) as OpenSerpMegaResponse, label)
}

// ---------------------------------------------------------------------------
// 后端链

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SearchChainResult {
  items: SearchResponseItem[]
  backend: string
}

/**
 * 依次尝试已配置的后端，返回第一个成功的结果。全部失败时抛出包含每个后端
 * 失败原因与配置建议的错误。
 */
export async function runSearchChain(
  req: SearchRequest,
  config: ResolvedWebSearchConfig = getWebSearchConfig(),
  fetchImpl: typeof fetch = fetch,
  log: (message: string) => void = logForDebugging,
): Promise<SearchChainResult> {
  const secrets = [config.hosted?.key]
  const attempts: Array<{ name: string; run: () => Promise<SearchResponseItem[]> }> = [
    { name: 'local OpenSERP', run: () => searchLocalOpenSerp(req, config.openserpUrl, fetchImpl) },
  ]
  if (config.hosted) {
    const hosted = config.hosted
    attempts.push({
      name: 'hosted zy-search',
      run: () => searchHostedGateway(req, hosted, fetchImpl),
    })
  }

  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      const items = (await attempt.run()).slice(0, req.maxResults)
      if (failures.length) {
        log(`[WebSearch] served by ${attempt.name} after fallback`)
      }
      return { items, backend: attempt.name }
    } catch (error) {
      const msg = redactSecrets(errorMessage(error), secrets)
      const line =
        error instanceof SearchBackendError ? `${error.backend}: ${msg}` : `${attempt.name}: ${msg}`
      failures.push(line)
      log(`[WebSearch] ${line}`)
    }
  }

  const hints: string[] = [
    `Start a self-hosted OpenSERP at ${config.openserpUrl} or point ZY_OPENSERP_URL at yours.`,
  ]
  if (config.hostedMisconfigured) {
    hints.push(config.hostedMisconfigured)
  }
  if (!config.hosted && !config.hostedMisconfigured) {
    hints.push('Your hosted gateway is not configured (set ZY_SEARCH_URL and ZY_SEARCH_KEY).')
  }
  hints.push(DUCKDUCKGO_HINT)
  throw new Error(`No web search backend is available. ${failures.join('; ')}. ${hints.join(' ')}`)
}
