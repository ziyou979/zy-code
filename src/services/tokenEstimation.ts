import { countTokensLocally } from './tokenizer/index.js'
import type { LLMMessage, ToolDefinition } from '../types/llm.js'
import { logError } from '../services/infra/log.js'
import { normalizeAttachmentForAPI } from './messages/api.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
import { getLLMAdapter } from './api/client.js'
import type { Attachment } from './attachments/attachments.js'
import { withTokenCountVCR } from './vcr.js'

export async function countTokensWithAPI(content: string): Promise<number | null> {
  // 空内容的特殊情况 — API 不接受空消息
  if (!content) {
    return 0
  }

  const message: LLMMessage = {
    role: 'user',
    content: [{ type: 'text' as const, text: content }],
  }

  return countMessagesTokensWithAPI([message], [])
}

export async function countMessagesTokensWithAPI(
  messages: LLMMessage[],
  tools: ToolDefinition[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const adapter = getLLMAdapter()
      if (adapter.countTokens) {
        return adapter.countTokens(messages, tools)
      }
      // Fallback to rough estimation if adapter doesn't support countTokens
      return null
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export function roughTokenCountEstimation(content: string, bytesPerToken: number = 4): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * 根据用户配置的自然语言返回 token 估算的 bytes-per-token 比率。
 *
 * 不同语言的 token 密度不同：
 * - 中文：每个字符约 1.5-2 个 token（UTF-8 每字符 3 字节 + BPE 粒度粗）
 * - 日文：与中文类似，约 2 个字节/token
 * - 韩文：约 2.5 字节/token
 * - 拉丁语系（英语等）：约 4 字节/token
 *
 * @param language - settings.json 中的 language 字段值
 * @returns 适合该语言的 bytesPerToken 估算值
 */
export function getBytesPerTokenForLanguage(language?: string): number {
  if (!language) {
    return 4
  }
  const lang = language.toLowerCase().trim()
  if (
    lang.includes('chinese') ||
    lang.includes('中文') ||
    lang === 'zh' ||
    lang.startsWith('zh-')
  ) {
    return 1.5
  }
  if (lang.includes('japanese') || lang.includes('日本語') || lang.startsWith('ja-')) {
    return 2
  }
  if (lang.includes('korean') || lang.includes('한국어') || lang.startsWith('ko-')) {
    return 2.5
  }
  return 4
}

/**
 * 使用本地 tokenizer 对消息列表进行 token 计数。
 * 将消息内容序列化为文本后用内置 BPE tokenizer 引擎计数。
 * 每个模型家族使用原生 tokenizer 数据，实现精确计数。
 */
export function countMessagesTokensLocally(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  model: string,
): number {
  let totalTokens = 0

  // 计算消息内容的 token 数
  for (const message of messages) {
    // 每条消息有固定的格式开销（role 标记等），约 4 token
    totalTokens += 4

    if (typeof message.content === 'string') {
      totalTokens += countTokensLocally(message.content, model)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        totalTokens += countBlockTokensLocally(block, model)
      }
    }
  }

  // 计算工具定义的 token 数
  if (tools.length > 0) {
    const toolsText = jsonStringify(tools)
    totalTokens += countTokensLocally(toolsText, model)
  }

  return totalTokens
}

/**
 * 使用本地 tokenizer 计算单个内容块的 token 数。
 */
function countBlockTokensLocally(block: unknown, model: string): number {
  if (typeof block !== 'object' || block === null) {
    return 0
  }

  const typedBlock = block as Record<string, unknown>

  if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
    return countTokensLocally(typedBlock.text, model)
  }

  if (typedBlock.type === 'tool_call') {
    const name = (typedBlock.name as string) ?? ''
    const input = jsonStringify(typedBlock.input ?? {})
    return countTokensLocally(name + input, model)
  }

  if (typedBlock.type === 'tool_result') {
    const content = typedBlock.content
    if (typeof content === 'string') {
      return countTokensLocally(content, model)
    }
    if (Array.isArray(content)) {
      let total = 0
      for (const subBlock of content) {
        total += countBlockTokensLocally(subBlock, model)
      }
      return total
    }
    return 0
  }

  if (typedBlock.type === 'thinking' && typeof typedBlock.thinking === 'string') {
    return countTokensLocally(typedBlock.thinking, model)
  }

  if (typedBlock.type === 'image' || typedBlock.type === 'document') {
    // 图片和文档使用固定估计值（与 roughTokenCountEstimationForBlock 一致）
    return 2000
  }

  // 兜底：序列化后计数
  return countTokensLocally(jsonStringify(typedBlock), model)
}

/**
 * 返回给定文件扩展名的估计字节/令牌比率。
 * 密集的 JSON 有许多单字符令牌（`{`、`}`、`:`、`,`、`"`）
 * 这使得实际比率更接近 2 而不是默认的 4。
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * 类似于 {@link roughTokenCountEstimation}，但在已知文件类型时使用更准确的
 * 字节/令牌比率。
 *
 * 这在基于 API 的令牌计数不可用时很重要（例如在
 * Bedrock 上），我们回退到粗略估计 — 低估可能会让
 * 过大的工具结果溜进对话中。
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(fileExtension))
}

/**
 * 通过 adapter 进行 token 计数。
 * 如果 adapter 不支持 countTokens，则返回 null。
 */
export async function countTokensViaHaikuFallback(
  messages: LLMMessage[],
  tools: ToolDefinition[],
): Promise<number | null> {
  try {
    const adapter = getLLMAdapter()
    if (adapter.countTokens) {
      return adapter.countTokens(messages, tools)
    }
    return null
  } catch (error) {
    logError(error)
    return null
  }
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if ((message.type === 'assistant' || message.type === 'user') && message.message?.content) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<import('../types/llm.js').ContentBlock>
        | Array<import('../types/llm.js').ContentBlock>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<import('../types/llm.js').ContentBlock>
    | Array<import('../types/llm.js').ContentBlock>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | import('../types/llm.js').ContentBlock | import('../types/llm.js').ContentBlock,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.zy.com/docs/en/build-with-zy/vision#calculate-image-costs
    // 令牌 = (宽 px * 高 px)/750
    // 图像被调整为最大 2000x2000（5333 令牌）。使用保守
    // 估计以匹配 microCompact 的 IMAGE_MAX_TOKEN_SIZE，避免
    // 低估并过晚触发自动压缩。
    //
    // document：源中的 base64 PDF。绝不能到达
    // jsonStringify 的 catch-all — 1MB PDF 约 ~1.33M base64 字符 →
    // ~325k 估计令牌，而 API 实际收取约 ~2000。
    // 与 microCompact 的 calculateToolResultTokens 相同的常量。
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_call') {
    // input 是模型生成的 JSON — 任意大小（bash
    // 命令、Edit 差异、文件内容）。字符串化一次以获取
    // 字符计数；API 无论如何都会重新序列化，所以这就是它看到的。
    return roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}))
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use、web_search_tool_result 等 —
  // 类文本有效负载（工具输入、搜索结果、无 base64）。
  // 字符串长度跟踪 API 看到的序列化形式；
  // 键/括号开销在实际块上是个位数百分比。
  return roughTokenCountEstimation(jsonStringify(block))
}
