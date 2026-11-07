import { buildProxiedFetch } from '../http/proxy.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  getManualModelCapability,
  type ModelCapabilityMatchContext,
} from '../settings/localModelCapabilities.js'
import { getDiscoveredModelCapabilitySnapshot } from '../settings/discoveredModelCapabilities.js'
import {
  resolveDefaultModelsUrl,
  resolveVertexModelsUrl,
  type DiscoveredModel,
  type FetchProviderModelsOptions,
} from './fetchProviderModels.js'
import {
  extractRegistryModelCapability,
  isModelCapabilityComplete,
  mergeModelCatalogCapabilities,
  type ModelCatalogCapability,
} from './modelCatalogCapabilities.js'

export type ModelCapabilityResolution = {
  automatic?: ModelCatalogCapability
  base: ModelCatalogCapability
  effective: ModelCatalogCapability
  overrides?: ModelCatalogCapability
  source: 'catalog' | 'registry' | 'local' | 'unknown'
  catalogIssue?: 'timeout' | 'unavailable' | 'not-found'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// 这里只映射平台标识，不维护任何模型名或能力表；模型内容由动态目录提供。
const PROVIDER_IDS: Record<string, string> = {
  ark: 'volcengine',
  bedrock: 'amazon-bedrock',
  dashscope: 'alibaba-cn',
  fireworks: 'fireworks-ai',
  gemini: 'google',
  'gemini-oauth': 'google',
  kimi: 'moonshotai-cn',
  nim: 'nvidia',
  tencent: 'tencent-coding-plan',
  together: 'togetherai',
  vertex: 'google-vertex',
  zhipu: 'zhipuai',
}

function endpointPrefix(base: string, target: string): boolean {
  try {
    const expected = new URL(base)
    const actual = new URL(target)
    const prefix = expected.pathname.replace(/\/+$/, '')
    return (
      expected.origin === actual.origin &&
      (actual.pathname === prefix || actual.pathname.startsWith(prefix + '/'))
    )
  } catch {
    return false
  }
}

/** 优先匹配平台和端点，未命中时用其他平台完全相同的模型 ID 填充能力。 */
export function findRegistryModel(
  data: unknown,
  options: Pick<FetchProviderModelsOptions, 'provider' | 'baseUrl' | 'apiFormat'>,
  model: string,
): Record<string, unknown> | undefined {
  const matched = findProviderRegistryModel(data, options, model)
  if (matched) return matched

  // 跨平台结果只作为可编辑默认值；按目录顺序取首个精确匹配，不混合不同平台的字段。
  for (const provider of Object.values(record(data))) {
    const fallback = getExactModel(provider, model)
    if (fallback) return fallback
  }
  return undefined
}

/** 同一域名可能有普通 API 和订阅计划，优先按完整端点路径区分。 */
function findProviderRegistryModel(
  data: unknown,
  options: Pick<FetchProviderModelsOptions, 'provider' | 'baseUrl' | 'apiFormat'>,
  model: string,
): Record<string, unknown> | undefined {
  const catalog = record(data)
  const providerId = PROVIDER_IDS[options.provider] ?? options.provider
  if (options.baseUrl) {
    if (options.provider === 'vertex' && resolveVertexModelsUrl(options.baseUrl)) {
      return getExactModel(catalog[providerId], model)
    }
    const matches = Object.entries(catalog)
      .filter(
        ([, value]) =>
          typeof record(value).api === 'string' &&
          endpointPrefix(record(value).api as string, options.baseUrl!),
      )
      .sort((a, b) => String(record(b[1]).api).length - String(record(a[1]).api).length)
    if (matches.length) {
      const longest = String(record(matches[0]![1]).api).length
      const specific = matches.filter(([, value]) => String(record(value).api).length === longest)
      const provider =
        specific.find(([id]) => id === providerId)?.[1] ??
        (specific.length === 1 ? specific[0]![1] : undefined)
      return provider ? getExactModel(provider, model) : undefined
    }
    // SDK 官方 provider 的公共目录可能没有 api 字段，只允许其官方端点匹配。
    const defaultUrl = resolveDefaultModelsUrl(options.provider, undefined, options.apiFormat)
    if (!defaultUrl || !endpointPrefix(defaultUrl.replace(/\/models$/, ''), options.baseUrl))
      return undefined
  }
  return getExactModel(catalog[providerId], model)
}

function getExactModel(provider: unknown, model: string): Record<string, unknown> | undefined {
  const value = record(record(provider).models)[model]
  const result = record(value)
  return Object.keys(result).length && (result.id === undefined || result.id === model)
    ? result
    : undefined
}

/** 选择模型时解析能力：平台目录 → 动态公共目录 → 手工覆盖；不发送推理请求。 */
export async function resolveModelCapabilities(
  model: DiscoveredModel,
  options: FetchProviderModelsOptions & { connectionId: string; refresh?: boolean },
): Promise<ModelCapabilityResolution> {
  const context: ModelCapabilityMatchContext = {
    provider: options.provider,
    apiFormat: options.apiFormat,
    connectionId: options.connectionId,
  }
  const manual = getManualModelCapability(model.id, context)
  const user = getDiscoveredModelCapabilitySnapshot(model.id, context, 'user')?.entry
  const cached = getDiscoveredModelCapabilitySnapshot(model.id, context)
  let catalogIssue: ModelCapabilityResolution['catalogIssue']
  const complete = (automatic: ModelCatalogCapability | undefined) =>
    mergeModelCatalogCapabilities(mergeModelCatalogCapabilities(automatic, manual), user)
  const result = (
    automatic: ModelCatalogCapability | undefined,
    source: ModelCapabilityResolution['source'],
  ): ModelCapabilityResolution => {
    const base = mergeModelCatalogCapabilities(automatic, manual)
    return {
      automatic,
      base,
      effective: mergeModelCatalogCapabilities(base, user),
      overrides: user,
      source,
      ...(catalogIssue ? { catalogIssue } : {}),
    }
  }
  if (isModelCapabilityComplete(complete(model.capability))) {
    return result(model.capability, model.capability ? 'catalog' : 'local')
  }
  let automatic = model.capability
  let source: ModelCapabilityResolution['source'] = automatic ? 'catalog' : 'unknown'
  const cacheFresh =
    cached?.updatedAt && Date.now() - Date.parse(cached.updatedAt) < 12 * 60 * 60 * 1000
  if (!options.refresh && cacheFresh && isModelCapabilityComplete(complete(cached.entry))) {
    automatic = mergeModelCatalogCapabilities(cached.entry, automatic)
    return result(automatic, cached.source === 'registry' ? 'registry' : 'catalog')
  }
  const catalogUrl = getInitialSettings().modelCapabilityCatalogUrl
  if (catalogUrl !== null) {
    // 公共目录需要下载完整 JSON，跨境连接可能超过平台模型列表的响应时间。
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30000)
    try {
      // 获取整个公开目录，不把用户的私有模型 ID、密钥或连接 URL 发送给公共服务。
      const response = await (buildProxiedFetch() ?? globalThis.fetch)(
        catalogUrl ?? 'https://models.dev/api.json',
        {
          signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
        },
      )
      if (response.ok) {
        const matched = findRegistryModel(await response.json(), options, model.id)
        if (matched) {
          automatic = mergeModelCatalogCapabilities(
            extractRegistryModelCapability(matched),
            automatic,
          )
          source = model.capability ? 'catalog' : 'registry'
        } else {
          catalogIssue = 'not-found'
        }
      } else {
        catalogIssue = 'unavailable'
      }
    } catch (error) {
      // 保留失败原因，让用户区分查询失败和模型未声明能力；取消选择不报错。
      if (!options.signal?.aborted) {
        catalogIssue =
          timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError')
            ? 'timeout'
            : 'unavailable'
      }
    }
  }
  if (!automatic && cached) {
    automatic = cached.entry
    source = cached.source === 'registry' ? 'registry' : 'catalog'
  }
  return result(automatic, automatic ? source : manual || user ? 'local' : source)
}
