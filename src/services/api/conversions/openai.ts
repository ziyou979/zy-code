/**
 * OpenAI 双向转换层 — 标准 Message[] / LLMStreamEvent ↔ OpenAI SDK 格式。
 *
 * 这个文件是 OpenAIProviderAdapter 的"知识库"，所有与 OpenAI SDK 接触的转换
 * 都集中在这里，方便测试和复用。
 *
 * 设计原则：
 * - 所有公开函数都接受标准 llm.ts 类型，输出 OpenAI SDK 类型（或反向）
 * - 不直接调用任何 OpenAI client；adapter 负责 IO
 * - 兼容 v1 (snake_case / tool_use / 嵌套 image source) 与 v2 (camelCase) 两种历史输入形态
 *
 * DashScope 400 防线（多重）：
 * - safeStringifyToolArguments：所有工具参数序列化的唯一入口
 * - normalizeContentFromAPI（messages.ts）：流式累积后把字符串 input parse 回 object
 * - 出站 messagesToOpenAI 内对 string input 兜底为 {}
 */

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions/completions'
import type {
  AssistantContentBlock,
  ChunkDelta,
  CreateParams,
  DeltaUsage,
  JSONOutputFormat,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  StopReason,
  ThinkingConfig,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from '../../../types/llm.js'

/**
 * buildOpenAIRequestParams 的返回类型。
 * 继承 SDK 的 ChatCompletionCreateParamsBase（保证 client.chat.completions.create 类型匹配），
 * 并用 index signature 兜底 thinking / providerExtras / extra_body 等动态扩展字段。
 */
export interface OpenAICreateParams extends ChatCompletionCreateParamsBase {
  [key: string]: unknown
}

import { normalizeModelStringForAPI } from '../../../services/model/model.js'
import {
  DEFAULT_OPENAI_THINKING_ATTR,
  type OpenAiAttr,
} from '../../../services/model/providerRegistry.js'
import { getAPIProvider, getProviderAttr } from '../../../services/model/providers.js'
import {
  getLocalModelPreserveThinking,
  localModelHasCapability,
} from '../../../utils/settings/localModelCapabilities.js'

interface DashScopeChatCompletionDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
}

interface OpenAIChatCompletionMessageWithReasoning
  extends OpenAI.Chat.Completions.ChatCompletionMessage {
  reasoning_content?: string | null
}

// ============================================================================
// 工具：tool_call.arguments 安全序列化
// ============================================================================

/**
 * 把 ToolCallBlock.input（任意值，可能是对象/字符串/undefined）
 * 安全序列化为 OpenAI 协议要求的 arguments 字符串。
 *
 * DashScope/百炼对该字段格式校验非常严格：
 *   - 必须是合法 JSON 字符串
 *   - 不能是 undefined、null、空字符串
 *   - 必须能 JSON.parse 成 object（不能是裸字符串/数组/数字）
 * 任一违反会触发 400 InvalidParameter:
 *   "function.arguments parameter of the code model must be in JSON format"。
 *
 * 兜底策略：
 *   - 已经是字符串：尝试 JSON.parse 验证；合法且 parse 后是 object → 直接用；
 *     不是 object → 包装成 {raw: <parsed>}；非法 JSON → 包装成 {raw: <原字符串>}
 *   - 是对象：JSON.stringify
 *   - undefined / null / 其他：回退 "{}"
 */
export function safeStringifyToolArguments(input: unknown): string {
  if (input === undefined || input === null) {
    return '{}'
  }
  if (typeof input === 'string') {
    if (input.trim() === '') {
      return '{}'
    }
    try {
      const parsed = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return input
      }
      // 合法 JSON 但不是 object（如 "\"hi\"" parse 出 "hi"），包装一下
      return JSON.stringify({ raw: parsed })
    } catch {
      // 不是合法 JSON 字符串 → 包装一下避免 DashScope 拒绝
      return JSON.stringify({ raw: input })
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    try {
      const out = JSON.stringify(input)
      return out && out !== 'undefined' ? out : '{}'
    } catch {
      return '{}'
    }
  }
  // 数组、数字、boolean 等：包装成 {raw: x}
  try {
    return JSON.stringify({ raw: input })
  } catch {
    return '{}'
  }
}

