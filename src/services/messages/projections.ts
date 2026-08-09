/**
 * 会话消息双投影（display vs hot）。
 *
 * 磁盘 / REPL state 持有完整 transcript（含 compact 前冷历史）。
 * 下游只应通过本模块取视图，避免 UI 误裁或 API 吃到冷历史上的陈旧 usage。
 *
 * - display：UI、resume 滚动、导出给人看的历史
 * - hot：API 请求、自动压缩阈值、fork/btw 等模型上下文
 * - liveApiUsage：statusline / 上下文比例；排除 summary+keep 上压缩前 usage
 */
import type { Message } from '../../types/message.js'
import { findLastCompactBoundaryIndex, isCompactBoundaryMessage } from './predicates.js'

/**
 * UI / resume 展示用：完整消息列表（浅拷贝）。
 * 不按 compact_boundary 裁切。
 */
export function getDisplayMessages(messages: readonly Message[]): Message[] {
  return messages.slice()
}

/**
 * 热上下文：从最后一个 compact_boundary 起（含 boundary 与其后 summary/keep/新消息）。
 * 无 boundary 时返回全部。
 * 实现权威在本模块；`predicates.getMessagesAfterCompactBoundary` 仅保留同语义兼容壳。
 */
export function getHotContextMessages(messages: readonly Message[]): Message[] {
  const list = messages as Message[]
  const boundaryIndex = findLastCompactBoundaryIndex(list)
  return boundaryIndex === -1 ? list.slice() : list.slice(boundaryIndex)
}

/**
 * 在热上下文中再排除 compact summary + messagesToKeep（preservedSegment）。
 * live API usage 锚点只应来自 keep 之后的新响应。
 */
export function getLiveApiUsageMessages(messages: readonly Message[]): Message[] {
  const hot = getHotContextMessages(messages)
  if (hot.length === 0) {
    return hot
  }

  let boundaryIdx = -1
  let tailUuid: string | undefined
  for (let i = 0; i < hot.length; i++) {
    const m = hot[i]
    if (m && isCompactBoundaryMessage(m)) {
      boundaryIdx = i
      tailUuid = m.compactMetadata?.preservedSegment?.tailUuid
    }
  }
  if (boundaryIdx === -1) {
    return hot
  }

  if (tailUuid) {
    const tailIdx = hot.findIndex((m) => m.uuid === tailUuid)
    if (tailIdx !== -1) {
      return hot.slice(tailIdx + 1)
    }
  }

  let i = boundaryIdx + 1
  while (i < hot.length) {
    const m = hot[i]
    if (m?.type === 'user' && 'isCompactSummary' in m && m.isCompactSummary) {
      i++
      continue
    }
    break
  }
  return hot.slice(i)
}
