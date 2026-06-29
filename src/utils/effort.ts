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
  getLocalModelPreserveThinking,
} from './settings/localModelCapabilities.js'
import { isEnvTruthy } from './envUtils.js'

// ---------------------------------------------------------------------------
// 语义化 Effort 档位体系（provider 无关）
// ---------------------------------------------------------------------------

export type PersistableEffortLevel =
  | 'off'
  | 'on' // 思考开启（无特定强度，不走 provider 映射）
  | 'quick'
  | 'light'
  | 'balanced'
  | 'thorough'
  | 'extreme'
  | 'ultra' // 最强思考 + 回传 thinking 块（preserve: optional 时自动追加）
export type EffortLevel = PersistableEffortLevel | 'orchestrate'

export const EFFORT_LEVELS = [
  'off',
  'on',
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'ultra',
  'orchestrate',
] as const

/**
 * 档位强弱顺序(由弱到强)。
 * orchestrate 不在此数组中——它是「extreme + 工作流编排」的会话模式标记，不是独立强度档。
 */
export const EFFORT_LEVEL_ORDER: readonly EffortLevel[] = [
  'off',
  'on',
  'quick',
  'light',
  'balanced',
  'thorough',
  'extreme',
  'ultra',
]

export type EffortValue = EffortLevel

// ---------------------------------------------------------------------------
// Provider 映射（内部档位 → 各家 API 参数值）
// 映射表声明在 providerRegistry.ts 的 effortMapping 字段中。
// ---------------------------------------------------------------------------

/**
 * 将内部 effort 档位映射为目标 provider 的 API 参数值。
 * 优先级：模型级 effortMap（model-capabilities.json）→ provider 级 effortMapping。
 * 没有配置 effortMapping 的 provider 不支持 effort，返回 undefined。
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
  // 1. 模型级映射（用户本地配置优先）
  if (model) {
    const modelMap = getLocalModelEffortMap(model)
    if (modelMap && key in modelMap) {
      return modelMap[key]!
    }
  }
  // 2. Provider 级映射
  const map = getProviderEffortMapping(providerId)
  return map?.[key]
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
  // 1. 本地配置覆盖
  const local = getLocalModelEffortLevels(model)
  if (local && local.length > 0) {
    const levels = [...local] as EffortLevel[]

    // preserve: "optional" 需要 ultra 来触发 preserve_thinking 回传
    if (!levels.includes('ultra')) {
      const preserve = getLocalModelPreserveThinking(model)
      if (preserve === 'optional') {
        levels.push('ultra')
      }
    }

    return levels
  }

  // 2. provider 声明（effortMapping 的 key 即为支持的档位）
  const entry = getProviderEntry(getAPIProvider())
  if (entry?.effortMapping) {
    return Object.keys(entry.effortMapping) as EffortLevel[]
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
  return undefined
}

/**
 * orchestrate 是会话模式标记，不可持久化到 settings.json。
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): PersistableEffortLevel | undefined {
  if (
    value === 'off' ||
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
  return toPersistableEffort(raw as EffortValue)
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
    case 'off':
      return 'Thinking disabled — fastest mode without any reasoning'
    case 'on':
      return 'Thinking enabled — no specific intensity level'
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
    case 'ultra':
      return 'Maximum thinking intensity with thought block preservation'
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