// ============================================================================
// 出站：标准 → OpenAI
// ============================================================================

type AnyMessage = LLMMessage | Record<string, unknown>

/**
 * 判断是否支持 reasoning_content 独立字段回传协议。
 * 通过 model-capabilities.json 的 preserveThinking 字段声明。
 * 兜底：模型名含 'deepseek' 时检查 localModelCapabilities。
 */
function supportsReasoningContentField(model: string | undefined): boolean {
  if (!model) {
    return false
  }
  // 从模型级别配置获取 preserveThinking
  const preserveThinking = getLocalModelPreserveThinking(model)
  if (preserveThinking) {
    return true
  }
  // 兜底：模型名含 deepseek 但通过 generic/siliconflow 等未声明配置的 provider 接入时
  if (model.toLowerCase().includes('deepseek')) {
    return localModelHasCapability(model, 'thinking')
  }
  return false
}

/**
 * 将标准消息转换为 OpenAI ChatCompletionMessageParam[]。
 *
 * 转换点：
 * - user 消息内嵌的 tool_result 块 → 拆为独立 role:'tool' 消息
 * - assistant 块 type 为 'tool_use' → 当 'tool_call' 处理
 * - image 块按平铺 { mimeType, data } 转 image_url
 * - thinking 块包装为 <thinking>...</thinking> 文本
 */
