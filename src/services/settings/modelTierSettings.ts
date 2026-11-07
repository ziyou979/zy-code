import { setMainLoopModelOverride } from '../../bootstrap/runtime/runtimeContext.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import {
  findModelTierScope,
  parseModelTierValue,
  type ModelSetting,
  type ModelTier,
} from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'
import { clearStickyForTier } from '../model/modelChainState.js'
import { resolveEffortForModel } from '../effort/effort.js'
import { shouldEnableThinkingByDefault } from '../messages/thinking.js'
import { getAuthConfigForProvider, getConfiguredConnectionIds } from '../auth/authConfig.js'
import { PROVIDER_REGISTRY } from '../model/providerRegistry.js'
import { getInitialSettings, updateSettingsForSource } from './settings.js'
import type { SettingsJson } from './types.js'

type SettingsUpdate = Parameters<typeof updateSettingsForSource>[1]
type TierValue = NonNullable<SettingsJson['models']>[string]

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

/** 清空当前作用域会让 shadowedScope 中被遮蔽的旧档位列表重新生效。 */
export class ShadowedModelTierError extends Error {
  constructor(
    readonly tier: ModelTier,
    /** '' 为顶层 models */
    readonly shadowedScope: string,
  ) {
    super(`clearing ${tier} would expose ${shadowedScope || 'top-level'} models`)
    this.name = 'ShadowedModelTierError'
  }

  /** settings.json 中会重新生效的键路径 */
  get settingsPath(): string {
    const models = `models.${this.tier}`
    return this.shadowedScope ? `providers.${this.shadowedScope}.${models}` : models
  }
}

// 编辑档位自身生效的作用域；都未配置时写当前 provider 段（若存在）或顶层，不借用 standard
function getEditScope(tier: ModelTier, st: SettingsJson): string {
  const p = getAPIProvider()
  return findModelTierScope(tier, st, p)?.scope ?? (st.providers?.[p] ? p : '')
}

/** 解析指定档位已配置的有序候选列表（第 0 项为主选，后续为降级备选）。 */
export function getModelTierCandidates(
  tier: ModelTier,
  settings = getInitialSettings(),
  scope = getEditScope(tier, settings),
): ModelTierCandidate[] {
  const value = scope ? settings.providers?.[scope]?.models?.[tier] : settings.models?.[tier]
  // 保留原始连接名；顶层隐式平台与运行时一样取当前 provider。
  return parseModelTierValue(value, scope || getAPIProvider()).map(
    ({ provider, model, label }) => ({
      provider: provider ?? '',
      model,
      ...(label === undefined ? {} : { label }),
    }),
  )
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
  const cur = getInitialSettings()
  const p = getAPIProvider()
  const scope = getEditScope(tier, cur)
  // 清空会暴露其他作用域的旧列表
  const shadowed = tierValue ? undefined : findModelTierScope(tier, cur, p, scope)
  if (shadowed) {
    return { error: new ShadowedModelTierError(tier, shadowed.scope) }
  }
  const models: Partial<Record<ModelTier, TierValue>> = {}
  models[tier] = tierValue
  // 单次写入；p 取自写入前，不受 sticky 失效影响
  const update: SettingsUpdate = scope ? { providers: { [scope]: { models } } } : { models }
  const main = { mainLoopModel: tier, model: undefined }
  if (activate && cur.providers?.[p]) {
    update.model = undefined
    update.providers = { ...update.providers, [p]: { ...update.providers?.[p], ...main } }
  } else if (activate) {
    update.mainLoopModel = tier
    update.model = undefined
  }
  const result = updateSettingsForSource('userSettings', update)
  if (result.error) return result

  const settings = getInitialSettings()
  if (activate) {
    setMainLoopModelOverride(tier)
    // 显式启用档位即选中新主选，旧 sticky 会让运行时继续停在原降级候选
    try {
      clearStickyForTier(tier, settings)
    } catch {
      // sticky 写失败不影响已保存的设置
    }
  }
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
