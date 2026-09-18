/**
 * OpenAI Responses API 双向转换层 — 标准 Message[] / LLMStreamEvent ↔ OpenAI Responses 格式。
 *
 * 与 conversions/openai.ts（Chat Completions）对应，是 OpenAIResponsesProviderAdapter
 * 的"知识库"。协议差异要点：
 *
 * - 请求体：`input`（item 数组）+ 顶层 `instructions`（系统消息），无 `messages` 数组
 * - 工具定义是扁平结构 `{type:'function', name, parameters}`，无 `function` 嵌套层
 * - 消息无 `role:'tool'`；工具调用是独立 `function_call` item，结果用
 *   `function_call_output` item（call_id 关联）
 * - 思考参数是 `reasoning: { effort }`，可用档位取决于模型能力
 * - 流式事件按类型分发（response.output_text.delta 等），usage 只在
 *   `response.completed` / `response.failed` / `response.incomplete` 事件内返回
 *
 * 设计原则与 openai.ts 一致：只做标准类型 ↔ SDK 类型转换，不碰 client。
 */

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses'
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
  ToolCallBlock,
  ToolChoice,
  ToolDefinition,
} from '../../../types/llm.js'
import { normalizeModelStringForAPI } from '../../model/model.js'
import { safeStringifyToolArguments } from './openai.js'

/**
 * buildResponsesRequestParams 的返回类型。
 * 继承 SDK 的 ResponseCreateParamsBase（保证 client.responses.create 类型匹配），
 * 并用 index signature 兜底 providerExtras / extra_body 等动态扩展字段。
 */
export interface ResponsesCreateParams extends ResponseCreateParamsBase {
  [key: string]: unknown
}

// ============================================================================
// 出站：标准 → OpenAI Responses
// ============================================================================

/**
 * 提取顶层 instructions 文本：params.system + messages 中所有 system 消息，
 * 按出现顺序用空行拼接。Responses API 的系统消息必须放在顶层 instructions，
 * 不能作为 input item。
 */
function extractInstructions(params: CreateParams): string | undefined {
  const parts: string[] = []
  for (const msg of params.messages ?? []) {
    if (msg.role === 'system' && msg.content) {
      parts.push(msg.content)
    }
  }
  if (params.system) {
    if (typeof params.system === 'string') {
      parts.push(params.system)
    } else {
      for (const block of params.system) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text)
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** 从 tool_result 块内容中提取纯文本（string 或 text 块数组）。 */
function extractToolResultText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('\n')
      .trim()
  }
  return ''
}

interface ResponsesToolCallMetadata {
  itemId?: string
}

/**
 * 获取 Responses 工具调用的两个独立标识。
 * `ToolCallBlock.id` 始终用于通用的 call_id；output item id 只保存在 provider 元数据中。
 */
function getResponsesToolCallIds(block: ToolCallBlock): {
  callId: string
  itemId?: string
} {
  const metadata = block.providerMetadata?.openaiResponses
  const itemId =
    typeof metadata === 'object' && metadata !== null && 'itemId' in metadata
      ? (metadata as ResponsesToolCallMetadata).itemId
      : undefined

  // 兼容修复前已写入当前会话的 `call_id|item_id`，避免要求用户丢弃会话。
  const separatorIndex = block.id.indexOf('|')
  if (separatorIndex > 0) {
    return {
      callId: block.id.slice(0, separatorIndex),
      itemId: itemId ?? (block.id.slice(separatorIndex + 1) || undefined),
    }
  }
  return { callId: block.id || randomUUID(), itemId }
}

/** 从工具结果引用中提取 call_id，并兼容修复前当前会话里的复合 ID。 */
function getResponsesCallId(toolCallId: string): string {
  const separatorIndex = toolCallId.indexOf('|')
  return separatorIndex > 0 ? toolCallId.slice(0, separatorIndex) : toolCallId
}

