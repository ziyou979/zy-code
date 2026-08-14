let officialUrls: Set<string> | undefined

/**
 * 以 fire-and-forget 方式获取官方 MCP registry，并填充 officialUrls 供
 * isOfficialMcpUrl 查询。
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  if (process.env.ZY_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return
  }

  // 使用国内可访问的地址，或跳过官方注册表预取（非关键功能）
}

/**
 * 仅当给定 URL 已通过 getLoggingSafeMcpBaseUrl 规范化且存在于官方 MCP registry 中时返回
 * true。registry 未定义时返回 false，按关闭策略处理。
 */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls = undefined
}
