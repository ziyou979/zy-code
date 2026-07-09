import type { ConnectorTextBlock } from '../../types/connectorText.js'
import {
  type AssistantContentBlock,
  type ContentBlock,
  LLMError,
  type StopReason,
} from '../../types/llm.js'

export type MalformedAssistantCompletionReason =
  | 'empty_visible_content'
  | 'thinking_only'
  | 'thinking_tag_only'

export type AssistantCompletionValidationResult =
  | { ok: true }
  | { ok: false; reason: MalformedAssistantCompletionReason }

type AssistantCompletionBlock = AssistantContentBlock | ContentBlock | ConnectorTextBlock

const THINKING_TAG_BLOCK_PATTERN = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi
const THINKING_TAG_PATTERN = /<\/?(think|thinking)\b[^>]*>/gi

export class MalformedAssistantCompletionError extends LLMError {
  readonly reason: MalformedAssistantCompletionReason

  constructor(reason: MalformedAssistantCompletionReason) {
    super(`Malformed assistant completion: ${reason}`, 502)
    this.name = 'MalformedAssistantCompletionError'
    this.reason = reason
  }
}

/**
 * 移除模型误写到可见文本中的思考标签本身，用于流式增量的轻量清理。
 */
export function stripThinkingTagsFromText(text: string): string {
  const startsWithClosingTag = /^<\/(think|thinking)\b[^>]*>/i.test(text)
  const cleaned = text.replace(THINKING_TAG_PATTERN, '')
  // 流式 delta 的首尾换行属于正文结构，不能按片段裁剪；否则 markdown
  // 块边界会被粘成一行。只有 provider 把 </think> 与正文放在同一
  // 片段开头时，移除标签后顺手丢弃紧随其后的分隔换行。
  return startsWithClosingTag ? cleaned.replace(/^\n+/, '') : cleaned
}

/**
 * 移除模型误写到可见文本中的完整思考标签块，用于判断是否真的存在用户可见回答。
 */
export function stripThinkingMarkupForVisibleText(text: string): string {
  return stripThinkingTagsFromText(text.replace(THINKING_TAG_BLOCK_PATTERN, '')).trim()
}

export function sanitizeAssistantCompletionContent(
  content: readonly AssistantContentBlock[],
): AssistantContentBlock[] {
  const sanitized: AssistantContentBlock[] = []

  for (const block of content) {
    if (block.type !== 'text') {
      sanitized.push(block)
      continue
    }

    const text = stripThinkingMarkupForVisibleText(block.text)
    if (text) {
      sanitized.push({ ...block, text })
    }
  }

  return sanitized
}

export function validateAssistantCompletion(args: {
  content: readonly AssistantCompletionBlock[]
  stopReason: StopReason | null | undefined
}): AssistantCompletionValidationResult {
  if (args.stopReason !== 'end_turn') {
    return { ok: true }
  }

  let hasRawText = false
  let hasVisibleText = false
  let hasThinking = false
  let hasToolCall = false

  for (const block of args.content) {
    const blockType: string = block.type
    if (blockType === 'tool_call' || blockType === 'mcp_tool_use') {
      hasToolCall = true
      continue
    }

    if (block.type === 'text') {
      if (block.text.trim()) {
        hasRawText = true
      }
      if (stripThinkingMarkupForVisibleText(block.text)) {
        hasVisibleText = true
      }
      continue
    }

    if (block.type === 'thinking' && block.thinking.trim()) {
      hasThinking = true
      continue
    }

    if (block.type === 'redacted_thinking' && block.data.trim()) {
      hasThinking = true
    }
  }

  if (hasToolCall || hasVisibleText) {
    return { ok: true }
  }

  if (hasThinking) {
    return { ok: false, reason: 'thinking_only' }
  }

  if (hasRawText) {
    return { ok: false, reason: 'thinking_tag_only' }
  }

  return { ok: false, reason: 'empty_visible_content' }
}

export function assertUsableAssistantCompletion(args: {
  content: readonly AssistantCompletionBlock[]
  stopReason: StopReason | null | undefined
}): void {
  const validation = validateAssistantCompletion(args)
  if (!validation.ok) {
    throw new MalformedAssistantCompletionError(validation.reason)
  }
}
