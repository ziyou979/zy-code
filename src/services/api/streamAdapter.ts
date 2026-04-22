/**
 * 统一的 LLM 请求适配器。
 *
 * 将 Anthropic SDK 和 OpenAI SDK 的调用统一为相同的接口，
 * 使 zy.ts 中的核心逻辑不再需要 isOpenAIProvider 分支判断。
 *
 * 设计原则：
 * - 使用 src/types/llm.ts 中定义的标准类型作为内部格式
 * - Anthropic 和 OpenAI 完全平等，各自实现适配器
 * - 适配器负责将 SDK 特定类型转换为标准类型
 */
import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type {
  LLMStreamEvent,
  LLMMessage,
  LLMRequestAdapter,
  StreamResult,
  LLMCreateParams,
  ContentBlock,
  ContentDelta,
  TokenUsage,
  DeltaUsage,
  StopReason,
  ToolDefinition,
} from '../../types/llm.js'
import { getAPIProvider, isOpenAIProvider } from '../../utils/model/providers.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import OpenAI from 'openai'
import { getUserAgent } from '../../utils/http.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { getApiKey } from '../../utils/auth.js'
import { getProviderEntry } from '../../utils/model/providerRegistry.js'

// Re-export for consumers that import from streamAdapter
export type { LLMRequestAdapter, StreamResult } from '../../types/llm.js'

// ============================================================================
// Anthropic 事件转换
// ============================================================================

/** 将 Anthropic SDK 的流式事件转换为标准 LLMStreamEvent */
function convertAnthropicStreamEvent(event: any): LLMStreamEvent {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: convertAnthropicMessage(event.message),
      }
    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: event.index,
        content_block: convertAnthropicContentBlock(event.content_block),
      }
    case 'content_block_delta':
      return {
        type: 'content_block_delta',
        index: event.index,
        delta: convertAnthropicDelta(event.delta),
      }
    case 'content_block_stop':
      return {
        type: 'content_block_stop',
        index: event.index,
      }
    case 'message_delta':
      return {
        type: 'message_delta',
        delta: {
          stop_reason: event.delta.stop_reason as StopReason,
        },
        usage: convertAnthropicDeltaUsage(event.usage),
      }
    case 'message_stop':
      return {
        type: 'message_stop',
      }
    default:
      // 未知事件类型，透传为 message_stop（安全降级）
      return { type: 'message_stop' }
  }
}

/** 将 Anthropic SDK 的消息转换为标准 LLMMessage */
function convertAnthropicMessage(msg: any): LLMMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: (msg.content || []).map(convertAnthropicContentBlock),
    model: msg.model,
    stop_reason: msg.stop_reason as StopReason,
    usage: convertAnthropicUsage(msg.usage),
    type: msg.type,
    stop_sequence: msg.stop_sequence ?? null,
  }
}

/** 将 Anthropic SDK 的内容块转换为标准 ContentBlock */
function convertAnthropicContentBlock(block: any): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data ?? '' }
    case 'server_tool_use':
      return { type: 'server_tool_use', id: block.id, name: block.name, input: block.input ?? {} }
    default:
      // 未知块类型，作为文本块处理
      return { type: 'text', text: '' }
  }
}

/** 将 Anthropic SDK 的增量转换为标准 ContentDelta */
function convertAnthropicDelta(delta: any): ContentDelta {
  switch (delta.type) {
    case 'text_delta':
      return { type: 'text_delta', text: delta.text }
    case 'input_json_delta':
      return { type: 'tool_input_delta', partial_json: delta.partial_json }
    case 'thinking_delta':
      return { type: 'thinking_delta', thinking: delta.thinking }
    case 'signature_delta':
      return { type: 'signature_delta', signature: delta.signature }
    default:
      // 未知增量类型，作为文本增量处理
      return { type: 'text_delta', text: '' }
  }
}

/** 将 Anthropic SDK 的 usage 转换为标准 TokenUsage */
function convertAnthropicUsage(usage: any): TokenUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens,
    cache_read_input_tokens: usage?.cache_read_input_tokens,
    server_tool_use_input_tokens: usage?.server_tool_use_input_tokens,
  }
}

/** 将 Anthropic SDK 的增量 usage 转换为标准 DeltaUsage */
function convertAnthropicDeltaUsage(usage: any): DeltaUsage {
  return {
    output_tokens: usage?.output_tokens ?? 0,
  }
}

// ============================================================================
// Anthropic 实现
// ============================================================================

