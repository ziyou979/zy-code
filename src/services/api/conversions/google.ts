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
 * - 流式：增量仍包装在 Candidate / Part 中，订阅代理也可能使用累计快照
 */

import { randomUUID } from 'node:crypto'
import { tSync } from '../../../i18n/index.js'
import { LLMError } from '../../../types/llm.js'
import { normalizeModelStringForAPI } from '../../model/model.js'
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
  /** 思考签名，用于后续请求复用（Google REST API 规范 camelCase） */
  thoughtSignature?: string
}

/** Google API 函数调用 */
export interface GoogleFunctionCall {
  name: string
  args?: Record<string, unknown>
  id?: string
  willContinue?: boolean
  partialArgs?: unknown[]
}

/**
 * 在入站适配边界将 Google API Part 中的思考签名明确转换为统一字符串。
 * 外部 REST JSON 返回 camelCase (thoughtSignature)，部分代理/SDK 返回 snake_case (thought_signature)。
 * 在转换层做明确归一化，禁止将两种命名的字段同时保留或混用。
 */
export function extractThoughtSignature(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') return undefined
  const p = part as Record<string, unknown>
  const fc = (p.functionCall && typeof p.functionCall === 'object' ? p.functionCall : undefined) as
    | Record<string, unknown>
    | undefined

  // 转换边界处理：外部 API/SDK 可能以 thoughtSignature 或 thought_signature 形式返回
  const candidate =
    p.thoughtSignature ??
    p['thought_signature'] ??
    (fc ? (fc.thoughtSignature ?? fc['thought_signature']) : undefined)

  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim()
  }
  return undefined
}

/**
 * 从业务标准 Message 内容块提取思考签名。
 * 内部领域模型严格遵循驼峰命名规范，统一通过 providerMetadata.googleThoughtSignature 或 block.signature 读取。
 */
export function extractBlockSignature(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined
  const b = block as Record<string, unknown>
  const meta = b.providerMetadata as Record<string, unknown> | undefined

  const candidate = meta?.googleThoughtSignature ?? b.signature

  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim()
  }
  return undefined
}

/**
 * 为 Google 返回的函数调用分配本地唯一 ID，原始 ID 放入 providerMetadata 供回传。
 * Vertex 的 functionCall.id 只在单次响应内唯一，跨响应会重复；若直接作为本地 ID，
 * 通用的 tool_call 去重会把后一轮带签名的调用当作重复删除，导致 thought_signature 缺失。
 */
function toLocalToolCallIdentity(googleId: string | undefined): {
  id: string
  googleFunctionCallId?: string
} {
  return {
    id: `call_${randomUUID()}`,
    ...(googleId && { googleFunctionCallId: googleId }),
  }
}

/** 读取本地工具块对应的 Google 原始调用 ID；旧历史没有该字段时沿用本地 ID。 */
function googleFunctionCallIdOf(block: Record<string, unknown>): string | undefined {
  const meta = block.providerMetadata as Record<string, unknown> | undefined
  const googleId = meta?.googleFunctionCallId
  if (typeof googleId === 'string' && googleId) {
    return googleId
  }
  return typeof block.id === 'string' ? block.id : undefined
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
  parametersJsonSchema?: Record<string, unknown>
}

/** Google API 请求体 */
export interface GoogleGenerateContentRequest {
  continuationToken?: string
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
  responseJsonSchema?: Record<string, unknown>
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
  initialPromptTokenCount?: number
  candidates?: GoogleCandidate[]
  usageMetadata?: GoogleUsageMetadata
  modelVersion?: string
  responseId?: string
  promptFeedback?: { blockReason?: string }
}

/** Google API 候选响应 */
export interface GoogleCandidate {
  continuationToken?: string
  content?: GoogleContent
  finishReason?: string
  finishMessage?: string
  index?: number
}

