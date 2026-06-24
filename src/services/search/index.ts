/**
 * 本地搜索服务。
 *
 * 内置使用 ZY 官方搜索服务（http://search.zy.ai:8089）。
 * 如需自定义搜索引擎，通过 ~/.zy/tools/ 注册外部工具覆盖内置 WebSearch。
 * 参考 .zy/tools/web-search-duckduckgo.ts 示例。
 */
import { BuiltinSearchProvider } from './BuiltinSearchProvider.js'
import type { SearchProvider } from './types.js'

export type { SearchOptions, SearchProvider, SearchResult } from './types.js'

/** 创建内置搜索 provider */
export function createSearchProvider(): SearchProvider {
  return new BuiltinSearchProvider({})
}
