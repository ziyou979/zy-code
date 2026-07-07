/**
 * Google Generative AI 双向转换层 — 标准 Message[] / LLMStreamEvent ↔ Google SDK 格式。
 *
 * 设计原则与 conversions/openai.ts、conversions/anthropic.ts 一致：
 * - 公开函数接受标准 llm.ts 类型，输出 Google SDK 类型（或反向）
 * - 不直接调用任何 Google client；adapter 负责 IO
 *
 * Google API 与 Anthropic/OpenAI 的关键格式差异：
 * - role: 'user' | 'model'（不是 'assistant'）
 * - 内容包装在 parts: Part[] 数组中
 * - systemInstruction 是独立字段（不在 contents 中）
 * - 工具调用：functionCall / functionResponse
 * - 思考内容：Part 上 thought: true + thoughtSignature
 * - 流式：返回完整 Candidate 对象而非 delta，需要客户端计算增量
 */

import { randomUUID } from 'node:crypto'
import { normalizeModelStringForAPI } from '../../../services/model/model.js'
import type {
  AssistantContentBlock,
  CreateParams,
  DeltaUsage,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  StopReason,
  ThinkingConfig,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from '../../../types/llm.js'

// ============================================================================
// Google API 类型定义（基于官方 Discovery Schema）
// ============================================================================

/** Google API Content（消息） */
export interface GoogleContent {
  role?: 'user' | 'model'
  parts: GooglePart[]
}

/** Google API Part（多态内容块） */
export interface GooglePart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: GoogleFunctionCall
  functionResponse?: GoogleFunctionResponse
  /** 标记此 Part 为思考内容 */
  thought?: boolean
  /** 思考签名，用于后续请求复用 */
  thoughtSignature?: string
}

/** Google API 函数调用 */
export interface GoogleFunctionCall {
  name: string
  args?: Record<string, unknown>
  id?: string
}

/** Google API 函数响应 */
export interface GoogleFunctionResponse {
  name: string
  response: Record<string, unknown>
  id?: string
}

/** Google API 函数声明 */
export interface GoogleFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** Google API 请求体 */
export interface GoogleGenerateContentRequest {
  contents: GoogleContent[]
  systemInstruction?: GoogleContent
  generationConfig?: GoogleGenerationConfig
  tools?: GoogleTool[]
  toolConfig?: GoogleToolConfig
}

/** Google API 生成配置 */
export interface GoogleGenerationConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  candidateCount?: number
  thinkingConfig?: GoogleThinkingConfig
  responseMimeType?: string
  responseSchema?: Record<string, unknown>
}

/** Google API 思考配置 */
export interface GoogleThinkingConfig {
  thinkingBudget?: number
  thinkingLevel?: string
  includeThoughts?: boolean
}

/** Google API 工具 */
export interface GoogleTool {
  functionDeclarations?: GoogleFunctionDeclaration[]
}

/** Google API 工具配置 */
export interface GoogleToolConfig {
  functionCallingConfig?: {
    mode?: 'AUTO' | 'ANY' | 'NONE'
    allowedFunctionNames?: string[]
  }
}

/** Google API 响应 */
export interface GoogleGenerateContentResponse {
  candidates?: GoogleCandidate[]
  usageMetadata?: GoogleUsageMetadata
  modelVersion?: string
  responseId?: string
}

/** Google API 候选响应 */
export interface GoogleCandidate {
  content?: GoogleContent
  finishReason?: string
  finishMessage?: string
  index?: number
}

/** Google API 用量元数据 */
export interface GoogleUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

// ============================================================================
// 出站：标准 → Google
// ============================================================================

type AnyMessage = LLMMessage | Record<string, unknown>

/**
 * 将标准 Message[] 转换为 Google Content[] + systemInstruction。
 *
 * 转换规则：
 * - system 消息 → systemInstruction（独立字段）
 * - assistant → role: 'model'
 * - user → role: 'user'
 * - tool → 合并到下一条 user 消息中作为 functionResponse
 * - 内容块包装在 parts[] 数组中
 */