/**
 * 将标准消息转换为 Responses API 的 input item 数组。
 *
 * 转换点：
 * - system 消息不产生 item（统一由 extractInstructions 收敛到顶层 instructions）
 * - user 消息内嵌的 tool_result 块 → 拆为独立 function_call_output item
 *   （保持原始数组顺序，output 紧随对应 function_call）
 * - assistant 消息：文本 → message item（role assistant）；tool_call 块 →
 *   独立 function_call item；带 Responses 签名的 thinking 块还原为 reasoning item
 * - tool 消息 → function_call_output item
 * - 图片块 → input_image（data URL）
 */
export function messagesToResponses(messages: LLMMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = []

  for (const [messageIndex, msg] of messages.entries()) {
    switch (msg.role) {
      case 'system':
        // 系统消息由 extractInstructions 收集，不产生 item
        break

      case 'user': {
        // v1 兼容：content 可能是字符串
        if (typeof msg.content === 'string') {
          result.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: msg.content }],
          })
          break
        }
        if (!Array.isArray(msg.content)) {
          break
        }
        // user 消息中可能内嵌 tool_result 块，拆为独立 function_call_output item，
        // 且必须先于 user 消息本身（保持与 assistant function_call 的先后关系）
        const toolOutputs: OpenAI.Responses.ResponseInputItem[] = []
        const parts: OpenAI.Responses.ResponseInputContent[] = []
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text = extractToolResultText(block.content)
            toolOutputs.push({
              type: 'function_call_output',
              call_id: getResponsesCallId(block.toolCallId ?? ''),
              output: text || '(empty)',
            })
          } else if (block.type === 'text') {
            if (block.text) {
              parts.push({ type: 'input_text', text: block.text })
            }
          } else if (block.type === 'image') {
            const mimeType = block.mimeType ?? 'image/png'
            const data = block.data ?? ''
            parts.push({
              type: 'input_image',
              detail: 'auto',
              image_url: `data:${mimeType};base64,${data}`,
            })
          }
          // document / connector_text 等：Responses 不支持，忽略
        }
        result.push(...toolOutputs)
        if (parts.length > 0) {
          result.push({
            type: 'message',
            role: 'user',
            content: parts,
          })
        }
        break
      }

      case 'assistant': {
        // v1 兼容：content 可能是字符串
        if (typeof msg.content === 'string') {
          result.push({
            id: `msg_zy_${messageIndex}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: msg.content, annotations: [] }],
          })
          break
        }
        if (!Array.isArray(msg.content)) {
          break
        }
        const textParts: string[] = []
        const reasoningItems: OpenAI.Responses.ResponseReasoningItem[] = []
        const toolCalls: OpenAI.Responses.ResponseFunctionToolCall[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) {
              textParts.push(block.text)
            }
          } else if (block.type === 'thinking' && block.signature) {
            // store:false 的 Responses 多轮必须重放完整 reasoning item。
            // signature 只接受本转换器保存的 JSON，避免把其他 provider 的签名误传。
            try {
              const item = JSON.parse(block.signature) as Record<string, unknown>
              if (
                item.type === 'reasoning' &&
                typeof item.id === 'string' &&
                Array.isArray(item.summary)
              ) {
                reasoningItems.push(item as unknown as OpenAI.Responses.ResponseReasoningItem)
              }
            } catch {
              // 非 Responses 签名属于其他 provider，忽略即可。
            }
          } else if (block.type === 'tool_call') {
            // 工具调用是独立 function_call item（arguments 为 JSON 字符串）
            const { callId, itemId } = getResponsesToolCallIds(block)
            toolCalls.push({
              type: 'function_call',
              ...(itemId ? { id: itemId } : {}),
              call_id: callId || randomUUID(),
              name: block.name,
              arguments: safeStringifyToolArguments(block.input),
            })
          }
          // redacted_thinking 属于其他 provider，不在此处转换。
        }
        // Responses 输出顺序通常是 reasoning → message → function_call；重放时保持一致。
        result.push(...reasoningItems)
        if (textParts.length > 0) {
          result.push({
            id: `msg_zy_${messageIndex}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: textParts.join('\n\n'), annotations: [] }],
          })
        }
        result.push(...toolCalls)
        break
      }

      case 'tool':
        result.push({
          type: 'function_call_output',
          call_id: getResponsesCallId(msg.toolCallId),
          output: msg.content || '(empty)',
        })
        break
    }
  }

  return result
}

