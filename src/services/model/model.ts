import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { ModelAlias } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'

export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/** 基于层级划分不同能力的模型 */
type ModelTier = 'advanced' | 'standard' | 'compact'

function getProviderSettings(settings: ReturnType<typeof getInitialSettings>) {
  return settings.providers?.[getAPIProvider()]
}

/**
 * 从 settings.models 中读取指定 tier 的模型。
 * 未配置时回退到 standard tier。
 * standard 也未配置则返回 undefined，由调用方处理（如引导用户进入 onboarding 配置）。
 */
function getModelByTier(tier: ModelTier): ModelName | undefined {
  const settings = getInitialSettings() || {}
  const providerSettings = getProviderSettings(settings)
  const tierModel = providerSettings?.models?.[tier] ?? settings.models?.[tier]
  if (tierModel) {
    return tierModel
  }
  // 其他层级未配置时使用 standard
  if (tier !== 'standard') {
    const standard = providerSettings?.models?.standard ?? settings.models?.standard
    if (standard) {
      return standard
    }
  }
  return undefined
}

/**
 * 获取用户指定的模型设置，来源包括 /model 命令（含 /config）、--model 启动参数或已保存的配置。
 *
 * 优先级：
 * 1. 会话中通过 /model 命令覆盖的模型
 * 2. 启动时通过 --model 参数覆盖的模型
 * 3. 用户已保存的 settings 配置
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getInitialSettings() || {}
    specifiedModel = getProviderSettings(settings)?.model || settings.model || undefined
  }

  // 如果用户指定的模型不在 availableModels 白名单中，则忽略
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * 获取当前会话使用的主循环模型。
 *
 * 优先级：
 * 1. 会话中通过 /model 命令覆盖的模型
 * 2. 启动时通过 --model 参数覆盖的模型
 * 3. settings 中的 models.standard 配置
 */
export function getMainLoopModel(): ModelName | undefined {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

/** 获取 advanced 能力层级的默认模型 */
export function getDefaultAdvancedModel(): ModelName | undefined {
  return getModelByTier('advanced')
}

/** 获取 standard 能力层级的默认模型 */
export function getDefaultStandardModel(): ModelName | undefined {
  return getModelByTier('standard')
}

/** 获取 compact 能力层级的默认模型 */
export function getDefaultCompactModel(): ModelName | undefined {
  return getModelByTier('compact')
}

/**
 * 获取默认的主循环模型设置。
 * 从 settings.mainLoopModel 读取 tier 名（advanced/standard/compact），
 * 再解析到实际模型。默认为 standard。
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias | undefined {
  const settings = getInitialSettings()
  const tier = getProviderSettings(settings)?.mainLoopModel ?? settings?.mainLoopModel ?? 'standard'
  return getModelByTier(tier)
}

/**
 * 同步获取默认的主循环模型（跳过用户指定的值）。
 * 未配置时返回 undefined。
 */
export function getDefaultMainLoopModel(): ModelName | undefined {
  const setting = getDefaultMainLoopModelSetting()
  if (!setting) {
    return undefined
  }
  return parseUserSpecifiedModel(setting)
}

export function renderDefaultModelSetting(setting: ModelName | ModelAlias): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  const settings = getInitialSettings() || {}
  const customModels = getProviderSettings(settings)?.customModels ?? settings.customModels
  if (customModels && customModels.length > 0) {
    const customModel = customModels.find((m) => m.alias === setting || m.model === setting)
    if (customModel) {
      return customModel.label ?? customModel.alias
    }
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: 为新模型添加显示名称映射（包括基础模型和 [1m] 变体，如适用）。
/**
 * 返回已知公开模型的可读显示名称，如果模型不是已知的公开模型则返回 null。
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  // 优先检查自定义模型
  const settings = getInitialSettings() || {}
  const customModels = getProviderSettings(settings)?.customModels ?? settings.customModels
  if (customModels && customModels.length > 0) {
    const customModel = customModels.find((m) => m.model === model || `${m.model}[1m]` === model)
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
 * 返回适合公开展示的作者名称（例如用于 git commit 尾部标记）。
 * 对已知公开模型返回 "Zy {ModelName}"，对未知/内部模型返回 "Zy ({model})"
 * 以保留完整的模型名称。
 *
 * @param model 完整的模型名称
 * @returns 公开模型返回 "Zy {ModelName}"，非公开模型返回 "Zy ({model})"
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `ZY ${publicName}`
  }
  return `ZY (${model})`
}

/**
 * 返回当前会话使用的完整模型名称，可能经过别名解析。
 *
 * @param modelInput 用户提供的模型别名或名称。
 */
export function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  // 直接解析 tier 别名到对应模型
  if (normalizedModel === 'advanced') {
    return getModelByTier('advanced') ?? modelInputTrimmed
  }
  if (normalizedModel === 'standard') {
    return getModelByTier('standard') ?? modelInputTrimmed
  }
  if (normalizedModel === 'compact') {
    return getModelByTier('compact') ?? modelInputTrimmed
  }

  // 从 settings 中解析自定义模型别名
  const settings = getInitialSettings() || {}
  const customModels = getProviderSettings(settings)?.customModels ?? settings.customModels
  if (customModels && customModels.length > 0) {
    const customModel = customModels.find((m) => m.alias.toLowerCase() === normalizedModel)
    if (customModel) {
      return customModel.model
    }
  }

  return modelInputTrimmed
}

/**
 * 将 skill 的 `model:` frontmatter 解析为实际模型。
 * Skill 作者可以指定 tier 别名（例如 `model: advanced`），
 * 会被解析为对应的实际模型名称。
 */
export function resolveSkillModelOverride(skillModel: string, _currentModel: string): string {
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
  const settings = getInitialSettings() || {}
  const customModels = getProviderSettings(settings)?.customModels ?? settings.customModels
  if (customModels && customModels.length > 0) {
    const customModel = customModels.find((m) => m.model === modelId.replace(/\[1m\]$/i, ''))
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
