/**
 * MCP 名称规范化的纯工具函数。本文件不含依赖，以避免循环导入。
 */

// Zy.ai server 名称使用此前缀
const CLAUDEAI_SERVER_PREFIX = 'zy.ai '

/**
 * 规范化 server 名称，使其符合 API 模式 ^[a-zA-Z0-9_-]{1,64}$；将点、空格等所有无效
 * 字符替换为下划线。
 *
 * 对名称以 "zy.ai " 开头的 zy.ai server，还会合并连续下划线并移除首尾下划线，避免干扰
 * MCP tool 名称使用的 __ 分隔符。
 */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