/**
 * 将标准工具定义转换为 Responses API 的 tools 数组。
 *
 * 与 Chat Completions 的关键差异：function 工具是扁平结构
 * `{type:'function', name, parameters}`，没有 `function` 嵌套层。
 * 省略 strict 字段：Responses 行为为「尝试严格模式，失败回退非严格」，
 * 兼容项目内未声明 additionalProperties 的宽松工具 schema。
 */
export function toolsToResponses(tools?: ToolDefinition[]): OpenAI.Responses.Tool[] | undefined {
  if (!tools?.length) {
    return undefined
  }
  return tools.map(
    (tool) =>
      ({
        type: 'function' as const,
        name: tool.name ?? '',
        description: tool.description ?? '',
        parameters: (tool.inputSchema ??
          (tool as unknown as { input_schema?: Record<string, unknown> }).input_schema ?? {
            type: 'object',
            properties: {},
          }) as Record<string, unknown>,
        // SDK 类型将 strict 声明为必填，但运行时可省略（官方推荐行为）
      }) as unknown as OpenAI.Responses.Tool,
  )
}

/** tool_choice 的目标类型：字符串枚举或指定单个函数。 */
export type ResponsesToolChoice =
  | OpenAI.Responses.ToolChoiceOptions
  | OpenAI.Responses.ToolChoiceFunction

/**
 * 将标准 ToolChoice 转换为 Responses 的 tool_choice。
 * 标准类型无 'required'，Responses 特有——不在标准映射内，需要时由调用方直接透传。
 */
export function toolChoiceToResponses(choice?: ToolChoice): ResponsesToolChoice | undefined {
  if (!choice) {
    return undefined
  }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', name: choice.name }
    default:
      return undefined
  }
}

// ============================================================================
// thinking / reasoning 参数适配
// ============================================================================

/**
 * 将标准 thinking 参数映射为 Responses 的 reasoning 参数。
 *
 * 与 Chat Completions 的关键差异：Responses 用 `reasoning: { effort }`，
 * 旧 o 系列不支持 none，其他模型的支持档位由能力配置决定。
 * 因此 disabled / 未配置时仍不强行发送 none，交由模型默认行为；
 * enabled / adaptive 时传 reasoning.effort。
 */
export function convertThinkingForResponses(
  thinking: ThinkingConfig | undefined,
  reasoningEffort?: string,
): { reasoning?: { effort?: ResponsesReasoningEffort } } | undefined {
  if (!thinking || thinking.type === 'disabled') {
    return undefined
  }
  return { reasoning: { effort: normalizeResponsesReasoningEffort(reasoningEffort) } }
}

/**
 * 保留模型能力配置选出的官方档位，不把 minimal/xhigh/max 静默降为 medium。
 * 未知值（如未映射的 ultra/extreme）仍回退到 medium。
 */
type ResponsesReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

function normalizeResponsesReasoningEffort(effort?: string): ResponsesReasoningEffort {
  const e = effort?.toLowerCase()
  if (e === 'none' || e === 'minimal' || e === 'xhigh' || e === 'max') {
    return e
  }
  if (e === 'low') {
    return 'low'
  }
  if (e === 'medium' || e === 'balanced') {
    return 'medium'
  }
  // "on" 是内部 toggle，沿用 high 映射；未知档位不擅自提高推理强度。
  if (e === 'high' || e === 'on') {
    return 'high'
  }
  if (e === 'light' || e === 'quick') {
    return 'low'
  }
  return 'medium'
}

