/**
 * 本地模型能力配置文件加载器。
 *
 * 配置文件路径：~/.zy/model-capabilities.json
 *
 * 用户每接入一个新模型，在此文件中添加一条配置即可。
 * pattern 为大小写不敏感的 substring match。
 *
 * capabilities 为结构化对象，支持 bool、string、array、object 等值类型。
 * 思考相关能力（adaptive、preserve、effort）聚合在 thinking 对象内。
 * 非能力字段（token 限制、定价、beta headers）保留在顶层。
 *
 * TODO: 后续由自建能力平台替代此本地配置，改为运行时查询。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { ApiFormat } from '../model/apiFormat.js'
import { API_FORMATS } from '../model/apiFormat.js'
import { CURRENCIES } from '../../types/currency.js'
import type { EffortLevel } from '../effort/effortTypes.js'
import { PERSISTABLE_EFFORT_LEVELS } from '../effort/effortTypes.js'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 模型能力键 — capabilities 对象顶层的合法 key。
 */
export type ModelCapabilityKind =
  | 'thinking' // 思考能力（对象，effort 仅有 "off" 表示不支持）
  | 'structured_outputs' // 严格工具 schema / 结构化输出
  | 'auto_mode' // 自动模式
  | 'prompt_caching' // prompt 缓存（"implicit" | "explicit"）

/**
 * effort 配置（档位 + 可选的 API 映射）。
 */
export type EffortCapabilityConfig = {
  levels: EffortLevel[]
  map?: Record<string, string>
}

/**
 * thinking 能力配置（始终为对象）。
 *
 * - effort 含非 "off" 档位 → 支持思考
 * - effort 仅 ["off"] 或无其他字段 → 不支持思考
 * - adaptive / preserve 存在 → 支持思考（附带子特性）
 */
export type ThinkingCapabilityConfig = {
  /** 是否支持自适应思考模式 */
  adaptive?: boolean
  /** 思考块回传模式 */
  preserve?: 'optional' | 'always'
  /** effort（思考强度）配置 */
  effort?: EffortLevel[] | EffortCapabilityConfig
}

/**
 * 模型能力对象 — 所有能力维度聚合在一个字段中。
 */
export type ModelCapabilities = {
  thinking?: ThinkingCapabilityConfig
  structured_outputs?: boolean
  auto_mode?: boolean
  prompt_caching?: 'implicit' | 'explicit'
}

/**
 * token 限制对象 — 上下文窗口与各类 token 上限。
 */
export type TokenLimits = {
  /** 上下文窗口总大小（input + output） */
  contextWindow?: string | number
  /** API 允许的最大输入 tokens */
  maxInputTokens?: string | number
  /** 单次响应最大输出 tokens */
  maxOutputTokens?: string | number
  /** 思维链最大 token 数（budget_tokens） */
  maxThinkingTokens?: string | number
}

/**
 * 模型能力匹配上下文。
 *
 * provider / apiFormat 都是可选维度，未配置选择器的条目保持全局匹配；
 * 配置了选择器的条目只在当前上下文满足时生效。
 */
export type ModelCapabilityMatchContext = {
  provider?: string | null
  apiFormat?: ApiFormat | null
}

// ---------------------------------------------------------------------------
// Token 解析
// ---------------------------------------------------------------------------

/**
 * 解析 token 数量字符串，支持 "256k"、"1m"、"4096" 等格式。
 * k = 1024, m = 1_000_000
 * 如果是纯数字字符串直接解析，如果是 number 直接返回。
 * 解析失败返回 NaN（区分"未配置"的 undefined 和"配置格式错误"的 NaN）。
 */
export function parseTokenCount(value: string | number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN
  }
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return NaN
  }

  const multipliers: Record<string, number> = { k: 1024, m: 1_000_000 }
  const suffix = trimmed.at(-1)

  if (suffix && suffix in multipliers) {
    const num = parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(num) ? Math.round(num * multipliers[suffix]) : NaN
  }

  const num = parseFloat(trimmed)
  return Number.isFinite(num) ? num : NaN
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/** 用于 Schema 验证的 token 数量类型：number 或 string */
const TokenCountSchema = z.union([z.number(), z.string()])

/** effort 档位枚举 */
const EffortLevelSchema = z.enum(PERSISTABLE_EFFORT_LEVELS)

/** API 协议格式枚举 */
const ApiFormatSchema = z.enum(API_FORMATS)

