import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { z } from 'zod/v4'
import { getLLMAdapter } from '../../services/api/client.js'
import { logForDebugging } from '../debug.js'
import { getZyConfigHomeDir, isInternalBuild } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { jsonStringify } from '../slowOperations.js'
import { ALL_MODEL_CONFIGS_WITH_COSTS } from './configs.js'
import {
  getAPIProvider,
  getModelCostsFromSettings,
  isAnthropicBaseUrl,
  providerHasCapability,
} from './providers.js'

// .strip() —— 不将内部专用字段（mycro_deployments 等）持久化到磁盘
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
      /** 每百万 token 定价（人民币，静态配置） */
      cost_input: z.number().optional(),
      cost_output: z.number().optional(),
      cost_cache_write: z.number().optional(),
      cost_cache_read: z.number().optional(),
      cost_web_search: z.number().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilitySchema()),
    timestamp: z.number(),
  }),
)

export type ModelCapability = z.infer<ReturnType<typeof ModelCapabilitySchema>>

function getCacheDir(): string {
  return join(getZyConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  return join(getCacheDir(), 'model-capabilities.json')
}

function isModelCapabilitiesEligible(): boolean {
  if (!isInternalBuild()) {
    return false
  }
  if (!providerHasCapability(getAPIProvider(), 'prompt_caching')) {
    return false
  }
  if (!isAnthropicBaseUrl()) {
    return false
  }
  return true
}

// 最长 ID 优先匹配，使子串匹配偏向最精确的结果；次级排序键确保 isEqual 稳定
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id))
}

// 以缓存路径为 key，使设置了 ZY_CONFIG_DIR 的测试能获得新的读取
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- 已 memoize；从同步方法 getContextWindowForModel 调用
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  (path) => path,
)

/**
 * 获取模型的定价信息。解析顺序：
 * 1. settings.json 中用户定义的 modelCapabilities 费用
 * 2. 静态配置注册表（ALL_MODEL_CONFIGS_WITH_COSTS）
 * 两者均无定价时返回 null。
 *
 * @param currentInputTokens 当前累计输入 token 总量（用于阶梯费用定价）
 */
export function getStaticPricingForModel(
  model: string,
  currentInputTokens?: number,
): {
  cost_input: number
  cost_output: number
  cost_cache_write: number
  cost_cache_read: number
  cost_web_search: number
} | null {
  // 优先级 1：用户 settings（支持阶梯费用）
  const userCosts = getModelCostsFromSettings(model, currentInputTokens)
  if (userCosts) {
    return {
      cost_input: userCosts.inputTokens,
      cost_output: userCosts.outputTokens,
      cost_cache_write: userCosts.promptCacheWriteTokens,
      cost_cache_read: userCosts.promptCacheReadTokens,
      cost_web_search: userCosts.webSearchRequests,
    }
  }

  // 优先级 2：静态配置注册表
  const lower = model.toLowerCase()
  for (const entry of Object.values(ALL_MODEL_CONFIGS_WITH_COSTS)) {
    const canonical = entry.config.anthropic.toLowerCase()
    if (lower === canonical || lower.includes(canonical)) {
      const c = entry.costs
      return {
        cost_input: c.inputTokens,
        cost_output: c.outputTokens,
        cost_cache_write: c.promptCacheWriteTokens,
        cost_cache_read: c.promptCacheReadTokens,
        cost_web_search: c.webSearchRequests,
      }
    }
  }
  return null
}

/**
 * 获取模型能力信息（上下文限制 + 定价）。
 * 定价优先从静态配置解析，然后从缓存解析。
 * 适用于所有用户 —— 静态定价始终可用，
 * 缓存仅为启用 prompt_caching 的内部用户加载。
 */
export function getModelCapability(model: string): ModelCapability | undefined {
  // 始终优先尝试静态定价
  const staticPricing = getStaticPricingForModel(model)

  const cached = loadCache(getCachePath())
  if (!cached || cached.length === 0) {
    return staticPricing ? { id: model, ...staticPricing } : undefined
  }

  const m = model.toLowerCase()
  const exact = cached.find((c) => c.id.toLowerCase() === m)
  const matched = exact ?? cached.find((c) => m.includes(c.id.toLowerCase()))
  if (!matched) {
    return staticPricing ? { id: model, ...staticPricing } : undefined
  }

  // 合并：静态定价优先（缓存可能没有定价信息）
  if (staticPricing) {
    return { ...matched, ...staticPricing }
  }
  return matched
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) {
    return
  }
  if (isEssentialTrafficOnly()) {
    return
  }

  try {
    const adapter = getLLMAdapter()
    if (!adapter.listModels) {
      return
    }
    const rawModels = await adapter.listModels()
    if (!rawModels || rawModels.length === 0) {
      return
    }
    const parsed: ModelCapability[] = []
    for (const entry of rawModels) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (result.success) {
        parsed.push(result.data)
      }
    }
    if (parsed.length === 0) {
      return
    }

    const path = getCachePath()
    const models = sortForMatching(parsed)
    if (isEqual(loadCache(path), models)) {
      logForDebugging('[modelCapabilities] cache unchanged, skipping write')
      return
    }

    await mkdir(getCacheDir(), { recursive: true })
    await writeFile(path, jsonStringify({ models, timestamp: Date.now() }), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    loadCache.cache.delete(path)
    logForDebugging(`[modelCapabilities] cached ${models.length} models`)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}
