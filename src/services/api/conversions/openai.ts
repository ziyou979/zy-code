/**
 * OpenAI 双向转换层 — 标准 Message[] / StreamEvent ↔ OpenAI SDK 格式。
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
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions/completions'
import { randomUUID } from 'crypto'
import type {
  AssistantContentBlock,
  ChunkDelta,
  CreateParams,
  DeltaUsage,
  LLMMessage,
  LLMResponse,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  UserContentBlock,
} from '../../../types/llm.js'

/**
 * buildOpenAIRequestParams 的返回类型。
 * 继承 SDK 的 ChatCompletionCreateParamsBase（保证 client.chat.completions.create 类型匹配），
 * 并用 index signature 兜底 thinking / providerExtras / extra_body 等动态扩展字段。
 */
export interface OpenAICreateParams extends ChatCompletionCreateParamsBase {
  [key: string]: unknown
}
import { getAPIProvider } from '../../../utils/model/providers.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { localModelHasCapability } from '../../../utils/settings/localModelCapabilities.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'

interface DashScopeChatCompletionDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[]
}

// ============================================================================
// 工具：tool_call.arguments 安全序列化
// ============================================================================

/**
 * 把 ToolCallInlineBlock.input（任意值，可能是对象/字符串/undefined）
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
  if (input === undefined || input === null) return '{}'
  if (typeof input === 'string') {
    if (input.trim() === '') return '{}'
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
 * 判断是否走 DeepSeek reasoning 协议。
 * DeepSeek 要求：两轮之间有 tool_call 时必须回传 reasoning_content。
 * 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *
 * 判定条件：模型名含 'deepseek' 且具备 thinking 能力（由 model-capabilities 声明）。
 */
function isDeepSeekReasoningModel(model: string | undefined): boolean {
  if (!model) return false
  if (!model.toLowerCase().includes('deepseek')) return false
  return localModelHasCapability(model, 'thinking')
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
                  ? block.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n')
                  : ''
            toolResults.push({
              role: 'tool',
              tool_call_id: block.toolCallId ?? '',
              content: text || '(empty)',
            })
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
          result.push({
            role: 'user',
            content: parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts,
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
          // 兼容标准 AssistantMessage.toolCalls 字段
          if (msg.toolCalls?.length) {
            am.tool_calls = msg.toolCalls.map((tc: any) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: safeStringifyToolArguments(tc.arguments),
              },
            }))
          }
          result.push(am)
          break
        }
        if (!Array.isArray(msg.content)) break

        const textParts: string[] = []
        const thinkingParts: string[] = []
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
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
        // - DeepSeek 协议（deepseek-reasoner 等）规定：两轮之间存在 tool_call 时，
        //   上一轮的 reasoning_content 必须作为独立字段回传，否则 400 ReasoningContentMissError。
        //   参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
        //   纯文本轮次无需回传（回传反而可能触发平台拒绝）。
        // - 其他 provider：统一包成 <thinking> 文本 prepend 到 content 兜底。
        if (thinkingParts.length > 0) {
          const thinkingText = thinkingParts.join('\n\n')
          const isDeepSeek = isDeepSeekReasoningModel(model)
          if (isDeepSeek && toolCalls.length > 0) {
            // DeepSeek 协议：两轮之间有 tool_call 时，必须回传 reasoning_content
            ;(am as any).reasoning_content = thinkingText
          } else if (!isDeepSeek) {
            // 非 DeepSeek：包成 <thinking> 文本 prepend 到 content
            textParts.unshift(`<thinking>${thinkingText}</thinking>`)
          }
          // DeepSeek 纯文本轮次：thinking 丢弃（官方要求）
        }
        if (textParts.length > 0) am.content = textParts.join('\n\n')
        if (toolCalls.length > 0) am.tool_calls = toolCalls
        // 也兼容 AssistantMessage.toolCalls 独立字段
        if (msg.toolCalls?.length && !am.tool_calls) {
          am.tool_calls = msg.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: safeStringifyToolArguments(tc.arguments),
            },
          }))
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

  return result
}

