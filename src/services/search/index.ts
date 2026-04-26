/**
 * 本地搜索服务 — 兜底方案。
 *
 * 当 provider 没有原生 web_search 能力时（非 dashscope/openai），
 * 回退到 DuckDuckGo Lite HTML 抓取，零配置、无需 API Key。
 */
import type { SearchProvider, SearchOptions } from './types.js'
import { DuckDuckGoProvider } from './DuckDuckGoProvider.js'

export type { SearchProvider, SearchResult, SearchOptions } from './types.js'

/**
 * 创建兜底 SearchProvider。
 * 目前只保留 DuckDuckGo 作为本地回退，
 * dashscope / openai 走各自的 API 原生搜索。
 */
export function createFallbackSearchProvider(options?: { region?: string }): SearchProvider {
  return new DuckDuckGoProvider({ region: options?.region })
}
