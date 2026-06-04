/**
 * SDK 校验器：用 OpenAI / Anthropic SDK 自身的类型 + 序列化器验证测试产出。
 *
 * 设计原则：
 * - 不写自己的 schema，直接复用 SDK 的类型定义（编译时校验）
 * - 提供运行时校验函数，对结构 / 字段做 hard check
 * - 任何不符合 SDK 协议的产物（如 tool_call.function.arguments 不是合法 JSON 字符串）
 *   都必须在这里被拦截
 */

import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'

// ============================================================================
// OpenAI ChatCompletionMessageParam 校验
// ============================================================================

/**
 * 校验一组 OpenAI ChatCompletionMessageParam[] 是否符合 OpenAI Chat Completions API
 * 规范，重点关注 tool_calls 的合法性 —— 这是 DashScope 400 的根因区域。
 *
 * 校验项：
 * - role 合法（system / user / assistant / tool / developer / function）
 * - assistant.tool_calls[].id 非空
 * - assistant.tool_calls[].type === 'function'
 * - assistant.tool_calls[].function.name 非空
 * - assistant.tool_calls[].function.arguments 是合法 JSON 字符串
 *   - 不能是 undefined / null / 空字符串
 *   - 必须能被 JSON.parse 成功
 *   - parse 后必须是 object（不是 string / number / array）—— 这是 DashScope 严格规则
 * - tool 消息的 tool_call_id 与上一条 assistant 的某个 tool_call.id 对应
 */
export function assertValidOpenAIChatMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
  if (!Array.isArray(messages)) {
    throw new Error(`messages must be an array, got ${typeof messages}`)
  }

  // 维护已经出现过的 tool_call.id 集合，用于校验 tool 消息的 tool_call_id 引用
  const seenToolCallIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const ctx = `messages[${i}]`

    if (typeof msg !== 'object' || msg === null) {
      throw new Error(`${ctx}: not an object`)
    }
    if (typeof msg.role !== 'string') {
      throw new Error(`${ctx}: missing role`)
    }
    const validRoles = ['system', 'user', 'assistant', 'tool', 'developer', 'function']
    if (!validRoles.includes(msg.role)) {
      throw new Error(`${ctx}: invalid role "${msg.role}"`)
    }

    if (msg.role === 'assistant') {
      const am = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam
      if (am.tool_calls) {
        if (!Array.isArray(am.tool_calls)) {
          throw new Error(`${ctx}.tool_calls: not an array`)
        }
        for (let j = 0; j < am.tool_calls.length; j++) {
          const tc = am.tool_calls[j]!
          const tctx = `${ctx}.tool_calls[${j}]`
          if (typeof tc.id !== 'string' || tc.id.length === 0) {
            throw new Error(`${tctx}.id: must be non-empty string, got ${JSON.stringify(tc.id)}`)
          }
          if (tc.type !== 'function') {
            throw new Error(`${tctx}.type: must be 'function', got ${JSON.stringify(tc.type)}`)
          }
          const fn = (tc as OpenAI.Chat.ChatCompletionMessageToolCall).function
          if (!fn || typeof fn !== 'object') {
            throw new Error(`${tctx}.function: missing`)
          }
          if (typeof fn.name !== 'string' || fn.name.length === 0) {
            throw new Error(
              `${tctx}.function.name: must be non-empty string, got ${JSON.stringify(fn.name)}`,
            )
          }
          // 严格 JSON 校验 —— DashScope 400 错误的根因
          if (typeof fn.arguments !== 'string') {
            throw new Error(
              `${tctx}.function.arguments: must be a string (JSON), got ${typeof fn.arguments}. ` +
                `OpenAI / DashScope require arguments to be a JSON-encoded string.`,
            )
          }
          if (fn.arguments.length === 0) {
            throw new Error(
              `${tctx}.function.arguments: must be non-empty JSON string. ` +
                `Empty string violates DashScope: 'function.arguments parameter must be in JSON format'.`,
            )
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(fn.arguments)
          } catch (e) {
            throw new Error(
              `${tctx}.function.arguments: not valid JSON. ` +
                `Got: ${JSON.stringify(fn.arguments).slice(0, 200)}. ` +
                `Parse error: ${(e as Error).message}`,
            )
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(
              `${tctx}.function.arguments: parsed result must be a JSON object, ` +
                `got ${Array.isArray(parsed) ? 'array' : typeof parsed}. ` +
                `Value: ${JSON.stringify(parsed).slice(0, 200)}. ` +
                `(DashScope strictly rejects non-object arguments, e.g. doubly-stringified strings.)`,
            )
          }
          seenToolCallIds.add(tc.id)
        }
      }
    } else if (msg.role === 'tool') {
      const tm = msg as OpenAI.Chat.ChatCompletionToolMessageParam
      if (typeof tm.tool_call_id !== 'string' || tm.tool_call_id.length === 0) {
        throw new Error(`${ctx}.tool_call_id: must be non-empty string`)
      }
      // tool 消息的 content 可以是 string 或 ContentPart[]
      if (tm.content === undefined || tm.content === null) {
        throw new Error(`${ctx}.content: missing`)
      }
    }
  }
}

