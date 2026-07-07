import { feature } from 'bun:bundle'
import { getSessionId } from '../../bootstrap/state.js'
import { EFFORT_BETA_HEADER, TASK_BUDGETS_BETA_HEADER } from '../../constants/betas.js'
import { getAPIProvider, isAnthropicModel } from '../../services/model/providers.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { shouldIncludeExperimentalBetas } from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { type EffortLevel, mapEffortToProvider, modelSupportsEffort } from '../../utils/effort.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { TaskBudgetParam } from '../../types/llm.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getLLMAdapter } from './client.js'
import type { Options } from './llmOrchestrator.js'

// 定义表示合法 JSON 值的类型
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

// BetaOutputConfig 类型在本文件内重新定义
type BetaOutputConfig = Record<string, unknown>

/**
 * 根据 ZY_CODE_EXTRA_BODY 环境变量（如果存在）和 beta
 * header（主要用于 Bedrock 请求）组装 API 请求的额外 body 参数。
 *
 * @param betaHeaders - 请求中包含的 beta header 数组。
 * @returns 表示额外 body 参数的 JSON 对象。
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 首先解析用户的额外 body 参数
  const extraBodyStr = process.env.ZY_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // 解析为 JSON，可以是 null、布尔值、数字、字符串、数组或对象
      const parsed = safeParseJSON(extraBodyStr)
      // 我们期望得到一个键值对对象，以便展开到 API 参数中
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅克隆 — safeParseJSON 使用 LRU 缓存，对相同字符串返回同一对象引用。
        // 修改 `result` 会污染缓存，导致值过期。
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `ZY_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(`Error parsing ZY_CODE_EXTRA_BODY: ${errorMessage(error)}`, {
        level: 'error',
      })
    }
  }

  // 反蒸馏：仅对直接 API CLI 发送 fake_tools  opt-in
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.ZY_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeExperimentalBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE('zy_anti_distill_fake_tool_injection', false)
      : false
  ) {
    result.anti_distillation = ['fake_tools']
  }

  // 处理 beta headers（如果提供）
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // 添加到现有数组，避免重复
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter((header) => !existingHeaders.includes(header))
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // 用 beta headers 创建新数组
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

/**
 * 配置 API 请求的 effort 参数。
 *
 */
export function configureEffortParams(
  effortValue: EffortLevel | undefined,
  outputConfig: BetaOutputConfig,
  _extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === 'off') {
    return
  }

  if (effortValue === undefined) {
    // Anthropic 模型即使不指定 effort 也需要 beta header
    if (isAnthropicModel(model)) {
      betas.push(EFFORT_BETA_HEADER)
    }
    return
  }

  if (typeof effortValue === 'string') {
    // 通过映射表将内部语义档位转为目标 provider 的 API 参数值
    const providerId = getAPIProvider()
    const providerValue = mapEffortToProvider(effortValue as EffortLevel, providerId, model)
    // provider 没有配置模型级 effort map 时不设置 effort 参数
    if (providerValue !== undefined) {
      outputConfig.effort = providerValue
      if (isAnthropicModel(model)) {
        betas.push(EFFORT_BETA_HEADER)
      }
    }
  }
}

// output_config.task_budget — API 端的令牌预算感知。
// 类型定义在 ../../types/llm.ts 中。
export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  betas: string[],
): TaskBudgetParam | undefined {
  if (!taskBudget || !shouldIncludeExperimentalBetas()) {
    return undefined
  }
  const param: TaskBudgetParam = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
  return param
}

export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.ZY_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `ZY_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // 仅在主动使用 OAuth 认证时包含 OAuth 账户 UUID
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // 如果在打印模式（非交互会话）下运行，跳过 API 验证
  if (isNonInteractiveSession) {
    return true
  }

  const adapter = getLLMAdapter()
  return adapter.verifyApiKey(apiKey)
}

// 非流式请求根据文档有 10 分钟上限：
// https://platform.zy.com/docs/en/api/errors#long-requests
// SDK 的 21333 令牌上限由 10 分钟 × 128k 令牌/小时推导，但我们
// 通过设置客户端级超时绕过它，因此可以设置更高的上限。
export let MAX_NON_STREAMING_TOKENS: number
MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 当 max_tokens 在非流式回退中被限制时调整思考预算。
 * 确保满足 API 约束：max_tokens > thinking.budget_tokens
 *
 * @param params - 将发送给 API 的参数
 * @param maxTokensCap - 允许的最大令牌数（MAX_NON_STREAMING_TOKENS）
 * @returns 调整后的参数，必要时已限制思考预算
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: { type: string; budget_tokens?: number }
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // 如果思考预算超过限制的 max_tokens 则调整
  // 以维护约束：max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (adjustedParams.thinking?.type === 'enabled' && adjustedParams.thinking.budget_tokens) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // 必须至少比 max_tokens 少 1
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

/**
 * 获取模型的默认 max_output_tokens。
 * 允许通过环境变量 ZY_CODE_MAX_OUTPUT_TOKENS 覆盖。
 * default/upperLimit 的计算逻辑已由 getModelMaxOutputTokens() 处理。
 */
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  const result = validateBoundedIntEnvVar(
    'ZY_CODE_MAX_OUTPUT_TOKENS',
    process.env.ZY_CODE_MAX_OUTPUT_TOKENS,
    maxOutputTokens.default,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
