export type LoginSetupState = 'api_key_setup' | 'platform_setup'

/** 将本地配置入口映射到各自页面，避免菜单新增或调整时再次错误复用状态。 */
export function resolveLoginSetupState(value: string): LoginSetupState | null {
  if (value === 'apikey') {
    return 'api_key_setup'
  }
  if (value === 'platform') {
    return 'platform_setup'
  }
  return null
}
