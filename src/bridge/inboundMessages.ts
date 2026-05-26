import type { UUID } from 'node:crypto'
import type { BridgeMessage } from '../types/index.js'
import type { UserContentBlock } from '../types/llm.js'

/**
 * 从 bridge 入站的 user 消息中提取 content 与 uuid 用于 enqueue。
 * 支持字符串 content 和 UserContentBlock[]（含图片等多模态）。
 *
 * 入参假定遵循标准类型（src/types/llm.ts），ImageBlock 必须是平铺
 * { type:'image', mimeType, data } 格式。
 *
 * 返回 undefined 表示应跳过该消息（非 user 类型、content 缺失或为空）。
 */
export function extractInboundMessageFields(
  msg: BridgeMessage,
): { content: string | Array<UserContentBlock>; uuid: UUID | undefined } | undefined {
  if (msg.type !== 'user') {
    return undefined
  }
  const content = (msg.message as any)?.content
  if (!content) {
    return undefined
  }
  if (Array.isArray(content) && content.length === 0) {
    return undefined
  }

  const uuid = 'uuid' in msg && typeof msg.uuid === 'string' ? (msg.uuid as UUID) : undefined

  return { content, uuid }
}
