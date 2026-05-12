import type {
  ToolDefinition,
  LLMResponse,
  LLMMessage,
  TextBlock,
  ToolChoice,
} from '../types/llm.js'

import { getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import { getCLISyspromptPrefix } from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'

import { getLLMAdapter } from '../services/api/client.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { normalizeModelStringForAPI } from './model/model.js'

// BetaJSONOutputFormat 可内联为结构化输出格式的本地类型
type BetaJSONOutputFormat = { type: 'json_schema'; json_schema?: unknown; schema?: unknown }

export type SideQueryOptions = {
  /** 用于查询的模型 */
  model: string
  /**
   * 系统提示词 - 字符串或 text block 数组（将以 CLI 归属前缀开头）。
   *
   * 归属头始终放在独立的 TextBlock 块中，以确保服务端解析能正确提取
   * cc_entrypoint 值而不包含系统提示词内容。
   */
  system?: string | TextBlock[]
  /** 要发送的消息（content block 上支持 cache_control） */
  messages: LLMMessage[]
  /** 可选的工具定义（支持标准 ToolDefinition[] 用于自定义工具类型） */
  tools?: ToolDefinition[]
  /** 可选的工具选择（使用 { type: 'tool', name: 'x' } 强制输出） */
  tool_choice?: ToolChoice
  /** 可选的 JSON 输出格式，用于结构化响应 */
  output_format?: BetaJSONOutputFormat
  /** 最大 token 数（默认：1024） */
  max_tokens?: number
  /** 最大重试次数（默认：2） */
  maxRetries?: number
  /** 中止信号 */
  signal?: AbortSignal
  /** 跳过 CLI 系统提示词前缀（保留 OAuth 归属头）。供提供自有提示词的内部分类器使用。 */
  skipSystemPromptPrefix?: boolean
  /** 温度覆盖 */
  temperature?: number
  /** 思考预算（启用思考），或 `false` 发送 `{ type: 'disabled' }`。 */
  thinking?: number | false
  /** 停止序列 — 当输出任何这些字符串时停止生成 */
  stop_sequences?: string[]
  /** 在 zy_api_success 中标记此调用，用于 COGS 与 reporting.sampling_calls 的关联。 */
  querySource: QuerySource
}

/**
 * 用于主对话循环之外的"旁路查询"的轻量级 API 封装。
 *
 * 使用此函数替代直接的 client.beta.messages.create() 调用，以确保
 * 通过指纹归属头进行正确的 OAuth token 验证。
 *
 * 此函数处理：
 * - OAuth 验证的指纹计算
 * - 归属头注入
 * - CLI 系统提示词前缀
 * - 模型对应的 betas 参数
 * - API 元数据
 * - 模型字符串标准化（去除 API 的 [1m] 后缀）
 *
 * @example
 * // 权限解释器
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // 会话搜索
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // 模型验证
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<LLMResponse> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const betas = [...getModelBetas(model)]
  // 如果使用了 output_format 且 provider 支持，则添加结构化输出 beta
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  const systemBlocks: TextBlock[] = [
    // 对提供自有提示词的内部分类器跳过 CLI 系统提示词前缀
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system) ? system : system ? [{ type: 'text' as const, text: system }] : []),
  ].filter((block): block is TextBlock => block !== null)

  let thinkingConfig: { type: 'disabled' } | { type: 'enabled'; budgetTokens: number } | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budgetTokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)
  const start = Date.now()

  // 统一通过 adapter 分派（OpenAI / Anthropic 等 provider 由 adapter 自行处理）
  const adapter = getLLMAdapter()

  // 把 systemBlocks 拼成 system role 消息放在 messages 前面
  const allMessages: LLMMessage[] = []
  if (systemBlocks.length > 0) {
    allMessages.push({
      role: 'system',
      content: systemBlocks.map((b) => b.text).join('\n\n'),
    } as any)
  }
  for (const m of messages) allMessages.push(m)

  const response = await adapter.createMessage(
    {
      model: normalizedModel,
      messages: allMessages,
      maxTokens: max_tokens,
      temperature,
      stopSequences: stop_sequences,
      tools: tools as any,
      toolChoice: tool_choice as any,
      providerExtras: {
        anthropic: {
          thinking: thinkingConfig,
          betas: betas.length > 0 ? betas : undefined,
          outputConfig: output_format ? { format: output_format } : undefined,
        },
      },
    },
    signal ?? new AbortController().signal,
  )

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('zy_api_success', {
    requestId: response.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model: normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    cachedInputTokens: response.usage?.extras?.cacheReadInputTokens ?? 0,
    uncachedInputTokens: response.usage?.extras?.cacheCreationInputTokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs: lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}
