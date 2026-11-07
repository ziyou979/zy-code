import type {
  ModelCapabilityEntry,
  TokenLimits,
  ThinkingCapabilityConfig,
} from '../settings/localModelCapabilities.js'
import { isModelInputModality } from './modelInputTypes.js'
import type { PersistableEffortLevel } from '../effort/effortTypes.js'

export type ModelCatalogCapability = Pick<ModelCapabilityEntry, 'capabilities' | 'tokens' | 'costs'>

export function getModelThinkingSupport(
  value: ThinkingCapabilityConfig | undefined,
): boolean | undefined {
  if (!value) {
    return undefined
  }
  if (value.adaptive || value.preserve) {
    return true
  }
  const levels = Array.isArray(value.effort) ? value.effort : value.effort?.levels
  return levels ? levels.some((level) => level !== 'off') : undefined
}

/** 删除界面级 effort 覆盖；没有其他声明时恢复为“能力未知”。 */
export function removeThinkingEffortOverride(
  value: ModelCatalogCapability['capabilities']['thinking'],
): ModelCatalogCapability['capabilities']['thinking'] {
  const thinking = { ...value }
  delete thinking.effort
  return Object.keys(thinking).length > 0 ? thinking : undefined
}

/** 统一字段级合并，右侧的明确声明优先；缺项仍保留左侧结果。 */
export function mergeModelCatalogCapabilities(
  base: ModelCatalogCapability | undefined,
  override: ModelCatalogCapability | undefined,
): ModelCatalogCapability {
  const baseThinking = base?.capabilities.thinking
  const overrideThinking = override?.capabilities.thinking
  // 明确不支持思考时整体替换，不能继承 preserve/adaptive 重新开启思考
  const thinking =
    getModelThinkingSupport(overrideThinking) === false
      ? overrideThinking
      : baseThinking || overrideThinking
        ? { ...baseThinking, ...overrideThinking }
        : undefined
  return {
    capabilities: {
      ...base?.capabilities,
      ...override?.capabilities,
      ...(thinking ? { thinking } : {}),
    },
    ...(base?.tokens || override?.tokens
      ? { tokens: { ...base?.tokens, ...override?.tokens } }
      : {}),
    ...((override?.costs ?? base?.costs) ? { costs: override?.costs ?? base?.costs } : {}),
  }
}

export function isModelCapabilityComplete(capability: ModelCatalogCapability | undefined): boolean {
  return Boolean(
    capability?.capabilities.input?.length &&
      capability.capabilities.thinking?.effort &&
      capability.tokens?.contextWindow &&
      capability.tokens.maxOutputTokens &&
      capability.capabilities.structured_outputs !== undefined,
  )
}

/** 公共目录是独立的数据源；仅转换结构化字段，不推断名称或计费方式。 */
export function extractRegistryModelCapability(
  metadata: Record<string, unknown>,
): ModelCatalogCapability {
  const limits = record(metadata.limit)
  const modalities = record(metadata.modalities)
  const result = extractModelCatalogCapability({
    modalities: {
      input_modalities: Array.isArray(modalities.input)
        ? modalities.input.map((value) => (value === 'pdf' ? 'application/pdf' : value))
        : undefined,
    },
    token_limits: {
      context_window: limits.context,
      max_input_token_length: limits.input,
      max_output_token_length: limits.output,
    },
    features: { structured_outputs: { json_schema: metadata.structured_output } },
  }) ?? { capabilities: {} }
  if (typeof metadata.reasoning === 'boolean') {
    result.capabilities.thinking = { effort: metadata.reasoning ? ['on'] : ['off'] }
  }
  if (metadata.reasoning === true && Array.isArray(metadata.reasoning_options)) {
    const option = metadata.reasoning_options.map(record).find((item) => item.type === 'effort')
    const values = Array.isArray(option?.values) ? option.values : []
    const levels: PersistableEffortLevel[] = []
    const map: Record<string, string> = {}
    if (values.includes('none')) levels.push('off')
    for (const [level, value] of [
      ['quick', 'minimal'],
      ['light', 'low'],
      ['balanced', 'medium'],
      ['thorough', 'high'],
    ] as const) {
      if (values.includes(value)) {
        levels.push(level)
        map[level] = value
      }
    }
    // 内部 extreme 对应此模型声明的最强强度，不能凭模型名猜测 xhigh/max 支持。
    const strongest = values.includes('max')
      ? 'max'
      : values.includes('xhigh')
        ? 'xhigh'
        : undefined
    if (strongest) {
      levels.push('extreme')
      map.extreme = strongest
    }
    if (Object.keys(map).length) result.capabilities.thinking = { effort: { levels, map } }
    else if (levels.length) result.capabilities.thinking = { effort: levels }
  }
  return result
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 只保留目录明确声明的能力；模型名称、描述和缺失字段都不能作为能力证据。 */
export function extractModelCatalogCapability(
  metadata: Record<string, unknown>,
): ModelCatalogCapability | undefined {
  const architecture = record(metadata.architecture)
  const modalities = record(metadata.modalities)
  const features = record(metadata.features)
  const limits = record(metadata.token_limits)
  const topProvider = record(metadata.top_provider)
  const capabilities: ModelCapabilityEntry['capabilities'] = {}
  const tokens: TokenLimits = {}
  const input = architecture.input_modalities ?? modalities.input_modalities
  if (Array.isArray(input)) {
    // 保留目录声明的具体格式；能力元数据不代表本地附件适配器支持所有格式。
    const supported = input.filter(isModelInputModality)
    if (supported.length) capabilities.input = [...new Set(supported)]
  }
  const contextWindow = positiveNumber(
    limits.context_window ?? metadata.context_length ?? metadata.inputTokenLimit,
  )
  const maxInputTokens = positiveNumber(limits.max_input_token_length ?? metadata.inputTokenLimit)
  const maxOutputTokens = positiveNumber(
    limits.max_output_token_length ??
      topProvider.max_completion_tokens ??
      metadata.outputTokenLimit,
  )
  const maxThinkingTokens = positiveNumber(limits.max_reasoning_token_length)
  if (contextWindow) tokens.contextWindow = contextWindow
  if (maxInputTokens) tokens.maxInputTokens = maxInputTokens
  if (maxOutputTokens) tokens.maxOutputTokens = maxOutputTokens
  if (maxThinkingTokens) tokens.maxThinkingTokens = maxThinkingTokens
  const parameters = Array.isArray(metadata.supported_parameters)
    ? metadata.supported_parameters
    : []
  if (maxThinkingTokens || parameters.includes('reasoning')) {
    // 目录只证明能思考，不证明能关闭或支持哪些强度，先使用平台默认强度。
    capabilities.thinking = { effort: ['on'] }
  }
  const structured = record(features.structured_outputs).json_schema
  if (typeof structured === 'boolean') capabilities.structured_outputs = structured
  else if (parameters.includes('structured_outputs')) capabilities.structured_outputs = true
  // response_format 也可能仅支持 JSON mode，不能据此宣称严格 schema 支持。
  if (!Object.keys(capabilities).length && !Object.keys(tokens).length) return undefined
  return { capabilities, ...(Object.keys(tokens).length ? { tokens } : {}) }
}
