/**
 * OpenAI Provider Adapter — 将标准消息格式转换为 OpenAI SDK 格式。
 *
 * 此文件是唯一引用 openai 包类型的 adapter。
 * 调用方只使用 StandardMessageFormat 中的类型。
 */
import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type {
  StandardMessage,
  StandardMessageRequest,
  StandardResponse,
  StandardStreamEvent,
  StandardContentBlock,
  StandardToolDefinition,
  StandardUsage,
  StandardStopReason,
} from './StandardMessageFormat.js'
import { getUserAgent } from '../../utils/http.js'

// ============================================================================
// 标准格式 → OpenAI 格式
// ============================================================================

function standardMessagesToOpenAI(
  messages: StandardMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content })
    } else if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: standardUserContentToOpenAI(msg.content),
      })
    } else if (msg.role === 'assistant') {
      result.push(standardAssistantContentToOpenAI(msg.content))
    }
  }

  return result
}

function standardUserContentToOpenAI(
  content: string | StandardContentBlock[],
): string | Array<OpenAI.Chat.ChatCompletionContentPart> {
  if (typeof content === 'string') return content
  const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.mimeType};base64,${block.data}`,
          },
        })
        break
      case 'tool_result': {
        const text = typeof block.content === 'string'
          ? block.content
          : block.content.map(b => b.type === 'text' ? (b as any).text : '').join('\n')
        parts.push({ type: 'text', text })
        break
      }
    }
  }
  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts
}

function standardAssistantContentToOpenAI(
  content: string | StandardContentBlock[],
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: 'assistant' }

  if (typeof content === 'string') {
    msg.content = content
    return msg
  }

  const textParts: string[] = []
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'thinking') {
      textParts.push(`<thinking>${block.thinking}</thinking>`)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
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
  if (toolCalls.length > 0) msg.tool_calls = toolCalls

  return msg
}

function standardToolsToOpenAI(
  tools?: StandardToolDefinition[],
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

// ============================================================================
// OpenAI 格式 → 标准格式
// ============================================================================

function openAIResponseToStandard(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): StandardResponse {
  const choice = completion.choices[0]
  const contentBlocks: StandardContentBlock[] = []

  if (choice?.message.content) {
    contentBlocks.push({ type: 'text', text: choice.message.content })
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
): StandardStopReason {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    case 'tool_calls': return 'tool_use'
    case 'content_filter': return 'stop_sequence'
    default: return null
  }
}

function openAIUsageToStandard(
  usage: OpenAI.CompletionUsage | undefined | null,
): StandardUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  }
}

// ============================================================================
// Provider 实现
// ============================================================================

export class OpenAIProviderAdapter {
  readonly name = 'openai'

  private client: OpenAI

  constructor(options?: {
    apiKey?: string
    baseURL?: string
    timeout?: number
  }) {
    this.client = new OpenAI({
      apiKey: options?.apiKey || process.env.OPENAI_API_KEY || '',
      baseURL: options?.baseURL || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      timeout: options?.timeout ?? parseInt(process.env.API_TIMEOUT_MS || '600000', 10),
      maxRetries: 3,
      defaultHeaders: { 'User-Agent': getUserAgent() },
    })
  }

  async createMessage(request: StandardMessageRequest): Promise<StandardResponse> {
    const messages = standardMessagesToOpenAI(request.messages)

    const completion = await this.client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 1,
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.tools && { tools: standardToolsToOpenAI(request.tools) }),
      ...(request.toolChoice && { tool_choice: request.toolChoice as any }),
      stream: false,
    })

    return openAIResponseToStandard(completion)
  }

  async *createMessageStream(
    request: StandardMessageRequest,
  ): AsyncIterable<StandardStreamEvent> {
    const messages = standardMessagesToOpenAI(request.messages)

    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 1,
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.tools && { tools: standardToolsToOpenAI(request.tools) }),
      ...(request.toolChoice && { tool_choice: request.toolChoice as any }),
      stream: true,
      stream_options: { include_usage: true },
    }) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    yield* openAIStreamToStandard(stream, request.model)
  }
}

// ============================================================================
// OpenAI SSE → 标准流式事件
// ============================================================================

async function* openAIStreamToStandard(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<StandardStreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  let toolBlockCounter = 0
  let textBlockStarted = false
  let openToolBlocks = 0

  yield {
    type: 'message_start',
    messageId,
    model,
  }

  for await (const chunk of stream) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // 文本
      if (delta.content && delta.content !== '') {
        if (!textBlockStarted) {
          yield {
            type: 'content_block_start',
            index: textBlockIndex,
            contentBlock: { type: 'text', text: '' },
          }
          textBlockStarted = true
        }
        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text', text: delta.content },
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
              type: 'content_block_start',
              index: textBlockStarted ? textBlockIndex + openToolBlocks : tcIdx,
              contentBlock: {
                type: 'tool_use',
                id: tc.id ?? randomUUID(),
                name: tc.function.name,
                input: {},
              },
            }
          }
          if (tc.function?.arguments) {
            yield {
              type: 'content_block_delta',
              index: textBlockStarted ? textBlockIndex + openToolBlocks : tcIdx,
              delta: { type: 'input_json', partialJson: tc.function.arguments },
            }
          }
        }
      }

      // 结束
      if (choice.finish_reason) {
        if (textBlockStarted) {
          yield { type: 'content_block_stop', index: textBlockIndex }
        }
        for (let i = 0; i < openToolBlocks; i++) {
          yield {
            type: 'content_block_stop',
            index: textBlockStarted ? textBlockIndex + 1 + i : i,
          }
        }

        yield {
          type: 'message_delta',
          stopReason: openAIFinishReasonToStandard(choice.finish_reason),
          usage: chunk.usage ? openAIUsageToStandard(chunk.usage) : undefined,
        }
      }
    }
  }
}
