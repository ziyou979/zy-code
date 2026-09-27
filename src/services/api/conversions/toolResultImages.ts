import type { ImageBlock, LLMMessage, LLMUserMessage, TextBlock } from '../../../types/llm.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    isRecord(value) &&
    value.type === 'image' &&
    typeof value.mimeType === 'string' &&
    typeof value.data === 'string'
  )
}

/**
 * Chat 的 tool 消息和当前 Responses SDK 的工具输出只接受文本。
 * 将工具图片转为后续 user 视觉输入；连续工具结果全部输出后再附图，
 * 避免打断并行 tool_calls 的结果配对。保留调用 ID，让多张图片仍可追溯来源。
 */
export function hoistToolResultImages<T extends LLMMessage | Record<string, unknown>>(
  messages: T[],
): Array<T | LLMUserMessage> {
  const result: Array<T | LLMUserMessage> = []
  let attachments: Array<TextBlock | ImageBlock> = []
  const flush = () => {
    if (attachments.length > 0) {
      result.push({ role: 'user', content: attachments })
      attachments = []
    }
  }

  for (const message of messages) {
    const content: unknown[] = Array.isArray(message.content) ? message.content : []
    const hasToolResults =
      message.role === 'user' &&
      content.some((block) => isRecord(block) && block.type === 'tool_result')
    if (!hasToolResults) {
      if (message.role !== 'tool') {
        flush()
      }
      result.push(message)
      continue
    }

    let changed = false
    const nextContent = content.map((block) => {
      if (!isRecord(block) || block.type !== 'tool_result' || !Array.isArray(block.content)) {
        return block
      }
      const images = block.content.filter(isImageBlock)
      if (images.length === 0) {
        return block
      }
      changed = true
      const label = `Images from tool result ${String(block.toolCallId ?? '')}:`
      attachments.push({ type: 'text', text: label }, ...images)
      return {
        ...block,
        content: [
          ...block.content.filter((part) => !isImageBlock(part)),
          {
            type: 'text',
            text: 'The images from this tool result are attached in the following user message.',
          },
        ],
      }
    })
    // 仅重写图片所在的消息；历史记录和缓存元数据均保持不变。
    result.push(changed ? { ...message, content: nextContent } : message)
  }
  flush()
  return result
}
