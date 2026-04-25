/**
 * 1M 上下文升级提示。
 * 现在上下文窗口统一通过 model-capabilities.json 的 contextWindow 配置管理，
 * 此文件保留仅为兼容旧的调用方，始终返回 null。
 */
export function getUpgradeMessage(_context: 'warning' | 'tip'): string | null {
  return null
}
