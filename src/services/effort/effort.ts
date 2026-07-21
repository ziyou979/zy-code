// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { tSync } from '../../i18n/index.js'
import { isUltrathinkEnabled, modelSupportsThinking } from '../../services/messages/thinking.js'
import { getInitialSettings } from '../settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getEffectiveApiFormat, getProviderAttr } from 'src/services/model/providers.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  getProviderForModel,
  parseUserSpecifiedModel,
} from 'src/services/model/model.js'
import {
  getLocalModelEffortLevels,
  getLocalModelEffortMap,
  getLocalModelPreserveThinking,
} from '../settings/localModelCapabilities.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import {
  PERSISTABLE_EFFORT_LEVELS,
  type EffortLevel,
  type PersistableEffortLevel,
} from './effortTypes.js'

// 向后兼容 re-export
export { PERSISTABLE_EFFORT_LEVELS, type PersistableEffortLevel, type EffortLevel }

// ---------------------------------------------------------------------------
// 语义化 Effort 档位体系（provider 无关）
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'off',
  'on',
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'ultra',
  'orchestrate', // 类似 cc 的 ultracode，模型会自发进行编排
]

/**
 * 档位强弱顺序映射(由弱到强)。
 * orchestrate 不在此映射中——它是「extreme + 工作流编排」的会话模式标记，不是独立强度档。
 */
export const EFFORT_LEVEL_RANK: ReadonlyMap<EffortLevel, number> = new Map<EffortLevel, number>([
  ['off', 0],
  ['on', 1],
  ['quick', 2],
  ['light', 3],
  ['balanced', 4],
  ['thorough', 5],
  ['extreme', 6],
  ['ultra', 7],
])

/** 按强度排序的档位列表（由弱到强），从 EFFORT_LEVEL_RANK 派生 */
export const EFFORT_LEVEL_ORDER: readonly EffortLevel[] = [...EFFORT_LEVEL_RANK.keys()]

function getModelCapabilityContext(model: string, provider: string = getProviderForModel(model)) {
  return {
    provider,
    apiFormat: getEffectiveApiFormat(provider, model),
  }
}

// ---------------------------------------------------------------------------
// Provider 映射（内部档位 → 各家 API 参数值）
// 映射由模型级 model-capabilities.json 的 effort.map 提供，不再走 provider 级配置。
// ---------------------------------------------------------------------------

/**
 * 将内部 effort 档位映射为目标 provider 的 API 参数值。
 * 映射来源：模型级 effortMap（model-capabilities.json 的 effort.map）。
 * 没有配置 effortMap 的模型不支持 effort，返回 undefined。
 *
 * "on" 是特殊档位，表示"思考开启，无特定强度"——直接返回 "on"，不走映射链。
 * 由各 provider 的 openaiAttr.thinking.enable() 处理为合理默认值。
 */