/** provider / apiFormat 选择器支持单值或多值。 */
const ProviderSelectorSchema = z.union([z.string(), z.array(z.string())])
const ApiFormatSelectorSchema = z.union([ApiFormatSchema, z.array(ApiFormatSchema)])

/** effort 配置 schema（数组或对象写法） */
const EffortSchema = z.union([
  z.array(EffortLevelSchema),
  z.object({
    levels: z.array(EffortLevelSchema).describe('模型支持的 effort 档位列表'),
    map: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        '模型级 effort 档位→API 参数值映射。' +
          '例如 { "light": "high", "balanced": "high", "thorough": "max" }。',
      ),
  }),
])

/** thinking 能力对象 schema */
const ThinkingConfigSchema = z.object({
  adaptive: z.boolean().optional().describe('是否支持自适应思考模式'),
  preserve: z
    .enum(['optional', 'always'])
    .optional()
    .describe(
      '思考块回传模式。' +
        "'optional'：可选，effort 额外增一档时回传。" +
        "'always'：必传，始终回传。",
    ),
  effort: EffortSchema.optional().describe(
    'effort（思考强度）配置。' +
      '简洁写法：档位数组 ["off", "on"]。' +
      '完整写法：{ levels: [...], map: { ... } }。',
  ),
})

/**
 * capabilities 对象 schema —— 每个 key 有独立的值类型约束。
 * 使用 z.object().partial() 使所有字段可选。
 */
const ModelCapabilitiesSchema = lazySchema(() =>
  z
    .object({
      thinking: ThinkingConfigSchema.describe(
        'thinking 能力配置（始终为对象）。' +
          'effort 含非 "off" 档位表示支持思考，仅 ["off"] 表示不支持。',
      ),
      structured_outputs: z.boolean().describe('是否支持严格工具 schema / 结构化输出'),
      auto_mode: z.boolean().describe('是否支持自动模式'),
      prompt_caching: z
        .enum(['implicit', 'explicit'])
        .describe(
          'prompt 缓存模式。' +
            "'implicit'：隐式缓存，由 provider 自动管理。" +
            "'explicit'：显式缓存，需要 cache_control 标记。",
        ),
    })
    .partial(),
)

/**
 * token 限制对象 schema。
 */
const TokenLimitsSchema = z.object({
  contextWindow: TokenCountSchema.optional().describe(
    '模型上下文窗口总大小（input + output），用于自动压缩和用量计算，支持数字或 "200k"、"1m" 格式',
  ),
  maxInputTokens: TokenCountSchema.optional().describe(
    'API 允许的最大输入 tokens，支持数字或 "256k"、"1m" 格式',
  ),
  maxOutputTokens: TokenCountSchema.optional().describe(
    '模型支持的最大输出 tokens（单次响应上限），支持数字或 "256k"、"1m" 格式',
  ),
  maxThinkingTokens: TokenCountSchema.optional().describe(
    '思维链最大 token 数（budget_tokens），未配置时默认为 maxOutputTokens - 1，支持数字或 "16k" 格式',
  ),
})

const ModelCostSchema = z.union([
  // 固定单价（向后兼容）
  z.object({
    currency: z.enum(CURRENCIES).optional().describe('定价货币单位，未配置时默认 CNY'),
    inputTokens: z.number().describe('每百万输入 token 费用'),
    outputTokens: z.number().describe('每百万输出 token 费用'),
    promptCacheWriteTokens: z.number().optional().describe('每百万缓存写入 token 费用'),
    promptCacheReadTokens: z.number().optional().describe('每百万缓存读取 token 费用'),
    webSearchRequests: z.number().optional().describe('每次网络搜索费用'),
  }),
  // 阶梯费用：根据输入 token 总量分段计价
  z.object({
    currency: z.enum(CURRENCIES).optional().describe('定价货币单位，未配置时默认 CNY'),
    tiers: z
      .array(
        z.object({
          upTo: TokenCountSchema.describe('此阶梯的输入 token 上限，支持 "128k"、"1m" 等格式'),
          inputTokens: z.number().describe('此阶梯内每百万输入 token 费用'),
          outputTokens: z.number().describe('此阶梯内每百万输出 token 费用'),
          promptCacheWriteTokens: z
            .number()
            .optional()
            .describe('此阶梯内每百万缓存写入 token 费用'),
          promptCacheReadTokens: z
            .number()
            .optional()
            .describe('此阶梯内每百万缓存读取 token 费用'),
        }),
      )
      .describe('按输入 token 总量分段计价的阶梯列表（从低到高排序）'),
    webSearchRequests: z.number().optional().describe('每次网络搜索费用'),
  }),
])

