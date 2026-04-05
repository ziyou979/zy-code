// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isZyAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getGlobalConfig } from '../config.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider } from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/** Tier-based model resolution: best > advanced > standard > compact > defaultModel */
type ModelTier = 'best' | 'advanced' | 'standard' | 'compact'

function getModelByTier(tier: ModelTier): ModelName {
  const settings = getSettings_DEPRECATED() || {}
  // 1. Tier-specific model
  if (settings.models?.[tier]) {
    return settings.models[tier]
  }
  // 2. Global default
  if (settings.defaultModel) {
    return settings.defaultModel
  }
  // 3. Built-in fallbacks (Zy defaults for users without custom config)
  switch (tier) {
    case 'best':
    case 'advanced':
      return getModelStrings().opus46
    case 'standard':
      return getModelStrings().sonnet46
    case 'compact':
      return getModelStrings().haiku45
  }
}

export function getSmallFastModel(): ModelName {
  return getModelByTier('compact')
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag,
 * or the saved settings.
 *
 * Priority:
 * 1. Model override during session (from /model command)
 * 2. Model override at startup (from --model flag)
 * 3. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = settings.model || undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Priority:
 * 1. Model override during session (from /model command)
 * 2. Model override at startup (from --model flag)
 * 3. Settings (from user's saved settings)
 * 4. Built-in default (from defaultModel in settings)
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getModelByTier('best')
}

// Maps legacy Zy aliases to capability tiers
const ALIAS_TO_TIER: Record<string, ModelTier> = {
  opus: 'advanced',
  sonnet: 'standard',
  haiku: 'compact',
  best: 'best',
}

export function getDefaultOpusModel(): ModelName {
  return getModelByTier('advanced')
}

export function getDefaultSonnetModel(): ModelName {
  return getModelByTier('standard')
}

export function getDefaultHaikuModel(): ModelName {
  return getModelByTier('compact')
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan: advanced tier in plan mode
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getModelByTier('advanced')
  }

  // haiku → standard tier in plan mode
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getModelByTier('standard')
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * Priority for settings-configured users: mainLoopModel → defaultModel → models.standard.
 * For Zy subscription users: Opus for Max/Team Premium, Sonnet for others.
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  const settings = getSettings_DEPRECATED()
  // Non-subscription users: use mainLoopModel → defaultModel → models.standard → built-in fallback
  if (settings?.mainLoopModel) {
    return settings.mainLoopModel
  }
  if (settings?.defaultModel || settings?.models) {
    return getModelByTier('standard')
  }

  // Check onboarding-configured model (configuredModel from globalConfig)
  const config = getGlobalConfig()
  if (config.configuredModel) {
    return config.configuredModel
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
export function canonicalNameToShort(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Zy 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('zy-opus-4-6')) {
    return 'zy-opus-4-6'
  }
  if (name.includes('zy-opus-4-5')) {
    return 'zy-opus-4-5'
  }
  if (name.includes('zy-opus-4-1')) {
    return 'zy-opus-4-1'
  }
  if (name.includes('zy-opus-4')) {
    return 'zy-opus-4'
  }
  if (name.includes('zy-sonnet-4-6')) {
    return 'zy-sonnet-4-6'
  }
  if (name.includes('zy-sonnet-4-5')) {
    return 'zy-sonnet-4-5'
  }
  if (name.includes('zy-sonnet-4')) {
    return 'zy-sonnet-4'
  }
  if (name.includes('zy-haiku-4-5')) {
    return 'zy-haiku-4-5'
  }
  // Zy 3.x models use a different naming scheme (zy-3-{family})
  if (name.includes('zy-3-7-sonnet')) {
    return 'zy-3-7-sonnet'
  }
  if (name.includes('zy-3-5-sonnet')) {
    return 'zy-3-5-sonnet'
  }
  if (name.includes('zy-3-5-haiku')) {
    return 'zy-3-5-haiku'
  }
  if (name.includes('zy-3-opus')) {
    return 'zy-3-opus'
  }
  if (name.includes('zy-3-sonnet')) {
    return 'zy-3-sonnet'
  }
  if (name.includes('zy-3-haiku')) {
    return 'zy-3-haiku'
  }
  // Qwen models
  if (name.includes('qwen3.6-plus')) {
    return 'qwen3.6-plus'
  }
  const match = name.match(/(zy-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'zy-3-5-haiku-20241022' and 'us.anthropic.zy-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'zy-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'zy-3-5-haiku-20241022')
 * @returns The short name (e.g., 'zy-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a canonical-format ID, so canonicalNameToShort can handle it.
  return canonicalNameToShort(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getZyAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.6 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.6 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.6 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'anthropic') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'anthropic'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isZyAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  // Check custom models for display label
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      m => m.alias === setting || m.model === setting,
    )
    if (customModel) {
      return customModel.label ?? customModel.alias
    }
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  // Check custom models first
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      m => m.model === model || m.model + '[1m]' === model,
    )
    if (customModel) {
      const has1m = model.toLowerCase().includes('[1m]')
      return (customModel.label ?? customModel.alias) + (has1m ? ' (1M context)' : '')
    }
  }

  switch (model) {
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  // For non-Anthropic providers, show the actual model string instead of
  // mapping to Zy marketing names (e.g. qwen3.6-plus should not show as "Opus 4.6")
  if (getAPIProvider() !== 'anthropic') {
    return model
  }
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Zy {ModelName}" for publicly known models, or "Zy ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Zy {ModelName}" for public models, or "Zy ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `ZY ${publicName}`
  }
  return `ZY (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    const tier = ALIAS_TO_TIER[modelString]
    if (tier) {
      return getModelByTier(tier) + (has1mTag ? '[1m]' : '')
    }
    // opusplan: use advanced tier in plan mode, standard otherwise
    if (modelString === 'opusplan') {
      return getModelByTier('standard') + (has1mTag ? '[1m]' : '')
    }
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Zy.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'anthropic' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Resolve custom model aliases from settings
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      m => m.alias.toLowerCase() === modelString,
    )
    if (customModel) {
      return customModel.model + (has1mTag ? '[1m]' : '')
    }
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M checks settings and raw model name. Resolve alias first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'zy-opus-4-20250514',
  'zy-opus-4-1-20250805',
  'zy-opus-4-0',
  'zy-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.ZY_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isZyAISubscriber()) {
      return `Default (${getZyAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  // Check custom models first
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      m => m.model === modelId.replace(/\[1m\]$/i, ''),
    )
    if (customModel) {
      const has1m = modelId.toLowerCase().includes('[1m]')
      return customModel.label ?? (has1m ? `${customModel.alias} (1M context)` : customModel.alias)
    }
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const m = modelId.toLowerCase()

  if (m.includes('zy-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (m.includes('zy-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (m.includes('zy-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (m.includes('zy-opus-4')) {
    return 'Opus 4'
  }
  if (m.includes('zy-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (m.includes('zy-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (m.includes('zy-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (m.includes('zy-3-7-sonnet')) {
    return 'Zy 3.7 Sonnet'
  }
  if (m.includes('zy-3-5-sonnet')) {
    return 'Zy 3.5 Sonnet'
  }
  if (m.includes('zy-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (m.includes('zy-3-5-haiku')) {
    return 'Zy 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