/** Google API 用量元数据 */
export interface GoogleUsageMetadata {
  initialPromptTokenCount?: number
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
 * - tool → 作为独立的 user 函数响应轮次，与新的用户输入分开
 * - 内容块包装在 parts[] 数组中
 */
export function messagesToGoogle(messages: AnyMessage[]): {
  contents: GoogleContent[]
  systemInstruction?: GoogleContent
} {
  const contents: GoogleContent[] = []
  let systemInstruction: GoogleContent | undefined

  const pendingToolResults: GooglePart[] = []
  // 中立工具结果只有调用 ID；Google 要求回传原函数名，必须从历史调用恢复。
  const toolCallNames = new Map<string, string>()
  // 本地 tool_call ID → 回传给 Google 的原始调用 ID
  const toolCallGoogleIds = new Map<string, string>()
  let latestTurnThinkingSignature: string | undefined
  let turnHasToolSignature = false

  for (const raw of messages) {
    // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 类型转换
    const msg = raw as any

    // system 消息提取为 systemInstruction
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string' ? msg.content : extractTextFromContent(msg.content)
      if (text) {
        systemInstruction ??= { parts: [] }
        systemInstruction.parts.push({ text })
      }
      continue
    }

    // tool 消息收集为 functionResponse parts
    if (msg.role === 'tool') {
      pendingToolResults.push({
        functionResponse: {
          name: msg.name ?? toolCallNames.get(msg.toolCallId) ?? `tool_${msg.toolCallId}`,
          response: { output: msg.content ?? '' },
          id: toolCallGoogleIds.get(msg.toolCallId) ?? msg.toolCallId,
        },
      })
      continue
    }

    // user 消息
    if (msg.role === 'user') {
      latestTurnThinkingSignature = undefined
      turnHasToolSignature = false
      const userParts = userContentToGoogleParts(msg.content)
      for (const part of userParts) {
        const response = part.functionResponse
        if (response?.id) {
          const name = toolCallNames.get(response.id)
          if (name) {
            response.name = name
          }
          response.id = toolCallGoogleIds.get(response.id) ?? response.id
        }
      }
      // 函数响应与新用户输入必须分开；混合时新版 Gemini 会误判尾轮次为 model。
      pendingToolResults.push(...userParts.filter((part) => part.functionResponse))
      if (pendingToolResults.length > 0) {
        const previous = contents.at(-1)
        if (previous?.role === 'user' && previous.parts.every((part) => part.functionResponse)) {
          previous.parts.push(...pendingToolResults)
        } else {
          contents.push({ role: 'user', parts: pendingToolResults.slice() })
        }
        pendingToolResults.length = 0
      }
      const inputParts = userParts.filter((part) => !part.functionResponse)
      if (inputParts.length > 0) {
        contents.push({ role: 'user', parts: inputParts })
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
      const res = assistantContentToGoogleParts(
        msg.content,
        latestTurnThinkingSignature,
        turnHasToolSignature,
      )
      const assistantParts = res.parts
      turnHasToolSignature = res.hasToolSignature
      if (res.thinkingSignature) {
        latestTurnThinkingSignature = res.thinkingSignature
      }
      // 结果只携带本地 ID，需按本地 ID 记录函数名与原始调用 ID。
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (
          (block?.type === 'tool_call' || block?.type === 'tool_use') &&
          typeof block.id === 'string'
        ) {
          toolCallNames.set(block.id, block.name)
          toolCallGoogleIds.set(block.id, googleFunctionCallIdOf(block) ?? block.id)
        }
      }
      if (assistantParts.length > 0) {
        const previous = contents.at(-1)
        if (previous?.role === 'model') {
          // 流式块常保存为多条 assistant 消息；同一轮的并行调用必须一起回传。
          previous.parts.push(...assistantParts)
        } else {
          contents.push({ role: 'model', parts: assistantParts })
        }
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

  // 并行工具可乱序完成，Gemini 4 却要求结果顺序与调用顺序一致。
  // 只重排新构造的函数响应 Part，不修改带签名的 model Part 或保存的历史。
  for (let i = 1; i < contents.length; i++) {
    const content = contents[i]!
    const calls = contents[i - 1]?.parts.flatMap((part) => part.functionCall ?? []) ?? []
    if (
      content.role === 'user' &&
      content.parts.every((part) => part.functionResponse) &&
      calls.length
    ) {
      const order = new Map(calls.map((call, index) => [call.id, index]))
      content.parts.sort(
        (a, b) =>
          (order.get(a.functionResponse?.id) ?? calls.length) -
          (order.get(b.functionResponse?.id) ?? calls.length),
      )
    }
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
        if (b.text || b.providerMetadata?.googleThoughtSignature) {
          parts.push({
            text: b.text ?? '',
            ...(b.providerMetadata?.googleThoughtSignature && {
              thoughtSignature: b.providerMetadata.googleThoughtSignature,
            }),
          })
        }
        break

      case 'image':
        if (b.mimeType && b.data) {
          parts.push({
            inlineData: { mimeType: b.mimeType, data: b.data },
          })
        }
        break

      case 'tool_use':
      case 'tool_call': {
        const sig = extractBlockSignature(b)
        parts.push({
          ...(sig && {
            thoughtSignature: sig,
          }),
          functionCall: {
            name: b.name,
            args: b.input ?? {},
            id: googleFunctionCallIdOf(b),
          },
        })
        break
      }

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

      case 'thinking': {
        const sig = extractBlockSignature(b)
        // 思考块在用户消息中（回传思考历史）
        if (b.thinking || sig) {
          parts.push({
            text: b.thinking ?? '',
            thought: true,
            ...(sig && {
              thoughtSignature: sig,
            }),
          })
        }
        break
      }
    }
  }
  return parts
}

/** 从 AssistantContentBlock[] 转换为 Google Part[] */
function assistantContentToGoogleParts(
  content: unknown,
  fallbackSignature?: string,
  initialHasToolSignature = false,
): { parts: GooglePart[]; hasToolSignature: boolean; thinkingSignature?: string } {
  if (typeof content === 'string') {
    return {
      parts: content ? [{ text: content }] : [],
      hasToolSignature: initialHasToolSignature,
    }
  }
  if (!Array.isArray(content)) {
    return { parts: [], hasToolSignature: initialHasToolSignature }
  }

  // 预扫描当前消息内部的思考块签名（仅用于为本消息内缺少签名的 tool_call 提供兜底）
  let messageThinkingSignature: string | undefined
  for (const block of content) {
    const b = block as Record<string, unknown> | null
    if (b && typeof b === 'object' && (b.type === 'thinking' || b.thought)) {
      const sig = extractBlockSignature(b)
      if (sig) {
        messageThinkingSignature = sig
        break
      }
    }
  }

  let hasToolSignature = initialHasToolSignature
  const parts: GooglePart[] = []
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (!b || typeof b !== 'object') continue
    const blockSig = extractBlockSignature(b)

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' || blockSig) {
          parts.push({
            text: typeof b.text === 'string' ? b.text : '',
            ...(blockSig && {
              thoughtSignature: blockSig,
            }),
          })
        }
        break

      case 'tool_use':
      case 'tool_call': {
        // Google 规范：并行工具调用中仅第一项携带 thoughtSignature。
        // 若当前工具块有显式签名，优先使用并标记已产生；
        // 若没有，仅在当轮尚未产生工具签名时，尝试从同轮 thinking 中继承一次。
        let sig: string | undefined
        if (blockSig) {
          sig = blockSig
          hasToolSignature = true
        } else if (!hasToolSignature) {
          sig = messageThinkingSignature ?? fallbackSignature
          if (sig) {
            hasToolSignature = true
          }
        }

        const functionCall: GoogleFunctionCall = {
          name: typeof b.name === 'string' ? b.name : '',
          args: (b.input as Record<string, unknown> | undefined) ?? {},
          id: googleFunctionCallIdOf(b),
        }
        parts.push({
          ...(sig && {
            thoughtSignature: sig,
          }),
          functionCall,
        })
        break
      }

      case 'thinking':
        if (typeof b.thinking === 'string' || blockSig) {
          parts.push({
            text: typeof b.thinking === 'string' ? b.thinking : '',
            thought: true,
            ...(blockSig && {
              thoughtSignature: blockSig,
            }),
          })
        }
        break

      case 'redacted_thinking':
        // Google 没有 redacted thinking 的概念，跳过
        break
    }
  }
  return {
    parts,
    hasToolSignature,
    thinkingSignature: messageThinkingSignature,
  }
}

