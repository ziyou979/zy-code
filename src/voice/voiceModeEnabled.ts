import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/**
 * 检查语音模式的 kill switch。除非 GrowthBook flag `zy_amber_quartz_disabled`
 * 已开启（紧急关闭），否则返回 true。默认值 false 表示磁盘缓存缺失或过期时视为
 * “未关闭”，使新安装无需等待 GrowthBook 初始化即可使用语音。用于判断语音模式是否
 * 应当可见，例如命令注册和配置 UI。
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // 使用正向三元表达式模式，参见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）无法从外部构建中消除内联字符串字面量。
  return feature('VOICE_MODE')
    ? !getFeatureValue_CACHED_MAY_BE_STALE('zy_amber_quartz_disabled', false)
    : false
}

/**
 * 只检查语音模式认证状态。用户拥有有效 OAuth token 时返回 true。
 * 底层使用记忆化的 getZyAIOAuthTokens：macOS 首次调用会启动 `security`
 *（约 20～50ms），后续调用命中缓存。token 刷新时（约每小时一次）会清除缓存，
 * 因此每次刷新预计有一次冷启动，成本足以满足使用时检查。
 */
export function hasVoiceAuth(): boolean {
  // 国内不可用语音模式，始终返回 false
  return false
}

/**
 * 完整运行时检查：认证 + GrowthBook kill switch。调用方包括 `/voice`
 *（voice.ts、voice/index.ts）、ConfigTool、VoiceModeNotice；这些命令执行路径可接受
 * 重新读取 keychain。React 渲染路径应改用会缓存认证结果的 useVoiceEnabled()。
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}