class AnthropicRequestAdapter implements LLMRequestAdapter {
  constructor(private readonly client: Anthropic) {}

  async createStream(
    params: LLMCreateParams,
    signal: AbortSignal,
    client_request_id?: string,
  ): Promise<StreamResult> {
    const anthropicParams = convertToAnthropicParams(params)
    // @ts-ignore - anthropicParams is Record<string, any>, SDK types are internal
    const result = await this.client.beta.messages.create(
      { ...anthropicParams, stream: true },
      {
        signal,
        ...(client_request_id && {
          headers: { 'anthropic-client-request-id': client_request_id },
        }),
      },
    ).withResponse()

    const rawStream = result.data as unknown as AsyncIterable<any>

    return {
      stream: convertAnthropicStream(rawStream),
      request_id: result.request_id,
      response: result.response,
    }
  }

  async createMessage(
    params: LLMCreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMMessage> {
    const anthropicParams = convertToAnthropicParams(params)
    // @ts-ignore - anthropicParams is Record<string, any>, SDK types are internal
    const result = await this.client.beta.messages.create(
      {
        ...anthropicParams,
        stream: false as const,
        model: normalizeModelStringForAPI(params.model),
      },
      {
        signal,
        timeout,
      },
    )
    return convertAnthropicMessage(result)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    // Anthropic 的 key 验证通过实际 API 调用完成
    return true
  }
}

/** 将标准 LLMCreateParams 转换为 Anthropic SDK 参数 */
function convertToAnthropicParams(params: LLMCreateParams): Record<string, any> {
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: params.messages as any,
    ...(params.system !== undefined && { system: params.system as any }),
    ...(params.tools !== undefined && { tools: params.tools as any }),
    ...(params.tool_choice !== undefined && { tool_choice: params.tool_choice as any }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.top_p !== undefined && { top_p: params.top_p }),
    ...(params.metadata !== undefined && { metadata: params.metadata as any }),
    ...(params.thinking !== undefined && { thinking: params.thinking as any }),
    ...(params.betas !== undefined && { betas: params.betas as any }),
    ...(params.context_management !== undefined && { context_management: params.context_management as any }),
    ...(params.output_config !== undefined && { output_config: params.output_config as any }),
  }
}

/** 将 Anthropic 原始事件流转换为标准事件流 */
async function* convertAnthropicStream(
  rawStream: AsyncIterable<any>,
): AsyncIterable<LLMStreamEvent> {
  for await (const event of rawStream) {
    yield convertAnthropicStreamEvent(event)
  }
}

// ============================================================================
// OpenAI 工具函数
// ============================================================================

/** 停止原因类型（OpenAI → 标准） */
type OpenAIStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null

function getOpenAIClient(options: {
  apiKey?: string
  model?: string
}): OpenAI {
  const apiKey = options.apiKey || getApiKey() || ''

  let baseURL: string | undefined
  try {
    const { getGlobalConfig } = require('../../utils/config.js')
    baseURL = getGlobalConfig().configuredBaseUrl
  } catch {
    // config not ready
  }
  if (!baseURL) {
    const entry = getProviderEntry(getAPIProvider())
    baseURL = entry?.defaultBaseUrls?.openai
  }
  if (!baseURL) {
    baseURL = 'https://api.openai.com/v1'
  }

  return new OpenAI({
    apiKey,
    baseURL,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    maxRetries: 3,
    defaultHeaders: {
      'User-Agent': getUserAgent(),
    },
  })
}

// ============================================================================
// Anthropic → OpenAI 格式转换
// ============================================================================

type AnthropicContent = string | Array<{
  type: string
  text?: string
  content?: string | Array<{ type: string; text?: string }>
  source?: { type: string; media_type?: string; data?: string }
  id?: string
  name?: string
  input?: unknown
}>

function convertMessagesToOpenAI(
  messages: any[],
  system?: string | Array<Record<string, unknown>>,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (typeof system === 'string' && system) {
    result.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = system
      .map((b) => (b.type === 'text' ? (b as any).text : ''))
      .filter(Boolean)
      .join('\n\n')
    if (text) result.push({ role: 'system', content: text })
  }

  for (const msg of messages) {
    const content = msg.content
    if (msg.role === 'user') {
      result.push({ role: 'user', content: convertUserContent(content) })
    } else if (msg.role === 'assistant') {
      result.push(convertAssistantMessage(content))
    }
  }

  return result
}