/** 从 ContentBlock[] 提取纯文本 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => (b as { text?: string }).text ?? '')
    .join('\n')
}

/** 从 tool_result content 提取文本 */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
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
export function buildGoogleRequestParams(
  params: CreateParams,
  schemaFormat: 'openapi' | 'json-schema' = 'openapi',
  purpose: 'generate' | 'count' = 'generate',
): GoogleGenerateContentRequest {
  const { contents, systemInstruction } = messagesToGoogle(params.messages)

  const request: GoogleGenerateContentRequest = {
    contents,
  }

  const topLevelSystem = extractTextFromContent(params.system)
  if (topLevelSystem) {
    request.systemInstruction = {
      parts: [{ text: topLevelSystem }, ...(systemInstruction?.parts ?? [])],
    }
  } else if (systemInstruction) {
    request.systemInstruction = systemInstruction
  }

  // 生成配置
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
    // 分代归一化会删除预算字段，不能修改调用方持有的配置对象。
    generationConfig.thinkingConfig = { ...providerExtras.google.thinkingConfig }
  } else if (params.thinking) {
    // 从标准中立字段读取，不跨 namespace 读取其他 provider 的配置
    const thinkingConfig = convertThinkingToGoogleConfig(
      params.thinking,
      params.reasoningEffort,
      params.model,
    )
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig
    }
  }

  const outputFormat = params.responseFormat
  if (outputFormat?.type === 'json_schema' && outputFormat.schema) {
    generationConfig.responseMimeType = 'application/json'
    generationConfig[schemaFormat === 'json-schema' ? 'responseJsonSchema' : 'responseSchema'] =
      outputFormat.schema as Record<string, unknown>
  }

  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig
  }

  // 3/4 系列使用强度，2.5 使用预算；不能把两代参数混合后依赖服务端容错。
  const modelId = normalizeModelStringForAPI(params.model).replace(/^(?:google\/|models\/)/, '')
  if (/^gemini-3(?:[.-])/.test(modelId) && generationConfig.thinkingConfig) {
    const thinking = generationConfig.thinkingConfig
    delete thinking.thinkingBudget
    thinking.thinkingLevel ??=
      params.reasoningEffort?.toUpperCase() ??
      (params.thinking?.type === 'disabled' ? 'LOW' : 'MEDIUM')
    if (/^gemini-3-pro(?:-|$)/.test(modelId) && thinking.thinkingLevel === 'MEDIUM') {
      delete thinking.thinkingLevel // 3.0 Pro 仅有 LOW/HIGH；省略时使用服务端默认值。
    }
    if (thinking.thinkingLevel === 'MINIMAL' && /pro/.test(modelId)) {
      thinking.thinkingLevel = 'LOW'
    }
  }

  // 工具与函数调用
  if (params.tools && params.tools.length > 0) {
    const functionDeclarations: GoogleFunctionDeclaration[] = params.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description && { description: tool.description }),
      ...(tool.inputSchema && {
        [schemaFormat === 'json-schema' ? 'parametersJsonSchema' : 'parameters']:
          tool.inputSchema as Record<string, unknown>,
      }),
    }))

    request.tools = [{ functionDeclarations }]

    // 工具选择映射
    if (params.toolChoice) {
      request.toolConfig = mapToolChoiceToGoogle(params.toolChoice)
    }
  }

  if (/^gemini-4-/.test(modelId)) {
    // Gemini 4 使用原生强度且不能关闭思考；预算及 MINIMAL 会触发 400。
    const config = request.generationConfig ?? {}
    const rawLevel = config.thinkingConfig?.thinkingLevel ?? params.reasoningEffort
    const level = rawLevel?.toUpperCase()
    config.thinkingConfig = {
      thinkingLevel: level && ['LOW', 'MEDIUM', 'HIGH'].includes(level) ? level : 'MEDIUM',
      includeThoughts:
        config.thinkingConfig?.includeThoughts ?? params.thinking?.type !== 'disabled',
    }
    delete config.temperature
    delete config.topP
    delete config.topK
    delete config.candidateCount
    // 仅保留调用方选择的总预算；Vertex 负责在预算内接续原生检查点。
    config.maxOutputTokens = Math.min(config.maxOutputTokens ?? 65536, 1048576)
    request.generationConfig = config
  }

  const version = modelId.match(/^gemini-(\d+)(?:\.(\d+))?-/)
  if (
    version &&
    (Number(version[1]) >= 4 ||
      (Number(version[1]) === 3 && Number(version[2]) >= 6) ||
      modelId.startsWith('gemini-3.5-flash-lite'))
  ) {
    delete generationConfig.temperature
    delete generationConfig.topP
    delete generationConfig.topK
  }

  // 错误在本地给出，避免相同的非法尾轮次反复发送、付费重试。
  const lastContent = request.contents.at(-1)
  if (purpose === 'generate' && lastContent?.role === 'model') {
    throw new LLMError(tSync('google.modelTurnEnding'), 400)
  }
  if (purpose === 'generate' && !lastContent) {
    throw new LLMError(tSync('google.emptyConversation'), 400)
  }

  return request
}