const ModelCapabilityOverrideSchema = lazySchema(() =>
  z.object({
    apiFormat: ApiFormatSelectorSchema.optional().describe(
      '该 provider 下此模型使用的 API 协议格式',
    ),
    capabilities: ModelCapabilitiesSchema()
      .optional()
      .describe('该 provider 下覆盖或补充的模型能力'),
    tokens: TokenLimitsSchema.optional().describe('该 provider 下覆盖或补充的 token 限制'),
    betaHeaders: z
      .array(z.string())
      .optional()
      .describe('该 provider 下覆盖的 anthropic-beta header 列表'),
    costs: ModelCostSchema.optional().describe('该 provider 下覆盖的模型定价'),
  }),
)

const ModelCapabilityEntrySchema = lazySchema(() =>
  z.object({
    pattern: z
      .string()
      .describe('模型匹配模式（大小写不敏感的 substring match，如 "qwen3.6-max"、"gpt-4o"）'),
    provider: ProviderSelectorSchema.optional().describe(
      '可选 provider 选择器。未配置时匹配所有 provider；配置后仅在对应 provider 下生效。',
    ),
    apiFormat: ApiFormatSelectorSchema.optional().describe(
      '可选 API 协议格式选择器，也可用于声明同一 provider 下该模型应使用的协议格式。',
    ),
    capabilities: ModelCapabilitiesSchema().describe(
      '模型能力配置（结构化对象，支持 bool/string/array/object 值类型）',
    ),
    tokens: TokenLimitsSchema.optional().describe(
      'token 限制配置（上下文窗口、输入/输出/思考上限）',
    ),
    betaHeaders: z
      .array(z.string())
      .optional()
      .describe(
        '为该模型附加的 anthropic-beta header 列表(按模型粒度透传,无需把 beta 串硬编码进代码)。' +
          '仅在端点确实接受这些 beta 时配置——未知 beta 可能导致 400。',
      ),
    costs: ModelCostSchema.optional().describe('模型定价配置，支持固定单价或阶梯费用'),
    providerOverrides: z
      .record(z.string(), ModelCapabilityOverrideSchema())
      .optional()
      .describe(
        '按 provider 覆盖模型能力、token 限制、定价和 apiFormat。用于同一模型在不同 provider 下上下文/价格不同的场景。',
      ),
  }),
)

const ModelCapabilitiesFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilityEntrySchema()),
  }),
)

export type ModelCapabilityEntry = z.infer<ReturnType<typeof ModelCapabilityEntrySchema>>

type ModelCapabilityOverride = z.infer<ReturnType<typeof ModelCapabilityOverrideSchema>>

export type ModelCapabilitiesFile = z.infer<ReturnType<typeof ModelCapabilitiesFileSchema>>

// ---------------------------------------------------------------------------
// 配置加载与迁移
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  return join(getZyConfigHomeDir(), 'model-capabilities.json')
}

/**
 * 迁移垫片：将旧格式就地转为新格式。
 *
 * 处理的旧格式：
 *   1. capabilities 为字符串数组 → 转为对象
 *   2. 顶层 promptCaching / preserveThinking / effortLevels / effortMap → capabilities 内
 *   3. capabilities 内散落的 adaptive_thinking / preserve_thinking / effort → thinking 对象
 *   4. 顶层 contextWindow / maxInputTokens / maxOutputTokens / maxThinkingTokens → limits 对象
 */
