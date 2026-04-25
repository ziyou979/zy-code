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

type ModelCapabilityKind =
  | ProviderCapability
  | '1m_context'
  | 'auto_mode'

const ModelCapabilityEntrySchema = lazySchema(() =>
  z.object({
    pattern: z
      .string()
      .describe(
        '模型匹配模式（大小写不敏感的 substring match，如 "qwen3.6-max"、"gpt-4o"）',
      ),
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
          '1m_context',
          'auto_mode',
        ]),
      )
      .describe('模型支持的能力列表'),
    maxOutputTokens: z
      .object({
        default: z.number().describe('默认最大输出 tokens'),
        upperLimit: z
          .number()
          .optional()
          .describe('最大输出 tokens 上限，默认等于 default'),
      })
      .optional()
      .describe('最大输出 tokens 配置'),
    maxInputTokens: z
      .number()
      .optional()
      .describe('最大输入 tokens'),
    costs: z
      .object({
        inputTokens: z.number().describe('每百万输入 token 费用（元）'),
        outputTokens: z.number().describe('每百万输出 token 费用（元）'),
        promptCacheWriteTokens: z
          .number()
          .optional()
          .describe('每百万缓存写入 token 费用（元）'),
        promptCacheReadTokens: z
          .number()
          .optional()
          .describe('每百万缓存读取 token 费用（元）'),
        webSearchRequests: z
          .number()
          .optional()
          .describe('每次网络搜索费用（元）'),
      })
      .optional()
      .describe('模型定价配置（单位：元/百万 token）'),
  }),
)

const ModelCapabilitiesFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilityEntrySchema()),
  }),
)

export type ModelCapabilityEntry = z.infer<
  ReturnType<typeof ModelCapabilityEntrySchema>
>

export type ModelCapabilitiesFile = z.infer<
  ReturnType<typeof ModelCapabilitiesFileSchema>
>

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
export function getLocalModelCapability(
  model: string,
): ModelCapabilityEntry | undefined {
  const config = loadLocalModelCapabilities()
  if (!config) return undefined
  const m = model.toLowerCase()
  return config.models.find(entry =>
    m.includes(entry.pattern.toLowerCase()),
  )
}

/**
 * 从本地配置检查模型是否支持某项能力。
 */
export function localModelHasCapability(
  model: string,
  capability: ModelCapabilityKind,
): boolean {
  const entry = getLocalModelCapability(model)
  return entry?.capabilities.includes(capability as never) ?? false
}

/**
 * 从本地配置获取模型的 maxOutputTokens。
 */
export function getLocalMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.maxOutputTokens) return undefined
  return {
    default: entry.maxOutputTokens.default,
    upperLimit:
      entry.maxOutputTokens.upperLimit ?? entry.maxOutputTokens.default,
  }
}

/**
 * 从本地配置获取模型定价。
 */
export function getLocalModelCosts(model: string): {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
} | undefined {
  const entry = getLocalModelCapability(model)
  if (!entry?.costs) return undefined
  return {
    inputTokens: entry.costs.inputTokens,
    outputTokens: entry.costs.outputTokens,
    promptCacheWriteTokens: entry.costs.promptCacheWriteTokens ?? 0,
    promptCacheReadTokens: entry.costs.promptCacheReadTokens ?? 0,
    webSearchRequests: entry.costs.webSearchRequests ?? 0,
  }
}