// ============================================================================
// response_format / text.format 适配
// ============================================================================

/**
 * 将标准 JSONOutputFormat 转换为 Responses 的 text.format。
 *
 * 与 chat 版的差异：Responses 原生支持 json_schema（chat 版内部 json_schema
 * 退化为 json_object）。内部 json_schema 有 schema 时映射为真正的
 * json_schema 格式（省略 strict 走官方回退机制）；无 schema 时退化为
 * json_object。
 */
export function convertOutputFormatToResponsesText(
  format: JSONOutputFormat | undefined,
): OpenAI.Responses.ResponseTextConfig | undefined {
  if (!format) {
    return undefined
  }

  if (format.type === 'json_schema') {
    if (format.schema) {
      return {
        format: {
          type: 'json_schema',
          name: 'structured_output',
          schema: format.schema,
        },
      }
    }
    return { format: { type: 'json_object' } }
  }

  if (format.type === 'json_object') {
    return { format: { type: 'json_object' } }
  }

  // 已有 OpenAI 格式的非标准 type，原样透传
  if (format.type) {
    return format as unknown as OpenAI.Responses.ResponseTextConfig
  }

  return undefined
}

// ============================================================================
// 入站：OpenAI Responses → 标准
// ============================================================================

/**
 * 将 Response.status / incomplete_details 映射为标准 StopReason。
 * completed → end_turn；incomplete 按 reason 区分（content_filter /
 * 默认按 max_output_tokens 截断）；failed 等 → null。
 * 注意：completed 且含 function_call 时调用方应返回 'tool_use'。
 */
export function responsesStatusToStopReason(
  status: OpenAI.Responses.ResponseStatus | undefined,
  incompleteDetails?: OpenAI.Responses.Response.IncompleteDetails | null,
): StopReason {
  if (status === 'incomplete') {
    if (incompleteDetails?.reason === 'content_filter') {
      return 'content_filter'
    }
    // max_output_tokens 截断（最常见）及未知原因统一按 max_tokens 处理
    return 'max_tokens'
  }
  if (status === 'completed') {
    return 'end_turn'
  }
  return null
}

/**
 * 从 Response 推导 stopReason：output 含 function_call 时优先判定为
 * tool_use（Responses 的 status 无法区分自然结束与工具调用结束）。
 */
function responseStopReason(response: OpenAI.Responses.Response): StopReason {
  // 截断的函数参数不能被误报为正常工具调用结束。
  if (response.status !== 'completed') {
    return responsesStatusToStopReason(response.status, response.incomplete_details)
  }
  const hasFunctionCall = response.output?.some((item) => item.type === 'function_call')
  if (hasFunctionCall) {
    return 'tool_use'
  }
  return responsesStatusToStopReason(response.status, response.incomplete_details)
}

/**
 * 将 Responses 的 ResponseUsage 映射为标准 TokenUsage。
 * input_tokens_details.cached_tokens → cacheReadInputTokens；
 * output_tokens_details.reasoning_tokens → extras（reasoning 计费口径）。
 */
export function responsesUsageToStandard(
  usage: OpenAI.Responses.ResponseUsage | undefined | null,
): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens,
    cacheCreationInputTokens: undefined,
    extras: usage?.output_tokens_details?.reasoning_tokens
      ? { reasoning_tokens: usage.output_tokens_details.reasoning_tokens }
      : undefined,
  }
}

function toDeltaUsage(usage: TokenUsage): DeltaUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    extras: usage.extras,
  }
}

// 当前 SDK 尚未声明 reasoning content 与 reasoning_text 事件，在协议边界补齐，
// 不升级依赖；原始 item 仍完整写入 signature，避免丢失后续请求需要的字段。
type ResponsesReasoningItem = OpenAI.Responses.ResponseReasoningItem & {
  content?: Array<{ type: 'reasoning_text'; text: string }>
}

