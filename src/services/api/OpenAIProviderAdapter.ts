/**
 * OpenAI Provider Adapter — 将中立标准格式转换为 OpenAI SDK 格式。
 *
 * 此文件是唯一引用 openai 包类型的 adapter。
 * 调用方只使用 llm.ts 中的标准类型。
 */
import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type {
  LLMAdapter,
  CreateParams,
  StreamResult,
  StreamEvent,
  Message,
  AssistantContentBlock,
  TokenUsage,
  DeltaUsage,
  StopReason,
  ToolDefinition,
  ToolChoice,
  UserContentBlock,
} from '../../types/llm.js'
import type { Response as LLMResponse } from '../../types/llm.js'
import { getUserAgent } from '../../utils/http.js'
import { getApiKey } from '../../utils/auth.js'
import { getAPIProvider, isOpenAIProvider } from '../../utils/model/providers.js'
import { getProviderEntry } from '../../utils/model/providerRegistry.js'

// ============================================================================
// 标准格式 → OpenAI 格式
// ============================================================================

function messagesToOpenAI(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        result.push({ role: 'system', content: msg.content })
        break
      case 'user':
        result.push({
          role: 'user',
          content: userContentToOpenAI(msg.content),
        })
        break
      case 'assistant':
        result.push(assistantContentToOpenAI(msg.content, msg.toolCalls))
        break
      case 'tool':
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content,
        })
        break
    }
  }

  return result
}

