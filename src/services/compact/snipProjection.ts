/**
 * Snip 投影 — 为显示目的将裁剪后的消息视图投影为边界标记。
 *
 * 当消息列表中存在 snip_boundary 系统消息时，将边界之前的所有
 * 消息替换为单个 "--- conversation history snipped ---" 标记消息。
 * 这为用户提供干净简洁的对话视图。
 */

import type { Message } from '../../types/message.js'

export function isSnipBoundaryMessage(message: { type: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'snip_boundary'
}

/**
 * 投影消息列表的裁剪视图：保留 snip_boundary 及之后的所有消息，
 * 移除边界之前的消息。SnipBoundaryMessage 组件负责渲染边界标记文本。
 */
export function projectSnippedView(messages: Message[]): Message[] {
  const boundaryIndex = messages.findIndex(isSnipBoundaryMessage)
  if (boundaryIndex === -1) {
    return messages
  }
  return messages.slice(boundaryIndex)
}