export function messagesToOpenAI(
  messages: AnyMessage[],
  model?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  for (const raw of messages) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const msg = raw as any
    switch (msg.role) {
      case 'system':
        if (msg.content) {
          result.push({ role: 'system', content: msg.content })
        }
        break

      case 'user': {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
          break
        }
        if (!Array.isArray(msg.content)) {
          result.push({ role: 'user', content: '' })
          break
        }
        // user 消息中可能内嵌 tool_result 块，需要拆为独立 role:'tool' 消息
        const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = []
        const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c: { type: string; text?: string }) =>
                        c.type === 'text' ? c.text : '',
                      )
                      .join('\n')
                  : ''
            toolResults.push({
              role: 'tool',
              tool_call_id: block.toolCallId ?? '',
              content: text || '(empty)',
              ...(block.cache_control && { cache_control: block.cache_control }),
              // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
            } as any)
          } else if (block.type === 'cache_edits') {
            // cache_edits 是缓存编辑指令，不是用户内容，直接透传
            // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
            parts.push({ ...block } as any)
          } else if (block.type === 'text') {
            // 保留 cache_control 等额外字段（百炼/火山引擎的 OpenAI 端点支持）
            parts.push({ ...block } as OpenAI.Chat.ChatCompletionContentPart)
          } else if (block.type === 'image') {
            const mimeType = block.mimeType ?? 'image/png'
            const data = block.data ?? ''
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${data}` },
            })
          }
        }
        // tool 消息要紧跟在前一条 assistant tool_calls 后面
        result.push(...toolResults)
        if (parts.length > 0) {
          // 单 text block 通常压扁成 string，但若带 cache_control 必须保留 array
          // 形式 —— 否则百炼/火山等 OpenAI 兼容端点收不到 cache_control 字段，
          // addCacheBreakpoints 在最后一条消息打的滚动 marker 会静默丢失。
          const first = parts[0]
          const onlyOneText = parts.length === 1 && first?.type === 'text'
          const hasCacheControl = parts.some(
            (p) => p && typeof p === 'object' && 'cache_control' in p,
          )
          result.push({
            role: 'user',
            content:
              onlyOneText && !hasCacheControl && first && 'text' in first ? first.text : parts,
          })
        } else if (toolResults.length === 0) {
          result.push({ role: 'user', content: '' })
        }
        break
      }

      case 'assistant': {
        if (typeof msg.content === 'string') {
          const am: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: msg.content,
          }
          result.push(am)
          break
        }
        if (!Array.isArray(msg.content)) {
          break
        }

        const textParts: string[] = []
        const thinkingParts: string[] = []
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
        let lastCacheControl: Record<string, unknown> | null = null
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
            const ext = block as { cache_control?: Record<string, unknown> }
            if (ext.cache_control) {
              lastCacheControl = ext.cache_control
            }
          } else if (block.type === 'tool_call' || block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: safeStringifyToolArguments(block.input),
              },
            })
          } else if (block.type === 'thinking') {
            thinkingParts.push(block.thinking ?? '')
          }
          // redacted_thinking / server_tool_use 等：OpenAI 不支持，忽略
        }
        const am: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
        }
        // 思考内容回传策略：
        // - 支持 reasoning_content 协议的 provider（DeepSeek/DashScope/Kimi）：
        //   有 tool_call 时以独立字段回传 reasoning_content，
        //   避免模型丢失 thinking 边界导致 </think> 泄漏（Qwen3.6#26）。
        // - 其他 provider：包成 <thinking> 文本 prepend 到 content 兜底。
        if (thinkingParts.length > 0) {
          const thinkingText = thinkingParts.join('\n\n')
          const useReasoningField = supportsReasoningContentField(model)
          if (useReasoningField && toolCalls.length > 0) {
            ;(am as unknown as Record<string, unknown>).reasoning_content = thinkingText
          } else if (!useReasoningField) {
            textParts.unshift(`<thinking>${thinkingText}</thinking>`)
          }
          // 支持 reasoning_content 的 provider 纯文本轮次：thinking 丢弃
        }
        if (textParts.length > 0) {
          if (lastCacheControl) {
            am.content = [
              { type: 'text', text: textParts.join('\n\n'), cache_control: lastCacheControl },
              // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
            ] as any
          } else {
            am.content = textParts.join('\n\n')
          }
        }
        if (toolCalls.length > 0) {
          am.tool_calls = toolCalls
        }
        result.push(am)
        break
      }

      case 'tool':
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content || '(empty)',
        })
        break
    }
  }

  // 后处理：确保 cache_control 落在最后一条 role:'user' 消息上。
  // OpenAI 兼容 provider（DashScope/百炼/火山引擎）的缓存截断点只认
  // system 和 user 消息；tool/assistant 上的标记会被忽略。
  ensureCacheControlOnLastUserMessage(result)

  return result
}

/**
 * 确保 cache_control 仅出现在最后一条 role:'user' 消息上。
 *
 * OpenAI 兼容 provider（DashScope/百炼/火山引擎）的缓存截断点只认
 * system 和 user 消息。tool/assistant 上的标记会被忽略。
 * 此函数将所有非 user 消息上的 cache_control 收拢到最后一条 user 消息。
 */
function ensureCacheControlOnLastUserMessage(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
  // 找最后一条 user 消息
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    if ((messages[i] as any).role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) {
    return
  }

  // 从所有非 user 消息上摘取 cache_control
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  let cacheControl: any = null
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const msg = messages[i] as any
    if (msg.cache_control) {
      if (!cacheControl) cacheControl = msg.cache_control
      delete msg.cache_control
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && block.cache_control) {
          if (!cacheControl) cacheControl = block.cache_control
          delete block.cache_control
        }
      }
    }
  }

  // 检查 user 消息本身是否已有 cache_control
  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const lastUser = messages[lastUserIdx] as any
  if (Array.isArray(lastUser.content)) {
    const last = lastUser.content[lastUser.content.length - 1]
    if (last && typeof last === 'object' && last.cache_control) {
      return // 已有标记，无需操作
    }
  }

  if (!cacheControl) {
    return
  }

  // 将 cache_control 放到最后 user 消息的最后一个 content block 上
  if (typeof lastUser.content === 'string') {
    lastUser.content = [{ type: 'text', text: lastUser.content, cache_control: cacheControl }]
  } else if (Array.isArray(lastUser.content) && lastUser.content.length > 0) {
    const last = lastUser.content[lastUser.content.length - 1]
    if (last && typeof last === 'object') {
      last.cache_control = cacheControl
    }
  }
}

export function toolsToOpenAI(
  tools?: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools?.length) {
    return undefined
  }
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: (tool.inputSchema ??
        (tool as unknown as { input_schema?: Record<string, unknown> }).input_schema ?? {
          type: 'object',
          properties: {},
        }) as Record<string, unknown>,
    },
  }))
}

export function toolChoiceToOpenAI(
  choice?: ToolChoice,
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!choice) {
    return undefined
  }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: choice.name } }
    default:
      return undefined
  }
}

// ============================================================================
// thinking / reasoning 参数适配（多 provider）
// ============================================================================

/**
 * 将 Anthropic 风格 thinking 参数转换为各 OpenAI 兼容平台所需的格式。
 *
 * 数据源：
 * - thinking 对象：决定"是否启用 thinking"（disabled/enabled/adaptive）
 * - outputConfig.effort：决定 thinking 的 effort 级别（low/medium/high）
 *
 * 默认参数格式：
 * - 启用：thinking: { type: 'enabled' }
 * - 自适应：模型声明 adaptive thinking 时使用 thinking: { type: 'adaptive' }
 * - 禁用：thinking: { type: 'disabled' }
 *
 * 少数 provider 若需要私有字段（如 Kimi / OpenRouter），在 providerRegistry
 * 中通过 openaiAttr.thinking 覆盖默认映射。
 */
export function convertThinkingForOpenAI(
  thinking: ThinkingConfig | undefined,
  model: string,
  overrideProvider?: string,
  reasoningEffort?: string,
): Record<string, unknown> {
  const provider = overrideProvider ?? getAPIProvider()
  const attr = getProviderAttr(provider)
  const thinkingAttr: NonNullable<OpenAiAttr['thinking']> = {
    ...DEFAULT_OPENAI_THINKING_ATTR,
    ...(attr?.thinking ?? {}),
  }

  if (!thinking || thinking.type === 'disabled') {
    // 部分 provider 默认开启思考；禁用时统一显式下发关闭参数。
    if (thinking?.type === 'disabled') {
      const disableParams = thinkingAttr.disable
      if (disableParams) {
        return typeof disableParams === 'function'
          ? disableParams(reasoningEffort, model)
          : disableParams
      }
      return { thinking: { type: 'disabled' } }
    }
    return {}
  }

  // reasoningEffort 来自中性的 CreateParams.reasoningEffort
  const effort = reasoningEffort

  // 使用默认映射；provider 若声明 openaiAttr.thinking，则仅覆盖差异部分。
  const params = thinkingAttr.enable(effort, model)

  // 从模型级别配置获取思考块回传模式
  const preserveThinking = getLocalModelPreserveThinking(model)

  // 必传模式：始终回传（mimo、deepseek）
  if (preserveThinking === 'always') {
    return { ...params, preserve_thinking: true }
  }

  // 可选模式：effort 为 ultra 或 extreme 时回传（dashscope、zhipu）
  if (preserveThinking === 'optional' && (effort === 'ultra' || effort === 'extreme')) {
    return { ...params, preserve_thinking: true }
  }

  return params
}

// ============================================================================
// response_format 适配
// ============================================================================

/**
 * 将 outputConfig.format 转换为 OpenAI 的 response_format。
 * - 已是 OpenAI 格式（含顶层 type）：原样返回
 * - 'json_object' 直接返回
 * - 内部 'json_schema' 在 OpenAI-compatible 协议下使用 JSON mode（json_object）
 *
 * 注意：Anthropic 与 OpenAI-compatible 的 JSON 输出参数语义不同。
 * 内部 json_schema 是 provider 中立的结构化输出请求；OpenAI 这里不透传
 * json_schema schema，而是发送 response_format.type=json_object。
 */
export function convertOutputFormatToResponseFormat(
  format: JSONOutputFormat | undefined,
): OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] | undefined {
  if (!format) {
    return undefined
  }

  if (format.type === 'json_schema') {
    // 内部 json_schema 表示“需要结构化 JSON 输出”。
    // Anthropic 使用 output_config.format.type=json_schema；OpenAI-compatible
    // 入口统一使用 JSON mode，避免把 Anthropic 语义误映射成 OpenAI 的 json_schema。
    return { type: 'json_object' }
  }

  // 非 json_schema 类型（如 json_object 或已有 OpenAI 格式）
  if (format.type === 'json_object') {
    return { type: 'json_object' }
  }

  // 已有 type 的非标准格式，原样透传
  if (format.type) {
    return format as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']
  }

  return undefined
}

// ============================================================================
// 入站：OpenAI → 标准
// ============================================================================

const OPENAI_STOP_REASON_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
  refusal: 'refusal',
}

export function openAIFinishReasonToStandard(reason: string | null | undefined): StopReason {
  if (!reason) {
    return null
  }
  return OPENAI_STOP_REASON_MAP[reason] ?? 'end_turn'
}

/**
 * 从 OpenAI usage 中提取缓存相关的扩展字段。
 * 百炼/火山引擎等兼容端点可能返回 cache_read_input_tokens / prompt_cache_hit_tokens，
 * 标准 OpenAI 则在 prompt_tokens_details.cached_tokens 下。
 */
/**
 * 从 OpenAI usage 中提取缓存相关 token 数量。
 * 百炼/火山引擎等兼容端点可能返回 cache_read_input_tokens / prompt_cache_hit_tokens，
 * 标准 OpenAI 则在 prompt_tokens_details.cached_tokens 下。
 */
function extractOpenAICacheTokens(usage: OpenAI.CompletionUsage | undefined | null): {
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
} {
  const rawUsage = usage as unknown as Record<string, unknown> | null | undefined
  let cacheReadInputTokens = 0
  let cacheCreationInputTokens = 0

  // 缓存命中 token
  if (rawUsage && typeof rawUsage.cache_read_input_tokens === 'number') {
    cacheReadInputTokens = rawUsage.cache_read_input_tokens as number
  } else if (typeof usage?.prompt_tokens_details?.cached_tokens === 'number') {
    cacheReadInputTokens = usage!.prompt_tokens_details!.cached_tokens
  } else if (rawUsage && typeof rawUsage.prompt_cache_hit_tokens === 'number') {
    cacheReadInputTokens = rawUsage.prompt_cache_hit_tokens as number
  }

  // 缓存写入 token
  if (rawUsage && typeof rawUsage.cache_creation_input_tokens === 'number') {
    cacheCreationInputTokens = rawUsage.cache_creation_input_tokens as number
  } else if (
    typeof (usage?.prompt_tokens_details as { cache_creation_input_tokens?: number })
      ?.cache_creation_input_tokens === 'number'
  ) {
    cacheCreationInputTokens = (
      usage!.prompt_tokens_details as { cache_creation_input_tokens: number }
    ).cache_creation_input_tokens
  }

  return { cacheReadInputTokens, cacheCreationInputTokens }
}

export function openAIUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): TokenUsage {
  const { cacheReadInputTokens, cacheCreationInputTokens } = extractOpenAICacheTokens(usage)
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  }
}

export function openAIDeltaUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): DeltaUsage {
  const { cacheReadInputTokens, cacheCreationInputTokens } = extractOpenAICacheTokens(usage)
  return {
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  }
}

export function openAIResponseToStandard(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): LLMResponse {
  const choice = completion.choices[0]
  const message = choice?.message as OpenAIChatCompletionMessageWithReasoning | undefined
  const contentBlocks: AssistantContentBlock[] = []

  if (message?.reasoning_content) {
    contentBlocks.push({
      type: 'thinking',
      thinking: message.reasoning_content,
      signature: '',
    })
  }

  if (message?.content) {
    contentBlocks.push({ type: 'text', text: message.content })
  }
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsedInput: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(tc.function.arguments ?? '{}')
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          parsedInput = parsed
        }
      } catch {
        // 非法 JSON：保留空对象
      }
      contentBlocks.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      })
    }
  }

  return {
    id: completion.id ?? randomUUID(),
    model: completion.model ?? model,
    role: 'assistant',
    content: contentBlocks,
    stopReason: openAIFinishReasonToStandard(choice?.finish_reason),
    usage: openAIUsageToStandard(completion.usage),
  }
}

/**
 * OpenAI 流式 → 标准 LLMStreamEvent。
 *
 * 关键设计：thinking / text / tool_call 三类 block 的 index 严格分离，
 * tool_call 的 baseIndex = max(textIndex, thinkingIndex) + 1，避免与
 * 思考块或文本块撞 index 导致 input_json_delta 累积到错误的 block 上
 * （那是 DashScope 400 的另一种触发方式）。
 *
 * tool_call 通过 OpenAI 的 tc.index 标识第几个工具，首 chunk 带 id+name，
 * 后续 chunks 只带 arguments 增量片段。
 */
export async function* mapOpenAIStreamToStandard(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<LLMStreamEvent> {
  const streamAttr = getProviderAttr(getAPIProvider())
  const messageId = randomUUID()
  let textBlockIndex = 0
  const toolBlockIndices = new Map<number, number>()
  let textBlockStarted = false
  const toolBlocksStarted = new Map<number, boolean>()
  // 深度思考：reasoning_content 需要独立的 thinking block
  let thinkingBlockStarted = false
  const thinkingBlockIndex = 0
  // 最终 stop_reason 和 usage（usage 可能在独立的 usage-only chunk 中到达）
  let finalStopReason: StopReason | null = null
  let finalUsage: DeltaUsage | undefined

  yield { type: 'response_start', responseId: messageId, model }

  for await (const chunk of stream) {
    // 累积 usage（OpenAI stream_options.include_usage 下，usage 在独立 chunk 中，
    // choices 为空，因此必须在 choices 循环外捕获）
    if (chunk.usage) {
      finalUsage = openAIDeltaUsageToStandard(chunk.usage)
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta as DashScopeChatCompletionDelta

      // 思考过程
      if (delta.reasoning_content && delta.reasoning_content !== '') {
        if (!thinkingBlockStarted) {
          yield {
            type: 'chunk_start',
            index: thinkingBlockIndex,
            chunk: { type: 'thinking', thinking: '', signature: '' },
          }
          thinkingBlockStarted = true
        }
        yield {
          type: 'chunk_delta',
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        }
      }

      // 文本
      // 部分 provider（如 DashScope/Qwen）在 thinking 结束时可能将 </think> 标签泄漏到 content，
      // 通过 openaiAttr.stripThinkingTags 声明，在此处剥离避免产生仅含 XML 标签的空 text block。
      if (delta.content && delta.content !== '') {
        const cleaned = streamAttr?.stripThinkingTags
          ? delta.content.replace(/<\/?(think|thinking)>/g, '').replace(/^\n+|\n+$/g, '')
          : delta.content
        if (cleaned) {
          if (!textBlockStarted) {
            textBlockIndex = thinkingBlockStarted ? thinkingBlockIndex + 1 : 0
            yield {
              type: 'chunk_start',
              index: textBlockIndex,
              chunk: { type: 'text', text: '' },
            }
            textBlockStarted = true
          }
          yield {
            type: 'chunk_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: cleaned },
          }
        }
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0
          if (!toolBlocksStarted.has(tcIdx)) {
            const baseIndex = textBlockStarted
              ? textBlockIndex + 1
              : thinkingBlockStarted
                ? thinkingBlockIndex + 1
                : 0
            const blockIndex = baseIndex + toolBlocksStarted.size
            toolBlockIndices.set(tcIdx, blockIndex)
            toolBlocksStarted.set(tcIdx, true)
            yield {
              type: 'chunk_start',
              index: blockIndex,
              chunk: {
                type: 'tool_call',
                id: tc.id ?? randomUUID(),
                name: tc.function?.name ?? '',
                input: {},
              },
            }
          }
          if (tc.function?.arguments) {
            const blockIndex = toolBlockIndices.get(tcIdx) ?? tcIdx
            const inputDelta: ChunkDelta = {
              type: 'input_json_delta',
              partialJson: tc.function.arguments,
            }
            yield { type: 'chunk_delta', index: blockIndex, delta: inputDelta }
          }
        }
      }

      // 结束（捕获 stop_reason，发送 chunk_stop 事件）
      if (choice.finish_reason) {
        finalStopReason = openAIFinishReasonToStandard(choice.finish_reason)
        if (thinkingBlockStarted) {
          yield { type: 'chunk_stop', index: thinkingBlockIndex }
        }
        if (textBlockStarted) {
          yield { type: 'chunk_stop', index: textBlockIndex }
        }
        for (const blockIndex of toolBlockIndices.values()) {
          yield { type: 'chunk_stop', index: blockIndex }
        }
      }
    }
  }

  // 在流结束后 yield response_delta，此时 usage 已从 usage-only chunk 中收集完毕
  if (finalStopReason) {
    yield {
      type: 'response_delta',
      stopReason: finalStopReason,
      usage: finalUsage,
    }
  }

  yield { type: 'response_stop' }
}

// ============================================================================
// 请求参数构造
// ============================================================================

/**
 * 把标准 CreateParams 拼装成 OpenAI chat.completions.create 的参数对象（不含 stream）。
 *
 * 包含：消息转换、工具转换、tool_choice、temperature/top_p/stop、
 * thinking 多 provider 适配、response_format、OpenAI 原生工具透传、
 * providerExtras.openai / extra_body 顶层透传、model 字符串规范化。
 */
export function buildOpenAIRequestParams(params: CreateParams): OpenAICreateParams {
  // biome-ignore lint/suspicious/noExplicitAny: v1/v2 双格式兼容（max_tokens/top_p/stop_sequences/tool_choice）
  const p = params as any
  const openAIMessages = messagesToOpenAI(p.messages ?? [], p.model)
  const openaiExtras = p.providerExtras?.openai

  // 系统提示：从 params.system 读取，注入为 messages 数组中的 system 角色消息
  if (params.system && Array.isArray(params.system) && params.system.length > 0) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    openAIMessages.unshift({ role: 'system', content: params.system } as any)
  }

  // OpenAI 原生工具（如 web_search_preview），注入到 tools 数组顶部
  const openaiNativeTools = openaiExtras?._web_search_tool ? [openaiExtras._web_search_tool] : []
  const cleanedExtras = openaiExtras ? { ...openaiExtras } : {}
  delete (cleanedExtras as Record<string, unknown>)._web_search_tool

  // response_format：providerExtras 优先；否则从 params.responseFormat 转换
  const explicitResponseFormat = openaiExtras?.response_format
  const responseFormatFromConfig = convertOutputFormatToResponseFormat(params.responseFormat)

  const toolChoice = p.toolChoice ?? p.tool_choice
  const requestNeedsNoThinking =
    params.thinking === undefined &&
    (toolChoice !== undefined || explicitResponseFormat || responseFormatFromConfig)
  const thinkingParams = convertThinkingForOpenAI(
    requestNeedsNoThinking ? { type: 'disabled' as const } : params.thinking,
    p.model,
    undefined,
    params.reasoningEffort,
  )

  const toolDefs =
    (p.tools && p.tools.length > 0) || openaiNativeTools.length > 0
      ? [...openaiNativeTools, ...((p.tools ? toolsToOpenAI(p.tools) : []) ?? [])]
      : undefined

  const out: OpenAICreateParams = {
    model: normalizeModelStringForAPI(p.model),
    messages: openAIMessages,
    max_tokens: p.maxTokens ?? p.max_tokens,
    temperature: p.temperature ?? 1,
  }
  const topP = p.topP ?? p.top_p
  if (topP !== undefined) {
    out.top_p = topP
  }
  const stops = p.stopSequences ?? p.stop_sequences
  if (stops) {
    out.stop = stops
  }
  if (toolDefs) {
    out.tools = toolDefs
  }
  if (toolChoice) {
    out.tool_choice = toolChoiceToOpenAI(toolChoice) ?? toolChoice
  }

  if (explicitResponseFormat) {
    out.response_format = explicitResponseFormat
  } else if (responseFormatFromConfig) {
    out.response_format = responseFormatFromConfig
  }

  Object.assign(out, thinkingParams)
  Object.assign(out, cleanedExtras)
  if (params.extraBody) {
    Object.assign(out, params.extraBody)
  }

  return out
}