/**
 * 将标准 thinking 配置转换为 Google generationConfig.thinkingConfig。
 */
function convertThinkingToGoogleConfig(
  thinking: ThinkingConfig,
  reasoningEffort?: string,
  model?: string,
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
      minimal: 'MINIMAL',
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
      xhigh: 'HIGH',
      max: 'HIGH',
    }
    return {
      thinkingBudget: thinking.budgetTokens ?? -1,
      ...(!/^gemini-2\.5-/.test(
        normalizeModelStringForAPI(model ?? '').replace(/^google\//, ''),
      ) && {
        thinkingLevel: (rawEffort && levelMap[rawEffort]) ?? 'MEDIUM',
      }),
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
  if (!googleReason) {
    return null
  }
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
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
      return 'content_filter'
    case 'FUNCTION_CALL':
      return 'tool_use'
    case 'CONTINUATION':
      // 原生适配器必须先完成续传，不能把中间检查点当作正常结束。
      throw new LLMError(tSync('google.invalidContinuation'), 400)
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      throw new LLMError(tSync('google.incompleteToolCall'), 400)
    default:
      throw new LLMError(tSync('google.unexpectedFinishReason', { reason: googleReason }), 400)
  }
}

/** 判断是否有函数调用（决定 stop_reason 是否为 tool_use） */
function hasFunctionCalls(parts: GooglePart[] | undefined): boolean {
  if (!parts) {
    return false
  }
  return parts.some((p) => !!p.functionCall)
}

