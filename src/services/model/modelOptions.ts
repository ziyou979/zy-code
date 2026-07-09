import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { tSync } from '../../i18n/index.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getLocalModelCapability } from '../../utils/settings/localModelCapabilities.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getProviderForModel,
  getUserSpecifiedModelSetting,
  type ModelSetting,
  type ModelReferenceInput,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(): ModelOption {
  return {
    value: null,
    label: tSync('modelOption.defaultRecommended'),
    description: tSync('modelOption.useDefault', {
      model: renderDefaultModelSetting(getDefaultMainLoopModelSetting() ?? ''),
    }),
  }
}

/**
 * 为指定 tier 构建模型选项。
 * 从 settings.json 的 models tier 映射读取实际模型 ID，
 * label 从 model-capabilities.json 的 pattern 获取（或直接用模型 ID）。
 */
function getTierOption(tier: string): ModelOption | undefined {
  const settings = getInitialSettings()
  const providerSettings = settings.providers?.[getAPIProvider()]
  const tierModel = providerSettings?.models?.[tier] ?? settings?.models?.[tier]
  if (!tierModel) {
    return undefined
  }
  const resolvedModel = resolveModelReferenceModel(tierModel)
  if (!resolvedModel) {
    return undefined
  }

  const cap = getLocalModelCapability(resolvedModel)
  const provider = getProviderForModel(resolvedModel)

  return {
    value: tier,
    label: cap?.pattern ?? resolvedModel,
    description: `${provider} · ${resolvedModel}`,
    descriptionForModel: `${provider} · ${resolvedModel}`,
  }
}

function resolveModelReferenceModel(value: ModelReferenceInput): string | undefined {
  return typeof value === 'string' ? value : value.model
}

function getStandardOption(): ModelOption {
  return (
    getTierOption('standard') ?? {
      value: 'standard',
      label: tSync('modelOption.standard'),
      description: tSync('modelOption.standardDesc'),
      descriptionForModel: tSync('modelOption.standardDescForModel'),
    }
  )
}

function getAdvancedOption(): ModelOption {
  return (
    getTierOption('advanced') ?? {
      value: 'advanced',
      label: tSync('modelOption.advanced'),
      description: tSync('modelOption.advancedDesc'),
      descriptionForModel: tSync('modelOption.advancedDescForModel'),
    }
  )
}

function getCompactOption(): ModelOption {
  return (
    getTierOption('compact') ?? {
      value: 'compact',
      label: tSync('modelOption.compact'),
      description: tSync('modelOption.compactDesc'),
      descriptionForModel: tSync('modelOption.compactDescForModel'),
    }
  )
}

function getModelOptionsBase(): ModelOption[] {
  // 自定义模型优先：完全替换内置 tier 选项
  const settings = getInitialSettings() || {}
  const customModels = settings.providers?.[getAPIProvider()]?.customModels ?? settings.customModels
  if (customModels && customModels.length > 0) {
    const customModelOptions: ModelOption[] = customModels.map((m) => ({
      value: m.alias,
      label: m.label ?? m.alias,
      description:
        m.description ??
        tSync('modelOption.customModelDesc', {
          model: `${m.provider ?? getProviderForModel(m.model)} · ${m.model}`,
        }),
    }))
    return [getDefaultOptionForUser(), ...customModelOptions]
  }

  // 外部用户：Default + 三个 tier
  return [getDefaultOptionForUser(), getStandardOption(), getAdvancedOption(), getCompactOption()]
}

/**
 * Returns a ModelOption for a known model with a human-readable label.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) {
    return null
  }
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(): ModelOption[] {
  const options = getModelOptionsBase()

  // 通过环境变量注入的自定义模型选项
  const envCustomModel = process.env.ZY_CODE_CUSTOM_MODEL_OPTION
  if (envCustomModel && !options.some((existing) => existing.value === envCustomModel)) {
    options.push({
      value: envCustomModel,
      label: process.env.ZY_CODE_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ZY_CODE_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        tSync('modelOption.customModelDesc', { model: envCustomModel }),
    })
  }

  // bootstrap 期间获取的额外模型选项
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some((existing) => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // 确保当前使用的模型出现在选项列表中
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel !== null && !options.some((opt) => opt.value === customModel)) {
    const resolvedCustomModel = parseUserSpecifiedModel(customModel)
    const knownOption = getKnownModelOption(resolvedCustomModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: tSync('modelOption.customModel'),
      })
    }
  }

  return filterModelOptionsByAllowlist(options)
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getInitialSettings() || {}
  if (!settings.availableModels) {
    return options
  }
  return options.filter(
    (opt) => opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