export function messagesToGoogle(messages: AnyMessage[]): {
  contents: GoogleContent[]
  systemInstruction?: GoogleContent
} {
  const contents: GoogleContent[] = []
  let systemInstruction: GoogleContent | undefined

  // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
  const pendingToolResults: GooglePart[] = []

  for (const raw of messages) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const msg = raw as any

    // system 消息提取为 systemInstruction
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string' ? msg.content : extractTextFromContent(msg.content)
      if (text) {
        systemInstruction = {
          parts: [{ text }],
        }
      }
      continue
    }

    // tool 消息收集为 functionResponse parts
    if (msg.role === 'tool') {
      pendingToolResults.push({
        functionResponse: {
          name: msg.name ?? `tool_${msg.toolCallId}`,
          response: { output: msg.content ?? '' },
          id: msg.toolCallId,
        },
      })
      continue
    }

    // user 消息
    if (msg.role === 'user') {
      const userParts = userContentToGoogleParts(msg.content)
      // 合并待处理的 tool results
      if (pendingToolResults.length > 0) {
        contents.push({
          role: 'user',
          parts: [...pendingToolResults, ...userParts],
        })
        pendingToolResults.length = 0
      } else {
        contents.push({ role: 'user', parts: userParts })
      }
      continue
    }

    // assistant 消息
    if (msg.role === 'assistant') {
      // 先消化待处理的 tool results（如果 assistant 之前还有未消化的）
      if (pendingToolResults.length > 0) {
        contents.push({
          role: 'user',
          parts: pendingToolResults.slice(),
        })
        pendingToolResults.length = 0
      }
      const assistantParts = assistantContentToGoogleParts(msg.content)
      if (assistantParts.length > 0) {
        contents.push({ role: 'model', parts: assistantParts })
      }
    }
  }

  // 消化剩余的 tool results
  if (pendingToolResults.length > 0) {
    contents.push({
      role: 'user',
      parts: pendingToolResults,
    })
  }

  return { contents, systemInstruction }
}

/** 从 UserContentBlock[] 转换为 Google Part[] */
function userContentToGoogleParts(content: unknown): GooglePart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }

  const parts: GooglePart[] = []
  for (const block of content) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const b = block as any
    switch (b.type) {
      case 'text':
        if (b.text) {
          parts.push({ text: b.text })
        }
        break

      case 'image':
        if (b.mimeType && b.data) {
          parts.push({
            inlineData: { mimeType: b.mimeType, data: b.data },
          })
        }
        break

      case 'tool_call':
        // 用户消息中的 tool_call（不太常见，但兼容）
        parts.push({
          functionCall: {
            name: b.name,
            args: b.input ?? {},
            id: b.id,
          },
        })
        break

      case 'tool_result':
        // 内联在 user 消息中的 tool_result
        parts.push({
          functionResponse: {
            name: b.name ?? `tool_${b.toolCallId}`,
            response: { output: extractToolResultText(b.content) },
            id: b.toolCallId,
          },
        })
        break

      case 'thinking':
        // 思考块在用户消息中（回传思考历史）
        if (b.thinking) {
          parts.push({
            text: b.thinking,
            thought: true,
            ...(b.signature && { thoughtSignature: b.signature }),
          })
        }
        break
    }
  }
  return parts
}

/** 从 AssistantContentBlock[] 转换为 Google Part[] */
function assistantContentToGoogleParts(content: unknown): GooglePart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }

  const parts: GooglePart[] = []
  for (const block of content) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const b = block as any
    switch (b.type) {
      case 'text':
        if (b.text) {
          parts.push({ text: b.text })
        }
        break

      case 'tool_call':
        parts.push({
          functionCall: {
            name: b.name,
            args: b.input ?? {},
            id: b.id,
          },
        })
        break

      case 'thinking':
        if (b.thinking) {
          parts.push({
            text: b.thinking,
            thought: true,
            ...(b.signature && { thoughtSignature: b.signature }),
          })
        }
        break

      case 'redacted_thinking':
        // Google 没有 redacted thinking 的概念，跳过
        break
    }
  }
  return parts
}

/** 从 ContentBlock[] 提取纯文本 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => (b as { text?: string }).text ?? '')
    .join('\n')
}

/** 从 tool_result content 提取文本 */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => (b as { text?: string }).text ?? '')
    .join('\n')
}

// ============================================================================
// 请求构建
// ============================================================================

/**
 * 从标准 CreateParams 构建 Google API 请求体。
 */
export function buildGoogleRequestParams(params: CreateParams): GoogleGenerateContentRequest {
  const { contents, systemInstruction } = messagesToGoogle(params.messages)

  const request: GoogleGenerateContentRequest = {
    contents,
  }

  if (systemInstruction) {
    request.systemInstruction = systemInstruction
  }

  // GenerationConfig
  const generationConfig: GoogleGenerationConfig = {}
  if (params.temperature !== undefined) {
    generationConfig.temperature = params.temperature
  }
  if (params.topP !== undefined) {
    generationConfig.topP = params.topP
  }
  if (params.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = params.maxTokens
  }
  if (params.stopSequences && params.stopSequences.length > 0) {
    generationConfig.stopSequences = params.stopSequences
  }

  // Thinking config: 优先用 providerExtras.google.thinkingConfig 覆盖
  const providerExtras = params.providerExtras
  if (providerExtras?.google?.thinkingConfig) {
    generationConfig.thinkingConfig = providerExtras.google.thinkingConfig as GoogleThinkingConfig
  } else if (params.thinking) {
    // 从标准中立字段读取，不跨 namespace 读取其他 provider 的配置
    const thinkingConfig = convertThinkingToGoogleConfig(params.thinking, params.reasoningEffort)
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig
    }
  }

  const outputFormat = params.responseFormat
  if (outputFormat?.type === 'json_schema' && outputFormat.schema) {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseSchema = outputFormat.schema as Record<string, unknown>
  }

  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig
  }

  // Tools / Function calling
  if (params.tools && params.tools.length > 0) {
    const functionDeclarations: GoogleFunctionDeclaration[] = params.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description && { description: tool.description }),
      ...(tool.inputSchema && { parameters: tool.inputSchema as Record<string, unknown> }),
    }))

    request.tools = [{ functionDeclarations }]

    // Tool choice mapping
    if (params.toolChoice) {
      request.toolConfig = mapToolChoiceToGoogle(params.toolChoice)
    }
  }

  return request
}

