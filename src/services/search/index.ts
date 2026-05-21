/**
 * 本地搜索服务。
 *
 * WebSearchTool 统一使用本地/外部搜索 provider 返回可验证链接，
 * 不依赖模型 provider 的服务端联网搜索能力。
 */
import { getUiLanguage } from '../../i18n/index.js'
import { DuckDuckGoProvider } from './DuckDuckGoProvider.js'
import type { SearchProvider } from './types.js'

export type { SearchOptions, SearchProvider, SearchResult } from './types.js'

export function getDuckDuckGoRegionForUiLanguage(language = getUiLanguage()): string {
  switch (language) {
    case 'zh-CN':
      return 'cn-zh'
    default:
      return 'us-en'
  }
}

/**
 * 创建 SearchProvider。
 * 目前使用 DuckDuckGo Lite HTML 抓取作为零配置搜索实现。
 */
export function createFallbackSearchProvider(options?: { region?: string }): SearchProvider {
  const region = options?.region ?? getDuckDuckGoRegionForUiLanguage()
  return new DuckDuckGoProvider({ region })
}