function userContentToOpenAI(
  content: string | UserContentBlock[],
): string | Array<OpenAI.Chat.ChatCompletionContentPart> {
  if (typeof content === 'string') return content
  const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.mimeType};base64,${block.data}`,
        },
      })
    }
  }
  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts
}

function assistantContentToOpenAI(
  content: string | AssistantContentBlock[],
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: 'assistant' }

  if (typeof content === 'string') {
    msg.content = content
    if (toolCalls?.length) {
      msg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }))
    }
    return msg
  }

  const textParts: string[] = []
  const toolCallBlocks: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_call') {
      toolCallBlocks.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }

  if (textParts.length > 0) msg.content = textParts.join('\n\n')
  if (toolCallBlocks.length > 0) msg.tool_calls = toolCallBlocks
  // 也使用 toolCalls 字段
  if (toolCalls?.length && !msg.tool_calls) {
    msg.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }))
  }

  return msg
}

function toolsToOpenAI(
  tools?: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

function toolChoiceToOpenAI(choice?: ToolChoice): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined
  switch (choice.type) {
    case 'auto': return 'auto'
    case 'none': return 'none'
    case 'tool': return { type: 'function', function: { name: choice.name } }
    default: return undefined
  }
}

// ============================================================================
// OpenAI 格式 → 标准格式
// ============================================================================

function openAIResponseToStandard(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): LLMResponse {
  const choice = completion.choices[0]
  const contentBlocks: AssistantContentBlock[] = []

  if (choice?.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      contentBlocks.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments ?? '{}'),
      })
    }
  }

  return {
    id: completion.id ?? randomUUID(),
    model: completion.model ?? 'unknown',
    role: 'assistant',
    content: contentBlocks,
    stopReason: openAIFinishReasonToStandard(choice?.finish_reason),
    usage: openAIUsageToStandard(completion.usage),
  }
}

function openAIFinishReasonToStandard(
  reason: string | null | undefined,
): StopReason {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    case 'tool_calls': return 'tool_use'
    case 'content_filter': return 'content_filter'
    default: return null
  }
}

function openAIUsageToStandard(
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

function openAIDeltaUsageToStandard(usage: OpenAI.CompletionUsage | undefined | null): DeltaUsage {
  return {
    outputTokens: usage?.completion_tokens ?? 0,
  }
}

// ============================================================================
// OpenAI 客户端创建
// ============================================================================

function getOpenAIClient(options?: {
  apiKey?: string
  baseURL?: string
  timeout?: number
}): OpenAI {
  const apiKey = options?.apiKey || getApiKey() || ''

  let baseURL: string | undefined = options?.baseURL
  if (!baseURL) {
    try {
      const { getGlobalConfig } = require('../../utils/config.js')
      baseURL = getGlobalConfig().configuredBaseUrl
    } catch {
      // config not ready
    }
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
    timeout: options?.timeout ?? parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    maxRetries: 3,
    defaultHeaders: { 'User-Agent': getUserAgent() },
  })
}

// ============================================================================
// Provider 实现
// ============================================================================

export class OpenAIProviderAdapter implements LLMAdapter {
  readonly name = 'openai'

  private client: OpenAI

  constructor(options?: {
    apiKey?: string
    baseURL?: string
    timeout?: number
  }) {
    this.client = getOpenAIClient(options)
  }

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const openAIParams = buildOpenAIParams(params)

    const stream = await this.client.chat.completions.create(
      {
        ...openAIParams,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    return {
      stream: convertOpenAIStream(stream, params.model),
      requestId: randomUUID(),
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMResponse> {
    const openAIParams = buildOpenAIParams(params)

    const completion = await this.client.chat.completions.create(
      {
        ...openAIParams,
        stream: false,
      },
      { signal },
    )

    return openAIResponseToStandard(completion)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}

function buildOpenAIParams(params: CreateParams) {
  const openAIMessages = messagesToOpenAI(params.messages)
  const openAITools = toolsToOpenAI(params.tools)
  const openAIToolChoice = toolChoiceToOpenAI(params.toolChoice)
  const openAIExtras = params.providerExtras?.openai

  return {
    model: params.model,
    messages: openAIMessages,
    max_tokens: params.maxTokens,
    temperature: params.temperature ?? 1,
    ...(params.topP !== undefined && { top_p: params.topP }),
    ...(params.stopSequences?.length && { stop: params.stopSequences }),
    ...(openAITools && { tools: openAITools }),
    ...(openAIToolChoice && { tool_choice: openAIToolChoice }),
    ...(openAIExtras as Record<string, unknown>),
  }
}

// ============================================================================
// OpenAI SSE → 标准流式事件
// ============================================================================

async function* convertOpenAIStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<StreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  let toolBlockCounter = 0
  let textBlockStarted = false
  let openToolBlocks = 0
  // 百炼深度思考：reasoning_content 需要独立的 thinking block
  let thinkingBlockStarted = false
  let thinkingBlockIndex = 0

  yield {
    type: 'response_start',
    responseId: messageId,
    model,
  }

  for await (const chunk of stream) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta as any

      // 思考过程（百炼等 OpenAI 兼容平台的 reasoning_content）
      // 思考内容必须在独立的 thinking block 中，不能和 text block 混用 index
      if (delta.reasoning_content && delta.reasoning_content !== '') {
        if (!thinkingBlockStarted) {
          // 首次收到 reasoning_content 时创建 thinking block（index 0）
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
          // 思考结束后才开始的 text block，index 要在 thinking 之后
          const newTextBlockIndex = thinkingBlockStarted ? thinkingBlockIndex + 1 : textBlockIndex
          textBlockIndex = newTextBlockIndex
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
          const isStart = openToolBlocks === 0 || tcIdx === 0
          if (isStart && tc.function?.name) {
            toolBlockCounter++
            openToolBlocks++
            yield {
              type: 'chunk_start',
              index: textBlockStarted ? textBlockIndex + openToolBlocks : tcIdx,
              chunk: {
                type: 'tool_call',
                id: tc.id ?? randomUUID(),
                name: tc.function.name,
                input: {},
              },
            }
          }
          if (tc.function?.arguments) {
            yield {
              type: 'chunk_delta',
              index: textBlockStarted ? textBlockIndex + openToolBlocks : tcIdx,
              delta: { type: 'input_json_delta', partialJson: tc.function.arguments },
            }
          }
        }
      }

      // 结束
      if (choice.finish_reason) {
        if (textBlockStarted) {
          yield { type: 'chunk_stop', index: textBlockIndex }
        }
        for (let i = 0; i < openToolBlocks; i++) {
          yield {
            type: 'chunk_stop',
            index: textBlockStarted ? textBlockIndex + 1 + i : i,
          }
        }

        yield {
          type: 'response_delta',
          stopReason: openAIFinishReasonToStandard(choice.finish_reason),
          usage: chunk.usage ? openAIDeltaUsageToStandard(chunk.usage) : undefined,
        }
      }
    }
  }

  // 流结束后发送 response_stop
  yield { type: 'response_stop' }
}
