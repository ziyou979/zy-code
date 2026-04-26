/**
 * 统一的 LLM 请求适配器。
 *
 * 将 Anthropic SDK 和 OpenAI SDK 的调用统一为相同的接口，
 *
 * 设计原则：
 * - 使用 src/types/llm.ts 中定义的标准类型作为内部格式
 * - Anthropic 和 OpenAI 完全平等，各自实现适配器
 * - 适配器负责将 SDK 特定类型转换为标准类型
 */
import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type {
  StreamEvent,
  Message,
  LLMAdapter,
  StreamResult,
  CreateParams,
  Response as LLMResponse,
  StopReason,
  ToolDefinition,
  DeltaUsage,
  AssistantContentBlock,
  ChunkDelta,
  TokenUsage,
} from '../../types/llm.js'
import { getAPIProvider, isOpenAIProvider } from '../../utils/model/providers.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import OpenAI from 'openai'
import { getUserAgent } from '../../utils/http.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { getApiKey } from '../../utils/auth.js'
import { getProviderEntry } from '../../utils/model/providerRegistry.js'

// Re-export for consumers that import from streamAdapter
export type { LLMAdapter, StreamResult } from '../../types/llm.js'

// ============================================================================
// Anthropic SDK → 标准流式事件转换
// ============================================================================

/** 将 Anthropic SDK 的流式事件转换为标准 StreamEvent */
function convertAnthropicStreamEvent(event: any): StreamEvent {
  switch (event.type) {
    case 'message_start': {
      const msg = event.message
      return {
        type: 'response_start',
        responseId: msg.id,
        model: msg.model,
      }
    }
    case 'content_block_start': {
      const block = event.content_block
      let chunk: AssistantContentBlock
      switch (block.type) {
        case 'text':
          chunk = { type: 'text', text: block.text ?? '' }
          break
        case 'tool_use':
          // 保留 tool_use type，让 zy.ts 等消费者能正确判断
          chunk = { type: 'tool_call' as any, id: block.id, name: block.name, input: block.input ?? {} }
          break
        case 'thinking':
          // 保留 thinking type
          chunk = { type: 'thinking' as any, thinking: block.thinking ?? '', signature: block.signature ?? '' }
          break
        case 'redacted_thinking':
          chunk = { type: 'redacted_thinking' as any, data: block.data ?? '' }
          break
        case 'server_tool_use':
          chunk = { type: 'server_tool_use' as any, id: block.id, name: block.name, input: block.input ?? {} }
          break
        default:
          chunk = { type: 'text', text: '' }
      }
      return {
        type: 'chunk_start',
        index: event.index,
        chunk,
      }
    }
    case 'content_block_delta': {
      const delta = event.delta
      let chunkDelta: ChunkDelta
      switch (delta.type) {
        case 'text_delta':
          chunkDelta = { type: 'text_delta', text: delta.text }
          break
        case 'input_json_delta':
          // 保留 partial_json 字段名（snake_case），zy.ts 直接读取
          chunkDelta = { type: 'input_json_delta', partial_json: delta.partial_json } as any
          break
        case 'thinking_delta':
          // 保留 thinking_delta 类型，让 zy.ts 能正确处理 thinking
          chunkDelta = { type: 'thinking_delta' as any, thinking: delta.thinking }
          break
        case 'signature_delta':
          chunkDelta = { type: 'signature_delta' as any, signature: delta.signature }
          break
        default:
          chunkDelta = { type: 'text_delta', text: '' }
      }
      return {
        type: 'chunk_delta',
        index: event.index,
        delta: chunkDelta,
      }
    }
    case 'content_block_stop':
      return {
        type: 'chunk_stop',
        index: event.index,
      }
    case 'message_delta': {
      const usage: DeltaUsage | undefined = event.usage
        ? {
            outputTokens: event.usage.output_tokens ?? 0,
            ...(event.usage.cache_creation_input_tokens !== undefined && {
              extras: { cacheCreationInputTokens: event.usage.cache_creation_input_tokens },
            }),
            ...(event.usage.cache_read_input_tokens !== undefined && {
              extras: {
                ...(event.usage.cache_creation_input_tokens !== undefined && {
                  cacheCreationInputTokens: event.usage.cache_creation_input_tokens,
                }),
                cacheReadInputTokens: event.usage.cache_read_input_tokens,
              },
            }),
          }
        : undefined
      return {
        type: 'response_delta',
        stopReason: event.delta.stop_reason as StopReason,
        usage,
      }
    }
    case 'message_stop':
      return {
        type: 'response_stop',
      }
    default:
      // 未知事件类型，透传为 response_stop（安全降级）
      return { type: 'response_stop' }
  }
}

