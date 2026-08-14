/**
 * 通过发现 skill:// resource，为指定 client 获取 MCP skill。
 * 这是供外部 build 使用的占位实现。
 */
export async function fetchMcpSkillsForClient(_client: unknown): Promise<unknown[]> {
  // 占位逻辑：在外部 build 中返回空数组
  return []
}

// 添加 cache 属性以匹配预期接口
fetchMcpSkillsForClient.cache = new Map()
