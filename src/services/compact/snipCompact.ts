/**
 * Snip 压缩策略 — 上下文超限时的确定性裁剪
 *
 * 当 token 使用量超过上下文窗口的 80% 时，将消息按 API round 分组，
 * 保留最近约 4 个 round，其余全部裁剪。裁剪位置插入 snip_boundary
 * 系统消息标记边界。
 *
 * 这是压缩链的最后一环：autoCompact → contextCollapse → reactiveCompact
 * → snipCompact。与其他策略不同，snip 是纯确定性的（不调用 LLM）。
 */

import type { Message, SystemSnipBoundaryMessage } from '../../types/message.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getDefaultStandardModel } from '../../utils/model/model.js'
import { getEffectiveContextWindowSize } from './autoCompact.js'
import { groupMessagesByApiRound } from './grouping.js'

export const SNIP_NUDGE_TEXT = 'Context has been compacted to stay within limits.'

export type SnipResult = { snipped: boolean; content: string }

/** 当前 token 数 / 上下文窗口 >= 此阈值时触发裁剪 */
const SNIP_THRESHOLD = 0.8

/** 裁剪后保留的最小 API round 数 */
const MIN_KEEP_GROUPS = 4

export function isSnipMarkerMessage(message: { type: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'snip_marker'
}

export function isSnipRuntimeEnabled(): boolean {
  return true
}

/**
 * 创建 snip_boundary 系统消息。
 */
function createSnipBoundaryMessage(content: string): SystemSnipBoundaryMessage {
  return {
    type: 'system',
    subtype: 'snip_boundary',
    content,
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(),
  }
}

/**
 * 判断是否应提示用户使用 snip 工具压缩上下文。
 * 当 token 使用量超过 60% 阈值时触发 nudging。
 */
export function shouldNudgeForSnips(messages: Message[]): boolean {
  if (messages.length === 0) return false
  const model = getDefaultStandardModel()
  const contextWindow = getEffectiveContextWindowSize(model)
  const currentTokens = tokenCountWithEstimation(messages)
  return currentTokens / contextWindow >= 0.6
}

/**
 * 判断消息列表是否应触发裁剪。
 */
export function shouldSnip(messages: Message[]): boolean {
  if (messages.length === 0) return false
  const model = getDefaultStandardModel()
  const contextWindow = getEffectiveContextWindowSize(model)
  const currentTokens = tokenCountWithEstimation(messages)
  return currentTokens / contextWindow >= SNIP_THRESHOLD
}

/**
 * 执行消息裁剪：保留最近约 N 个 API round，裁剪更早的消息。
 * 裁剪位置插入 snip_boundary 系统消息。
 */
export function snipMessages(messages: Message[]): Message[] {
  const groups = groupMessagesByApiRound(messages)
  if (groups.length <= MIN_KEEP_GROUPS) return messages

  // 保留最近 MIN_KEEP_GROUPS 个 round
  const keepFromIndex = groups.length - MIN_KEEP_GROUPS

  // 跳过 preamble（group 0 通常是 system prompt 等）
  // preamble 应始终保留
  const preamble = groups[0] ?? []
  const hasPreamble = preamble.length > 0 && preamble[0]!.type !== 'assistant'

  let result: Message[]
  if (hasPreamble && keepFromIndex > 0) {
    // 保留 preamble + 裁剪标记 + 最近 N 个 round
    result = [
      ...preamble,
      createSnipBoundaryMessage(SNIP_NUDGE_TEXT),
      ...groups.slice(Math.max(1, keepFromIndex)).flat(),
    ]
  } else {
    result = [createSnipBoundaryMessage(SNIP_NUDGE_TEXT), ...groups.slice(keepFromIndex).flat()]
  }

  return result
}

/**
 * 主入口：检查是否需要裁剪并在需要时执行。
 * 返回裁剪后的消息、释放的 token 数以及可选的边界消息（用于 yield 到对话流）。
 */
export function snipCompactIfNeeded(
  messages: Message[],
  opts?: { force?: boolean },
): { messages: Message[]; tokensFreed: number; boundaryMessage?: Message } {
  if (messages.length === 0) {
    return { messages, tokensFreed: 0 }
  }

  const beforeTokens = tokenCountWithEstimation(messages)

  if (!opts?.force && !shouldSnip(messages)) {
    return { messages, tokensFreed: 0 }
  }

  const snipped = snipMessages(messages)
  const afterTokens = tokenCountWithEstimation(snipped)
  const tokensFreed = Math.max(0, beforeTokens - afterTokens)

  // 查找剪裁边界消息作为 boundaryMessage
  const boundaryMessage = snipped.find(
    (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'snip_boundary',
  )

  return { messages: snipped, tokensFreed, boundaryMessage }
}