/** 将 Anthropic SDK 的 usage 转换为标准 TokenUsage */
function convertAnthropicUsage(usage: any): TokenUsage {
  const extras: Record<string, number> = {}
  if (usage?.cache_creation_input_tokens !== undefined) {
    extras.cacheCreationInputTokens = usage.cache_creation_input_tokens
  }
  if (usage?.cache_read_input_tokens !== undefined) {
    extras.cacheReadInputTokens = usage.cache_read_input_tokens
  }
  if (usage?.server_tool_use_input_tokens !== undefined) {
    extras.serverToolUseInputTokens = usage.server_tool_use_input_tokens
  }
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(Object.keys(extras).length > 0 && { extras }),
  }
}

// ============================================================================
// Anthropic 实现
// ============================================================================

class AnthropicRequestAdapter implements LLMAdapter {
  constructor(private readonly client: Anthropic) {}

  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    clientRequestId?: string,
  ): Promise<StreamResult> {
    const anthropicParams = convertToAnthropicParams(params)
    // @ts-ignore - anthropicParams is Record<string, any>, SDK types are internal
    const result = await this.client.beta.messages.create(
      { ...anthropicParams, stream: true },
      {
        signal,
        ...(clientRequestId && {
          headers: { 'anthropic-client-request-id': clientRequestId },
        }),
      },
    ).withResponse()

    const rawStream = result.data as unknown as AsyncIterable<any>

    return {
      stream: convertAnthropicStream(rawStream),
      requestId: result.request_id,
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    timeout?: number,
  ): Promise<LLMResponse> {
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
    return convertAnthropicResponse(result, params.model)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    // Anthropic 的 key 验证通过实际 API 调用完成
    return true
  }
}

/** 将参数转换为 Anthropic SDK 参数。兼容 v1 (snake_case) 和 v2 (camelCase) 格式。 */
function convertToAnthropicParams(params: CreateParams): Record<string, any> {
  // 兼容 v1 snake_case 和 v2 camelCase 字段
  const p = params as any
  const maxTokens = p.maxTokens ?? p.max_tokens
  const model = p.model
  const temperature = p.temperature
  const topP = p.topP ?? p.top_p
  const stopSequences = p.stopSequences ?? p.stop_sequences

  // 从 providerExtras 或顶层字段中提取 Anthropic 专属字段
  const anthropicExtras = p.providerExtras?.anthropic
  const thinking = anthropicExtras?.thinking ?? p.thinking
  const betas = anthropicExtras?.betas ?? p.betas
  const contextManagement = anthropicExtras?.contextManagement ?? p.context_management
  const outputConfig = anthropicExtras?.outputConfig ?? p.output_config
  const metadata = p.metadata

  // 消息：兼容 v1 LLMMessageParam[] (只有 user/assistant) 和 v2 Message[] (4 角色分离)
  const rawMessages = p.messages ?? []
  const systemMessages = rawMessages.filter((m: any) => m.role === 'system')
  const nonSystemMessages = rawMessages.filter((m: any) => m.role !== 'system')

  // 构建 system 提示
  let systemContent: string | Array<Record<string, unknown>> | undefined
  if (systemMessages.length > 0) {
    systemContent = systemMessages.map((m: any) => m.content as string).join('\n\n')
  } else if (p.system !== undefined) {
    // v1 的 system 是顶层字段
    systemContent = p.system
  }

  // 工具定义：兼容 v1 (input_schema) 和 v2 (inputSchema)
  const rawTools = p.tools
  const convertedTools = rawTools?.map((t: any) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema ?? t.inputSchema,
  }))

  // Anthropic 原生工具（如 web_search_20260209），直接透传原始 schema
  const anthropicNativeTools = anthropicExtras?._extraToolSchemas ?? []
  const allTools = [...anthropicNativeTools, ...(convertedTools ?? [])]

  return {
    model,
    max_tokens: maxTokens,
    messages: nonSystemMessages as any,
    ...(systemContent !== undefined && { system: systemContent }),
    ...(allTools.length > 0 && { tools: allTools }),
    ...(p.tool_choice !== undefined && { tool_choice: p.tool_choice }),
    ...(p.toolChoice !== undefined && { tool_choice: p.toolChoice as any }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(stopSequences !== undefined && { stop_sequences: stopSequences }),
    ...(metadata !== undefined && { metadata }),
    ...(thinking !== undefined && { thinking }),
    ...(betas !== undefined && { betas }),
    ...(contextManagement !== undefined && { context_management: contextManagement }),
    ...(outputConfig !== undefined && { output_config: outputConfig }),
    // 透传 extra_body 中的其他字段
    ...(p.extra_body ? (p.extra_body as any) : {}),
  }
}