/** 将 Google UsageMetadata 映射为标准 TokenUsage */
function mapUsageMetadata(usage: GoogleUsageMetadata | undefined): TokenUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0 }
  }
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    ...(usage.cachedContentTokenCount !== undefined && {
      cacheReadInputTokens: usage.cachedContentTokenCount,
    }),
    ...((usage.thoughtsTokenCount !== undefined ||
      usage.initialPromptTokenCount !== undefined ||
      (usage.cachedContentTokenCount ?? 0) > 0) && {
      extras: {
        // promptTokenCount 已含 cachedContentTokenCount
        ...((usage.cachedContentTokenCount ?? 0) > 0 && { inputIncludesCache: 1 }),
        ...(usage.thoughtsTokenCount !== undefined && {
          thoughtsTokenCount: usage.thoughtsTokenCount,
        }),
        ...(usage.initialPromptTokenCount !== undefined && {
          initialPromptTokenCount: usage.initialPromptTokenCount,
        }),
      },
    }),
  }
}

/** 将 Google UsageMetadata 映射为增量 DeltaUsage */
function mapDeltaUsage(usage: GoogleUsageMetadata | undefined): DeltaUsage {
  if (!usage) {
    return { outputTokens: 0 }
  }
  return {
    ...(usage.promptTokenCount !== undefined && { inputTokens: usage.promptTokenCount }),
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    ...(usage.cachedContentTokenCount !== undefined && {
      cacheReadInputTokens: usage.cachedContentTokenCount,
    }),
    ...((usage.thoughtsTokenCount !== undefined ||
      usage.initialPromptTokenCount !== undefined ||
      (usage.cachedContentTokenCount ?? 0) > 0) && {
      extras: {
        // promptTokenCount 已含 cachedContentTokenCount
        ...((usage.cachedContentTokenCount ?? 0) > 0 && { inputIncludesCache: 1 }),
        ...(usage.thoughtsTokenCount !== undefined && {
          thoughtsTokenCount: usage.thoughtsTokenCount,
        }),
        ...(usage.initialPromptTokenCount !== undefined && {
          initialPromptTokenCount: usage.initialPromptTokenCount,
        }),
      },
    }),
  }
}

