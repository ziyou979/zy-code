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
 * - 思考参数是 `reasoning: { effort }`，且无显式关闭机制（o 系列模型始终思考）
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

/**
 * 将标准消息转换为 Responses API 的 input item 数组。
 *
 * 转换点：
 * - system 消息不产生 item（统一由 extractInstructions 收敛到顶层 instructions）
 * - user 消息内嵌的 tool_result 块 → 拆为独立 function_call_output item
 *   （保持原始数组顺序，output 紧随对应 function_call）
 * - assistant 消息：文本 → message item（role assistant）；tool_call 块 →
 *   独立 function_call item；thinking 块丢弃（无状态多轮无需回传推理内容）
 * - tool 消息 → function_call_output item
 * - 图片块 → input_image（data URL）
 */
export function messagesToResponses(messages: LLMMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = []

  for (const msg of messages) {
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
              call_id: block.toolCallId ?? '',
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
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: msg.content }],
          })
          break
        }
        if (!Array.isArray(msg.content)) {
          break
        }
        const textParts: string[] = []
        const toolCalls: OpenAI.Responses.ResponseFunctionToolCall[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) {
              textParts.push(block.text)
            }
          } else if (block.type === 'tool_call') {
            // 工具调用是独立 function_call item（arguments 为 JSON 字符串）
            toolCalls.push({
              type: 'function_call',
              call_id: block.id ?? randomUUID(),
              name: block.name,
              arguments: safeStringifyToolArguments(block.input),
            })
          }
          // thinking / redacted_thinking：无状态多轮不回传（需 encrypted_content
          // 才可回传，项目未启用），丢弃
        }
        // 消息 item 在前、function_call items 在后，与模型实际输出顺序一致
        if (textParts.length > 0) {
          result.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: textParts.join('\n\n') }],
          })
        }
        result.push(...toolCalls)
        break
      }

      case 'tool':
        result.push({
          type: 'function_call_output',
          call_id: msg.toolCallId,
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
 * 且 **没有显式关闭机制**（o 系列模型始终思考，只能调低 effort）。
 * 因此 disabled / 未配置时选择不传 reasoning 字段，交由模型默认行为；
 * enabled / adaptive 时传 reasoning.effort。
 */
export function convertThinkingForResponses(
  thinking: ThinkingConfig | undefined,
  reasoningEffort?: string,
): { reasoning?: { effort?: 'low' | 'medium' | 'high' } } | undefined {
  if (!thinking || thinking.type === 'disabled') {
    return undefined
  }
  return { reasoning: { effort: normalizeResponsesReasoningEffort(reasoningEffort) } }
}

/**
 * 将任意 effort 档位收敛为 Responses 接受的 low/medium/high。
 * mapEffortToProvider 产出的值依赖 model-capabilities 的 effort.map 配置，
 * 可能超出此值域（如 ultra/extreme），统一收敛到 medium。
 */
function normalizeResponsesReasoningEffort(effort?: string): 'low' | 'medium' | 'high' {
  const e = effort?.toLowerCase()
  if (e === 'low') return 'low'
  if (e === 'medium' || e === 'balanced') return 'medium'
  // "on" 是内部 toggle；extreme/thorough 等映射为 high
  if (
    e === 'high' ||
    e === 'on' ||
    e === 'extreme' ||
    e === 'ultra' ||
    e === 'thorough' ||
    e === 'xhigh'
  ) {
    return 'high'
  }
  if (e === 'light' || e === 'quick') return 'low'
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

/**
 * 将非流式 Response 转换为标准 LLMResponse。
 *
 * output 数组按序处理（天然保证 reasoning → text → function_call 的顺序）：
 * - message item 的 output_text parts → text 块
 * - function_call item → tool_call 块（arguments JSON 容错解析）
 * - reasoning item 的 summary → thinking 块
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
        })
        break
      }

      case 'reasoning': {
        const summary = (item.summary ?? []).map((s) => s.text).join('\n\n')
        if (summary) {
          contentBlocks.push({ type: 'thinking', thinking: summary, signature: '' })
        }
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
 * - 新块出现时，为已开始未结束的旧块补发 chunk_stop（恢复逐块完成时序）
 * - 多并行工具调用以 item_id 区分；函数名来自 response.output_item.added
 *   （arguments.delta 事件本身不带 name）
 * - usage / 最终 stopReason 只在 response.completed / failed / incomplete
 *   事件内返回（Responses 无独立 usage chunk）
 */
export async function* mapResponsesStreamToStandard(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
  model: string,
): AsyncIterable<LLMStreamEvent> {
  const messageId = randomUUID()
  // 块状态：thinking / text / tool 各自维护 started / stopped
  let thinkingBlockIndex = -1
  let thinkingStarted = false
  let thinkingStopped = false
  let textBlockIndex = -1
  let textStarted = false
  let textStopped = false
  // item_id → 块信息（多并行工具调用按 item_id 区分）
  const toolBlocks = new Map<string, { index: number; name: string }>()
  const toolStopped = new Set<number>()
  let nextIndex = 0
  let finalStopReason: StopReason | null = null
  let finalUsage: DeltaUsage | undefined

  yield { type: 'response_start', responseId: messageId, model }

  // 为所有已开始未结束的块补发 chunk_stop（新块出现或收尾时调用）
  const stopAllOpenBlocks = (): LLMStreamEvent[] => {
    const events: LLMStreamEvent[] = []
    if (thinkingStarted && !thinkingStopped) {
      events.push({ type: 'chunk_stop', index: thinkingBlockIndex })
      thinkingStopped = true
    }
    if (textStarted && !textStopped) {
      events.push({ type: 'chunk_stop', index: textBlockIndex })
      textStopped = true
    }
    for (const [itemId, block] of toolBlocks) {
      if (!toolStopped.has(block.index)) {
        events.push({ type: 'chunk_stop', index: block.index })
        toolStopped.add(block.index)
      }
      void itemId
    }
    return events
  }

  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta': {
        if (!textStarted) {
          for (const e of stopAllOpenBlocks()) {
            yield e
          }
          textBlockIndex = nextIndex++
          yield {
            type: 'chunk_start',
            index: textBlockIndex,
            chunk: { type: 'text', text: '' },
          }
          textStarted = true
        }
        yield {
          type: 'chunk_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: event.delta },
        }
        break
      }

      case 'response.reasoning_summary_text.delta': {
        if (!thinkingStarted) {
          thinkingBlockIndex = nextIndex++
          yield {
            type: 'chunk_start',
            index: thinkingBlockIndex,
            chunk: { type: 'thinking', thinking: '', signature: '' },
          }
          thinkingStarted = true
        }
        yield {
          type: 'chunk_delta',
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: event.delta },
        }
        break
      }

      case 'response.output_item.added': {
        // function_call item 创建时即可拿到函数名（arguments.delta 不带 name）
        if (event.item.type === 'function_call') {
          const itemId = event.item.id ?? ''
          if (itemId && !toolBlocks.has(itemId)) {
            for (const e of stopAllOpenBlocks()) {
              yield e
            }
            const index = nextIndex++
            toolBlocks.set(itemId, { index, name: event.item.name })
            yield {
              type: 'chunk_start',
              index,
              chunk: {
                type: 'tool_call',
                id: itemId,
                name: event.item.name,
                input: {},
              },
            }
          }
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        // 兜底：若未收到 output_item.added（异常流），此时才开始工具块
        if (!toolBlocks.has(event.item_id)) {
          for (const e of stopAllOpenBlocks()) {
            yield e
          }
          const index = nextIndex++
          toolBlocks.set(event.item_id, { index, name: '' })
          yield {
            type: 'chunk_start',
            index,
            chunk: { type: 'tool_call', id: event.item_id, name: '', input: {} },
          }
        }
        const block = toolBlocks.get(event.item_id)
        if (block && event.delta) {
          const delta: ChunkDelta = {
            type: 'input_json_delta',
            partialJson: event.delta,
          }
          yield { type: 'chunk_delta', index: block.index, delta }
        }
        break
      }

      case 'response.completed': {
        // usage 与最终状态只在 completed 事件内返回
        const stopReason = responseStopReason(event.response)
        for (const e of stopAllOpenBlocks()) {
          yield e
        }
        finalStopReason = stopReason
        finalUsage = event.response.usage
          ? toDeltaUsage(responsesUsageToStandard(event.response.usage))
          : undefined
        yield { type: 'response_delta', stopReason, usage: finalUsage }
        yield { type: 'response_stop' }
        return
      }

      case 'response.failed':
      case 'response.incomplete': {
        const stopReason = responseStopReason(event.response)
        for (const e of stopAllOpenBlocks()) {
          yield e
        }
        finalStopReason = stopReason
        finalUsage = event.response.usage
          ? toDeltaUsage(responsesUsageToStandard(event.response.usage))
          : undefined
        yield { type: 'response_delta', stopReason, usage: finalUsage }
        yield { type: 'response_stop' }
        return
      }

      case 'error': {
        // error 事件（SSE 层错误，如流中断）
        const detail = [event.code, event.message].filter(Boolean).join(' ')
        throw new Error(`OpenAI Responses API error: ${detail}`)
      }

      default:
        // response.created / content_part.* / output_item.done /
        // function_call_arguments.done / reasoning.delta 等无需处理的事件
        break
    }
  }

  // 流异常结束（未收到 completed/failed/incomplete）：兜底收尾
  for (const e of stopAllOpenBlocks()) {
    yield e
  }
  yield { type: 'response_delta', stopReason: finalStopReason ?? null, usage: finalUsage }
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
    out.reasoning = reasoningParams.reasoning
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
