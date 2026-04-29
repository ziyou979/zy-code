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
import { randomUUID } from 'crypto'
import type {
  AssistantContentBlock,
  ChunkDelta,
  CreateParams,
  DeltaUsage,
  Message,
  Response as LLMResponse,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  UserContentBlock,
} from '../../../types/llm.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'

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

type AnyMessage = Message | Record<string, unknown>

/**
 * 将标准消息（含 v1 / v2 兼容）转换为 OpenAI ChatCompletionMessageParam[]。
 *
 * 兼容点：
 * - v1 user 消息内嵌 tool_result 块 → 拆为独立 role:'tool' 消息
 * - v1 assistant 块 type 为 'tool_use' → 当 'tool_call' 处理
 * - v1 image 块嵌套 source（mediaType/data）与 v2 平铺（mimeType/data）
 * - thinking 块包装为 <thinking>...</thinking> 文本
 */
export function messagesToOpenAI(
  messages: AnyMessage[],
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
        // v1: user 消息中可能包含 tool_result 块，需要拆为独立 tool 消息
        const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = []
        const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c: any) => (c.type === 'text' ? c.text : ''))
                      .join('\n')
                  : ''
            toolResults.push({
              role: 'tool',
              tool_call_id: block.toolCallId ?? '',
              content: text || '(empty)',
            })
          } else if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image') {
            // v1 嵌套 source / v2 平铺
            const mimeType = block.mimeType ?? block.source?.mediaType ?? 'image/png'
            const data = block.data ?? block.source?.data ?? ''
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
            content:
              parts.length === 1 && parts[0]?.type === 'text'
                ? parts[0].text
                : parts,
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
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_call' || block.type === 'tool_use') {
            // 同时识别 v2 'tool_call' 和 v1 'tool_use'
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: safeStringifyToolArguments(block.input),
              },
            })
          } else if (block.type === 'thinking') {
            textParts.push(`<thinking>${block.thinking ?? ''}</thinking>`)
          }
          // redacted_thinking / server_tool_use 等：OpenAI 不支持，忽略
        }
        const am: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
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
      parameters: (tool.inputSchema ?? (tool as any).input_schema ?? {
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
  thinking: { type: string; budget_tokens?: number } | undefined,
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
      (format.json_schema as Record<string, unknown>) ??
      (format.schema as Record<string, unknown>)
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

export function openAIFinishReasonToStandard(
  reason: string | null | undefined,
): StopReason {
  if (!reason) return null
  return OPENAI_STOP_REASON_MAP[reason] ?? 'end_turn'
}

export function openAIUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): TokenUsage {
  const inputTokens = usage?.prompt_tokens ?? 0
  const outputTokens = usage?.completion_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }
}

export function openAIDeltaUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): DeltaUsage {
  return { outputTokens: usage?.completion_tokens ?? 0 }
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

  yield { type: 'response_start', responseId: messageId, model }

  for await (const chunk of stream) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta as any

      // 思考过程
      if (delta.reasoning_content && delta.reasoning_content !== '') {
        if (!thinkingBlockStarted) {
          yield {
            type: 'chunk_start',
            index: thinkingBlockIndex,
            chunk: { type: 'thinking', thinking: '', signature: '' } as any,
          }
          thinkingBlockStarted = true
        }
        yield {
          type: 'chunk_delta',
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content } as any,
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

      // 结束
      if (choice.finish_reason) {
        if (thinkingBlockStarted) {
          yield { type: 'chunk_stop', index: thinkingBlockIndex }
        }
        if (textBlockStarted) {
          yield { type: 'chunk_stop', index: textBlockIndex }
        }
        for (const blockIndex of toolBlockIndices.values()) {
          yield { type: 'chunk_stop', index: blockIndex }
        }

        yield {
          type: 'response_delta',
          stopReason: openAIFinishReasonToStandard(choice.finish_reason),
          usage: openAIDeltaUsageToStandard(chunk.usage),
        }
      }
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
export function buildOpenAIRequestParams(
  params: CreateParams,
): Record<string, unknown> {
  const p = params as any
  const openAIMessages = messagesToOpenAI(p.messages ?? [])
  const openaiExtras = p.providerExtras?.openai

  // OpenAI 原生工具（如 web_search_preview），注入到 tools 数组顶部
  const openaiNativeTools = openaiExtras?._web_search_tool
    ? [openaiExtras._web_search_tool]
    : []
  const cleanedExtras = openaiExtras ? { ...openaiExtras } : {}
  delete (cleanedExtras as any)._web_search_tool

  // response_format：providerExtras 优先；否则尝试从 outputConfig 转
  const explicitResponseFormat = openaiExtras?.response_format
  const responseFormatFromConfig = convertOutputFormatToResponseFormat(p.output_config)

  const thinkingParams = convertThinkingForOpenAI(
    p.thinking,
    p.model,
    p.output_config,
  )

  const toolDefs =
    (p.tools && p.tools.length > 0) || openaiNativeTools.length > 0
      ? [
          ...openaiNativeTools,
          ...((p.tools ? toolsToOpenAI(p.tools) : []) ?? []),
        ]
      : undefined

  const out: Record<string, unknown> = {
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