export function toolsToOpenAI(
  tools?: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: (tool.inputSchema ??
        (tool as any).input_schema ?? {
          type: 'object',
          properties: {},
        }) as Record<string, unknown>,
    },
  }))
}

export function toolChoiceToOpenAI(
  choice?: ToolChoice,
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined
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
 * 各平台参数格式：
 * - 百炼（dashscope）: enable_thinking: true
 * - 智谱（zhipu）: thinking: { type: 'enabled', clear_thinking: false }
 * - Kimi（moonshot）: chat_template_args / enable_thinking
 * - DeepSeek: reasoning_effort
 * - OpenRouter: reasoning: { effort }
 * - OpenAI 官方: reasoning_effort
 * - 通用 OpenAI 兼容平台（按模型名启发）: enable_thinking
 */
export function convertThinkingForOpenAI(
  thinking: { type: string; budgetTokens?: number } | undefined,
  model: string,
  outputConfig?: Record<string, unknown>,
): Record<string, unknown> {
  if (!thinking || thinking.type === 'disabled') return {}

  const provider = getAPIProvider()
  const modelLower = model.toLowerCase()
  const effort = outputConfig?.effort as string | undefined

  if (provider === 'dashscope') return { enable_thinking: true }
  if (provider === 'zhipu') {
    return { thinking: { type: 'enabled', clear_thinking: false } }
  }
  if (provider === 'kimi') {
    if (modelLower.includes('kimi-k2-thinking') || modelLower.includes('k2-thinking')) {
      return { chat_template_args: { enable_thinking: true } }
    }
    return { enable_thinking: true }
  }
  if (provider === 'deepseek') return { reasoning_effort: effort ?? 'medium' }
  if (provider === 'openrouter') return { reasoning: { effort: effort ?? 'medium' } }
  if (provider === 'openai') return { reasoning_effort: effort ?? 'medium' }

  if (
    modelLower.includes('reasoning') ||
    modelLower.includes('r1') ||
    modelLower.includes('thinking') ||
    modelLower.includes('deepseek')
  ) {
    return { enable_thinking: true }
  }

  return {}
}

// ============================================================================
// response_format 适配
// ============================================================================

/**
 * 将 Anthropic 风格 outputConfig.format 转换为 OpenAI 的 response_format。
 * - 已是 OpenAI 格式（含顶层 type）：原样返回
 * - 'json_object' 直接返回
 * - 'json_schema' 取 inner json_schema 或 schema 字段
 */
export function convertOutputFormatToResponseFormat(
  outputConfig: Record<string, unknown> | undefined,
): OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] | undefined {
  if (!outputConfig) return undefined

  const format = outputConfig.format as Record<string, unknown> | undefined
  if (!format) return undefined

  if (format.type === 'json_object') return { type: 'json_object' }

  if (format.type === 'json_schema') {
    const jsonSchema =
      (format.json_schema as Record<string, unknown>) ?? (format.schema as Record<string, unknown>)
    if (jsonSchema) {
      return {
        type: 'json_schema',
        json_schema: jsonSchema as unknown as OpenAI.ResponseFormatJSONSchema['json_schema'],
      }
    }
  }

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
  if (!reason) return null
  return OPENAI_STOP_REASON_MAP[reason] ?? 'end_turn'
}

/**
 * 从 OpenAI usage 中提取缓存相关的扩展字段。
 * 百炼/火山引擎等兼容端点可能返回 cache_read_input_tokens / prompt_cache_hit_tokens，
 * 标准 OpenAI 则在 prompt_tokens_details.cached_tokens 下。
 */
