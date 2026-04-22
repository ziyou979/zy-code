import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { getLLMClient } from '../../services/api/client.js'
import { logForDebugging } from '../debug.js'
import { getZyConfigHomeDir, isInternalBuild } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { jsonStringify } from '../slowOperations.js'
import { ALL_MODEL_CONFIGS_WITH_COSTS } from './configs.js'
import { getAPIProvider, providerHasCapability, isAnthropicBaseUrl, getModelCostsFromSettings } from './providers.js'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
      /** Pricing per million tokens (CNY, static config) */
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
  if (!isInternalBuild()) return false
  if (!providerHasCapability(getAPIProvider(), 'prompt_caching')) return false
  if (!isAnthropicBaseUrl()) return false
  return true
}

// Longest-id-first so substring match prefers most specific; secondary key for stable isEqual
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id),
  )
}

// Keyed on cache path so tests that set ZY_CONFIG_DIR get a fresh read
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  path => path,
)

/**
 * Get pricing for a model. Resolution order:
 * 1. User-defined modelCapabilities costs in settings.json
 * 2. Static config registry (ALL_MODEL_CONFIGS_WITH_COSTS)
 * Returns null if neither has pricing.
 */
export function getStaticPricingForModel(model: string): {
  cost_input: number
  cost_output: number
  cost_cache_write: number
  cost_cache_read: number
  cost_web_search: number
} | null {
  // Priority 1: user settings
  const userCosts = getModelCostsFromSettings(model)
  if (userCosts) {
    return {
      cost_input: userCosts.inputTokens,
      cost_output: userCosts.outputTokens,
      cost_cache_write: userCosts.promptCacheWriteTokens,
      cost_cache_read: userCosts.promptCacheReadTokens,
      cost_web_search: userCosts.webSearchRequests,
    }
  }

  // Priority 2: static config registry
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
 * Get model capability (context limits + pricing).
 * Pricing is resolved from static config first, then cache.
 * Works for all users — static pricing is always available,
 * cache is only loaded for ant users with prompt_caching.
 */
export function getModelCapability(model: string): ModelCapability | undefined {
  // Always try static pricing first
  const staticPricing = getStaticPricingForModel(model)

  const cached = loadCache(getCachePath())
  if (!cached || cached.length === 0) {
    return staticPricing ? { id: model, ...staticPricing } : undefined
  }

  const m = model.toLowerCase()
  const exact = cached.find(c => c.id.toLowerCase() === m)
  const matched = exact ?? cached.find(c => m.includes(c.id.toLowerCase()))
  if (!matched) {
    return staticPricing ? { id: model, ...staticPricing } : undefined
  }

  // Merge: static pricing takes precedence (cache may not have pricing)
  if (staticPricing) {
    return { ...matched, ...staticPricing }
  }
  return matched
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
  if (isEssentialTrafficOnly()) return

  try {
    const anthropic = await getLLMClient({ maxRetries: 1 })
    const parsed: ModelCapability[] = []
    for await (const entry of anthropic.models.list({})) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (result.success) parsed.push(result.data)
    }
    if (parsed.length === 0) return

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
