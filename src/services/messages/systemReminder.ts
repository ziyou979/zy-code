// system-reminder 标签包装工具函数。
// 从 api.ts 提取，供 normalize.ts 和 attachmentApi.ts 共用。

import type { UserMessage } from '../../types/message.js'

export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

export function wrapMessagesInSystemReminder(messages: UserMessage[]): UserMessage[] {
  return messages.map((msg) => {
    const content = msg.message.content
    if (!Array.isArray(content)) {
      return msg
    }
    const wrappedContent = content.map((block) => {
      if (block.type === 'text') {
        return {
          ...block,
          text: wrapInSystemReminder(block.text),
        }
      }
      return block
    })
    return {
      ...msg,
      message: {
        ...msg.message,
        content: wrappedContent,
      },
    }
  })
}