function extractOpenAIUsageExtras(
  usage: OpenAI.CompletionUsage | undefined | null,
): Record<string, number> {
  const extras: Record<string, number> = {}
  const rawUsage = usage as unknown as Record<string, unknown> | null | undefined

  // 缓存命中 token
  if (rawUsage && typeof rawUsage.cache_read_input_tokens === 'number') {
    extras.cacheReadInputTokens = rawUsage.cache_read_input_tokens as number
  } else if (typeof usage?.prompt_tokens_details?.cached_tokens === 'number') {
    extras.cacheReadInputTokens = usage!.prompt_tokens_details!.cached_tokens
  } else if (rawUsage && typeof rawUsage.prompt_cache_hit_tokens === 'number') {
    extras.cacheReadInputTokens = rawUsage.prompt_cache_hit_tokens as number
  }

  // 缓存写入 token
  if (rawUsage && typeof rawUsage.cache_creation_input_tokens === 'number') {
    extras.cacheCreationInputTokens = rawUsage.cache_creation_input_tokens as number
  } else if (
    typeof (usage?.prompt_tokens_details as any)?.cache_creation_input_tokens === 'number'
  ) {
    extras.cacheCreationInputTokens = (
      usage!.prompt_tokens_details as any
    ).cache_creation_input_tokens
  }

  return extras
}

export function openAIUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): TokenUsage {
  const extras = extractOpenAIUsageExtras(usage)
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

export function openAIDeltaUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): DeltaUsage {
  const extras = extractOpenAIUsageExtras(usage)
  return {
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

export function openAIResponseToStandard(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): LLMResponse {
  const choice = completion.choices[0]
  const contentBlocks: AssistantContentBlock[] = []

  if (choice?.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
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
 * OpenAI 流式 → 标准 StreamEvent。
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
): AsyncIterable<StreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  const toolBlockIndices = new Map<number, number>()
  let textBlockStarted = false
  const toolBlocksStarted = new Map<number, boolean>()
  // 百炼深度思考：reasoning_content 需要独立的 thinking block
  let thinkingBlockStarted = false
  const thinkingBlockIndex = 0
  // 最终 stop_reason 和 usage（usage 可能在独立的 usage-only chunk 中到达）
  let finalStopReason: StopReason | null = null
  let finalUsage: DeltaUsage | undefined = undefined

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
      if (delta.content && delta.content !== '') {
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
          delta: { type: 'text_delta', text: delta.content },
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
  const p = params as any
  const openAIMessages = messagesToOpenAI(p.messages ?? [], p.model)
  const openaiExtras = p.providerExtras?.openai

  // 系统提示：buildSystemPromptBlocks 生成的 TextBlock[] 带有 cache_control，
  // 注入为 messages 数组中的 system 角色消息
  if (p.system && Array.isArray(p.system) && p.system.length > 0) {
    openAIMessages.unshift({ role: 'system', content: p.system } as any)
  }

  // OpenAI 原生工具（如 web_search_preview），注入到 tools 数组顶部
  const openaiNativeTools = openaiExtras?._web_search_tool ? [openaiExtras._web_search_tool] : []
  const cleanedExtras = openaiExtras ? { ...openaiExtras } : {}
  delete (cleanedExtras as any)._web_search_tool

  // response_format：providerExtras 优先；否则尝试从 outputConfig 转
  const explicitResponseFormat = openaiExtras?.response_format
  const responseFormatFromConfig = convertOutputFormatToResponseFormat(p.output_config)

  const thinkingParams = convertThinkingForOpenAI(p.thinking, p.model, p.output_config)

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
  if (topP !== undefined) out.top_p = topP
  const stops = p.stopSequences ?? p.stop_sequences
  if (stops) out.stop = stops
  if (toolDefs) out.tools = toolDefs
  const toolChoice = p.toolChoice ?? p.tool_choice
  if (toolChoice) out.tool_choice = toolChoiceToOpenAI(toolChoice) ?? toolChoice

  if (explicitResponseFormat) {
    out.response_format = explicitResponseFormat
  } else if (responseFormatFromConfig) {
    out.response_format = responseFormatFromConfig
  }

  Object.assign(out, thinkingParams)
  Object.assign(out, cleanedExtras)
  if (p.extra_body) Object.assign(out, p.extra_body)

  return out
}
