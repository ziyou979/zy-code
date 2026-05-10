/**
 * 搜索服务类型定义。
 *
 * WebSearchTool 使用独立搜索 provider 返回可验证链接，
 * 避免依赖模型 provider 的服务端联网搜索可观测性。
 */

/** 单条搜索结果 */
export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

/** 搜索请求选项 */
export interface SearchOptions {
  /** 只允许来自这些域名的结果 */
  allowedDomains?: string[]
  /** 阻止来自这些域名的结果 */
  blockedDomains?: string[]
  /** 最大结果数量 */
  maxResults?: number
}

/** 搜索 provider 接口 — 本地兜底方案实现此接口 */
export interface SearchProvider {
  /** Provider 唯一标识符 */
  readonly id: string

  /**
   * 执行搜索查询。
   * @param query 搜索关键词
   * @param options 搜索选项（域过滤、结果数量等）
   * @returns 搜索结果列表
   */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
}
