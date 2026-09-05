import type { SettingsJson } from './types.js'

export type OnboardingTierModels = {
  standard: string
  advanced?: string
  compact?: string
}

/**
 * 将 onboarding 的模型选择绑定到刚创建的认证连接。
 * 连接 id 与底层 provider 分离，因此这里不能只保存裸模型字符串。
 */
export function buildOnboardingModels(
  connectionId: string,
  tierModels: OnboardingTierModels,
): NonNullable<SettingsJson['models']> {
  const models: NonNullable<SettingsJson['models']> = {
    standard: { provider: connectionId, model: tierModels.standard },
  }
  if (tierModels.advanced) {
    models.advanced = { provider: connectionId, model: tierModels.advanced }
  }
  if (tierModels.compact) {
    models.compact = { provider: connectionId, model: tierModels.compact }
  }
  return models
}
