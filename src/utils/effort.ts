// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from 'src/services/model/providers.js'
import { getProviderEntry } from 'src/services/model/providerRegistry.js'
import { getLocalModelEffortLevels } from './settings/localModelCapabilities.js'
import { isEnvTruthy } from './envUtils.js'
import { isInternalBuild } from './envUtils.js'
export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max'

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'] as const

/**
 * 档位强弱顺序(由弱到强),clamp 时按此顺序寻找最近的合法档。
 * 与 EFFORT_LEVELS 内容一致,单独导出以表明"这是有序的"语义。
 */
export const EFFORT_LEVEL_ORDER: readonly EffortLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]

export type EffortValue = EffortLevel | number

/**
 * 模型支持的 effort 档位列表 —— effort 能力的单一事实源。
 * 优先级链(首个命中即返回):
 *   1. ~/.zy/model-capabilities.json 的 effortLevels 字段(per-model 覆盖)
 *   2. provider 默认: providerEntry.defaultEffortLevels(internal build 用 internalEffortLevels)
 *   3. ZY_CODE_ALWAYS_ENABLE_EFFORT 环境变量强制开启 → 给一个保守全集
 *   4. [] (不支持 effort)
 * @[MODEL LAUNCH]: 在 ~/.zy/model-capabilities.json 为新模型配置 effortLevels
 */
export function getModelEffortLevels(model: string): EffortLevel[] {
  // 1. 本地配置覆盖优先
  const local = getLocalModelEffortLevels(model)
  if (local && local.length > 0) {
    return local
  }

  // 2. provider 默认档位(internal build 可解锁 max 等扩展档位)
  const entry = getProviderEntry(getAPIProvider())
  const providerLevels =
    isInternalBuild() && entry?.internalEffortLevels
      ? entry.internalEffortLevels
      : entry?.defaultEffortLevels
  if (providerLevels && providerLevels.length > 0) {
    return [...providerLevels]
  }

  // 3. 环境变量强制开启(未指定具体档位时给保守全集)
  if (isEnvTruthy(process.env.ZY_CODE_ALWAYS_ENABLE_EFFORT)) {
    return isInternalBuild() ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high']
  }

  // 4. 不支持 effort
  return []
}

export function modelSupportsEffort(model: string): boolean {
  return getModelEffortLevels(model).length > 0
}

export function modelSupportsMaxEffort(model: string): boolean {
  return getModelEffortLevels(model).includes('max')
}

/**
 * 将请求的 effort 档位 clamp 到模型实际支持的档位集合内。
 * 命中则原样返回;否则按 EFFORT_LEVEL_ORDER 先向下(更弱)、再向上(更强)
 * 找最近的合法档;supported 为空返回 undefined(表示不应发送 effort)。
 */
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
    // 未知档位:返回支持集合里最强的一档
    return EFFORT_LEVEL_ORDER.filter((l) => supported.includes(l)).at(-1)
  }
  // 先向下找更弱的合法档(保持现有 max→high 行为)
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  // 再向上找更强的合法档
  for (let i = idx + 1; i < EFFORT_LEVEL_ORDER.length; i++) {
    if (supported.includes(EFFORT_LEVEL_ORDER[i]!)) {
      return EFFORT_LEVEL_ORDER[i]
    }
  }
  return undefined
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!Number.isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * 数值类型仅用于模型默认值，不会被持久化。
 * 'max' 对外部用户是会话级别的（内部用户可以持久化）。
 * 写入端在保存到设置前调用此函数，以确保 Zod schema
 * （仅接受字符串级别）不会拒绝写入。
 */
export function toPersistableEffort(value: EffortValue | undefined): EffortLevel | undefined {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max' && isInternalBuild()) {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort 在读取时为非内部用户过滤 'max'，
  // 因此手动编辑的 settings.json 不会将会话级别的 max 泄漏到新会话中。
  return toPersistableEffort(getInitialSettings().effortLevel as any)
}

/**
 * 决定当用户在 ModelPicker 中选择模型时，持久化哪个 effort 级别（如有）。
 * 保持先前通过 /effort 显式设置的选项粘性，即使它与所选模型的默认值相同；
 * 同时让纯默认值和会话临时 effort（CLI --effort、EffortCallout 默认值）
 * 回落为 undefined，以便跟随未来的模型默认值变更。
 *
 * priorPersisted 必须来自磁盘上的 userSettings
 * （getSettingsForSource('userSettings')?.effortLevel），而非合并后的设置
 * （project/policy 层会泄漏到用户的全局 settings.json），
 * 也不能来自 AppState.effortValue（包含不会写入 settings.json 的会话级别来源）。
 */
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

/**
 * 解析实际将发送给 API 的 effort 值，遵循完整的优先级链：
 *   环境变量 ZY_CODE_EFFORT_LEVEL → appState.effortValue → 模型默认值
 *
 * 当不应发送 effort 参数时返回 undefined（环境变量设为
 * 'unset'，或模型不存在默认值）。
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved = envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (resolved === undefined) {
    return undefined
  }
  // 数值 effort 仅内部使用,不参与 clamp。
  if (typeof resolved === 'number') {
    return resolved
  }
  // clamp 到模型实际支持的档位集合(取代旧的写死 max→high;
  // 不支持任何档位的模型会得到 undefined,即不发送 effort 参数)。
  return clampEffort(resolved, getModelEffortLevels(model))
}

/**
 * 解析展示给用户的 effort 级别。对 resolveAppliedEffort 进行包装，
 * 添加 'high' 回退值（即 API 在未发送 effort 参数时使用的值）。
 * 作为状态栏和 /effort 输出的唯一事实来源（CC-1088）。
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // 运行时防护：值可能来自远程配置（GrowthBook），TypeScript 类型
    // 无法帮助我们。将未知字符串强制转换为 'high'，而非不加检查地传递。
    return isEffortLevel(value) ? value : 'high'
  }
  if (isInternalBuild() && typeof value === 'number') {
    if (value <= 50) {
      return 'low'
    }
    if (value <= 85) {
      return 'medium'
    }
    if (value <= 100) {
      return 'high'
    }
    return 'max'
  }
  return 'high'
}

/**
 * 获取 effort 级别的用户可见描述
 *
 * @param level 要描述的 effort 级别
 * @returns 人类可读的描述
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'minimal':
      return 'Fastest possible response with very brief reasoning'
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning (Opus 4.6 only)'
  }
}

/**
 * 获取 effort 值（字符串和数值类型）的用户可见描述
 *
 * @param value 要描述的 effort 值
 * @returns 人类可读的描述
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (isInternalBuild() && typeof value === 'number') {
    return `[INNER-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
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

// @[MODEL LAUNCH]: 更新新模型的默认 effort 级别
export function getDefaultEffortForModel(model: string): EffortValue | undefined {
  // 重要：未通知模型发布负责人和研究团队前，请勿更改默认 effort 级别。
  // 默认 effort 是一个敏感设置，可能严重影响模型质量和性能表现。

  // 当 ultrathink 功能开启时，默认 effort 为 medium（ultrathink 会提升到 high）
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // 回退到 undefined，意味着不设置 effort 级别。
  // 在 API 端将解析为 high effort 级别。
  return undefined
}
