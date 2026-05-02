/**
 * 1M 上下文权限检查。
 * 现在上下文窗口统一通过 model-capabilities.json 的 contextWindow 配置管理，
 * 这些函数保留仅为兼容旧的调用方，始终返回 false。
 */

export function checkOpus1mAccess(): boolean {
  return false
}

export function checkSonnet1mAccess(): boolean {
  return false
}