function migrateCapabilitiesFormat(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') {
    return
  }
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) {
    return
  }
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const e = entry as Record<string, unknown>

    // 1. capabilities 数组 → 对象
    if (Array.isArray(e.capabilities)) {
      const caps: Record<string, unknown> = {}
      for (const cap of e.capabilities as string[]) {
        if (typeof cap === 'string') {
          caps[cap] = true
        }
      }
      e.capabilities = caps
    }

    // 确保 capabilities 是对象
    if (!e.capabilities || typeof e.capabilities !== 'object') {
      e.capabilities = {}
    }
    const caps = e.capabilities as Record<string, unknown>

    // 2. 顶层字段 → capabilities 内
    if (e.promptCaching !== undefined) {
      caps.prompt_caching ??= e.promptCaching
      delete e.promptCaching
    }
    if (e.preserveThinking !== undefined) {
      // 顶层 preserveThinking → caps.preserve_thinking（中间态，下面再合并到 thinking）
      caps.preserve_thinking ??= e.preserveThinking
      delete e.preserveThinking
    }
    if (e.effortLevels !== undefined || e.effortMap !== undefined) {
      if (caps.effort === undefined) {
        if (e.effortMap !== undefined) {
          caps.effort = {
            levels: e.effortLevels ?? [],
            map: e.effortMap as Record<string, string>,
          }
        } else {
          caps.effort = e.effortLevels
        }
      }
      delete e.effortLevels
      delete e.effortMap
    }

    // 3. thinking 统一为对象格式
    //    thinking: true/false → thinking: { effort: ["off"] }
    //    散落的 adaptive_thinking / preserve_thinking / effort → 合并到 thinking 对象
    //    无 thinking 字段 → 补 thinking: { effort: ["off"] }
    const hasScatteredThinking =
      caps.adaptive_thinking !== undefined ||
      caps.preserve_thinking !== undefined ||
      caps.effort !== undefined

    // 构建 thinking 对象
    let thinkingObj: Record<string, unknown> = {}

    if (typeof caps.thinking === 'object' && caps.thinking !== null) {
      thinkingObj = { ...(caps.thinking as Record<string, unknown>) }
    } else if (caps.thinking === true || caps.thinking === false) {
      // boolean → 对象，effort 默认 ["off"]
      thinkingObj = { effort: ['off'] }
    }

    // 合并散落字段
    if (caps.adaptive_thinking !== undefined) {
      thinkingObj.adaptive ??= caps.adaptive_thinking
      delete caps.adaptive_thinking
    }
    if (caps.preserve_thinking !== undefined) {
      thinkingObj.preserve ??= caps.preserve_thinking
      delete caps.preserve_thinking
    }
    if (caps.effort !== undefined) {
      thinkingObj.effort ??= caps.effort
      delete caps.effort
    }

    // 确保 thinking 始终存在
    if (Object.keys(thinkingObj).length > 0) {
      caps.thinking = thinkingObj
    } else {
      // 没有 thinking 也没有散落字段 → 补默认
      caps.thinking = { effort: ['off'] }
    }

    // 4. 顶层 token 限制字段 → tokens 对象
    const tokenKeys = [
      'contextWindow',
      'maxInputTokens',
      'maxOutputTokens',
      'maxThinkingTokens',
    ] as const
    const hasScatteredTokens = tokenKeys.some((key) => e[key] !== undefined)
    if (hasScatteredTokens || (e.tokens && typeof e.tokens === 'object')) {
      const tokensObj: Record<string, unknown> =
        typeof e.tokens === 'object' && e.tokens !== null
          ? { ...(e.tokens as Record<string, unknown>) }
          : {}

      for (const key of tokenKeys) {
        if (e[key] !== undefined) {
          tokensObj[key] ??= e[key]
          delete e[key]
        }
      }

      if (Object.keys(tokensObj).length > 0) {
        e.tokens = tokensObj
      }
    }
  }
}

/**
 * 加载本地模型能力配置文件。
 * 返回 null 表示文件不存在或解析失败。
 */
export function loadLocalModelCapabilities(): ModelCapabilitiesFile | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    migrateCapabilitiesFormat(parsed)
    const result = ModelCapabilitiesFileSchema().safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * 读取当前 provider / apiFormat 上下文。
 *
 * 此处延迟 require，避免 settings/model provider 初始化阶段形成静态循环依赖。
 */
function getCurrentModelCapabilityContext(): ModelCapabilityMatchContext {
  try {
    const providers = require('../model/providers.js') as typeof import('../model/providers.js')
    const provider = providers.getAPIProvider()
    return {
      provider,
      apiFormat: providers.getEffectiveApiFormat(provider),
    }
  } catch {
    return {}
  }
}

function selectorIncludes(
  selector: string | string[] | undefined,
  value: string | null | undefined,
): boolean {
  if (selector === undefined) {
    return true
  }
  if (!value) {
    return false
  }
  const normalizedValue = value.toLowerCase()
  if (Array.isArray(selector)) {
    return selector.some((item) => item.toLowerCase() === normalizedValue)
  }
  return selector.toLowerCase() === normalizedValue
}

