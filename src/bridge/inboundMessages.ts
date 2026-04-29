import type {
  ContentBlock,
  ImageBlock,
} from '../types/llm.js'
import type { UUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'

/**
 * Process an inbound user message from the bridge, extracting content
 * and UUID for enqueueing. Supports both string content and
 * ContentBlock[] (e.g. messages containing images).
 *
 * Normalizes image blocks from bridge clients that may use camelCase
 * `mediaType` instead of snake_case `media_type` (mobile-apps#5825).
 *
 * Returns the extracted fields, or undefined if the message should be
 * skipped (non-user type, missing/empty content).
 */
export function extractInboundMessageFields(
  msg: SDKMessage,
):
  | { content: string | Array<ContentBlock>; uuid: UUID | undefined }
  | undefined {
  if (msg.type !== 'user') return undefined
  const content = (msg.message as any)?.content
  if (!content) return undefined
  if (Array.isArray(content) && content.length === 0) return undefined

  const uuid =
    'uuid' in msg && typeof msg.uuid === 'string'
      ? (msg.uuid as UUID)
      : undefined

  return {
    content: Array.isArray(content) ? normalizeImageBlocks(content) : content,
    uuid,
  }
}

/**
 * Normalize image content blocks from bridge clients.
 *
 * 兼容三种历史/客户端形态，统一转换成 v2 平铺格式 { type:'image', mimeType, data }：
 *   - v2 平铺缺 mimeType（iOS/web bridge 可能漏送）
 *   - v1 嵌套 source: { type:'base64', mediaType, data }
 *   - v1 嵌套但 mediaType 也缺失（兜底用 magic byte 探测）
 *
 * Fast-path scan returns the original array reference when no
 * normalization is needed (zero allocation on the happy path).
 */
export function normalizeImageBlocks(
  blocks: Array<ContentBlock>,
): Array<ContentBlock> {
  if (!blocks.some(needsNormalize)) return blocks

  return blocks.map(block => {
    if (!needsNormalize(block)) return block
    const b = block as ImageBlock & { source?: { mediaType?: string; data?: string } }
    const data = b.data ?? b.source?.data ?? ''
    const mediaType =
      b.mimeType ??
      b.source?.mediaType ??
      detectImageFormatFromBase64(data)
    return {
      type: 'image',
      mimeType: mediaType,
      data,
    } as ImageBlock
  })
}

function needsNormalize(block: ContentBlock): boolean {
  if (block.type !== 'image') return false
  const b = block as ImageBlock & { source?: { mediaType?: string; data?: string } }
  // 缺 mimeType / 缺 data / 还在用 v1 嵌套 source —— 都需要归一
  if (!b.mimeType || !b.data) return true
  if ('source' in b && b.source) return true
  return false
}
