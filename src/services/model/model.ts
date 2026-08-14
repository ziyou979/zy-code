import { getMainLoopModelOverride } from '../../bootstrap/runtime/runtimeContext.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import type { ModelAlias } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  clearStickyForTier,
  getModelFailoverConfig,
  getStickyForTier,
  setStickyForTier,
  type ModelChainFailoverReason,
} from './modelChainState.js'
import { getProviderEntry } from './providerRegistry.js'
import { type APIProvider, getAPIProvider } from './providers.js'
import { getAuthConfigForProvider } from '../auth/authConfig.js'

export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null
export type ModelReference = {
  provider?: string
  model: string
  label?: string
}
export type ModelReferenceInput = ModelName | ModelReference
/** 档位配置值：单引用或有序候选列表 */
export type ModelTierValue = ModelReferenceInput | ModelReference[]

export type ResolvedModelReference = {
  model: ModelName
  provider?: APIProvider
  /** auth.json 中的命名连接；与底层 provider 分离以支持多个 generic。 */
  authProfile?: string
  /** 在候选列表中的下标；单通道时为 0 */
  candidateIndex?: number
  label?: string
}

type CustomModelConfig = {
  alias: string
  model: string
  label?: string
  provider?: string
}

type InitialSettings = SettingsJson

/** 基于层级划分不同能力的模型 */
export type ModelTier = 'advanced' | 'standard' | 'compact'

function isModelReference(value: unknown): value is ModelReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'model' in value &&
    typeof (value as { model?: unknown }).model === 'string'
  )
}

function resolveProviderReference(provider?: string): {
  provider?: APIProvider
  authProfile?: string
} {
  if (!provider) {
    return {}
  }
  const authConfig = getAuthConfigForProvider(provider)
  const registryProvider = authConfig?.provider ?? provider
  if (!getProviderEntry(registryProvider)) {
    return {}
  }
  return {
    provider: registryProvider as APIProvider,
    ...(authConfig?.provider ? { authProfile: provider } : {}),
  }
}

function toAPIProvider(provider?: string): APIProvider | undefined {
  return resolveProviderReference(provider).provider
}

function getOptionalSettings(): InitialSettings | undefined {
  try {
    return getInitialSettings()
  } catch {
    return undefined
  }
}

function getProviderSettings(
  settings: InitialSettings | undefined,
  provider: string = getAPIProvider(),
) {
  return settings?.providers?.[provider]
}

function resolveModelReference(
  value: ModelReferenceInput | undefined,
  implicitProvider?: string,
  candidateIndex = 0,
): ResolvedModelReference | undefined {
  if (typeof value === 'string') {
    return { model: value, ...resolveProviderReference(implicitProvider), candidateIndex }
  }
  if (isModelReference(value)) {
    return {
      model: value.model,
      ...resolveProviderReference(value.provider ?? implicitProvider),
      candidateIndex,
      label: value.label,
    }
  }
  return undefined
}

/**
 * 将档位值（单引用或数组）规范为有序候选列表。
 * 数组下标越小优先级越高。
 */
export function normalizeModelTierValue(
  value: unknown,
  implicitProvider?: string,
): ResolvedModelReference[] {
  if (value === undefined || value === null) {
    return []
  }
  if (Array.isArray(value)) {
    const list: ResolvedModelReference[] = []
    for (let i = 0; i < value.length; i++) {
      const resolved = resolveModelReference(value[i] as ModelReferenceInput, implicitProvider, i)
      if (resolved) {
        list.push(resolved)
      }
    }
    return list
  }
  const single = resolveModelReference(value as ModelReferenceInput, implicitProvider, 0)
  return single ? [single] : []
}

function getModelReferenceModel(value: ModelReferenceInput | undefined): ModelName | undefined {
  return resolveModelReference(value)?.model
}

/**
 * 收集某档位的有序候选（含 sticky 解析前的完整列表）。
 */