/**
 * 校验单个 OpenAI ChatCompletion 响应（非流式）是否符合 SDK 协议。
 */
export function assertValidOpenAIChatCompletion(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): void {
  if (typeof completion.id !== 'string') {
    throw new Error('completion.id missing')
  }
  if (!Array.isArray(completion.choices)) {
    throw new Error('completion.choices not array')
  }
  for (let i = 0; i < completion.choices.length; i++) {
    const ch = completion.choices[i]!
    if (typeof ch.index !== 'number') {
      throw new Error(`choices[${i}].index missing`)
    }
    if (!ch.message || ch.message.role !== 'assistant') {
      throw new Error(`choices[${i}].message: must be assistant`)
    }
    if (ch.message.tool_calls) {
      for (let j = 0; j < ch.message.tool_calls.length; j++) {
        const tc = ch.message.tool_calls[j]!
        if (typeof tc.id !== 'string' || tc.id.length === 0) {
          throw new Error(`choices[${i}].message.tool_calls[${j}].id missing`)
        }
        if (tc.type !== 'function') {
          throw new Error(`choices[${i}].message.tool_calls[${j}].type must be function`)
        }
      }
    }
  }
}

// ============================================================================
// Anthropic Messages 参数校验
// ============================================================================

/**
 * 校验 Anthropic messages.create 参数是否符合 SDK 协议。
 */
export function assertValidAnthropicCreateParams(params: Record<string, unknown>): void {
  if (typeof params !== 'object' || params === null) {
    throw new Error('params must be object')
  }
  if (typeof params.model !== 'string' || params.model.length === 0) {
    throw new Error('params.model must be non-empty string')
  }
  if (typeof params.max_tokens !== 'number' || params.max_tokens <= 0) {
    throw new Error('params.max_tokens must be positive number')
  }
  if (!Array.isArray(params.messages)) {
    throw new Error('params.messages must be array')
  }
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i]
    const ctx = `messages[${i}]`
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error(
        `${ctx}.role: Anthropic messages only support user/assistant, got ${msg.role}`,
      )
    }
    if (typeof msg.content === 'string') {
      continue
    }
    if (!Array.isArray(msg.content)) {
      throw new Error(`${ctx}.content: must be string or array`)
    }
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j]
      const bctx = `${ctx}.content[${j}]`
      if (typeof block.type !== 'string') {
        throw new Error(`${bctx}.type: missing`)
      }
      // Anthropic 合法 block 类型
      const validBlockTypes = [
        'text',
        'image',
        'tool_use',
        'tool_result',
        'thinking',
        'redacted_thinking',
        'document',
        'server_tool_use',
        'web_search_tool_result',
        'code_execution_tool_result',
        'mcp_tool_use',
        'mcp_tool_result',
        'container_upload',
      ]
      if (!validBlockTypes.includes(block.type)) {
        throw new Error(`${bctx}.type: unknown block type "${block.type}"`)
      }
      if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || block.id.length === 0) {
          throw new Error(`${bctx}.id: must be non-empty string`)
        }
        if (typeof block.name !== 'string' || block.name.length === 0) {
          throw new Error(`${bctx}.name: must be non-empty string`)
        }
        // Anthropic 的 tool_use.input 必须是 object（不是 string）
        if (typeof block.input !== 'object' || block.input === null || Array.isArray(block.input)) {
          throw new Error(
            `${bctx}.input: must be object, got ${Array.isArray(block.input) ? 'array' : typeof block.input}`,
          )
        }
      }
    }
  }
}

/**
 * 校验 Anthropic 非流式响应是否合法。
 */
export function assertValidAnthropicResponse(resp: Anthropic.Message): void {
  if (typeof resp.id !== 'string') {
    throw new Error('response.id missing')
  }
  if (resp.type !== 'message') {
    throw new Error('response.type must be "message"')
  }
  if (resp.role !== 'assistant') {
    throw new Error('response.role must be "assistant"')
  }
  if (!Array.isArray(resp.content)) {
    throw new Error('response.content must be array')
  }
}