function getProviderOverride(
  entry: ModelCapabilityEntry,
  provider: string | null | undefined,
): ModelCapabilityOverride | undefined {
  if (!provider) {
    return undefined
  }
  return entry.providerOverrides?.[provider]
}

function mergeCapabilities(
  base: ModelCapabilityEntry['capabilities'],
  override: ModelCapabilityOverride['capabilities'] | undefined,
): ModelCapabilityEntry['capabilities'] {
  if (!override) {
    return base
  }
  return {
    ...base,
    ...override,
    thinking:
      base.thinking || override.thinking
        ? {
            ...(base.thinking ?? {}),
            ...(override.thinking ?? {}),
          }
        : undefined,
  }
}

function mergeEntryWithProviderOverride(
  entry: ModelCapabilityEntry,
  override: ModelCapabilityOverride | undefined,
  provider: string | null | undefined,
): ModelCapabilityEntry {
  if (!override) {
    return entry
  }
  return {
    ...entry,
    provider: provider ?? entry.provider,
    apiFormat: override.apiFormat ?? entry.apiFormat,
    capabilities: mergeCapabilities(entry.capabilities, override.capabilities),
    tokens: override.tokens ? { ...(entry.tokens ?? {}), ...override.tokens } : entry.tokens,
    betaHeaders: override.betaHeaders ?? entry.betaHeaders,
    costs: override.costs ?? entry.costs,
  }
}

function getEntrySpecificity(entry: ModelCapabilityEntry, hasProviderOverride = false): number {
  return (hasProviderOverride ? 4 : 0) + (entry.provider ? 2 : 0) + (entry.apiFormat ? 1 : 0)
}

function resolveMatchedEntry(
  entry: ModelCapabilityEntry,
  normalizedModel: string,
  context: ModelCapabilityMatchContext,
  options?: { ignoreApiFormat?: boolean },
): { entry: ModelCapabilityEntry; hasProviderOverride: boolean } | undefined {
  if (!normalizedModel.includes(entry.pattern.toLowerCase())) {
    return undefined
  }

  const override = getProviderOverride(entry, context.provider)
  if (!override && !selectorIncludes(entry.provider, context.provider)) {
    return undefined
  }

  const effectiveEntry = mergeEntryWithProviderOverride(entry, override, context.provider)
  if (!options?.ignoreApiFormat && !selectorIncludes(effectiveEntry.apiFormat, context.apiFormat)) {
    return undefined
  }
  return { entry: effectiveEntry, hasProviderOverride: override !== undefined }
}

/**
 * 从本地配置中查找模型能力条目。
 * 优先选择 provider/apiFormat 更具体、pattern 更长的条目。
 */
export function getLocalModelCapability(
  model: string,
  context?: ModelCapabilityMatchContext,
): ModelCapabilityEntry | undefined {
  if (!model) {
    return undefined
  }
  const config = loadLocalModelCapabilities()
  if (!config) {
    return undefined
  }
  const m = model.toLowerCase()
  const resolvedContext = context ?? getCurrentModelCapabilityContext()
  return config.models
    .map((entry, index) => ({ entry, index }))
    .map(({ entry, index }) => {
      const matched = resolveMatchedEntry(entry, m, resolvedContext)
      return matched ? { ...matched, index } : undefined
    })
    .filter(
      (
        candidate,
      ): candidate is {
        entry: ModelCapabilityEntry
        hasProviderOverride: boolean
        index: number
      } => candidate !== undefined,
    )
    .sort((a, b) => {
      const specificityDelta =
        getEntrySpecificity(b.entry, b.hasProviderOverride) -
        getEntrySpecificity(a.entry, a.hasProviderOverride)
      if (specificityDelta !== 0) {
        return specificityDelta
      }
      const patternDelta = b.entry.pattern.length - a.entry.pattern.length
      if (patternDelta !== 0) {
        return patternDelta
      }
      return a.index - b.index
    })[0]?.entry
}

/**
 * 从本地配置获取模型声明的 API 协议格式。
 * 用于同一 provider 下不同模型走不同协议格式的场景。
 */
