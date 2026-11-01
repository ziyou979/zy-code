import { setMainLoopModelOverride } from '../../bootstrap/runtime/runtimeContext.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { ModelSetting, ModelTier } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'
import { resolveEffortForModel } from '../effort/effort.js'
import { shouldEnableThinkingByDefault } from '../messages/thinking.js'
import { getAuthConfigForProvider, getConfiguredConnectionIds } from '../auth/authConfig.js'
import { PROVIDER_REGISTRY } from '../model/providerRegistry.js'
import { getInitialSettings, updateSettingsForSource } from './settings.js'

export type ModelTierProviderConnection = {
  id: string
  provider: string
  configured: boolean
}

export type ModelTierCandidate = {
  provider: string
  model: string
  label?: string
}

/** 档位选择器同时展示注册平台和 auth.json 中的实际命名连接。 */
export function getModelTierProviderConnections(): ModelTierProviderConnection[] {
  const configuredIds = [...new Set(getConfiguredConnectionIds())].sort((a, b) =>
    a.localeCompare(b),
  )
  const configured = configuredIds.map((id) => ({
    id,
    provider: getAuthConfigForProvider(id)?.provider ?? id,
    configured: true,
  }))
  const configuredSet = new Set(configuredIds)
  const available = PROVIDER_REGISTRY.filter(
    (entry) => entry.showInOnboarding !== false && !configuredSet.has(entry.id),
  )
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, provider: entry.id, configured: false }))
  return [...configured, ...available]
}

/** 解析指定档位已配置的有序候选列表（第 0 项为主选，后续为降级备选）。 */
export function getModelTierCandidates(
  tier: ModelTier,
  settings = getInitialSettings(),
): ModelTierCandidate[] {
  const value = settings.models?.[tier]
  if (!value) return []
  if (Array.isArray(value)) {
    const list: ModelTierCandidate[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        list.push({ provider: '', model: item })
      } else if (item && typeof item === 'object' && 'model' in item) {
        const ref = item as { provider?: string; model: string; label?: string }
        list.push({ provider: ref.provider ?? '', model: ref.model, label: ref.label })
      }
    }
    return list
  }
  if (typeof value === 'string') {
    return [{ provider: '', model: value }]
  }
  if (typeof value === 'object' && 'model' in value) {
    const ref = value as { provider?: string; model: string; label?: string }
    return [{ provider: ref.provider ?? '', model: ref.model, label: ref.label }]
  }
  return []
}

/** 保存主循环选择，沿用现有 provider 级配置的优先级。 */
export function saveMainLoopModelSetting(model: ModelSetting): { error: Error | null } {
  const settings = getInitialSettings()
  const currentProvider = getAPIProvider()
  const isTier = model === 'advanced' || model === 'standard' || model === 'compact'
  const modelUpdate: { model?: string; mainLoopModel?: ModelTier } = isTier
    ? { model: undefined, mainLoopModel: model }
    : { model: model ?? undefined, mainLoopModel: undefined }
  if (settings.providers?.[currentProvider] !== undefined) {
    return updateSettingsForSource('userSettings', {
      providers: {
        [currentProvider]: modelUpdate,
      },
    })
  }
  return updateSettingsForSource('userSettings', modelUpdate)
}

/** 保存档位的完整候选列表，长度大于 1 时存为降级链数组，等于 1 时存为对象。 */
export function saveModelTierCandidates(
  tier: ModelTier,
  candidates: ModelTierCandidate[],
  activate: boolean,
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const tierValue =
    candidates.length === 0
      ? undefined
      : candidates.length === 1
        ? { provider: candidates[0]!.provider, model: candidates[0]!.model }
        : candidates.map((c) => ({ provider: c.provider, model: c.model }))

  const primaryModel = candidates[0]?.model ?? ''
  const result = updateSettingsForSource('userSettings', {
    models: { [tier]: tierValue },
    ...(activate ? { mainLoopModel: tier, model: undefined } : {}),
  })
  if (result.error) return result

  const settings = getInitialSettings()
  if (activate) setMainLoopModelOverride(tier)
  if (setAppState) {
    setAppState((prev) => ({
      ...prev,
      settings,
      ...(activate
        ? {
            mainLoopModel: tier,
            mainLoopModelForSession: null,
            thinkingEnabled: shouldEnableThinkingByDefault(primaryModel || tier),
            effortValue: resolveEffortForModel(primaryModel || tier, prev.effortValue),
          }
        : {}),
    }))
  }
  return result
}

