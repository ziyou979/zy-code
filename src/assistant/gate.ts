/**
 * KAIROS 功能门控模块
 *
 * 控制 KAIROS assistant mode 是否启用。通过以下优先级判断：
 * 1. 环境变量 ZY_CODE_KAIROS_ENABLED（若设为 true/false，直接采用）
 * 2. 设置文件中的 kairosEnabled 配置项
 * 3. 若 --assistant CLI 标志被设置，强制启用（走 markAssistantForced 路径）
 */

import { getInitialSettings } from '../utils/settings/settings.js'

let _kairosEnabled: boolean | null = null
let _initialized = false

/**
 * 检查 KAIROS 是否启用（异步，内部缓存结果）。
 * 由 main.tsx 在信任检查通过后调用。
 */
export async function isKairosEnabled(): Promise<boolean> {
  if (_kairosEnabled !== null) return _kairosEnabled

  // 优先读取环境变量
  const env = process.env.ZY_CODE_KAIROS_ENABLED
  if (env !== undefined) {
    _kairosEnabled = env === 'true' || env === '1'
    return _kairosEnabled
  }

  // 读取设置文件
  try {
    const settings = getInitialSettings()
    if (settings?.kairosEnabled !== undefined) {
      _kairosEnabled = settings.kairosEnabled === true
      return _kairosEnabled
    }
  } catch {
    // 设置不可用时跳过
  }

  // 默认启用（若 feature flag 已编译进来，说明用户有意启用）
  _kairosEnabled = true
  return _kairosEnabled
}

/**
 * 检查指定子功能是否允许通过门控。
 * @param featureName - 子功能名称
 */
export function checkGate(featureName: string): boolean {
  // 简单实现：所有子功能均通过（只要 KAIROS 主门控已启用）
  // 后续可按需细化（如根据 GrowthBook flag 或 settings 控制子功能）
  if (_kairosEnabled === null) return false
  return _kairosEnabled
}

/**
 * 初始化 KAIROS 门控模块。
 * 在应用启动时调用，重置缓存状态。
 */
export function initializeKairosGate(): void {
  _kairosEnabled = null
  _initialized = true
}
