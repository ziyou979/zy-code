/** 搜索选项 */
export interface SearchOptions {
  /** 最大返回结果数 */
  maxResults?: number
  /** 限定域名列表 */
  allowedDomains?: string[]
  /** 屏蔽域名列表 */
  blockedDomains?: string[]
}

/** 单条搜索结果 */
export interface SearchResult {
  /** 结果标题 */
  title: string
  /** 结果 URL */
  url: string
  /** 结果摘要片段 */
  snippet?: string
}

/** 搜索 provider 接口 */
export interface SearchProvider {
  /** provider 标识 */
  readonly id: string
  /** 执行搜索 */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
}
