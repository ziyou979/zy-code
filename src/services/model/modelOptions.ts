import { getInitialMainLoopModel } from '../../bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { getGlobalConfig } from '../config/config.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getModelCandidatesForTier,
  getProviderForModel,
  getUserSpecifiedModelSetting,
  type ModelTier,
  type ModelSetting,
  parseUserSpecifiedModel,
  pinModelCandidate,
  type ResolvedModelReference,
  renderDefaultModelSetting,
  selectActiveCandidate,
} from './model.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'

export type ModelOption = {
  value: ModelSetting
  /** Select 内部使用的唯一值；候选模型仍向调用方返回所属 tier。 */
  pickerValue?: string
  label: string
  description: string
  descriptionForModel?: string
  candidateSelection?: {
    tier: ModelTier
    candidate: ResolvedModelReference
  }
}

const MODEL_CANDIDATE_PICKER_PREFIX = '__zy_model_candidate__'

function getConfiguredModelLabel(model: string): string {
  // 延迟加载模型能力，避免仅导入 modelOptions 就提前冻结本地能力缓存。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLocalModelCapability } =
    require('../settings/localModelCapabilities.js') as typeof import('../settings/localModelCapabilities.js')
  return getLocalModelCapability(model)?.pattern ?? model
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
function getTierLabel(tier: ModelTier): string {
  return tSync(`modelOption.${tier}`)
}

/**
 * 将一个档位的全部候选展开为可主动选择的选项。
 * 当前 sticky 候选继续使用 tier 作为 picker value，确保重新打开时能正确聚焦；
 * 其余候选使用内部唯一值，选中后仍将 tier 写入会话状态。
 */
export function createTierCandidateOptions(
  tier: ModelTier,
  candidates: ResolvedModelReference[],
  active: ResolvedModelReference,
  getModelLabel: (model: string) => string = getConfiguredModelLabel,
): ModelOption[] {
  return candidates.map((candidate, index) => {
    const resolvedModel = candidate.model
    // 命名连接是用户在 auth.json 中认知的名称，应优先于底层 generic。
    const provider =
      candidate.authProfile ?? candidate.provider ?? getProviderForModel(resolvedModel)
    const isActive =
      candidate.model === active.model &&
      candidate.provider === active.provider &&
      index === (active.candidateIndex ?? 0)
    const position = tSync('modelOption.candidatePosition', {
      current: index + 1,
      total: candidates.length,
    })
    const activeHint = isActive ? ` · ${tSync('modelOption.activeCandidate')}` : ''

    return {
      value: tier,
      pickerValue: isActive ? tier : `${MODEL_CANDIDATE_PICKER_PREFIX}:${tier}:${index}`,
      label: tSync('modelOption.tierCandidateLabel', {
        tier: getTierLabel(tier),
        model: getModelLabel(resolvedModel),
      }),
      description: `${provider} · ${resolvedModel} · ${position}${activeHint}`,
      descriptionForModel: `${provider} · ${resolvedModel} · ${position}${activeHint}`,
      candidateSelection: {
        tier,
        candidate: { ...candidate, candidateIndex: index },
      },
    }
  })
}

function getTierOptions(tier: ModelTier): ModelOption[] {
  const settings = getInitialSettings()
  const candidates = getModelCandidatesForTier(tier, settings, getAPIProvider())
  const active = selectActiveCandidate(candidates, tier, settings)
  if (!active) {
    return []
  }
  return createTierCandidateOptions(tier, candidates, active)
}

function getStandardOption(): ModelOption {
  return {
    value: 'standard',
    label: tSync('modelOption.standard'),
    description: tSync('modelOption.standardDesc'),
    descriptionForModel: tSync('modelOption.standardDescForModel'),
  }
}

function getAdvancedOption(): ModelOption {
  return {
    value: 'advanced',
    label: tSync('modelOption.advanced'),
    description: tSync('modelOption.advancedDesc'),
    descriptionForModel: tSync('modelOption.advancedDescForModel'),
  }
}

function getCompactOption(): ModelOption {
  return {
    value: 'compact',
    label: tSync('modelOption.compact'),
    description: tSync('modelOption.compactDesc'),
    descriptionForModel: tSync('modelOption.compactDescForModel'),
  }
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
  const standard = getTierOptions('standard')
  const advanced = getTierOptions('advanced')
  const compact = getTierOptions('compact')
  return [
    getDefaultOptionForUser(),
    ...(standard.length > 0 ? standard : [getStandardOption()]),
    ...(advanced.length > 0 ? advanced : [getAdvancedOption()]),
    ...(compact.length > 0 ? compact : [getCompactOption()]),
  ]
}

/** 将 picker 候选落到该档位的 sticky 状态，并返回会话应保存的 tier。 */
export function applyModelOptionSelection(option: ModelOption): ModelSetting {
  if (!option.candidateSelection) {
    return option.value
  }
  pinModelCandidate(option.candidateSelection.tier, option.candidateSelection.candidate)
  return option.candidateSelection.tier
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
    (opt) =>
      opt.value === null ||
      (opt.candidateSelection
        ? isModelAllowed(opt.candidateSelection.candidate.model)
        : isModelAllowed(opt.value)),
  )
}