/**
 * 保存单个档位模型选择。
 * 若原配置已有备用降级链，将选中的新模型替换/置顶为主选，保留后续备选节点，防止清空降级链。
 */
export function saveModelTierSelection(
  selection: {
    tier: ModelTier
    provider: string
    model: string
    activate: boolean
  },
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const { tier, provider, model, activate } = selection
  if (!model) {
    return saveModelTierCandidates(tier, [], activate, setAppState)
  }

  const existingCandidates = getModelTierCandidates(tier)
  if (existingCandidates.length > 1) {
    // 过滤掉原链中与新主选完全重复的项，保留其余备选节点
    const remainingFallbacks = existingCandidates
      .slice(1)
      .filter((c) => !(c.provider === provider && c.model === model))
    const updatedCandidates = [{ provider, model }, ...remainingFallbacks]
    return saveModelTierCandidates(tier, updatedCandidates, activate, setAppState)
  }

  return saveModelTierCandidates(tier, [{ provider, model }], activate, setAppState)
}

/** 向指定档位追加备用降级节点。 */
export function addModelTierCandidate(
  tier: ModelTier,
  candidate: ModelTierCandidate,
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const existingCandidates = getModelTierCandidates(tier)
  // 如果已存在相同的 provider + model，避免重复追加
  const isDuplicate = existingCandidates.some(
    (c) => c.provider === candidate.provider && c.model === candidate.model,
  )
  if (isDuplicate) {
    return { error: null }
  }
  const updatedCandidates = [...existingCandidates, candidate]
  return saveModelTierCandidates(tier, updatedCandidates, false, setAppState)
}

/** 从指定档位中移除某候选节点。 */
export function removeModelTierCandidate(
  tier: ModelTier,
  index: number,
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const existingCandidates = getModelTierCandidates(tier)
  if (index < 0 || index >= existingCandidates.length) {
    return { error: null }
  }
  const updatedCandidates = existingCandidates.filter((_, i) => i !== index)
  return saveModelTierCandidates(tier, updatedCandidates, false, setAppState)
}

/** 调整指定档位中某候选节点的排列顺序。 */
export function reorderModelTierCandidates(
  tier: ModelTier,
  fromIndex: number,
  toIndex: number,
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const candidates = [...getModelTierCandidates(tier)]
  if (
    fromIndex < 0 ||
    fromIndex >= candidates.length ||
    toIndex < 0 ||
    toIndex >= candidates.length ||
    fromIndex === toIndex
  ) {
    return { error: null }
  }
  const [moved] = candidates.splice(fromIndex, 1)
  if (!moved) return { error: null }
  candidates.splice(toIndex, 0, moved)
  return saveModelTierCandidates(tier, candidates, false, setAppState)
}

/** 清空某档位的降级链，仅保留主选模型。 */
export function clearModelTierFallbacks(
  tier: ModelTier,
  setAppState?: AppStateStore['setState'],
): { error: Error | null } {
  const candidates = getModelTierCandidates(tier)
  if (candidates.length <= 1) {
    return { error: null }
  }
  const primary = candidates[0] ? [candidates[0]] : []
  return saveModelTierCandidates(tier, primary, false, setAppState)
}

/** 保存全局模型故障降级策略配置。 */
export function saveModelFailoverPolicy(policy: {
  enabled?: boolean
  mode?: 'confirm' | 'notify' | 'off'
  maxConsecutiveFailures?: number
}): { error: Error | null } {
  const current = getInitialSettings().modelFailover
  return updateSettingsForSource('userSettings', {
    modelFailover: {
      ...current,
      ...policy,
    },
  })
}
