import { getIsNonInteractiveSession } from '../../bootstrap/runtime/runtimeContext.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getInitialSettings } from '../settings/settings.js'
import { isAgentSwarmsEnabled } from '../swarm/agentSwarmsEnabled.js'

export function shouldEnablePromptSuggestion(): boolean {
  const envOverride = process.env.ZY_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) {
    logEvent('zy_prompt_suggestion_init', {
      enabled: false,
      source: 'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  if (isEnvTruthy(envOverride)) {
    logEvent('zy_prompt_suggestion_init', {
      enabled: true,
      source: 'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return true
  }

  // 与 Config.tsx 中设置开关的可见性保持一致。
  if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_chomp_inflection', false)) {
    logEvent('zy_prompt_suggestion_init', {
      enabled: false,
      source: 'growthbook' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  if (getIsNonInteractiveSession()) {
    logEvent('zy_prompt_suggestion_init', {
      enabled: false,
      source: 'non_interactive' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // swarm 中只有 leader 展示建议，避免队友各自触发生成。
  if (isAgentSwarmsEnabled() && isTeammate()) {
    logEvent('zy_prompt_suggestion_init', {
      enabled: false,
      source: 'swarm_teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  const enabled = getInitialSettings()?.promptSuggestionEnabled !== false
  logEvent('zy_prompt_suggestion_init', {
    enabled,
    source: 'setting' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return enabled
}