function convertUserContent(
  content: AnthropicContent,
): string | Array<OpenAI.Chat.ChatCompletionContentPart> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text ?? '' })
    } else if (block.type === 'tool_result') {
      const text =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c.text ?? '').join('\n')
            : ''
      parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source?.media_type ?? 'image/png'};base64,${block.source?.data ?? ''}`,
        },
      })
    }
  }
  return parts.length === 1 && parts[0]?.type === 'text'
    ? parts[0].text
    : parts
}

function convertAssistantMessage(
  content: AnthropicContent,
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
  }

  if (typeof content === 'string') {
    msg.content = content
    return msg
  }
  if (!Array.isArray(content)) return msg

  const textParts: string[] = []
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text ?? '')
    } else if (block.type === 'thinking') {
      textParts.push(`<thinking>${block.text ?? ''}</thinking>`)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? randomUUID(),
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: typeof block.input === 'string'
            ? block.input
            : JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  if (textParts.length > 0) msg.content = textParts.join('\n\n')
  if (toolCalls.length > 0) msg.tool_calls = toolCalls

  return msg
}

function convertToolsToOpenAI(
  tools?: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool: any) => ({
    type: 'function' as const,
    function: {
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

// ============================================================================
// OpenAI → 标准格式转换
// ============================================================================

/** 将 OpenAI 响应直接转换为标准 LLMMessage */
function convertOpenAIResponseToStandard(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): LLMMessage {
  const choice = completion.choices[0]
  const contentBlocks: ContentBlock[] = []

  if (choice?.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content, citations: [] })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments ?? '{}'),
      })
    }
  }

  const stopReasonMap: Record<string, StopReason> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
  }

  return {
    id: completion.id ?? randomUUID(),
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: completion.model ?? model,
    stop_reason: choice?.finish_reason
      ? stopReasonMap[choice.finish_reason] ?? 'end_turn'
      : null,
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

/** 将 OpenAI 流式响应直接映射为标准 LLMStreamEvent */
async function* mapOpenAIStreamToStandard(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<LLMStreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  let toolBlockIndices = new Map<number, number>()
  let textBlockStarted = false
  let toolBlocksStarted = new Map<number, boolean>()

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  for await (const chunk of stream) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // 文本 delta
      if (delta.content && delta.content !== '') {
        if (!textBlockStarted) {
          yield {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
          }
          textBlockStarted = true
        }
        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }
      }

      // tool_calls delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0
          if (!toolBlocksStarted.has(tcIdx)) {
            const anthropicIdx = textBlockStarted
              ? textBlockIndex + 1 + toolBlocksStarted.size
              : tcIdx
            toolBlockIndices.set(tcIdx, anthropicIdx)
            toolBlocksStarted.set(tcIdx, true)
            yield {
              type: 'content_block_start',
              index: anthropicIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id ?? randomUUID(),
                name: tc.function?.name ?? '',
                input: {},
              },
            }
          }
          if (tc.function?.arguments) {
            const anthropicIdx = toolBlockIndices.get(tcIdx) ?? tcIdx
            yield {
              type: 'content_block_delta',
              index: anthropicIdx,
              delta: {
                type: 'tool_input_delta',
                partial_json: tc.function.arguments,
              },
            }
          }
        }
      }

      // finish_reason
      if (choice.finish_reason) {
        // 关闭已打开的 content blocks
        if (textBlockStarted) {
          yield {
            type: 'content_block_stop',
            index: textBlockIndex,
          }
        }
        for (const [, anthropicIdx] of toolBlockIndices) {
          yield {
            type: 'content_block_stop',
            index: anthropicIdx,
          }
        }

        const stopReasonMap: Record<string, StopReason> = {
          stop: 'end_turn',
          length: 'max_tokens',
          tool_calls: 'tool_use',
          content_filter: 'stop_sequence',
        }

        const usage: DeltaUsage = {
          output_tokens: chunk.usage?.completion_tokens ?? 0,
        }

        yield {
          type: 'message_delta',
          delta: {
            stop_reason: stopReasonMap[choice.finish_reason] ?? 'end_turn',
          },
          usage,
        }
      }
    }
  }

  // 流结束后发送 message_stop，与 Anthropic SDK 行为对齐
  yield { type: 'message_stop' }
}

// ============================================================================
// OpenAI 实现
// ============================================================================

class OpenAIRequestAdapter implements LLMRequestAdapter {
  async createStream(
    params: LLMCreateParams,
    signal: AbortSignal,
    _client_request_id?: string,
  ): Promise<StreamResult> {
    const client = getOpenAIClient({ model: params.model })
    const openAIParams = stripAnthropicOnlyParams(params)
    const openAIMessages = convertMessagesToOpenAI(openAIParams.messages, openAIParams.system)

    logForDebugging(
      `[OpenAI] Streaming request: model=${params.model}, messages=${openAIMessages.length}, max_tokens=${params.max_tokens}`,
    )

    const stream = await client.chat.completions.create(
      {
        model: params.model,
        messages: openAIMessages,
        max_tokens: params.max_tokens,
        temperature: params.temperature ?? 1,
        ...(params.top_p !== undefined && { top_p: params.top_p }),
        ...(params.tools && { tools: convertToolsToOpenAI(params.tools) }),
        ...(params.tool_choice && { tool_choice: params.tool_choice as any }),
        stream: true,
        stream_options: { include_usage: true },
        ...(params.extra_body ? (params.extra_body as any) : {}),
      },
      { signal },
    ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    return {
      stream: mapOpenAIStreamToStandard(stream, params.model),
      request_id: randomUUID(),
      response: undefined,
    }
  }

  async createMessage(
    params: LLMCreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMMessage> {
    const client = getOpenAIClient({ model: params.model })
    const openAIParams = stripAnthropicOnlyParams(params)
    const openAIMessages = convertMessagesToOpenAI(openAIParams.messages, openAIParams.system)

    logForDebugging(
      `[OpenAI] Non-streaming request: model=${params.model}, messages=${openAIMessages.length}, max_tokens=${params.max_tokens}`,
    )

    const completion = await client.chat.completions.create(
      {
        model: params.model,
        messages: openAIMessages,
        max_tokens: params.max_tokens,
        temperature: params.temperature ?? 1,
        ...(params.top_p !== undefined && { top_p: params.top_p }),
        ...(params.tools && { tools: convertToolsToOpenAI(params.tools) }),
        ...(params.tool_choice && { tool_choice: params.tool_choice as any }),
        stream: false,
        ...(params.extra_body ? (params.extra_body as any) : {}),
      },
      { signal },
    )

    return convertOpenAIResponseToStandard(completion, params.model)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}

/**
 * 从标准参数中移除 OpenAI 不支持的字段。
 */
function stripAnthropicOnlyParams(params: LLMCreateParams) {
  const {
    betas, thinking, context_management, system,
    metadata, output_config, ...rest
  } = params as any
  return {
    ...rest,
    model: normalizeModelStringForAPI(params.model),
    ...(system !== undefined && { system: system as string | Record<string, unknown>[] }),
  }
}

/**
 * 供外部使用的 OpenAI 消息创建函数（替代 openaiQuery.ts 中的 openAICreateMessage）。
 */
export async function createOpenAIMessage(params: {
  model: string
  messages: any[]
  system?: string | Array<Record<string, unknown>>
  max_tokens: number
  temperature?: number
  top_p?: number
  tools?: ToolDefinition[]
  tool_choice?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<LLMMessage> {
  const client = getOpenAIClient({ model: params.model })
  const openAIMessages = convertMessagesToOpenAI(params.messages, params.system)

  logForDebugging(
    `[OpenAI] Non-streaming request: model=${params.model}, messages=${openAIMessages.length}, max_tokens=${params.max_tokens}`,
  )

  const completion = await client.chat.completions.create(
    {
      model: params.model,
      messages: openAIMessages,
      max_tokens: params.max_tokens,
      temperature: params.temperature ?? 1,
      ...(params.top_p !== undefined && { top_p: params.top_p }),
      ...(params.tools && { tools: convertToolsToOpenAI(params.tools) }),
      ...(params.tool_choice && { tool_choice: params.tool_choice as any }),
      stream: false,
    },
    { signal: params.signal },
  )

  return convertOpenAIResponseToStandard(completion, params.model)
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 根据当前 API provider 创建对应的请求适配器。
 *
 * @param anthropicClient - Anthropic SDK 客户端实例（由 withRetry 提供）
 * @returns 对应 provider 的请求适配器
 */
export function getRequestAdapter(anthropicClient: Anthropic): LLMRequestAdapter {
  if (isOpenAIProvider(getAPIProvider())) {
    return new OpenAIRequestAdapter()
  }
  return new AnthropicRequestAdapter(anthropicClient)
}