type ResponsesStreamEvent =
  | OpenAI.Responses.ResponseStreamEvent
  | {
      type: 'response.reasoning_text.delta'
      item_id: string
      content_index: number
      delta: string
    }
  | {
      type: 'response.reasoning_text.done'
      item_id: string
      content_index: number
      text: string
    }

function reasoningText(item: ResponsesReasoningItem): string {
  const summary = (item.summary ?? []).map((part) => part.text).join('\n\n')
  // summary 与正文是不同表示；优先摘要，仅在摘要为空时使用明确返回的正文。
  return summary.trim() ? summary : (item.content ?? []).map((part) => part.text).join('\n\n')
}

/**
 * 将非流式 Response 转换为标准 LLMResponse。
 *
 * output 数组按序处理（天然保证 reasoning → text → function_call 的顺序）：
 * - message item 的 output_text parts → text 块
 * - function_call item → tool_call 块（arguments JSON 容错解析）
 * - reasoning item 的 summary / reasoning_text → thinking 块
 * - file_search_call / web_search_call 等内置工具调用：项目不支持，忽略
 */
export function responsesToStandard(
  response: OpenAI.Responses.Response,
  model: string,
): LLMResponse {
  const contentBlocks: AssistantContentBlock[] = []

  for (const item of response.output) {
    switch (item.type) {
      case 'message': {
        const texts: string[] = []
        for (const part of item.content) {
          if (part.type === 'output_text' && part.text) {
            texts.push(part.text)
          } else if (part.type === 'refusal' && part.refusal) {
            texts.push(part.refusal)
          }
        }
        if (texts.length > 0) {
          contentBlocks.push({ type: 'text', text: texts.join('') })
        }
        break
      }

      case 'function_call': {
        let parsedInput: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(item.arguments ?? '{}')
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            parsedInput = parsed
          }
        } catch {
          // 非法 JSON：保留空对象
        }
        contentBlocks.push({
          type: 'tool_call',
          id: item.call_id ?? item.id ?? randomUUID(),
          name: item.name,
          input: parsedInput,
          ...(item.id ? { providerMetadata: { openaiResponses: { itemId: item.id } } } : {}),
        })
        break
      }

      case 'reasoning': {
        contentBlocks.push({
          type: 'thinking',
          thinking: reasoningText(item),
          // 保存完整 item（含 id 与 encrypted_content），供 store:false 下一轮重放。
          signature: JSON.stringify(item),
        })
        break
      }

      default:
        // 内置工具调用（file_search_call 等）：忽略
        break
    }
  }

  return {
    id: response.id ?? randomUUID(),
    model: response.model ?? model,
    role: 'assistant',
    content: contentBlocks,
    stopReason: responseStopReason(response),
    usage: responsesUsageToStandard(response.usage),
  }
}

/**
 * Responses 流式事件 → 标准 LLMStreamEvent。
 *
 * 事件驱动设计（与 mapOpenAIStreamToStandard 的 chunk 扫描不同）：
 * - 块 index 按出现顺序分配：thinking → text → tool，与模型输出顺序一致
 * - 新块出现时，为旧文本/思考块补发 chunk_stop，工具块等参数收齐后结算
 * - 多并行工具调用以 item_id 区分；函数名来自 response.output_item.added
 *   （arguments.delta 事件本身不带 name）
 * - usage / 最终 stopReason 只在 response.completed / incomplete
 *   事件内返回（Responses 无独立 usage chunk）
 */