/** 将 Anthropic 原始事件流转换为标准事件流 */
async function* convertAnthropicStream(
  rawStream: AsyncIterable<any>,
): AsyncIterable<StreamEvent> {
  for await (const event of rawStream) {
    yield convertAnthropicStreamEvent(event)
  }
}

/** 将 Anthropic SDK 非流式响应转换为标准 Response */
function convertAnthropicResponse(result: any, model: string): LLMResponse {
  const content: AssistantContentBlock[] = (result.content || []).map((block: any) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text ?? '' }
      case 'tool_use':
        return { type: 'tool_call', id: block.id, name: block.name, input: block.input ?? {} }
      case 'thinking':
        return { type: 'text', text: block.thinking ?? '' }
      default:
        return { type: 'text', text: '' }
    }
  })

  return {
    id: result.id,
    model: result.model ?? model,
    role: 'assistant',
    content,
    stopReason: result.stop_reason as StopReason,
    usage: convertAnthropicUsage(result.usage),
  }
}

// ============================================================================
// OpenAI 工具函数
// ============================================================================

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
// CreateParams 消息 → OpenAI 格式转换
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

/** 将 4 角色分离消息转换为 OpenAI 格式 */
/**
 * 将消息转换为 OpenAI 格式。兼容 v1 (LLMMessageParam[]) 和 v2 (Message[]) 格式。
 * v1: user 消息中嵌有 tool_result 块，需要拆分为独立的 role:'tool' 消息
 * v2: tool 消息是独立的 role:'tool' 角色
 */
