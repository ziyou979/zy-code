/**
 * 压缩摘要消息选取 — 对齐 Claude Code zQn / KQn。
 *
 * 摘要 agent（尤其开启 thinking 或 fork 路径）可能产出多条 assistant：
 * - 纯思考 / CoT 草稿
 * - 真正的 <summary>…</summary> 正文
 *
 * 若仅取 getLastAssistantMessage，会把思考内容写进 post-compact 上下文，
 * 污染后续 API 调用。此处优先选取含 <summary> 标签的 assistant。
 */

import type { AssistantMessage, Message } from '../../types/message.js'
import { getAssistantMessageText } from '../messages/predicates.js'

/** 消息是否为带 text 块的、非 API 错误的 assistant */
function isTextAssistant(message: Message): message is AssistantMessage {
  if (message.type !== 'assistant' || message.isApiErrorMessage) {
    return false
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => block.type === 'text')
}

/** 消息的 text 块是否包含 <summary> 标记（大小写不敏感） */
function hasSummaryTag(message: AssistantMessage): boolean {
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => block.type === 'text' && /<summary\b/i.test(block.text))
}

/**
 * 对齐 CC `zQn`：优先最后一条含 `<summary>` 的 text assistant；
 * 否则回退到最后一条带 text 的 assistant。
 */
export function pickCompactSummaryAssistant(
  messages: readonly Message[],
): AssistantMessage | undefined {
  const withSummary = messages.findLast(
    (m): m is AssistantMessage => isTextAssistant(m) && hasSummaryTag(m),
  )
  if (withSummary) {
    return withSummary
  }
  return messages.findLast((m): m is AssistantMessage => isTextAssistant(m))
}

/**
 * 从消息列表提取压缩摘要正文。
 * 对齐 CC `KQn` 的选取语义；文本提取用 join 全部 text 块（比 CC 仅取首块更稳）。
 */
export function getCompactSummaryText(messages: readonly Message[]): string | null {
  const picked = pickCompactSummaryAssistant(messages)
  if (!picked) {
    return null
  }
  return getAssistantMessageText(picked)
}

/**
 * 在已收集的 assistant 流式消息中选取最终摘要消息。
 * 对齐 CC 流式路径：`P.isApiErrorMessage ? P : zQn(x) ?? P`
 */
export function resolveStreamedCompactAssistant(
  assistants: readonly AssistantMessage[],
): AssistantMessage | undefined {
  if (assistants.length === 0) {
    return undefined
  }
  const last = assistants[assistants.length - 1]!
  if (last.isApiErrorMessage) {
    return last
  }
  return pickCompactSummaryAssistant(assistants) ?? last
}
