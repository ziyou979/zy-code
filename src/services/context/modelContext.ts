// biome-ignore-all assist/source/organizeImports: ANT-ONLY import 标记不可重排序
import { getModelCapability } from 'src/services/model/modelCapabilities.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  getLocalMaxOutputTokens,
  getLocalContextWindow,
  getLocalMaxThinkingTokens,
} from '../settings/localModelCapabilities.js'

// 默认上下文窗口大小（200k tokens）
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// compact 操作的最大输出 token 数
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// 通用默认值（当模型未配置 maxOutputTokens 时）
const _MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// 默认 max output token 计算公式中的默认参数
const DEFAULT_MAX_OUTPUT_TOKEN_RATIO = 0.75
const DEFAULT_MIN_DEFAULT_MAX_OUTPUT_TOKENS = 8_000

// 保留给 query.ts 截断重试机制使用
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * 获取模型的上下文窗口大小。
 * 仅读取 contextWindow 配置，未配置时返回默认值 200k。
 */
export function getContextWindowForModel(model: string): number {
  const localContextWindow = getLocalContextWindow(model)
  if (localContextWindow >= 100_000) {
    return localContextWindow
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * 根据 token 使用数据计算上下文窗口使用百分比。
 * 返回已用和剩余百分比，如果没有使用数据则返回 null。
 */
export function calculateContextPercentages(
  currentUsage: {
    inputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.inputTokens +
    currentUsage.cacheCreationInputTokens +
    currentUsage.cacheReadInputTokens

  const usedPercentage = Math.round((totalInputTokens / contextWindowSize) * 100)
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * 返回模型的默认值和上限 max output tokens。
 *
 * 优先级：
 * 1. ~/.zy/model-capabilities.json 本地模型能力配置（单个 maxOutputTokens 数值）
 * 2. API 缓存的 max_tokens
 * 3. 通用默认值（32000 / 64000）
 *
 * 计算公式：
 * - upperLimit = maxOutputTokens（模型配置值或 API 缓存值）
 * - default = min(upperLimit * ratio, cap)
 *   - ratio: settings.json 中 defaultMaxOutputTokenRatio（默认 0.75）
 *   - cap: settings.json 中 minDefaultMaxOutputTokens（默认 8000）
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  // 1. 从本地配置获取模型的 maxOutputTokens
  const localValue = getLocalMaxOutputTokens(model)

  // 确定 upperLimit（优先本地配置，其次 API 缓存，最后通用默认值）
  let upperLimit: number
  if (Number.isFinite(localValue) && localValue >= 4_096) {
    upperLimit = localValue
  } else {
    const cap = getModelCapability(model)
    if (cap?.max_tokens && cap.max_tokens >= 4_096) {
      upperLimit = cap.max_tokens
    } else {
      upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
    }
  }

  // 2. 读取 settings.json 中的全局配置
  const settings = getInitialSettings()
  const ratio = settings.defaultMaxOutputTokenRatio ?? DEFAULT_MAX_OUTPUT_TOKEN_RATIO
  const cap = settings.minDefaultMaxOutputTokens ?? DEFAULT_MIN_DEFAULT_MAX_OUTPUT_TOKENS

  // 3. 计算 default
  const calculatedDefault = Math.min(Math.round(upperLimit * ratio), cap)

  return {
    default: calculatedDefault,
    upperLimit,
  }
}

/**
 * 返回给定模型的最大思考 token 预算。最大思考 token 数
 * 应严格小于最大输出 token 数。
 *
 * 优先级：
 * 1. ~/.zy/model-capabilities.json 中手动配置的 maxThinkingTokens
 * 2. 默认：maxOutputTokens.upperLimit - 1
 *
 * 已废弃：较新的模型使用自适应思考模式，而非固定的思考 token 预算。
 */
export function getMaxThinkingTokensForModel(model: string): number {
  const localThinkingTokens = getLocalMaxThinkingTokens(model)
  if (Number.isFinite(localThinkingTokens)) {
    return localThinkingTokens
  }
  return getModelMaxOutputTokens(model).upperLimit - 1
}
