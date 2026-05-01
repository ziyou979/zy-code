/**
 * 上下文折叠的消息变换操作。
 *
 * - collapseContext: 对完整消息列表执行折叠（较激进，用于 413 恢复）
 * - projectView: 读取时投影——将已提交的折叠 span 替换为占位消息
 */

import { randomUUID } from 'crypto'
import type { Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

/** 与 index.ts 中的 CommittedCollapse 保持一致的接口 */
interface CollapseEntry {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

/**
 * 将消息列表中已提交的折叠 span 替换为摘要占位消息。
 *
 * 对每个折叠 entry，在消息列表中定位 firstArchivedUuid 到 lastArchivedUuid 之间的 span，
 * 用一个包含摘要内容的用户消息替换。已折叠的 span 不会重复折叠（跳过之前插入的占位消息）。
 *
 * @param messages - 原始消息列表
 * @param collapseEntries - 已提交的折叠条目
 * @returns 投影后的消息列表（不修改原数组）
 */
export function projectView(
  messages: readonly Message[],
  collapseEntries: readonly CollapseEntry[],
): Message[] {
  if (collapseEntries.length === 0) return messages as Message[]

  // 收集所有需要归档的 UUID 范围
  const ranges = collapseEntries.map(e => ({
    first: e.firstArchivedUuid,
    last: e.lastArchivedUuid,
    summaryContent: e.summaryContent,
    summaryUuid: e.summaryUuid,
  }))

  const result: Message[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    // 检查当前消息是否属于某个折叠范围
    let matchedRange: (typeof ranges)[number] | null = null
    for (const range of ranges) {
      if (msg.uuid === range.first) {
        matchedRange = range
        break
      }
    }

    if (matchedRange) {
      // 跳过从 first 到 last 之间的所有消息
      while (i < messages.length && messages[i]!.uuid !== matchedRange.last) {
        i++
      }
      // 也跳过 last 消息本身
      i++

      // 插入摘要占位消息
      const placeholder: UserMessage = {
        ...createUserMessage({ content: `[Earlier context collapsed]` }),
        uuid: matchedRange.summaryUuid as any,
        message: {
          role: 'user',
          content: matchedRange.summaryContent,
        },
      } as unknown as UserMessage
      result.push(placeholder as unknown as Message)
    } else {
      result.push(msg as Message)
      i++
    }
  }

  return result
}

/**
 * 对消息列表执行折叠操作：找到最旧的可折叠 span，创建占位消息替换之。
 * 用于 413 恢复时激进折叠。
 *
 * @param messages - 原始消息列表
 * @returns 折叠后的消息列表
 */
export function collapseContext(messages: readonly Message[]): Message[] {
  if (messages.length < 10) return messages as Message[]

  // 找到至少 2 个 assistant 消息后才开始折叠
  const assistantPositions: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.type === 'assistant') {
      assistantPositions.push(i)
    }
  }

  if (assistantPositions.length < 5) return messages as Message[]

  // 保留最近 3 个 assistant 消息，折叠更早的部分
  const cutIdx = assistantPositions[assistantPositions.length - 3]!
  if (cutIdx <= 0) return messages as Message[]

  const toArchive = messages.slice(0, cutIdx)
  const keep = messages.slice(cutIdx)

  // 生成简单摘要
  const userTexts: string[] = []
  for (const m of toArchive) {
    if (m.type === 'user' && typeof m.message.content === 'string') {
      userTexts.push(m.message.content.slice(0, 100))
      if (userTexts.length >= 3) break
    }
  }

  const summaryText =
    userTexts.length > 0
      ? userTexts.join(' | ')
      : `Earlier conversation (${toArchive.length} messages)`

  const collapsedMessage: UserMessage = {
    ...createUserMessage({
      content: `[Archived ${toArchive.length} messages: ${summaryText}]`,
    }),
    uuid: randomUUID() as any,
  } as unknown as UserMessage

  return [collapsedMessage as unknown as Message, ...keep as Message[]]
}