export function getModelCandidatesForTier(
  tier: ModelTier | string,
  settings: InitialSettings | undefined = getOptionalSettings(),
  activeProvider: APIProvider = getAPIProvider(),
): ResolvedModelReference[] {
  const modelTier = tier as ModelTier
  const activeProviderSettings = getProviderSettings(settings, activeProvider)

  const fromActive = normalizeModelTierValue(
    activeProviderSettings?.models?.[modelTier],
    activeProvider,
  )
  if (fromActive.length > 0) {
    return fromActive
  }

  const fromTop = normalizeModelTierValue(settings?.models?.[modelTier], activeProvider)
  if (fromTop.length > 0) {
    return fromTop
  }

  for (const provider of getAllProviderIds(settings, activeProvider)) {
    if (provider === activeProvider) {
      continue
    }
    const scoped = normalizeModelTierValue(
      settings?.providers?.[provider]?.models?.[modelTier],
      provider,
    )
    if (scoped.length > 0) {
      return scoped
    }
  }

  if (modelTier !== 'standard') {
    return getModelCandidatesForTier('standard', settings, activeProvider)
  }

  return []
}

/**
 * 按 sticky（或默认 index 0）选取档位当前生效候选。
 */
export function selectActiveCandidate(
  candidates: ResolvedModelReference[],
  tier: string,
  settings: InitialSettings | undefined,
): ResolvedModelReference | undefined {
  if (candidates.length === 0) {
    return undefined
  }
  const sticky = getStickyForTier(tier, settings)
  if (sticky) {
    // 优先按 index；若 index 越界或 model/provider 已变，尝试匹配 model+provider
    if (sticky.index >= 0 && sticky.index < candidates.length) {
      const byIndex = candidates[sticky.index]
      if (
        byIndex &&
        byIndex.model === sticky.model &&
        (byIndex.provider ?? '') === (sticky.provider || byIndex.provider || '') &&
        (byIndex.authProfile ?? '') === (sticky.authProfile ?? byIndex.authProfile ?? '')
      ) {
        return { ...byIndex, candidateIndex: sticky.index }
      }
    }
    const matched = candidates.findIndex(
      (c) =>
        c.model === sticky.model &&
        (c.provider ?? '') === (sticky.provider || c.provider || '') &&
        (c.authProfile ?? '') === (sticky.authProfile ?? c.authProfile ?? ''),
    )
    if (matched >= 0) {
      const candidate = candidates[matched]!
      if (matched !== sticky.index) {
        setStickyForTier(
          tier,
          {
            index: matched,
            provider: candidate.provider ?? sticky.provider,
            authProfile: candidate.authProfile,
            model: candidate.model,
            reason: sticky.reason,
            switchedAt: sticky.switchedAt,
          },
          settings,
        )
      }
      return { ...candidate, candidateIndex: matched }
    }
    // 配置确实移除了该候选时，只清除此档位，不误伤其它用户选择。
    clearStickyForTier(tier, settings)
  }
  return { ...candidates[0]!, candidateIndex: 0 }
}

/**
 * 推进到下一候选并持久化 sticky。
 * @returns 下一候选，若无更多候选则 null
 */
export function advanceModelCandidate(
  tier: string,
  currentIndex: number,
  reason: ModelChainFailoverReason,
  settings: InitialSettings | undefined = getOptionalSettings(),
  activeProvider: APIProvider = getAPIProvider(),
): ResolvedModelReference | null {
  const candidates = getModelCandidatesForTier(tier, settings, activeProvider)
  const nextIndex = currentIndex + 1
  if (nextIndex >= candidates.length) {
    return null
  }
  const next = candidates[nextIndex]!
  const providerId = next.provider ?? activeProvider
  setStickyForTier(
    tier,
    {
      index: nextIndex,
      provider: providerId,
      authProfile: next.authProfile,
      model: next.model,
      reason,
    },
    settings,
  )
  return {
    ...next,
    candidateIndex: nextIndex,
    provider: toAPIProvider(providerId) ?? next.provider,
  }
}

/** 手动将 sticky 设为指定候选（如 /model 选择） */
export function pinModelCandidate(
  tier: string,
  candidate: ResolvedModelReference,
  settings: InitialSettings | undefined = getOptionalSettings(),
): void {
  const providerId = candidate.provider ?? getAPIProvider()
  setStickyForTier(
    tier,
    {
      index: candidate.candidateIndex ?? 0,
      provider: providerId,
      authProfile: candidate.authProfile,
      model: candidate.model,
      reason: 'user_model',
    },
    settings,
  )
}

export function isModelFailoverEnabled(
  settings: InitialSettings | undefined = getOptionalSettings(),
): boolean {
  return getModelFailoverConfig(settings).enabled
}