export function getLocalModelApiFormat(
  model: string,
  context?: ModelCapabilityMatchContext,
): ApiFormat | undefined {
  if (!model) {
    return undefined
  }
  const config = loadLocalModelCapabilities()
  if (!config) {
    return undefined
  }
  const resolvedContext = context ?? getCurrentModelCapabilityContext()
  const m = model.toLowerCase()
  const entry = config.models
    .map((candidate, index) => ({ entry: candidate, index }))
    .map(({ entry: candidate, index }) => {
      const matched = resolveMatchedEntry(candidate, m, resolvedContext, { ignoreApiFormat: true })
      return matched ? { ...matched, index } : undefined
    })
    .filter(
      (
        candidate,
      ): candidate is {
        entry: ModelCapabilityEntry
        hasProviderOverride: boolean
        index: number
      } => candidate !== undefined,
    )
    .filter(({ entry }) => entry.apiFormat !== undefined)
    .sort((a, b) => {
      const specificityDelta =
        getEntrySpecificity(b.entry, b.hasProviderOverride) -
        getEntrySpecificity(a.entry, a.hasProviderOverride)
      if (specificityDelta !== 0) {
        return specificityDelta
      }
      const patternDelta = b.entry.pattern.length - a.entry.pattern.length
      if (patternDelta !== 0) {
        return patternDelta
      }
      return a.index - b.index
    })[0]?.entry
  const apiFormat = entry?.apiFormat
  return Array.isArray(apiFormat) ? apiFormat[0] : apiFormat
}

// ---------------------------------------------------------------------------
// 能力查询
// ---------------------------------------------------------------------------

/**
 * 从本地配置检查模型是否支持某项能力。
 *
 * thinking 特殊处理：effort 仅含 "off" 且无 adaptive/preserve → 不支持。
 * 其他能力：key 存在且不为 false → 支持。
 */
export function localModelHasCapability(
  model: string,
  capability: ModelCapabilityKind,
  context?: ModelCapabilityMatchContext,
): boolean {
  const entry = getLocalModelCapability(model, context)
  const value = entry?.capabilities?.[capability]
  if (value === undefined || value === false) {
    return false
  }

  // thinking: 检查是否真正支持（effort 仅 ["off"] 且无 adaptive/preserve → 不支持）
  if (capability === 'thinking' && typeof value === 'object' && value !== null) {
    const t = value as ThinkingCapabilityConfig
    if (t.adaptive || t.preserve) {
      return true
    }
    if (!t.effort) {
      return false
    }
    if (Array.isArray(t.effort)) {
      return t.effort.some((l) => l !== 'off')
    }
    // object format: { levels, map }
    return t.effort.levels.some((l) => l !== 'off')
  }

  return true
}

// ---------------------------------------------------------------------------
// thinking 子配置访问器
// ---------------------------------------------------------------------------

/**
 * 获取 thinking 配置对象（始终为对象）。
 */
function getThinkingConfig(
  model: string,
  context?: ModelCapabilityMatchContext,
): ThinkingCapabilityConfig | undefined {
  const entry = getLocalModelCapability(model, context)
  return entry?.capabilities?.thinking
}

/**
 * 检查模型是否支持自适应思考模式。
 */
export function localModelHasAdaptiveThinking(
  model: string,
  context?: ModelCapabilityMatchContext,
): boolean {
  return getThinkingConfig(model, context)?.adaptive === true
}

/**
 * 从本地配置获取模型的 preserve 思考块回传模式。
 */
export function getLocalModelPreserveThinking(
  model: string,
  context?: ModelCapabilityMatchContext,
): 'optional' | 'always' | undefined {
  return getThinkingConfig(model, context)?.preserve
}

/**
 * 从本地配置获取模型支持的 effort 档位列表。
 * 支持 effort 的两种写法：
 *   - 数组：["off", "balanced", "extreme"]
 *   - 对象：{ levels: [...], map: { ... } }
 */
export function getLocalModelEffortLevels(
  model: string,
  context?: ModelCapabilityMatchContext,
): EffortLevel[] | undefined {
  const effort = getThinkingConfig(model, context)?.effort
  if (!effort) {
    return undefined
  }
  if (Array.isArray(effort)) {
    return effort
  }
  return effort.levels
}

/**
 * 从本地配置获取模型级 effort 映射表（内部档位→API 参数值）。
 * 仅当 effort 为对象写法（{ levels, map }）时返回 map。
 */
