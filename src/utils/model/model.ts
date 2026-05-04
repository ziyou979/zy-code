import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { tSync } from '../../i18n/index.js'
import { isModelAllowed } from './modelAllowlist.js'
import type { ModelAlias } from './aliases.js'

export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/** 基于层级划分不同能力的模型 */
type ModelTier = 'advanced' | 'standard' | 'compact'

/**
 * 从 settings.models 中读取指定 tier 的模型。
 * 未配置时回退到 standard tier。
 * standard 也未配置则抛错引导用户配置。
 */
function getModelByTier(tier: ModelTier): ModelName {
  const settings = getSettings_DEPRECATED() || {}
  const tierModel = settings.models?.[tier]
  if (tierModel) return tierModel
  // 其他层级未配置时使用 standard
  if (tier !== 'standard') {
    const standard = settings.models?.standard
    if (standard) return standard
  }
  throw new Error(tSync('settings.missingStandardModel'))
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
 * 3. models.standard from settings
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

/** 获取 advanced 能力层级的默认模型 */
export function getDefaultAdvancedModel(): ModelName {
  return getModelByTier('advanced')
}

/** 获取 standard 能力层级的默认模型 */
export function getDefaultStandardModel(): ModelName {
  return getModelByTier('standard')
}

/** 获取 compact 能力层级的默认模型 */
export function getDefaultCompactModel(): ModelName {
  return getModelByTier('compact')
}

/**
 * Get the default main loop model setting.
 * 从 settings.mainLoopModel 读取 tier 名（advanced/standard/compact），
 * 再解析到实际模型。默认为 standard。
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  const settings = getSettings_DEPRECATED()
  const tier = settings?.mainLoopModel ?? 'standard'
  return getModelByTier(tier)
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

export function renderDefaultModelSetting(setting: ModelName | ModelAlias): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      (m) => m.alias === setting || m.model === setting,
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
      (m) => m.model === model || m.model + '[1m]' === model,
    )
    if (customModel) {
      const has1m = model.toLowerCase().includes('[1m]')
      return (customModel.label ?? customModel.alias) + (has1m ? ' (1M context)' : '')
    }
  }
  return null
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  return publicName ?? model
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
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  // 直接解析 tier 别名到对应模型
  if (normalizedModel === 'advanced') return getModelByTier('advanced')
  if (normalizedModel === 'standard') return getModelByTier('standard')
  if (normalizedModel === 'compact') return getModelByTier('compact')

  // Resolve custom model aliases from settings
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find((m) => m.alias.toLowerCase() === normalizedModel)
    if (customModel) {
      return customModel.model
    }
  }

  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model.
 * Skill authors can specify a tier alias (e.g., `model: advanced`) which gets
 * resolved to the actual model name.
 */
export function resolveSkillModelOverride(skillModel: string, currentModel: string): string {
  // 上下文窗口统一通过 model-capabilities.json 中的 contextWindow 配置管理，
  // skill 指定的模型会使用其自身配置的 contextWindow，无需后缀传递
  return skillModel
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

export function getMarketingNameForModel(modelId: string): string | undefined {
  const settings = getSettings_DEPRECATED() || {}
  if (settings.customModels && settings.customModels.length > 0) {
    const customModel = settings.customModels.find(
      (m) => m.model === modelId.replace(/\[1m\]$/i, ''),
    )
    if (customModel) {
      const has1m = modelId.toLowerCase().includes('[1m]')
      return customModel.label ?? (has1m ? `${customModel.alias} (1M context)` : customModel.alias)
    }
  }
  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