function getAllProviderIds(
  settings: InitialSettings | undefined,
  activeProvider: string = getAPIProvider(),
): string[] {
  const providerIds = new Set<string>([activeProvider])
  for (const provider of Object.keys(settings?.providers ?? {})) {
    providerIds.add(provider)
  }
  return [...providerIds]
}

function getCustomModelReferences(
  settings: InitialSettings | undefined,
  activeProvider: string = getAPIProvider(),
): Array<{
  alias: string
  model: string
  label?: string
  provider?: APIProvider
  authProfile?: string
}> {
  const refs: Array<{
    alias: string
    model: string
    label?: string
    provider?: APIProvider
    authProfile?: string
  }> = []

  const addModels = (customModels: CustomModelConfig[] | undefined, implicitProvider?: string) => {
    for (const customModel of customModels ?? []) {
      const resolvedProvider = resolveProviderReference(customModel.provider ?? implicitProvider)
      refs.push({
        alias: customModel.alias,
        model: customModel.model,
        label: customModel.label,
        ...resolvedProvider,
      })
    }
  }

  addModels(settings?.providers?.[activeProvider]?.customModels, activeProvider)
  addModels(settings?.customModels)
  for (const provider of Object.keys(settings?.providers ?? {})) {
    if (provider === activeProvider) {
      continue
    }
    addModels(settings?.providers?.[provider]?.customModels, provider)
  }

  return refs
}

function getModelByTierReferenceForSettings(
  settings: InitialSettings | undefined,
  tier: ModelTier,
  activeProvider: APIProvider,
): ResolvedModelReference | undefined {
  const candidates = getModelCandidatesForTier(tier, settings, activeProvider)
  return selectActiveCandidate(candidates, tier, settings)
}

function getModelByTierReference(tier: ModelTier): ResolvedModelReference | undefined {
  return getModelByTierReferenceForSettings(getOptionalSettings(), tier, getAPIProvider())
}

/** 解析当前 provider 生效的主循环档位，供模型与 provider 路由共同使用。 */
function getMainLoopTierForSettings(
  settings: InitialSettings | undefined,
  activeProvider: APIProvider,
): ModelTier {
  return (
    getProviderSettings(settings, activeProvider)?.mainLoopModel ??
    settings?.mainLoopModel ??
    'standard'
  )
}

/**
 * 从 settings.models 中读取指定 tier 的模型。
 * 未配置时回退到 standard tier。
 * standard 也未配置则返回 undefined，由调用方处理（如引导用户进入 onboarding 配置）。
 */