export function mapEffortToProvider(
  effort: EffortLevel,
  providerId: string,
  model?: string,
): string | undefined {
  // "on" 是 toggle 模式的开启档，不走 provider 映射
  if (effort === 'on') {
    return 'on'
  }
  // "ultra" 复用 "extreme" 的 provider 映射（最强思考强度）
  // "orchestrate" 同理
  const key = effort === 'orchestrate' || effort === 'ultra' ? 'extreme' : effort
  // 模型级映射（model-capabilities.json 的 effort.map）
  if (model) {
    const modelMap = getLocalModelEffortMap(model, getModelCapabilityContext(model, providerId))
    if (modelMap && key in modelMap) {
      return modelMap[key]!
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 模型 effort 支持检测
// ---------------------------------------------------------------------------

/**
 * 模型是否支持 effort 功能。
 * 优先级：本地 model-capabilities → provider 声明 → 环境变量强制。
 *
 * 当 preserve === 'optional' 且 effort 列表中无 'ultra' 时，
 * 自动追加 'ultra' 档位（最强思考 + 回传 thinking 块）。
 */
export function getModelEffortLevels(model: string): EffortLevel[] {
  const provider = getProviderForModel(model)
  const context = getModelCapabilityContext(model, provider)
  // 1. 本地配置覆盖
  const local = getLocalModelEffortLevels(model, context)
  if (local && local.length > 0) {
    const levels = [...local] as EffortLevel[]

    // preserve: "optional" 需要 ultra 来触发 preserve_thinking 回传
    if (!levels.includes('ultra')) {
      const preserve = getLocalModelPreserveThinking(model, context)
      if (preserve === 'optional') {
        levels.push('ultra')
      }
    }

    return levels
  }

  // 2. provider 有 openaiAttr.thinking → 仅支持 toggle 模式
  const providerAttr = getProviderAttr(provider, model)
  if (providerAttr?.thinking) {
    return ['off', 'on']
  }

  // 3. 环境变量强制开启
  if (isEnvTruthy(process.env.ZY_CODE_ALWAYS_ENABLE_EFFORT)) {
    return [...EFFORT_LEVEL_ORDER]
  }

  // 5. 不支持 effort
  return []
}

export function modelSupportsEffort(model: string): boolean {
  return getModelEffortLevels(model).length > 0
}

// ---------------------------------------------------------------------------
// Hook effort 级别
// ---------------------------------------------------------------------------

export function getCurrentHookEffortLevel(effortValue?: EffortLevel): EffortLevel | undefined {
  const model = getMainLoopModel()
  if (!model || !modelSupportsEffort(model)) {
    return undefined
  }
  return getDisplayedEffortLevel(model, effortValue)
}

// ---------------------------------------------------------------------------
// Clamp（向下兼容——新体系中由 mapEffortToProvider 替代，
// 但保留给 localModelCapabilities 等场景使用）
// ---------------------------------------------------------------------------

export function clampEffort(
  requested: EffortLevel,
  supported: readonly EffortLevel[],
): EffortLevel | undefined {
  if (supported.length === 0) {
    return undefined
  }
  if (supported.includes(requested)) {
    return requested
  }
  const idx = EFFORT_LEVEL_RANK.get(requested)
  if (idx === undefined) {
    return EFFORT_LEVEL_ORDER.filter((l) => supported.includes(l)).at(-1)
  }
  // 向下查找最近的支持档位
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  // 向上查找最近的支持档位
  for (let i = idx + 1; i < EFFORT_LEVEL_ORDER.length; i++) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  return undefined
}

/**
 * 把候选 effort 落到目标模型真实支持的档位上。
 * 用于 /model 切换和请求发送前的兜底，避免旧模型的强度泄漏到新模型。
 */
export function resolveEffortForModel(
  model: string,
  requested: EffortLevel | undefined,
): EffortLevel | undefined {
  const supportedLevels = getModelEffortLevels(model)
  return resolveEffortForSupportedLevels(
    supportedLevels,
    requested,
    getDefaultEffortForModel(model),
  )
}

export function resolveEffortForSupportedLevels(
  supportedLevels: readonly EffortLevel[],
  requested: EffortLevel | undefined,
  defaultEffort: EffortLevel | undefined,
): EffortLevel | undefined {
  if (supportedLevels.length === 0) {
    return undefined
  }
  const resolved = requested ?? defaultEffort
  return resolved === undefined ? undefined : clampEffort(resolved, supportedLevels)
}

/**
 * 接受 AppState 中保存的模型设置（null 表示默认、别名需解析），返回该设置下
 * 应写入状态的 effort 值。
 */
export function resolveEffortForModelSetting(
  modelSetting: string | null | undefined,
  requested: EffortLevel | undefined,
): EffortLevel | undefined {
  const model = modelSetting ? parseUserSpecifiedModel(modelSetting) : getDefaultMainLoopModel()
  return model ? resolveEffortForModel(model, requested) : undefined
}

// ---------------------------------------------------------------------------
// 解析与验证
// ---------------------------------------------------------------------------

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortLevel | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  return undefined
}

/**
 * orchestrate 是会话模式标记，不可持久化到 settings.json。
 */
export function toPersistableEffort(
  value: EffortLevel | undefined,
): PersistableEffortLevel | undefined {
  if (
    value === 'off' ||
    value === 'on' ||
    value === 'quick' ||
    value === 'light' ||
    value === 'balanced' ||
    value === 'thorough' ||
    value === 'extreme' ||
    value === 'ultra'
  ) {
    return value
  }
  // orchestrate 是会话级，不持久化
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  const raw = getInitialSettings().effortLevel as string | undefined
  if (!raw) {
    return undefined
  }
  return toPersistableEffort(raw as EffortLevel)
}

export function resolveInitialEffortSetting(cliEffort?: unknown): EffortLevel | undefined {
  // 启动入口只负责解析显式配置；没有配置时保持 undefined，
  // 由 resolveAppliedEffort/getDisplayedEffortLevel 按模型能力应用默认开启档。
  return parseEffortValue(cliEffort) ?? getInitialEffortSetting()
}

export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortLevel | null | undefined {
  const envOverride = process.env.ZY_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' || envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

// ---------------------------------------------------------------------------
// 解析实际 effort（优先级链）
// ---------------------------------------------------------------------------

export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortLevel | undefined,
): EffortLevel | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved = envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (resolved === undefined) {
    return undefined
  }
  return resolveEffortForModel(model, resolved)
}

/**
 * 展示给用户的 effort 级别。
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortLevel | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'thorough'
  return isEffortLevel(resolved) ? resolved : 'thorough'
}

// ---------------------------------------------------------------------------
// 描述（用户可见，走 i18n 更好，此处作为 fallback）
// ---------------------------------------------------------------------------

export function getEffortLevelDescription(level: EffortLevel): string {
  return (tSync(`effort.description.${level}` as `effort.description.${string}`) as string) || level
}

export type EffortCalloutConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const EFFORT_CALLOUT_CONFIG_DEFAULT: EffortCalloutConfig = {
  enabled: true,
  dialogTitle: 'effort.defaultDialogTitle',
  dialogDescription: 'effort.defaultDialogDescription',
}

export function getEffortCalloutConfig(): EffortCalloutConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE('zy_grey_step2', EFFORT_CALLOUT_CONFIG_DEFAULT)
  return {
    ...EFFORT_CALLOUT_CONFIG_DEFAULT,
    ...config,
  }
}

export function getDefaultThinkingEffortFromLevels(
  supportedLevels: readonly EffortLevel[],
): EffortLevel {
  // 1. 按 EFFORT_LEVEL_RANK 的顺序排序 supportedLevels
  const sortedLevels = [...supportedLevels].sort((a, b) => {
    return (EFFORT_LEVEL_RANK.get(a) ?? 0) - (EFFORT_LEVEL_RANK.get(b) ?? 0)
  })

  // 2. 去掉 'off'
  const activeLevels = sortedLevels.filter((level) => level !== 'off')

  // 3. 如果没有有效等级，返回 'off'
  if (activeLevels.length === 0) {
    return 'off'
  }

  // 4. 取中间值（偶数长度时取较低的中间值，偏向保守选择）
  const middleIndex = Math.floor((activeLevels.length - 1) / 2)
  return activeLevels[middleIndex]
}

export function getDefaultEffortForModel(model: string): EffortLevel | undefined {
  const supportedLevels = getModelEffortLevels(model)

  // 支持思考的模型默认开启思考，且优先使用模型实际支持的开启档位。
  if (modelSupportsThinking(model)) {
    return getDefaultThinkingEffortFromLevels(supportedLevels) ?? 'on'
  }
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return getDefaultThinkingEffortFromLevels(supportedLevels) ?? 'balanced'
  }
  return undefined
}

export function isOrchestrateEffort(effortValue: EffortLevel | undefined): boolean {
  return effortValue === 'orchestrate'
}