export async function* mapResponsesStreamToStandard(
  stream: AsyncIterable<ResponsesStreamEvent>,
  model: string,
): AsyncIterable<LLMStreamEvent> {
  type Block = {
    index: number
    kind: 'thinking' | 'text' | 'tool_call'
    value: string
    stopped: boolean
    signature?: string
    source?: 'summary' | 'content'
    partIndex?: number
    parts: Map<string, string>
  }
  const blocks = new Map<string, Block>()
  let nextIndex = 0

  function* stopBlocks(includeTools = true): Generator<LLMStreamEvent> {
    for (const block of blocks.values()) {
      if (!block.stopped && (includeTools || block.kind !== 'tool_call')) {
        block.stopped = true
        yield { type: 'chunk_stop', index: block.index }
      }
    }
  }

  function* startBlock(
    key: string,
    chunk: Extract<AssistantContentBlock, { type: 'thinking' | 'text' | 'tool_call' }>,
  ): Generator<LLMStreamEvent, Block> {
    const existing = blocks.get(key)
    if (existing) {
      return existing
    }
    // 并行 function_call 不能在另一个工具开始时提前结算未收齐的 JSON。
    yield* stopBlocks(false)
    const block: Block = {
      index: nextIndex++,
      kind: chunk.type,
      value: '',
      stopped: false,
      parts: new Map(),
    }
    blocks.set(key, block)
    yield { type: 'chunk_start', index: block.index, chunk }
    return block
  }

  function* append(block: Block, value: string): Generator<LLMStreamEvent> {
    if (!value) {
      return
    }
    block.value += value
    const delta: ChunkDelta =
      block.kind === 'thinking'
        ? { type: 'thinking_delta', thinking: value }
        : block.kind === 'text'
          ? { type: 'text_delta', text: value }
          : { type: 'input_json_delta', partialJson: value }
    yield { type: 'chunk_delta', index: block.index, delta }
  }

  function* finishValue(block: Block, value: string): Generator<LLMStreamEvent> {
    // done 携带累计全文。仅补齐未收到的后缀，避免 delta + done 重复追加。
    if (value.startsWith(block.value)) {
      yield* append(block, value.slice(block.value.length))
    }
  }

  function* thinkingPart(
    itemId: string,
    source: 'summary' | 'content',
    partIndex: number,
    value: string,
    done: boolean,
  ): Generator<LLMStreamEvent> {
    if (!value) {
      return
    }
    const block = yield* startBlock(`reasoning:${itemId}`, {
      type: 'thinking',
      thinking: '',
      signature: '',
    })
    // 流式不能撤回已显示的内容，因此同一 item 采用最先到达的非空表示。
    // 后续 summary / 正文只保留在签名中，避免把两种表示混成重复思考。
    if (block.source && block.source !== source) {
      return
    }
    block.source = source
    const key = `${source}:${partIndex}`
    const previous = block.parts.get(key) ?? ''
    const suffix = done ? (value.startsWith(previous) ? value.slice(previous.length) : '') : value
    if (!suffix) {
      return
    }
    if (block.partIndex !== undefined && block.partIndex !== partIndex) {
      yield* append(block, '\n\n')
    }
    block.partIndex = partIndex
    block.parts.set(key, previous + suffix)
    yield* append(block, suffix)
  }

  function* finishItem(item: OpenAI.Responses.ResponseOutputItem): Generator<LLMStreamEvent> {
    if (item.type === 'reasoning') {
      const reasoning: ResponsesReasoningItem = item
      const existing = blocks.get(`reasoning:${item.id}`)
      const source =
        existing?.source ??
        ((item.summary ?? []).some((p) => p.text.trim()) ? 'summary' : 'content')
      const parts = source === 'summary' ? (item.summary ?? []) : (reasoning.content ?? [])
      for (const [index, part] of parts.entries()) {
        yield* thinkingPart(item.id, source, index, part.text, true)
      }
      const block = yield* startBlock(`reasoning:${item.id}`, {
        type: 'thinking',
        thinking: '',
        signature: '',
      })
      const signature = JSON.stringify(item)
      if (signature !== block.signature) {
        block.signature = signature
        yield {
          type: 'chunk_delta',
          index: block.index,
          delta: { type: 'signature_delta', signature },
        }
      }
    } else if (item.type === 'message') {
      for (const [index, part] of item.content.entries()) {
        const value =
          part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : ''
        if (!value) {
          continue
        }
        const block = yield* startBlock(`text:${item.id}:${index}`, { type: 'text', text: '' })
        yield* finishValue(block, value)
      }
    } else if (item.type === 'function_call') {
      const block = yield* startBlock(`tool:${item.id ?? item.call_id}`, {
        type: 'tool_call',
        id: item.call_id,
        name: item.name,
        input: {},
        ...(item.id ? { providerMetadata: { openaiResponses: { itemId: item.id } } } : {}),
      })
      yield* finishValue(block, item.arguments ?? '')
    }
  }

  yield { type: 'response_start', responseId: randomUUID(), model }
  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const block = yield* startBlock(`text:${event.item_id}:${event.content_index}`, {
          type: 'text',
          text: '',
        })
        yield* append(block, event.delta)
        break
      }
      case 'response.output_text.done':
      case 'response.refusal.done': {
        const value = event.type === 'response.refusal.done' ? event.refusal : event.text
        if (value) {
          const block = yield* startBlock(`text:${event.item_id}:${event.content_index}`, {
            type: 'text',
            text: '',
          })
          yield* finishValue(block, value)
        }
        break
      }
      case 'response.reasoning_summary_text.delta':
        yield* thinkingPart(event.item_id, 'summary', event.summary_index, event.delta, false)
        break
      case 'response.reasoning_summary_text.done':
        yield* thinkingPart(event.item_id, 'summary', event.summary_index, event.text, true)
        break
      case 'response.reasoning_text.delta':
        yield* thinkingPart(event.item_id, 'content', event.content_index, event.delta, false)
        break
      case 'response.reasoning_text.done':
        yield* thinkingPart(event.item_id, 'content', event.content_index, event.text, true)
        break
      case 'response.reasoning.delta':
        // 旧 SDK / 兼容端点的别名；未知结构不能隐式转换为用户可见文本。
        if (typeof event.delta === 'string') {
          yield* thinkingPart(event.item_id, 'content', event.content_index, event.delta, false)
        }
        break
      case 'response.reasoning.done':
        yield* thinkingPart(event.item_id, 'content', event.content_index, event.text, true)
        break
      case 'response.output_item.added': {
        if (event.item.type === 'reasoning') {
          // item 创建就启动思考计时；只在 done 才提供正文的端点也能计入等待时间。
          yield* startBlock(`reasoning:${event.item.id}`, {
            type: 'thinking',
            thinking: '',
            signature: '',
          })
        } else if (event.item.type === 'function_call') {
          const item = event.item
          const block = yield* startBlock(`tool:${item.id ?? item.call_id}`, {
            type: 'tool_call',
            id: item.call_id,
            name: item.name,
            input: {},
            ...(item.id ? { providerMetadata: { openaiResponses: { itemId: item.id } } } : {}),
          })
          yield* finishValue(block, item.arguments ?? '')
        }
        break
      }
      case 'response.output_item.done':
        yield* finishItem(event.item)
        break
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done': {
        const block = blocks.get(`tool:${event.item_id}`)
        // 没有 added 时不能拿 item_id 冒充 call_id，也不能执行缺少名称的工具。
        // 等 output_item.done / 终止响应携带完整身份后再回填参数。
        if (block) {
          if (event.type === 'response.function_call_arguments.delta') {
            yield* append(block, event.delta)
          } else {
            yield* finishValue(block, event.arguments)
          }
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        // 终止事件也可能是唯一完整快照；逐 item 回填，保留所有 reasoning 签名。
        for (const item of event.response.output ?? []) {
          yield* finishItem(item)
        }
        yield* stopBlocks()
        yield {
          type: 'response_delta',
          stopReason: responseStopReason(event.response),
          usage: event.response.usage
            ? toDeltaUsage(responsesUsageToStandard(event.response.usage))
            : undefined,
        }
        yield { type: 'response_stop' }
        return
      }
      case 'response.failed':
        throw new Error(event.response.error?.message ?? 'OpenAI Responses request failed')
      case 'error':
        throw new Error(
          `OpenAI Responses API error: ${[event.code, event.message].filter(Boolean).join(' ')}`,
        )
      default:
        // 生命周期通知与项目未启用的内置工具事件无需投影为聊天内容。
        break
    }
  }
  yield* stopBlocks()
  yield { type: 'response_delta', stopReason: null }
  yield { type: 'response_stop' }
}
// ============================================================================
// 请求参数构造
// ============================================================================