function getModelByTier(tier: ModelTier): ModelName | undefined {
  return getModelByTierReference(tier)?.model
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
    const settings = getOptionalSettings()
    specifiedModel =
      getModelReferenceModel(getProviderSettings(settings)?.model) ??
      getModelReferenceModel(settings?.model) ??
      undefined
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
  const settings = getOptionalSettings()
  const tier = getMainLoopTierForSettings(settings, getAPIProvider())
  return getModelByTierReference(tier)?.model
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
  const settings = getOptionalSettings()
  for (const customModel of getCustomModelReferences(settings)) {
    if (customModel.alias === setting || customModel.model === setting) {
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
  const settings = getOptionalSettings()
  for (const customModel of getCustomModelReferences(settings)) {
    if (customModel.model === model || `${customModel.model}[1m]` === model) {
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
  const settings = getOptionalSettings()
  for (const customModel of getCustomModelReferences(settings)) {
    if (customModel.alias.toLowerCase() === normalizedModel) {
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
  const settings = getOptionalSettings()
  for (const customModel of getCustomModelReferences(settings)) {
    if (customModel.model === modelId.replace(/\[1m\]$/i, '')) {
      const has1m = modelId.toLowerCase().includes('[1m]')
      return customModel.label ?? (has1m ? `${customModel.alias} (1M context)` : customModel.alias)
    }
  }
  return undefined
}

function findConfiguredModelReferenceForSettings(
  settings: InitialSettings | undefined,
  model: string,
  activeProvider: APIProvider,
): ResolvedModelReference | undefined {
  const matchesTierValue = (value: unknown, implicitProvider?: string) => {
    for (const candidate of normalizeModelTierValue(value, implicitProvider)) {
      if (candidate.model === model) {
        return candidate
      }
    }
    return undefined
  }

  const matchesSingle = (value: ModelReferenceInput | undefined, implicitProvider?: string) => {
    const resolved = resolveModelReference(value, implicitProvider)
    return resolved?.model === model ? resolved : undefined
  }

  for (const tier of ['advanced', 'standard', 'compact'] as const) {
    const activeMatch = matchesTierValue(
      settings?.providers?.[activeProvider]?.models?.[tier],
      activeProvider,
    )
    if (activeMatch) {
      return activeMatch
    }
    const topLevelMatch = matchesTierValue(settings?.models?.[tier], activeProvider)
    if (topLevelMatch) {
      return topLevelMatch
    }
  }

  for (const customModel of getCustomModelReferences(settings, activeProvider)) {
    if (customModel.alias === model || customModel.model === model) {
      return {
        model: customModel.model,
        provider: customModel.provider,
        authProfile: customModel.authProfile,
      }
    }
  }

  for (const provider of Object.keys(settings?.providers ?? {})) {
    if (provider === activeProvider) {
      continue
    }
    for (const tier of ['advanced', 'standard', 'compact'] as const) {
      const scopedMatch = matchesTierValue(
        settings?.providers?.[provider]?.models?.[tier],
        provider,
      )
      if (scopedMatch) {
        return scopedMatch
      }
    }
  }

  const topLevelModel = matchesSingle(settings?.model, activeProvider)
  if (topLevelModel) {
    return topLevelModel
  }

  for (const provider of getAllProviderIds(settings, activeProvider)) {
    const providerModel = matchesSingle(settings?.providers?.[provider]?.model, provider)
    if (providerModel) {
      return providerModel
    }
  }

  return undefined
}

export function getProviderForModelFromSettings(
  settings: InitialSettings | undefined,
  model?: string | null,
  activeProvider: APIProvider = getAPIProvider(),
): APIProvider {
  if (!model) {
    const tier = getMainLoopTierForSettings(settings, activeProvider)
    return (
      getModelByTierReferenceForSettings(settings, tier, activeProvider)?.provider ?? activeProvider
    )
  }

  const normalizedModel = model.trim().toLowerCase()
  if (
    normalizedModel === 'advanced' ||
    normalizedModel === 'standard' ||
    normalizedModel === 'compact'
  ) {
    return (
      getModelByTierReferenceForSettings(settings, normalizedModel, activeProvider)?.provider ??
      activeProvider
    )
  }

  return (
    findConfiguredModelReferenceForSettings(settings, model, activeProvider)?.provider ??
    activeProvider
  )
}

export function getProviderForModel(model?: string | null): APIProvider {
  return getProviderForModelFromSettings(getOptionalSettings(), model, getAPIProvider())
}

export function getAuthProfileForModelFromSettings(
  settings: InitialSettings | undefined,
  model?: string | null,
  activeProvider: APIProvider = getAPIProvider(),
): string | undefined {
  if (!model) {
    const tier = getMainLoopTierForSettings(settings, activeProvider)
    return getModelByTierReferenceForSettings(settings, tier, activeProvider)?.authProfile
  }
  const normalizedModel = model.trim().toLowerCase()
  if (
    normalizedModel === 'advanced' ||
    normalizedModel === 'standard' ||
    normalizedModel === 'compact'
  ) {
    return getModelByTierReferenceForSettings(settings, normalizedModel, activeProvider)
      ?.authProfile
  }

  // 相同模型可以出现在多个连接中，先按主循环档位的 sticky 解析。
  const mainTier = getMainLoopTierForSettings(settings, activeProvider)
  const tiers: ModelTier[] = [
    mainTier,
    ...(['advanced', 'standard', 'compact'] as const).filter((tier) => tier !== mainTier),
  ]
  for (const tier of tiers) {
    const active = getModelByTierReferenceForSettings(settings, tier, activeProvider)
    if (active?.model === model) {
      return active.authProfile
    }
  }
  return findConfiguredModelReferenceForSettings(settings, model, activeProvider)?.authProfile
}

export function getAuthProfileForModel(model?: string | null): string | undefined {
  return getAuthProfileForModelFromSettings(getOptionalSettings(), model, getAPIProvider())
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