function convertMessagesToOpenAI(
  messages: any[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        if (msg.content) {
          result.push({ role: 'system', content: msg.content })
        }
        break
      case 'user':
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
        } else if (Array.isArray(msg.content)) {
          // v1: user 消息中可能包含 tool_result 块，需要拆分为独立的 tool 消息
          const toolResults: any[] = []
          const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = []
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              // v1 tool_result → 独立的 role:'tool' 消息
              const text = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content)
                    ? block.content.map((c: any) => c.type === 'text' ? c.text : '').join('\n')
                    : '')
              toolResults.push({
                role: 'tool',
                tool_call_id: block.tool_use_id ?? '',
                content: text || '(empty)',
              })
            } else if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text })
            } else if (block.type === 'image') {
              // 兼容 v1 嵌套 source 和 v2 平铺格式
              const mimeType = block.mimeType ?? block.source?.media_type ?? 'image/png'
              const data = block.data ?? block.source?.data ?? ''
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${data}` },
              })
            }
          }
          // 先发送 tool 消息（紧跟在 assistant tool_calls 后面）
          result.push(...toolResults)
          // 再发送 user 消息
          if (parts.length > 0) {
            result.push({
              role: 'user',
              content: parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts,
            })
          } else if (toolResults.length === 0) {
            result.push({ role: 'user', content: '' })
          }
        } else {
          result.push({ role: 'user', content: '' })
        }
        break
      case 'assistant':
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content })
        } else if (Array.isArray(msg.content)) {
          const textParts: string[] = []
          const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text)
            } else if (block.type === 'tool_use' || block.type === 'tool_call') {
              // 兼容 v1 (tool_use) 和 v2 (tool_call)
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                },
              })
            } else if (block.type === 'thinking') {
              textParts.push(`<thinking>${block.thinking ?? ''}</thinking>`)
            }
            // redacted_thinking / server_tool_use: OpenAI 不支持，忽略
          }
          const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
          }
          if (textParts.length > 0) assistantMsg.content = textParts.join('\n\n')
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
          result.push(assistantMsg)
        }
        break
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

function convertToolsToOpenAI(
  tools?: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }))
}

// ============================================================================
// OpenAI response_format 转换
// ============================================================================

/**
 * 将 Anthropic 风格的 output_config.format 转换为 OpenAI 的 response_format。
 * Anthropic: { format: { type: 'json_schema', json_schema: { ... } | schema: { ... } } }
 * OpenAI:    { type: 'json_schema', json_schema: { ... } }
 *
 * 如果已经是 OpenAI 格式（顶层有 type 字段），直接返回。
 * 如果是 'json_object' 格式，也直接返回。
 */
function convertOutputFormatToResponseFormat(
  outputConfig: Record<string, unknown> | undefined,
): OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] | undefined {
  if (!outputConfig) return undefined

  // output_config 可能是 Anthropic 格式：{ format: { type: 'json_schema', ... } }
  const format = outputConfig.format as Record<string, unknown> | undefined
  if (!format) return undefined

  // 如果已经是 OpenAI 原生格式（顶层有 type）
  if (format.type === 'json_object') {
    return { type: 'json_object' }
  }

  if (format.type === 'json_schema') {
    // json_schema 可能在内嵌的 json_schema 字段中，也可能在 schema 字段中
    const jsonSchema = (format.json_schema as Record<string, unknown>) ??
      (format.schema as Record<string, unknown>)
    if (jsonSchema) {
      return {
        type: 'json_schema',
        json_schema: jsonSchema as unknown as OpenAI.ResponseFormatJSONSchema['json_schema'],
      }
    }
  }

  // 兜底：如果 format 本身看起来像 OpenAI 格式
  if (format.type) {
    return format as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']
  }

  return undefined
}

// ============================================================================
// OpenAI thinking/reasoning 参数转换
// ============================================================================

/**
 * 将 Anthropic 格式的 thinking 参数转换为各 OpenAI 兼容平台所需的格式。
 * 参考 Open Code (sst/opencode) 的 transform.ts 实现。
 *
 * 数据源：
 * - thinking 对象：决定"是否启用 thinking"（disabled/enabled/adaptive）
 * - output_config.effort：决定 thinking 的 effort 级别（low/medium/high），
 *   由 zy.ts 的 configureEffortParams() 设置，受 /effort 命令和 settings.effortLevel 控制
 *
 * 各平台参数格式：
 * - 百炼（dashscope）: `enable_thinking: true`
 * - 智谱（zhipu）: `thinking: { type: 'enabled', clear_thinking: false }`
 * - Kimi（moonshot）: `chat_template_args: { enable_thinking: true }`（kimi-k2-thinking）
 * - DeepSeek: `reasoning_effort: "low"|"medium"|"high"`
 * - OpenRouter: `reasoning: { effort: "low"|"medium"|"high" }`
 * - OpenAI 官方: `reasoning_effort: "low"|"medium"|"high"`
 * - 其他（模型名含 reasoning/r1 等）: `enable_thinking: true`
 */
function convertThinkingForOpenAI(
  thinking: { type: string; budget_tokens?: number } | undefined,
  model: string,
  outputConfig?: Record<string, unknown>,
): Record<string, unknown> {
  // thinking 未设置或已禁用，不传递任何参数
  if (!thinking || thinking.type === 'disabled') {
    return {}
  }

  const provider = getAPIProvider()
  const modelLower = model.toLowerCase()

  // 从 output_config 中读取 effort 级别（由 zy.ts configureEffortParams 设置）
  const effort = outputConfig?.effort as string | undefined

  // 百炼（DashScope）：enable_thinking: true
  if (provider === 'dashscope') {
    return { enable_thinking: true }
  }

  // 智谱：thinking: { type: 'enabled', clear_thinking: false }
  if (provider === 'zhipu') {
    return { thinking: { type: 'enabled', clear_thinking: false } }
  }

  // Kimi（Moonshot）：chat_template_args: { enable_thinking: true }
  // kimi-k2-thinking 模型使用 chat_template_args，其他 kimi 模型使用 enable_thinking
  if (provider === 'kimi') {
    if (modelLower.includes('kimi-k2-thinking') || modelLower.includes('k2-thinking')) {
      return { chat_template_args: { enable_thinking: true } }
    }
    return { enable_thinking: true }
  }

  // DeepSeek：reasoning_effort
  if (provider === 'deepseek') {
    return { reasoning_effort: effort ?? 'medium' }
  }

  // OpenRouter：reasoning: { effort: "low"|"medium"|"high" }
  if (provider === 'openrouter') {
    return { reasoning: { effort: effort ?? 'medium' } }
  }

  // OpenAI 官方：reasoning_effort
  if (provider === 'openai') {
    return { reasoning_effort: effort ?? 'medium' }
  }

  // SiliconFlow 等通用 OpenAI 兼容平台：
  // 如果模型名包含 reasoning/thinking/r1 等关键词，传 enable_thinking: true
  if (modelLower.includes('reasoning') || modelLower.includes('r1') ||
      modelLower.includes('thinking') || modelLower.includes('deepseek')) {
    return { enable_thinking: true }
  }

  return {}
}

// ============================================================================
// OpenAI → 标准格式转换
// ============================================================================

const OPENAI_STOP_REASON_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
  refusal: 'refusal',
}

/** 将 OpenAI 响应直接转换为标准 Response */
function convertOpenAIResponseToStandard(
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
    model: completion.model ?? model,
    role: 'assistant',
    content: contentBlocks,
    stopReason: choice?.finish_reason
      ? OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? 'end_turn'
      : null,
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

/** 将 OpenAI 流式响应直接映射为标准 StreamEvent */
async function* mapOpenAIStreamToStandard(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  model: string,
): AsyncIterable<StreamEvent> {
  const messageId = randomUUID()
  let textBlockIndex = 0
  let toolBlockIndices = new Map<number, number>()
  let textBlockStarted = false
  let toolBlocksStarted = new Map<number, boolean>()
  let currentModel = model
  // 百炼深度思考：reasoning_content 需要独立的 thinking block
  let thinkingBlockStarted = false
  let thinkingBlockIndex = 0

  yield {
    type: 'response_start',
    responseId: messageId,
    model,
  }

  for await (const chunk of stream) {
    if (chunk.model) currentModel = chunk.model

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

      // 文本 delta
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

      // tool_calls delta — 使用 tool_use type 让 zy.ts 等消费者能正确判断
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0
          if (!toolBlocksStarted.has(tcIdx)) {
            const blockIndex = textBlockStarted
              ? textBlockIndex + 1 + toolBlocksStarted.size
              : tcIdx
            toolBlockIndices.set(tcIdx, blockIndex)
            toolBlocksStarted.set(tcIdx, true)
            yield {
              type: 'chunk_start',
              index: blockIndex,
              chunk: {
                type: 'tool_use',
                id: tc.id ?? randomUUID(),
                name: tc.function?.name ?? '',
                input: {},
              },
            }
          }
          if (tc.function?.arguments) {
            const blockIndex = toolBlockIndices.get(tcIdx) ?? tcIdx
            yield {
              type: 'chunk_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              } as any,
            }
          }
        }
      }

      // finish_reason
      if (choice.finish_reason) {
        // 关闭已打开的 content blocks
        if (textBlockStarted) {
          yield {
            type: 'chunk_stop',
            index: textBlockIndex,
          }
        }
        for (const [, blockIndex] of toolBlockIndices) {
          yield {
            type: 'chunk_stop',
            index: blockIndex,
          }
        }

        const usage: DeltaUsage = {
          outputTokens: chunk.usage?.completion_tokens ?? 0,
        }

        yield {
          type: 'response_delta',
          stopReason: OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? 'end_turn',
          usage,
        }
      }
    }
  }

  // 流结束后发送 response_stop
  yield { type: 'response_stop' }
}

// ============================================================================
// OpenAI 实现
// ============================================================================

class OpenAIRequestAdapter implements LLMAdapter {
  async createStream(
    params: CreateParams,
    signal: AbortSignal,
    _clientRequestId?: string,
  ): Promise<StreamResult> {
    const p = params as any
    const client = getOpenAIClient({ model: p.model })
    // 兼容 v1 LLMMessageParam[] 和 v2 Message[]
    const rawMessages = p.messages ?? []
    const openAIMessages = convertMessagesToOpenAI(rawMessages)
    const openaiExtras = p.providerExtras?.openai

    logForDebugging(
      `[OpenAI] Streaming request: model=${p.model}, messages=${openAIMessages.length}`,
    )

    // 从 providerExtras.openai 中提取 response_format（如果已转换）
    const openaiResponseFormat = openaiExtras?.response_format
    // 从 output_config 中提取并转换为 OpenAI 的 response_format
    const outputConfigResponseFormat = convertOutputFormatToResponseFormat(p.output_config)

    // 提取 OpenAI 原生工具（如 web_search_preview），注入到 tools 数组
    const openaiNativeTools = openaiExtras?._web_search_tool
      ? [openaiExtras._web_search_tool]
      : []
    // 从 openaiExtras 中移除内部字段，避免作为顶层参数传递
    const openaiExtrasCleaned = openaiExtras ? { ...openaiExtras } : {}
    delete (openaiExtrasCleaned as any)._web_search_tool

    // 将 Anthropic 格式的 thinking 转换为 OpenAI 兼容格式的 thinking 参数
    // - 百炼: enable_thinking: true
    // - 智谱: thinking: { type: 'enabled' }
    // 其他 OpenAI 兼容平台通过 extra_body 自行传递
    const thinkingParams = convertThinkingForOpenAI(p.thinking, p.model, p.output_config)

    const stream = await client.chat.completions.create(
      {
        model: normalizeModelStringForAPI(p.model),
        messages: openAIMessages,
        max_tokens: p.maxTokens ?? p.max_tokens,
        temperature: p.temperature ?? 1,
        ...((p.topP ?? p.top_p) !== undefined && { top_p: p.topP ?? p.top_p }),
        ...((p.stopSequences ?? p.stop_sequences) && { stop: p.stopSequences ?? p.stop_sequences }),
        ...((p.tools && p.tools.length > 0) || openaiNativeTools.length > 0
          ? {
              tools: [
                ...openaiNativeTools,
                ...(p.tools ? convertToolsToOpenAI(p.tools) : []),
              ],
            }
          : {}),
        ...((p.toolChoice ?? p.tool_choice) && { tool_choice: (p.toolChoice ?? p.tool_choice) as any }),
        stream: true,
        stream_options: { include_usage: true },
        ...(openaiResponseFormat ? { response_format: openaiResponseFormat as any } : {}),
        ...(outputConfigResponseFormat && !openaiResponseFormat ? { response_format: outputConfigResponseFormat } : {}),
        ...thinkingParams,
        ...(Object.keys(openaiExtrasCleaned).length > 0 ? (openaiExtrasCleaned as any) : {}),
        ...(p.extra_body ? (p.extra_body as any) : {}),
      },
      { signal },
    ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    return {
      stream: mapOpenAIStreamToStandard(stream, p.model),
      requestId: randomUUID(),
      response: undefined,
    }
  }

  async createMessage(
    params: CreateParams,
    signal: AbortSignal,
    _timeout?: number,
  ): Promise<LLMResponse> {
    const p = params as any
    const client = getOpenAIClient({ model: p.model })
    const rawMessages = p.messages ?? []
    const openAIMessages = convertMessagesToOpenAI(rawMessages)
    const openaiExtras = p.providerExtras?.openai

    logForDebugging(
      `[OpenAI] Non-streaming request: model=${p.model}, messages=${openAIMessages.length}`,
    )

    // 从 providerExtras.openai 中提取 response_format（如果已转换）
    const openaiResponseFormat = openaiExtras?.response_format
    // 从 output_config 中提取并转换为 OpenAI 的 response_format
    const outputConfigResponseFormat = convertOutputFormatToResponseFormat(p.output_config)

    // 提取 OpenAI 原生工具（如 web_search_preview），注入到 tools 数组
    const openaiNativeTools = openaiExtras?._web_search_tool
      ? [openaiExtras._web_search_tool]
      : []
    const openaiExtrasCleanedNonStream = openaiExtras ? { ...openaiExtras } : {}
    delete (openaiExtrasCleanedNonStream as any)._web_search_tool

    // 将 Anthropic 格式的 thinking 转换为 OpenAI 兼容格式
    const thinkingParams = convertThinkingForOpenAI(p.thinking, p.model, p.output_config)

    const completion = await client.chat.completions.create(
      {
        model: normalizeModelStringForAPI(p.model),
        messages: openAIMessages,
        max_tokens: p.maxTokens ?? p.max_tokens,
        temperature: p.temperature ?? 1,
        ...((p.topP ?? p.top_p) !== undefined && { top_p: p.topP ?? p.top_p }),
        ...((p.stopSequences ?? p.stop_sequences) && { stop: p.stopSequences ?? p.stop_sequences }),
        ...((p.tools && p.tools.length > 0) || openaiNativeTools.length > 0
          ? {
              tools: [
                ...openaiNativeTools,
                ...(p.tools ? convertToolsToOpenAI(p.tools) : []),
              ],
            }
          : {}),
        ...((p.toolChoice ?? p.tool_choice) && { tool_choice: (p.toolChoice ?? p.tool_choice) as any }),
        stream: false,
        ...thinkingParams,
        ...(openaiResponseFormat ? { response_format: openaiResponseFormat as any } : {}),
        ...(outputConfigResponseFormat && !openaiResponseFormat ? { response_format: outputConfigResponseFormat } : {}),
        ...(Object.keys(openaiExtrasCleanedNonStream).length > 0 ? (openaiExtrasCleanedNonStream as any) : {}),
        ...(p.extra_body ? (p.extra_body as any) : {}),
      },
      { signal },
    )

    return convertOpenAIResponseToStandard(completion, p.model)
  }

  async verifyApiKey(_apiKey: string): Promise<boolean> {
    return true
  }
}

/**
 * 供外部使用的 OpenAI 消息创建函数（替代 openaiQuery.ts 中的 openAICreateMessage）。
 * 注意：此函数保留为向后兼容，调用方仍在使用旧的 v1 类型。
 * 参数使用 any 类型以兼容旧代码，返回标准 Response。
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
}): Promise<LLMResponse> {
  const client = getOpenAIClient({ model: params.model })

  // 将旧格式消息转换为标准 4 角色分离格式
  const messages: Message[] = []

  // 如果 system 存在，作为 system 消息
  if (params.system) {
    if (typeof params.system === 'string') {
      messages.push({ role: 'system', content: params.system })
    } else {
      // TextBlockParam[] → 拼接为纯文本
      messages.push({
        role: 'system',
        content: params.system.map(b => (b as any).text).join('\n\n'),
      })
    }
  }

  // 转换旧格式消息为新的 4 角色分离格式
  for (const msg of params.messages) {
    if (msg.role === 'user') {
      // 旧 user 消息可能包含 tool_result，需要拆分
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // 检查是否有 tool_result 块
        const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')
        if (hasToolResult) {
          // 拆分 tool_result 为独立的 tool 消息
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              const content = typeof block.content === 'string'
                ? block.content
                : (block.content || []).map((b: any) => b.type === 'text' ? b.text : '').join('\n')
              messages.push({
                role: 'tool',
                toolCallId: block.tool_use_id,
                content,
                isError: block.is_error,
              })
            }
          }
          // 非 tool_result 块作为 user 消息
          const userBlocks = msg.content.filter((b: any) => b.type !== 'tool_result')
          if (userBlocks.length > 0) {
            messages.push({
              role: 'user',
              content: userBlocks.length === 1 && userBlocks[0]?.type === 'text'
                ? userBlocks[0].text
                : userBlocks,
            })
          }
        } else {
          messages.push({ role: 'user', content: msg.content })
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content })
      } else {
        messages.push({ role: 'assistant', content: msg.content })
      }
    }
  }

  const openAIMessages = convertMessagesToOpenAI(messages)

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
export function getRequestAdapter(anthropicClient: Anthropic): LLMAdapter {
  if (isOpenAIProvider(getAPIProvider())) {
    return new OpenAIRequestAdapter()
  }
  return new AnthropicRequestAdapter(anthropicClient)
}