/**
 * 把标准 CreateParams 拼装成 client.responses.create 的参数对象（不含 stream）。
 *
 * 包含：消息转换（input items + 顶层 instructions）、工具转换（扁平结构）、
 * tool_choice、temperature/top_p、thinking → reasoning 映射、
 * text.format 结构化输出、OpenAI 原生工具透传、providerExtras.openai /
 * extra_body 顶层透传、model 字符串规范化。
 */
export function buildResponsesRequestParams(params: CreateParams): ResponsesCreateParams {
  // biome-ignore lint/suspicious/noExplicitAny: v1/v2 双格式兼容（max_tokens/tool_choice 等）
  const p = params as any
  const items = messagesToResponses(p.messages ?? [])
  const instructions = extractInstructions(params)
  const openaiExtras = p.providerExtras?.openai

  // OpenAI 原生工具（如 web_search_preview），注入到 tools 数组顶部
  const openaiNativeTools = openaiExtras?._web_search_tool ? [openaiExtras._web_search_tool] : []
  const cleanedExtras = openaiExtras ? { ...openaiExtras } : {}
  delete (cleanedExtras as Record<string, unknown>)._web_search_tool
  // response_format 是 chat 专属字段，Responses 用 text.format，剔除避免误传
  delete (cleanedExtras as Record<string, unknown>).response_format

  const toolDefs =
    (p.tools && p.tools.length > 0) || openaiNativeTools.length > 0
      ? [...openaiNativeTools, ...((p.tools ? toolsToResponses(p.tools) : []) ?? [])]
      : undefined

  const toolChoice = p.toolChoice ?? p.tool_choice

  const out: ResponsesCreateParams = {
    model: normalizeModelStringForAPI(p.model),
    input: items.length > 0 ? items : '',
    max_output_tokens: p.maxTokens ?? p.max_tokens,
    temperature: p.temperature ?? 1,
  }

  if (instructions) {
    out.instructions = instructions
  }

  const topP = p.topP ?? p.top_p
  if (topP !== undefined) {
    out.top_p = topP
  }

  if (toolDefs) {
    out.tools = toolDefs
  }
  if (toolChoice) {
    out.tool_choice = toolChoiceToResponses(toolChoice) ?? toolChoice
  }

  // thinking → reasoning（结构不同于 chat 的 thinking:{type}，独立映射；
  // disabled 时不传 reasoning，无 requestNeedsNoThinking 兜底需求）
  const reasoningParams = convertThinkingForResponses(params.thinking, params.reasoningEffort)
  if (reasoningParams?.reasoning) {
    // 旧 SDK 的 effort 类型只有 low/medium/high；协议已支持更多模型相关档位。
    out.reasoning = reasoningParams.reasoning as ResponseCreateParamsBase['reasoning']
  }

  const textConfig = convertOutputFormatToResponsesText(params.responseFormat)
  if (textConfig) {
    out.text = textConfig
  }

  Object.assign(out, cleanedExtras)
  if (params.extraBody) {
    Object.assign(out, params.extraBody)
  }

  return out
}
