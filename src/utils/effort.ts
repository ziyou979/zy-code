// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider, getProviderEffortMapping } from 'src/services/model/providers.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import { getProviderEntry } from 'src/services/model/providerRegistry.js'
import {
  getLocalModelEffortLevels,
  getLocalModelEffortMap,
} from './settings/localModelCapabilities.js'
import { isEnvTruthy, isInternalBuild } from './envUtils.js'

// ---------------------------------------------------------------------------
// 语义化 Effort 档位体系（provider 无关）
// ---------------------------------------------------------------------------

export type PersistableEffortLevel = 'quick' | 'light' | 'balanced' | 'thorough' | 'extreme'
export type EffortLevel = PersistableEffortLevel | 'orchestrate'

export const EFFORT_LEVELS = [
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'orchestrate',
] as const

/**
 * 档位强弱顺序(由弱到强)。
 * orchestrate 不在此数组中——它是「extreme + 工作流编排」的会话模式标记，不是独立强度档。
 */
export const EFFORT_LEVEL_ORDER: readonly EffortLevel[] = [
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
]

export type EffortValue = EffortLevel

// ---------------------------------------------------------------------------
// Provider 映射（内部档位 → 各家 API 参数值）
// 映射表声明在 providerRegistry.ts 的 effortMapping 字段中。
// ---------------------------------------------------------------------------

// anthropic 的映射作为回退默认值
const DEFAULT_EFFORT_MAPPING: Record<string, string> = {
  quick: 'low',
  light: 'medium',
  balanced: 'high',
  thorough: 'xhigh',
  extreme: 'max',
  orchestrate: 'max',
}

/**
 * 将内部 effort 档位映射为目标 provider 的 API 参数值。
 * 优先级：模型级 effortMap（model-capabilities.json）→ provider 级 effortMapping → anthropic 默认。
 */
export function mapEffortToProvider(
  effort: EffortLevel,
  providerId: string,
  model?: string,
): string {
  const key = effort === 'orchestrate' ? 'extreme' : effort
  // 1. 模型级映射（用户本地配置优先）
  if (model) {
    const modelMap = getLocalModelEffortMap(model)
    if (modelMap && key in modelMap) {
      return modelMap[key]!
    }
  }
  // 2. Provider 级映射 → 3. 默认
  const map = getProviderEffortMapping(providerId) ?? DEFAULT_EFFORT_MAPPING
  return map[key] ?? 'medium'
}

// ---------------------------------------------------------------------------
// 旧值兼容迁移
// ---------------------------------------------------------------------------

const LEGACY_EFFORT_MAP: Record<string, EffortLevel> = {
  minimal: 'quick',
  low: 'light',
  medium: 'balanced',
  high: 'thorough',
  xhigh: 'extreme',
  max: 'extreme',
  ultracode: 'orchestrate',
}

/**
 * 将旧格式 effort 值迁移为新语义档位。
 * 已经是新格式则原样返回。
 */
export function migrateLegacyEffort(value: string): EffortLevel | undefined {
  if (isEffortLevel(value)) {
    return value
  }
  return LEGACY_EFFORT_MAP[value]
}

// ---------------------------------------------------------------------------
// 模型 effort 支持检测
// ---------------------------------------------------------------------------

/**
 * 模型是否支持 effort 功能。
 * 优先级：本地 model-capabilities → provider 声明 → 环境变量强制。
 */
export function getModelEffortLevels(model: string): EffortLevel[] {
  // 1. 本地配置覆盖
  const local = getLocalModelEffortLevels(model)
  if (local && local.length > 0) {
    return local
  }

  // 2. provider 声明
  const entry = getProviderEntry(getAPIProvider())
  const providerLevels =
    isInternalBuild() && entry?.internalEffortLevels
      ? entry.internalEffortLevels
      : entry?.defaultEffortLevels
  if (providerLevels && providerLevels.length > 0) {
    return [...providerLevels]
  }

  // 3. 环境变量强制开启
  if (isEnvTruthy(process.env.ZY_CODE_ALWAYS_ENABLE_EFFORT)) {
    return [...EFFORT_LEVEL_ORDER]
  }

  // 4. 不支持 effort
  return []
}

export function modelSupportsEffort(model: string): boolean {
  return getModelEffortLevels(model).length > 0
}

// ---------------------------------------------------------------------------
// Hook effort 级别
// ---------------------------------------------------------------------------

export function getCurrentHookEffortLevel(effortValue?: EffortValue): EffortLevel | undefined {
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
  const idx = EFFORT_LEVEL_ORDER.indexOf(requested)
  if (idx === -1) {
    return EFFORT_LEVEL_ORDER.filter((l) => supported.includes(l)).at(-1)
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  for (let i = idx + 1; i < EFFORT_LEVEL_ORDER.length; i++) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 解析与验证
// ---------------------------------------------------------------------------

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  // 兼容旧值
  return migrateLegacyEffort(str)
}

/**
 * orchestrate 是会话模式标记，不可持久化到 settings.json。
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): PersistableEffortLevel | undefined {
  if (
    value === 'quick' ||
    value === 'light' ||
    value === 'balanced' ||
    value === 'thorough' ||
    value === 'extreme'
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
  // 支持读取旧值
  return migrateLegacyEffort(raw) ?? toPersistableEffort(raw as EffortValue)
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

export function getEffortEnvOverride(): EffortValue | null | undefined {
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
  appStateEffortValue: EffortValue | undefined,
): EffortLevel | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved = envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (resolved === undefined) {
    return undefined
  }
  if (!modelSupportsEffort(model)) {
    return undefined
  }
  return resolved
}

/**
 * 展示给用户的 effort 级别。
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'thorough'
  return convertEffortValueToLevel(resolved)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  return isEffortLevel(value) ? value : 'thorough'
}

// ---------------------------------------------------------------------------
// 描述（用户可见，走 i18n 更好，此处作为 fallback）
// ---------------------------------------------------------------------------

export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'quick':
      return 'Fastest response with minimal reasoning'
    case 'light':
      return 'Light reasoning, quick implementation'
    case 'balanced':
      return 'Balanced approach with standard reasoning'
    case 'thorough':
      return 'Deep reasoning with comprehensive analysis'
    case 'extreme':
      return 'Maximum reasoning depth and thoroughness'
    case 'orchestrate':
      return 'Extreme reasoning + dynamic workflow orchestration (session only)'
  }
}

export function getEffortValueDescription(value: EffortValue): string {
  return getEffortLevelDescription(value)
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

export function getDefaultEffortForModel(model: string): EffortValue | undefined {
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'balanced'
  }
  return undefined
}

export function isOrchestrateEffort(effortValue: EffortValue | undefined): boolean {
  return effortValue === 'orchestrate'
}

// 向后兼容别名
export const isUltracodeEffort = isOrchestrateEffort