export function getLocalModelEffortMap(
  model: string,
  context?: ModelCapabilityMatchContext,
): Record<string, string> | undefined {
  const effort = getThinkingConfig(model, context)?.effort
  if (!effort || Array.isArray(effort)) {
    return undefined
  }
  return effort.map
}

// ---------------------------------------------------------------------------
// 其他访问器函数
// ---------------------------------------------------------------------------

/**
 * 从本地配置获取模型的 prompt 缓存模式。
 */
export function getModelPromptCachingMode(
  model: string,
  context?: ModelCapabilityMatchContext,
): 'implicit' | 'explicit' | undefined {
  const entry = getLocalModelCapability(model, context)
  return entry?.capabilities?.prompt_caching
}

/**
 * 从本地配置获取该模型附加的 anthropic-beta header 列表。
 */
export function getLocalModelBetaHeaders(
  model: string,
  context?: ModelCapabilityMatchContext,
): string[] | undefined {
  const entry = getLocalModelCapability(model, context)
  return entry?.betaHeaders
}

/**
 * 从本地配置获取模型的最大输出 tokens（单次响应上限）。
 */
export function getLocalMaxOutputTokens(
  model: string,
  context?: ModelCapabilityMatchContext,
): number {
  const entry = getLocalModelCapability(model, context)
  const value = entry?.tokens?.maxOutputTokens
  if (value === undefined) {
    return NaN
  }
  return parseTokenCount(value)
}

/**
 * 从本地配置获取 maxInputTokens（API 允许的最大输入 tokens）。
 */
export function getLocalMaxInputTokens(
  model: string,
  context?: ModelCapabilityMatchContext,
): number {
  const entry = getLocalModelCapability(model, context)
  const value = entry?.tokens?.maxInputTokens
  if (value === undefined) {
    return NaN
  }
  return parseTokenCount(value)
}

/**
 * 从本地配置获取上下文窗口大小（用于自动压缩和用量计算）。
 */
export function getLocalContextWindow(
  model: string,
  context?: ModelCapabilityMatchContext,
): number {
  const entry = getLocalModelCapability(model, context)
  const value = entry?.tokens?.contextWindow
  if (value === undefined) {
    return NaN
  }
  return parseTokenCount(value)
}

/**
 * 从本地配置获取思维链最大 token 数（budget_tokens）。
 */
export function getLocalMaxThinkingTokens(
  model: string,
  context?: ModelCapabilityMatchContext,
): number {
  const entry = getLocalModelCapability(model, context)
  const value = entry?.tokens?.maxThinkingTokens
  if (value === undefined) {
    return NaN
  }
  return parseTokenCount(value)
}

/**
 * 从本地配置获取模型定价。
 * 支持固定单价和阶梯费用两种格式。
 */
export function getLocalModelCosts(
  model: string,
  currentInputTokens?: number,
  context?: ModelCapabilityMatchContext,
):
  | {
      inputTokens: number
      outputTokens: number
      promptCacheWriteTokens: number
      promptCacheReadTokens: number
      webSearchRequests: number
      currency: string
    }
  | undefined {
  const entry = getLocalModelCapability(model, context)
  if (!entry?.costs) {
    return undefined
  }

  const currency = entry.costs.currency ?? 'CNY'

  if ('tiers' in entry.costs) {
    const tiers = entry.costs.tiers
    if (!tiers || tiers.length === 0) {
      return undefined
    }

    const usage = currentInputTokens ?? 0
    let activeTier = tiers[tiers.length - 1]
    for (const tier of tiers) {
      const upTo = parseTokenCount(tier.upTo)
      if (upTo === undefined || usage <= upTo) {
        activeTier = tier
        break
      }
    }

    return {
      inputTokens: activeTier.inputTokens,
      outputTokens: activeTier.outputTokens,
      promptCacheWriteTokens: activeTier.promptCacheWriteTokens ?? 0,
      promptCacheReadTokens: activeTier.promptCacheReadTokens ?? 0,
      webSearchRequests: entry.costs.webSearchRequests ?? 0,
      currency,
    }
  }

  return {
    inputTokens: entry.costs.inputTokens,
    outputTokens: entry.costs.outputTokens,
    promptCacheWriteTokens: entry.costs.promptCacheWriteTokens ?? 0,
    promptCacheReadTokens: entry.costs.promptCacheReadTokens ?? 0,
    webSearchRequests: entry.costs.webSearchRequests ?? 0,
    currency,
  }
}