/**
 * 将 Google Part[] 转换为标准 AssistantContentBlock[]。
 */
function googlePartsToContent(parts: GooglePart[] | undefined): AssistantContentBlock[] {
  if (!parts) {
    return []
  }
  const content: AssistantContentBlock[] = []
  let latestSignature: string | undefined
  let hasAssignedToolSignature = false

  for (const part of parts) {
    const sig = extractThoughtSignature(part)
    if (sig) {
      latestSignature = sig
    }

    if (part.thought && (part.text || sig)) {
      // 思考块
      content.push({
        type: 'thinking',
        thinking: part.text ?? '',
        signature: sig ?? latestSignature ?? '',
      })
    } else if (part.text !== undefined) {
      // 文本块
      if (part.text || sig) {
        content.push({
          type: 'text',
          text: part.text,
          ...(sig && {
            providerMetadata: { googleThoughtSignature: sig },
          }),
        })
      }
    } else if (part.functionCall) {
      // 工具调用：若本 part 未带独立签名，且当轮此前有思考签名且尚未被消耗，仅第一项继承
      let callSig = sig
      if (callSig) {
        hasAssignedToolSignature = true
      } else if (!hasAssignedToolSignature && latestSignature) {
        callSig = latestSignature
        hasAssignedToolSignature = true
      }
      const { id, googleFunctionCallId } = toLocalToolCallIdentity(part.functionCall.id)
      content.push({
        type: 'tool_call',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...((callSig || googleFunctionCallId) && {
          providerMetadata: {
            ...(callSig && { googleThoughtSignature: callSig }),
            ...(googleFunctionCallId && { googleFunctionCallId }),
          },
        }),
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
      stopReason: response.promptFeedback?.blockReason
        ? 'content_filter'
        : mapFinishReason(candidate?.finishReason),
      usage: mapUsageMetadata(response.usageMetadata),
    }
  }

  const parts = candidate.content.parts || []
  if (candidate.finishReason === 'CONTINUATION') {
    throw new LLMError(tSync('google.invalidContinuation'), 400)
  }
  for (const part of parts) {
    if (part.functionCall?.willContinue || part.functionCall?.partialArgs) {
      throw new LLMError(tSync('google.partialToolArguments'), 400)
    }
  }
  if (
    hasFunctionCalls(parts) &&
    !['STOP', 'FUNCTION_CALL'].includes(candidate.finishReason ?? '')
  ) {
    throw new LLMError(tSync('google.incompleteToolCall'), 400)
  }
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
 * 原生 Gemini 返回增量；部分订阅代理返回累计快照，调用方明确指定。
 */
export function googleStreamToStandard(
  stream: AsyncIterable<GoogleGenerateContentResponse>,
  model: string,
  contentMode: 'delta' | 'snapshot' = 'snapshot',
): AsyncIterable<LLMStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // 按 Part 位置保存文本状态，并从统一计数器
      // 分配标准 block index，避免 thinking / text / tool 都从 0 开始互相覆盖。
      const textStates = new Map<string, { index: number; value: string }>()
      type PendingTool = {
        index: number
        call: GoogleFunctionCall
        localId: string
        googleFunctionCallId?: string
        signature?: string
      }
      const emittedToolCalls = new Map<string, PendingTool>()
      const pendingTools = new Map<number, PendingTool>()
      const textSignatures = new Map<number, string>()
      const signedThinkingIndices = new Set<number>()
      const openBlockIndices = new Set<number>()
      let nextBlockIndex = 0
      let sawToolCall = false
      let isFirstChunk = true
      let finalStopReason: StopReason = null
      let finalUsage: DeltaUsage | undefined
      let googleUsage: GoogleUsageMetadata = {}
      let latestStreamSignature: string | undefined
      let streamSignatureAssignedToTool = false

      function* closeBlock(index: number): Generator<LLMStreamEvent> {
        const tool = pendingTools.get(index)
        if (tool) {
          const effectiveSignature = tool.signature
          yield {
            type: 'chunk_start',
            index,
            chunk: {
              type: 'tool_call',
              id: tool.localId,
              name: tool.call.name,
              input: {},
              ...((effectiveSignature || tool.googleFunctionCallId) && {
                providerMetadata: {
                  ...(effectiveSignature && { googleThoughtSignature: effectiveSignature }),
                  ...(tool.googleFunctionCallId && {
                    googleFunctionCallId: tool.googleFunctionCallId,
                  }),
                },
              }),
            },
          }
          yield {
            type: 'chunk_delta',
            index,
            delta: { type: 'input_json_delta', partialJson: JSON.stringify(tool.call.args ?? {}) },
          }
          pendingTools.delete(index)
        }
        const signature = textSignatures.get(index)
        yield {
          type: 'chunk_stop',
          index,
          ...(signature && { extras: { providerMetadata: { googleThoughtSignature: signature } } }),
        }
        openBlockIndices.delete(index)
      }

      function* closeTextThrough(lastIndex: number): Generator<LLMStreamEvent> {
        // 签名归属原始 Part；关闭前面的思考/正文时保留提交顺序，工具仍等待整轮成功。
        for (const index of [...openBlockIndices].sort((a, b) => a - b)) {
          if (index <= lastIndex && !pendingTools.has(index)) {
            yield* closeBlock(index)
          }
        }
        for (const [key, state] of textStates) {
          if (!openBlockIndices.has(state.index)) {
            textStates.delete(key)
          }
        }
      }

      for await (const chunk of stream) {
        if (chunk.usageMetadata) {
          // 用量尾包可只携带思考计数；先合并原生计数再计算完整输出量，不能覆盖或重复相加。
          googleUsage = { ...googleUsage, ...chunk.usageMetadata }
          finalUsage = mapDeltaUsage(googleUsage)
        }
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
        if (chunk.promptFeedback?.blockReason) {
          finalStopReason = 'content_filter'
        }
        const parts = candidate?.content?.parts || []

        // 处理每个 Part
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          const partSig = extractThoughtSignature(part)
          if (partSig) {
            latestStreamSignature = partSig
          }

          if (part.thought && part.text !== undefined) {
            // 思考内容增量
            const newText = part.text
            const key = `thinking:${i}`
            let state = textStates.get(key)
            if (
              contentMode === 'delta' &&
              state &&
              (partSig || signedThinkingIndices.has(state.index))
            ) {
              yield* closeTextThrough(state.index)
              state = undefined
            }
            const delta =
              contentMode === 'snapshot' && state && newText.startsWith(state.value)
                ? newText.slice(state.value.length)
                : newText

            if (!state && (delta || partSig)) {
              // 新的思考块开始
              const index = nextBlockIndex++
              textStates.set(key, { index, value: newText })
              openBlockIndices.add(index)
              yield {
                type: 'chunk_start',
                index,
                chunk: { type: 'thinking', thinking: '', signature: '' },
              }
            } else if (state) {
              state.value = newText
            }

            if (delta) {
              const index = textStates.get(key)?.index
              if (index === undefined) {
                continue
              }
              yield {
                type: 'chunk_delta',
                index,
                delta: { type: 'thinking_delta', thinking: delta },
              }
            }

            if (partSig) {
              const index = textStates.get(key)?.index
              if (index === undefined) {
                continue
              }
              signedThinkingIndices.add(index)
              yield {
                type: 'chunk_delta',
                index,
                delta: { type: 'signature_delta', signature: partSig },
              }
            }
          } else if (part.text !== undefined && !part.thought) {
            // 文本内容增量
            const newText = part.text
            const key = `text:${i}`
            let state = textStates.get(key)
            // 带签名的原生 Part 不与之前无签名的 Part 合并；空文本尾包同样保留。
            if (contentMode === 'delta' && state && (partSig || textSignatures.has(state.index))) {
              // chunk_stop 会立即保存并显示消息，不能先提交正文而让更早的思考留到 STOP。
              // 工具仍需整轮成功后才执行；这里只关闭前面的思考/文本块，并清除旧分段状态。
              yield* closeTextThrough(state.index)
              state = undefined
            }
            const delta =
              contentMode === 'snapshot' && state && newText.startsWith(state.value)
                ? newText.slice(state.value.length)
                : newText

            if (!state && (delta || partSig)) {
              // 新的文本块开始
              const index = nextBlockIndex++
              textStates.set(key, { index, value: newText })
              openBlockIndices.add(index)
              yield {
                type: 'chunk_start',
                index,
                chunk: { type: 'text', text: '' },
              }
            } else if (state) {
              state.value = newText
            }

            if (delta) {
              const index = textStates.get(key)?.index
              if (index === undefined) {
                continue
              }
              yield {
                type: 'chunk_delta',
                index,
                delta: { type: 'text_delta', text: delta },
              }
            }
            if (partSig) {
              const index = textStates.get(key)?.index
              if (index !== undefined) {
                textSignatures.set(index, partSig)
              }
            }
          } else if (part.functionCall) {
            if (part.functionCall.willContinue || part.functionCall.partialArgs) {
              // 尚未实现 JSONPath 参数片段合并，明确拒绝，不能把残缺参数执行成命令。
              throw new LLMError(tSync('google.partialToolArguments'), 400)
            }
            let toolSig = partSig
            if (toolSig) {
              streamSignatureAssignedToTool = true
            } else if (!streamSignatureAssignedToTool && latestStreamSignature) {
              toolSig = latestStreamSignature
              streamSignatureAssignedToTool = true
            }
            // 累计快照会重复携带同一个 functionCall，只发出一次标准工具块。
            const toolKey =
              part.functionCall.id ??
              (contentMode === 'delta'
                ? `call:${nextBlockIndex}`
                : `part:${i}:${part.functionCall.name}`)
            const previous = emittedToolCalls.get(toolKey)
            if (previous) {
              if (part.functionCall.args) {
                previous.call.args = part.functionCall.args
              }
              if (partSig) {
                previous.signature = partSig
              }
              continue
            }
            if (contentMode === 'delta') {
              // 先完成此前的思考/文本块，保存后的 Part 顺序与服务端一致。
              for (const state of textStates.values()) {
                if (openBlockIndices.has(state.index)) {
                  yield* closeBlock(state.index)
                }
              }
              textStates.clear()
            }
            const toolCallIndex = nextBlockIndex++
            const identity = toLocalToolCallIdentity(part.functionCall.id)
            const tool: PendingTool = {
              index: toolCallIndex,
              call: { ...part.functionCall },
              localId: identity.id,
              googleFunctionCallId: identity.googleFunctionCallId,
              signature: toolSig,
            }
            emittedToolCalls.set(toolKey, tool)
            pendingTools.set(toolCallIndex, tool)
            openBlockIndices.add(toolCallIndex)
            sawToolCall = true
          }
        }

        // 检查是否有 finish reason（最后一个 chunk）
        if (candidate?.finishReason) {
          if (sawToolCall && !['STOP', 'FUNCTION_CALL'].includes(candidate.finishReason)) {
            throw new LLMError(tSync('google.incompleteToolCall'), 502)
          }
          // 若尾包到达时刷新了思考签名，给当轮尚未关联签名的工具调用（仅第一项）补齐
          if (latestStreamSignature && !streamSignatureAssignedToTool) {
            for (const tool of pendingTools.values()) {
              if (!tool.signature) {
                tool.signature = latestStreamSignature
                streamSignatureAssignedToTool = true
                break
              }
            }
          }
          // 工具执行推迟至整轮明确完成，断线或截断不会重跑已经提前执行的命令。
          for (const index of [...openBlockIndices].sort((a, b) => a - b)) {
            yield* closeBlock(index)
          }
          openBlockIndices.clear()

          finalStopReason =
            sawToolCall || hasFunctionCalls(candidate.content?.parts)
              ? ('tool_use' as StopReason)
              : mapFinishReason(candidate.finishReason)
        }
      }

      for (const index of openBlockIndices) {
        if (!pendingTools.has(index)) {
          yield* closeBlock(index)
        }
      }
      // 完成包和用量包可能分开发送；合并成一次最终事件，避免上层重复累计成本。
      if (finalStopReason !== null || finalUsage) {
        yield { type: 'response_delta', stopReason: finalStopReason, usage: finalUsage }
      }
      // 流结束
      yield { type: 'response_stop' }
    },
  }
}