/**
 * 将标准 thinking 配置转换为 Google generationConfig.thinkingConfig。
 */
function convertThinkingToGoogleConfig(
  thinking: ThinkingConfig,
  reasoningEffort?: string,
): GoogleThinkingConfig | undefined {
  if (thinking.type === 'disabled') {
    return { thinkingBudget: 0, includeThoughts: false }
  }

  if (thinking.type === 'adaptive') {
    return { thinkingBudget: -1, includeThoughts: true }
  }

  if (thinking.type === 'enabled') {
    // reasoningEffort 来自中性的 CreateParams.reasoningEffort
    const rawEffort = reasoningEffort

    // 将 provider 映射后的 effort 值转为 Google thinkingLevel
    // 注意：这里映射的是 model-level effort.map 的输出值
    const levelMap: Record<string, string> = {
      low: 'MINIMAL',
      medium: 'LOW',
      high: 'MEDIUM',
      xhigh: 'HIGH',
      max: 'HIGH',
    }
    return {
      thinkingBudget: thinking.budgetTokens ?? -1,
      thinkingLevel: (rawEffort && levelMap[rawEffort]) ?? 'MEDIUM',
      includeThoughts: true,
    }
  }

  return undefined
}

/** 将标准 ToolChoice 映射为 Google ToolConfig */
function mapToolChoiceToGoogle(toolChoice: ToolChoice): GoogleToolConfig {
  switch (toolChoice.type) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } }
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } }
    case 'tool':
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [toolChoice.name],
        },
      }
    default:
      return {}
  }
}

// ============================================================================
// 入站：Google → 标准
// ============================================================================

/** 将 Google finishReason 映射为标准 StopReason */
function mapFinishReason(googleReason: string | undefined): StopReason {
  if (!googleReason) return null
  switch (googleReason) {
    case 'STOP':
      return 'end_turn'
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter'
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'FUNCTION_CALL':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

/** 判断是否有函数调用（决定 stop_reason 是否为 tool_use） */
function hasFunctionCalls(parts: GooglePart[] | undefined): boolean {
  if (!parts) return false
  return parts.some((p) => !!p.functionCall)
}

/** 将 Google UsageMetadata 映射为标准 TokenUsage */
function mapUsageMetadata(usage: GoogleUsageMetadata | undefined): TokenUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0 }
  }
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.cachedContentTokenCount !== undefined && {
      cacheReadInputTokens: usage.cachedContentTokenCount,
    }),
    ...(usage.thoughtsTokenCount !== undefined && {
      extras: { thoughtsTokenCount: usage.thoughtsTokenCount },
    }),
  }
}

/** 将 Google UsageMetadata 映射为增量 DeltaUsage */
function mapDeltaUsage(usage: GoogleUsageMetadata | undefined): DeltaUsage {
  if (!usage) {
    return { outputTokens: 0 }
  }
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.cachedContentTokenCount !== undefined && {
      cacheReadInputTokens: usage.cachedContentTokenCount,
    }),
  }
}

/**
 * 将 Google Part[] 转换为标准 AssistantContentBlock[]。
 */
