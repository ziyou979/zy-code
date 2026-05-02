/**
 * 本地模型能力配置文件加载器。
 *
 * 配置文件路径：~/.zy/model-capabilities.json
 *
 * 用户每接入一个新模型，在此文件中添加一条配置即可。
 * pattern 为大小写不敏感的 substring match。
 *
 * TODO: 后续由自建能力平台替代此本地配置，改为运行时查询。
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod/v4'
import { getZyConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import type { ProviderCapability } from '../model/providers.js'

type ModelCapabilityKind = ProviderCapability | 'auto_mode'

/**
 * 解析 token 数量字符串，支持 "256k"、"1m"、"4096" 等格式。
 * k = 1024, m = 1024 * 1024
 * 如果是纯数字字符串直接解析，如果是 number 直接返回。
 * 解析失败返回 NaN（区分"未配置"的 undefined 和"配置格式错误"的 NaN）。
 */
export function parseTokenCount(value: string | number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN
  }
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return NaN

  const multipliers: Record<string, number> = { k: 1024, m: 1024 * 1024 }
  const suffix = trimmed.at(-1)

  if (suffix && suffix in multipliers) {
    const num = parseFloat(trimmed.slice(0, -1))
    return Number.isFinite(num) ? Math.round(num * multipliers[suffix]) : NaN
  }

  const num = parseFloat(trimmed)
  return Number.isFinite(num) ? num : NaN
}

/** 用于 Schema 验证的 token 数量类型：number 或 string */
const TokenCountSchema = z.union([z.number(), z.string()])

const ModelCapabilityEntrySchema = lazySchema(() =>
  z.object({
    pattern: z
      .string()
      .describe('模型匹配模式（大小写不敏感的 substring match，如 "qwen3.6-max"、"gpt-4o"）'),
    capabilities: z
      .array(
        z.enum([
          'thinking',
          'adaptive_thinking',
          'effort',
          'max_effort',
          'advisor',
          'structured_outputs',
          'context_management',
          'prompt_caching',
          'web_search',
          'interleaved_thinking',
          'auto_mode',
        ]),
      )
      .describe('模型支持的能力列表'),
    maxOutputTokens: TokenCountSchema.optional().describe(
      '模型支持的最大输出 tokens（单次响应上限），支持数字或 "256k"、"1m" 格式',
    ),
    maxInputTokens: TokenCountSchema.optional().describe(
      'API 允许的最大输入 tokens，支持数字或 "256k"、"1m" 格式',
    ),
    contextWindow: TokenCountSchema.optional().describe(
      '模型上下文窗口总大小（input + output），用于自动压缩和用量计算，支持数字或 "200k"、"1m" 格式',
    ),
    maxThinkingTokens: TokenCountSchema.optional().describe(
      '思维链最大 token 数（budget_tokens），未配置时默认为 maxOutputTokens - 1，支持数字或 "16k" 格式',
    ),
    costs: z
      .union([
        // 固定单价（向后兼容）
        z.object({
          inputTokens: z.number().describe('每百万输入 token 费用（元）'),
          outputTokens: z.number().describe('每百万输出 token 费用（元）'),
          promptCacheWriteTokens: z.number().optional().describe('每百万缓存写入 token 费用（元）'),
          promptCacheReadTokens: z.number().optional().describe('每百万缓存读取 token 费用（元）'),
          webSearchRequests: z.number().optional().describe('每次网络搜索费用（元）'),
        }),
        // 阶梯费用：根据输入 token 总量分段计价
        z.object({
          tiers: z
            .array(
              z.object({
                upTo: TokenCountSchema.describe(
                  '此阶梯的输入 token 上限，支持 "128k"、"1m" 等格式',
                ),
                inputTokens: z.number().describe('此阶梯内每百万输入 token 费用（元）'),
                outputTokens: z.number().describe('此阶梯内每百万输出 token 费用（元）'),
                promptCacheWriteTokens: z
                  .number()
                  .optional()
                  .describe('此阶梯内每百万缓存写入 token 费用（元）'),
                promptCacheReadTokens: z
                  .number()
                  .optional()
                  .describe('此阶梯内每百万缓存读取 token 费用（元）'),
              }),
            )
            .describe('按输入 token 总量分段计价的阶梯列表（从低到高排序）'),
          webSearchRequests: z.number().optional().describe('每次网络搜索费用（元）'),
        }),
      ])
      .optional()
      .describe('模型定价配置（单位：元/百万 token），支持固定单价或阶梯费用'),
  }),
)

const ModelCapabilitiesFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilityEntrySchema()),
  }),
)

export type ModelCapabilityEntry = z.infer<ReturnType<typeof ModelCapabilityEntrySchema>>

export type ModelCapabilitiesFile = z.infer<ReturnType<typeof ModelCapabilitiesFileSchema>>

function getConfigPath(): string {
  return join(getZyConfigHomeDir(), 'model-capabilities.json')
}

/**
 * 加载本地模型能力配置文件。
 * 返回 null 表示文件不存在或解析失败。
 */
export function loadLocalModelCapabilities(): ModelCapabilitiesFile | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const parsed = safeParseJSON(raw, false)
    const result = ModelCapabilitiesFileSchema().safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * 从本地配置中查找模型能力条目。
 * 返回第一个匹配 pattern 的条目，未匹配返回 undefined。
 */
export function getLocalModelCapability(model: string): ModelCapabilityEntry | undefined {
  const config = loadLocalModelCapabilities()
  if (!config) return undefined
  const m = model.toLowerCase()
  return config.models.find((entry) => m.includes(entry.pattern.toLowerCase()))
}

/**
 * 从本地配置检查模型是否支持某项能力。
 */
export function localModelHasCapability(model: string, capability: ModelCapabilityKind): boolean {
  const entry = getLocalModelCapability(model)
  return entry?.capabilities.includes(capability as never) ?? false
}

/**
 * 从本地配置获取模型的最大输出 tokens（单次响应上限）。
 * 未配置或格式错误时返回 NaN。
 * 支持 "256k"、"1m" 等字符串格式。
 */
export function getLocalMaxOutputTokens(model: string): number {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxOutputTokens) return NaN
  return parseTokenCount(entry.maxOutputTokens)
}

/**
 * 从本地配置获取 maxInputTokens（API 允许的最大输入 tokens）。
 * 未配置或格式错误时返回 NaN。
 * 支持 "256k"、"1m" 等字符串格式。
 */
export function getLocalMaxInputTokens(model: string): number {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxInputTokens) return NaN
  return parseTokenCount(entry.maxInputTokens)
}

/**
 * 从本地配置获取上下文窗口大小（用于自动压缩和用量计算）。
 * 未配置或格式错误时返回 NaN。
 * 支持 "200k"、"1m" 等字符串格式。
 */
export function getLocalContextWindow(model: string): number {
  const entry = getLocalModelCapability(model)
  if (!entry?.contextWindow) return NaN
  return parseTokenCount(entry.contextWindow)
}

/**
 * 从本地配置获取思维链最大 token 数（budget_tokens）。
 * 未配置或格式错误时返回 NaN。
 * 支持 "16k" 等字符串格式。
 */
export function getLocalMaxThinkingTokens(model: string): number {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxThinkingTokens) return NaN
  return parseTokenCount(entry.maxThinkingTokens)
}

/**
 * 从本地配置获取模型定价。
 * 支持固定单价和阶梯费用两种格式。
 *
 * 对于阶梯费用，根据当前累计输入 token 总量确定当前单价。
 * @param model 模型名称
 * @param currentInputTokens 当前累计输入 token 总量（用于确定阶梯）
 */
export function getLocalModelCosts(
  model: string,
  currentInputTokens?: number,
):
  | {
      inputTokens: number
      outputTokens: number
      promptCacheWriteTokens: number
      promptCacheReadTokens: number
      webSearchRequests: number
    }
  | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.costs) return undefined

  // 判断是固定单价还是阶梯费用
  if ('tiers' in entry.costs) {
    // 阶梯费用模式
    const tiers = entry.costs.tiers
    if (!tiers || tiers.length === 0) return undefined

    const usage = currentInputTokens ?? 0

    // 找到当前使用量对应的阶梯
    let activeTier = tiers[tiers.length - 1] // 默认最后一个阶梯
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
    }
  }

  // 固定单价模式（向后兼容）
  return {
    inputTokens: entry.costs.inputTokens,
    outputTokens: entry.costs.outputTokens,
    promptCacheWriteTokens: entry.costs.promptCacheWriteTokens ?? 0,
    promptCacheReadTokens: entry.costs.promptCacheReadTokens ?? 0,
    webSearchRequests: entry.costs.webSearchRequests ?? 0,
  }
}