function googlePartsToContent(parts: GooglePart[] | undefined): AssistantContentBlock[] {
  if (!parts) return []
  const content: AssistantContentBlock[] = []

  for (const part of parts) {
    if (part.thought && part.text) {
      // 思考块
      content.push({
        type: 'thinking',
        thinking: part.text,
        signature: part.thoughtSignature ?? '',
      })
    } else if (part.text !== undefined) {
      // 文本块
      if (part.text) {
        content.push({ type: 'text', text: part.text })
      }
    } else if (part.functionCall) {
      // 工具调用
      content.push({
        type: 'tool_call',
        id: part.functionCall.id ?? `call_${randomUUID()}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      })
    }
  }

  return content
}

/**
 * 将非流式 Google 响应转换为标准 LLMResponse。
 */
export function googleResponseToStandard(
  response: GoogleGenerateContentResponse,
  model: string,
): LLMResponse {
  const candidate = response.candidates?.[0]
  if (!candidate?.content) {
    return {
      id: response.responseId ?? randomUUID(),
      model: model || response.modelVersion || 'unknown',
      role: 'assistant',
      content: [],
      stopReason: mapFinishReason(candidate?.finishReason),
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  const parts = candidate.content.parts || []
  const content = googlePartsToContent(parts)

  // 如果有函数调用，stop_reason 应为 tool_use
  const stopReason = hasFunctionCalls(parts)
    ? ('tool_use' as StopReason)
    : mapFinishReason(candidate.finishReason)

  return {
    id: response.responseId ?? randomUUID(),
    model: model || response.modelVersion || 'unknown',
    role: 'assistant',
    content,
    stopReason,
    usage: mapUsageMetadata(response.usageMetadata),
  }
}

// ============================================================================
// 流式转换
// ============================================================================

/**
 * 将 Google 流式响应转换为标准 LLMStreamEvent。
 *
 * Google 流式返回的是累积式内容（每个 chunk 包含完整内容而非增量），
 * 需要跟踪先前状态并计算 delta。
 */
export function googleStreamToStandard(
  stream: AsyncIterable<GoogleGenerateContentResponse>,
  model: string,
): AsyncIterable<LLMStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // 跟踪先前状态以计算增量
      let previousTextLength = 0
      let previousThinkingLength = 0
      let previousToolCallCount = 0
      let isFirstChunk = true

      for await (const chunk of stream) {
        // 第一个 chunk 发出 response_start
        if (isFirstChunk) {
          isFirstChunk = false
          yield {
            type: 'response_start',
            responseId: chunk.responseId ?? randomUUID(),
            model: model || chunk.modelVersion || 'unknown',
          }
        }

        const candidate = chunk.candidates?.[0]
        if (!candidate?.content) continue

        const parts = candidate.content.parts || []

        // 处理每个 Part
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]

          if (part.thought && part.text !== undefined) {
            // 思考内容增量
            const newText = part.text
            const delta = newText.slice(previousThinkingLength)
            previousThinkingLength = newText.length

            if (delta && previousThinkingLength === delta.length) {
              // 新的思考块开始
              yield {
                type: 'chunk_start',
                index: 0,
                chunk: { type: 'thinking', thinking: '', signature: '' },
              }
            }

            if (delta) {
              yield {
                type: 'chunk_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: delta },
              }
            }

            if (part.thoughtSignature) {
              yield {
                type: 'chunk_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: part.thoughtSignature },
              }
            }
          } else if (part.text !== undefined && !part.thought) {
            // 文本内容增量
            const newText = part.text
            const delta = newText.slice(previousTextLength)
            previousTextLength = newText.length

            if (delta && previousTextLength === delta.length) {
              // 新的文本块开始
              yield {
                type: 'chunk_start',
                index: previousToolCallCount === 0 ? 0 : previousToolCallCount,
                chunk: { type: 'text', text: '' },
              }
            }

            if (delta) {
              yield {
                type: 'chunk_delta',
                index: previousToolCallCount === 0 ? 0 : previousToolCallCount,
                delta: { type: 'text_delta', text: delta },
              }
            }
          } else if (part.functionCall) {
            // 函数调用 — 检测新增的 function call
            const toolCallIndex = previousToolCallCount
            previousToolCallCount++

            // 发出 chunk_start
            yield {
              type: 'chunk_start',
              index: toolCallIndex,
              chunk: {
                type: 'tool_call',
                id: part.functionCall.id ?? `call_${randomUUID()}`,
                name: part.functionCall.name,
                input: {},
              },
            }

            // 发出 input_json_delta
            const argsJson = JSON.stringify(part.functionCall.args ?? {})
            if (argsJson && argsJson !== '{}') {
              yield {
                type: 'chunk_delta',
                index: toolCallIndex,
                delta: { type: 'input_json_delta', partialJson: argsJson },
              }
            }

            // 发出 chunk_stop
            yield {
              type: 'chunk_stop',
              index: toolCallIndex,
            }
          }
        }

        // 检查是否有 finish reason（最后一个 chunk）
        if (candidate.finishReason) {
          const parts2 = candidate.content?.parts || []
          const stopReason = hasFunctionCalls(parts2)
            ? ('tool_use' as StopReason)
            : mapFinishReason(candidate.finishReason)

          yield {
            type: 'response_delta',
            stopReason,
            usage: chunk.usageMetadata ? mapDeltaUsage(chunk.usageMetadata) : undefined,
          }
        }
      }

      // 流结束
      yield { type: 'response_stop' }
    },
  }
}
