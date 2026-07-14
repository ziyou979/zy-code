// 对话链构建：从 transcript JSONL 重建 user/assistant/attachment/system 链。
// 处理 compact boundary、孤立并行 tool_result 恢复、抓首条 prompt 等。

import type { UUID } from 'node:crypto'
import { logEvent } from 'src/services/analytics/index.js'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import type { TokenUsage } from '../../types/llm.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import {
  type FileHistorySnapshotMessage,
  type SerializedMessage,
  type TranscriptMessage,
} from '../../types/logs.js'
import type { Message, SystemCompactBoundaryMessage } from '../../types/message.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { logError } from '../../utils/log.js'
import { extractTag, isCompactBoundaryMessage } from '../messages/predicates.js'

const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // 存储一个合理长度的版本用于显示时截断
    // 实际截断将在显示时根据终端宽度应用
    if (result.length > 200) {
      result = `${result.slice(0, 200).trim()}…`
    }

    return result
  }

  return 'No prompt'
}

/**
 * 获取最后一条已处理的用户消息（即在任何非用户消息出现之前）。
 * 用于确定 session 是否有有效的用户交互。
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) {
      continue
    }
    // 跳过压缩摘要消息 - 它们不应被视为首条 prompt
    if ('isCompactSummary' in msg && msg.isCompactSummary) {
      continue
    }

    const content = msg.message?.content
    if (!content) {
      continue
    }

    // 收集所有文本值。content 恒为 UserContentBlock[](加载边界已归一),遍历所有
    // 文本块,以免遗漏隐藏在 <ide_selection>/<ide_opened_file> 块后面的真实 prompt。
    const texts: string[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        texts.push(block.text)
      }
    }

    for (const textContent of texts) {
      if (!textContent) {
        continue
      }

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // 如果是内置命令，它不太可能提供有意义的上下文（例如 `/model sonnet`）
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // 否则，对于自定义命令，仅在有参数时保留（例如 `/review reticulate splines`）
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          // 返回清洁格式化的命令而非原始 XML
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // 以 ! 前缀格式化 bash 输入（如用户输入的那样）。在通用 XML 跳过
      // 之前检查，使 bash 模式 session 获得有意义的标题。
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // 跳过无意义的消息（本地命令输出、hook 输出、
      // 自主 tick prompt、任务通知、纯 IDE metadata 标签）
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(transcript: TranscriptMessage[]): SerializedMessage[] {
  return transcript.map((m) => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * 压缩后将保留段重新拼接回链中。
 *
 * 保留的消息在 JSONL 中保持其原始的压缩前 parentUuid
 * （recordTranscript 去重跳过了它们 — 无法重写）。
 * 内部链（keep[i+1]→keep[i]）完整；只有端点需要修补：
 * head→anchor，以及 anchor 的其他子节点→tail。anchor 在
 * 后缀保留时是最后一个摘要，在前缀保留时是 boundary 本身。
 *
 * 只有最后一个 seg-boundary 被重新链接 — 更早的 seg 已被
 * 摘要进其中。绝对最后 boundary 之前的所有内容（preservedUuids
 * 除外）都被删除，这处理了所有多 boundary 形状而无需特殊处理。
 *
 * 原地修改 Map。
 */
export function applyPreservedSegmentRelinks(messages: Map<string, TranscriptMessage>): void {
  type Seg = NonNullable<SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']>

  // 找到绝对最后的 boundary 和最后的 seg-boundary（可能不同：
  // 响应式压缩后手动 /compact → seg 是过时的）。
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<string, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // 任何地方都没有 seg → 无操作。findUnresolvedToolUse 等读取完整 map。
  if (!lastSeg) {
    return
  }

  // seg 过时（无 seg 的 boundary 在其后出现）：跳过重新链接，仍在绝对
  // 位置裁剪 — 否则过时的保留链变成幽灵叶子。
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // 在修改之前验证 tail→head，使格式错误的 metadata 真正
  // 无操作（遍历在 headUuid 处停止，不需要先运行重新链接）。
  const preservedUuids = new Set<string>()
  if (segIsLive) {
    const walkSeen = new Set<string>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // tail→head 遍历中断 — 保留段中的某个 UUID 不在 transcript 中。
      // 此处返回会跳过下面的裁剪，因此恢复会加载完整的压缩前历史。
      // 已知原因：轮中产生的 attachment 推入 mutableMessages 但从未
      // recordTranscript（SDK 子进程在下一轮的 qe:420 flush 之前重启）。
      logEvent('zy_relink_walk_broken', {
        tailInTranscript: messages.has(lastSeg.tailUuid),
        headInTranscript: messages.has(lastSeg.headUuid),
        anchorInTranscript: messages.has(lastSeg.anchorUuid),
        walkSteps: walkSeen.size,
        transcriptSize: messages.size,
      })
      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid as UUID,
      })
    }
    // 尾部拼接：anchor 的其他子节点 → tail。如果已指向 tail
    // 则无操作（useLogMessages 竞争情况）。
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid as UUID })
      }
    }
    // 归零过时用量：磁盘上的 input_tokens 反映压缩前上下文
    // (~190K) — stripStaleUsage 只修补了被去重跳过的内存副本。
    // 没有这个，恢复 → 立即自动压缩螺旋。
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') {
        continue
      }
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          // 同时归零 snake_case 与 camelCase 拼写：disk 序列化用 snake，
          // TokenUsage 接口用 camel — stripStaleUsage 也两种都写。
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          } as unknown as TokenUsage,
        },
      })
    }
  }

  // 裁剪绝对最后 boundary 之前所有未保留的内容。
  // !segIsLive 时 preservedUuids 为空 → 完全裁剪。
  const toDelete: string[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (idx !== undefined && idx < absoluteLastBoundaryIdx && !preservedUuids.has(uuid)) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) {
    messages.delete(uuid)
  }
}

/**
 * O(n) 单次遍历：找到匹配谓词的最新时间戳的消息。
 * 替代 `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` 模式，
 * 该模式为 O(n log n) + 2n 次 Date 分配。
 */
export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) {
      continue
    }
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * 从叶子消息到根节点构建对话链
 * @param messages 所有消息的 Map
 * @param leafMessage 起始的叶子消息
 * @returns 从根到叶的消息数组
 */
export function buildConversationChain(
  messages: Map<string, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<string>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      logEvent('zy_chain_parent_cycle', {})
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid ? messages.get(currentMsg.parentUuid) : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

/**
 * buildConversationChain 的后处理：恢复单父遍历使之成为孤儿的
 * 兄弟 assistant 块和 tool_result。
 *
 * 流式传输（zy.ts:~2024）每个 content_block_stop 发出一个 AssistantMessage
 * — N 个并行 tool_use → N 条消息，不同 uuid，相同 message.id。每个
 * tool_result 的 sourceToolAssistantUUID 指向其自己的单块 assistant，
 * 因此 insertMessageChain 的覆写（约第 894 行）将每个 TR 的 parentUuid
 * 写入不同的 assistant。拓扑是 DAG；上面的遍历是链表遍历，只保留一个分支。
 *
 * 在生产中观察到的两种丢失模式（两者均在此修复）：
 *   1. 兄弟 assistant 成为孤儿：遍历走 prev→asstA→TR_A→next，丢弃 asstB
 *      （相同 message.id，从 asstA 链接）和 TR_B。
 *   2. Progress-fork（遗留，pre-#23537）：每个 tool_use asst 有一个 progress
 *      子节点（继续写入链）和一个 TR 子节点。遍历跟随
 *      progress；TR 被丢弃。不再写入（progress 已从 transcript 持久化
 *      中移除），但旧 transcript 仍有此形状。
 *
 * 读侧修复：写入拓扑已在磁盘上（对于旧 transcript）；
 * 此恢复遍历处理它们。
 */
function recoverOrphanedParallelToolResults(
  messages: Map<string, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<string>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter((m): m is ChainAssistant => m.type === 'assistant')
  if (chainAssistants.length === 0) {
    return chain
  }

  // Anchor = 每个兄弟组的最后一个链上成员。chainAssistants 已按
  // 链顺序排列，因此后面的迭代覆写 → 后者优先。
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) {
      anchorByMsgId.set(a.message.id, a)
    }
  }

  // O(n) 预计算：兄弟组和 TR 索引。
  // TR 按 parentUuid 索引 — insertMessageChain:~894 已将其写为
  // srcUUID，--fork-session 剥离 srcUUID 但保留 parentUuid。
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<string, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) {
        group.push(m)
      } else {
        siblingsByMsgId.set(m.message.id, [m])
      }
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      m.message.content.some((b) => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) {
        group.push(m)
      } else {
        toolResultsByAsst.set(m.parentUuid, [m])
      }
    }
  }

  // 对于每个触及链的 message.id 组：收集链外兄弟，
  // 然后收集所有成员的链外 TR。在最后一个链上成员之后拼接，
  // 使组对 normalizeMessagesForAPI 的合并保持连续，
  // 并且每个 TR 都落在其 tool_use 之后。
  const processedGroups = new Set<string>()
  const inserts = new Map<string, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) {
      continue
    }
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter((s) => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) {
        continue
      }
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) {
          orphanedTRs.push(tr)
        }
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) {
      continue
    }

    // 时间戳排序保持 content-block / completion 顺序；
    // 稳定排序在相同时保留 JSONL 写入顺序。
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) {
      seen.add(r.uuid)
    }
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) {
    return chain
  }
  logEvent('zy_chain_parallel_tr_recovered', {
    recovered_count: recoveredCount,
  })

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) {
      result.push(...toInsert)
    }
  }
  return result
}

/**
 * 在重建的链中找到最新的 turn_duration 检查点，并将其记录的
 * messageCount 与该点的链位置进行比较。发出 zy_resume_consistency_delta
 * 用于 BigQuery 监控写入→加载往返漂移 — 即 compact/并行-TR
 * 操作修改内存但磁盘上的 parentUuid 遍历重建了不同集合的
 * bug 类别（adamr-20260320-165831: 显示 397K → 恢复时实际 1.65M）。
 *
 * delta > 0: 恢复加载了比 session 内更多（常见失败模式）
 * delta < 0: 恢复加载了更少（链截断 — #22453 类别）
 * delta = 0: 往返一致
 *
 * 从 loadConversationForResume 调用 — 每次恢复触发一次，不在
 * /share 或日志列表链重建时触发。
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') {
      continue
    }
    const expected = m.messageCount
    if (expected === undefined) {
      return
    }
    // `i` 是检查点在重建链中的 0 基索引。
    // 检查点在 messageCount 条消息之后追加，因此它自己的
    // 位置应为 messageCount（即 i === expected）。
    const actual = i
    logEvent('zy_resume_consistency_delta', {
      expected,
      actual,
      delta: actual - expected,
      chain_length: chain.length,
      checkpoint_age_entries: chain.length - 1 - i,
    })
    return
  }
}

/**
 * 从对话中构建文件历史快照链
 */
export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<string, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → snapshots[] 中的最后索引，用于 O(1) 更新查找
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate ? indexByMessageId.get(snapshot.messageId) : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * 从对话中构建归因快照链。
 * 与文件历史快照不同，归因快照完整返回，因为它们使用
 * 生成的 UUID（非消息 UUID）并表示应在 session 恢复时还原的累积状态。
 */
export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<string, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // 返回所有归因快照 - 它们将在恢复时合并
  return Array.from(attributionSnapshots.values())
}

/**
 * 检查用户消息是否有可见内容（文本或图片，不仅是 tool_result）。
 * 工具结果作为折叠组的一部分显示，而非独立消息。
 * 也排除不向用户显示的 meta 消息。
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') {
    return false
  }

  // meta 消息不向用户显示
  if (message.isMeta) {
    return false
  }

  const content = message.message?.content
  if (!content) {
    return false
  }

  // 文本或图片块（非 tool_result）才算可见
  return content.some(
    (block) => block.type === 'text' || block.type === 'image' || block.type === 'document',
  )
}

/**
 * 检查 assistant 消息是否有可见的文本内容（不仅是 tool_use 块）。
 * 工具使用作为分组/折叠的 UI 元素显示，而非独立消息。
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') {
    return false
  }

  const content = message.message?.content
  if (!content) {
    return false
  }

  // 检查文本块（不仅是 tool_use/thinking 块）
  return content.some(
    (block) =>
      block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/**
 * 计算在 UI 中显示为对话轮次的可见消息数。
 * 排除：
 * - system、attachment 和 progress 消息
 * - 带有 isMeta 标志的用户消息（对用户隐藏）
 * - 仅包含 tool_result 块的用户消息（作为折叠组显示）
 * - 仅包含 tool_use 块的 assistant 消息（作为折叠组显示）
 */
export function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // 计算具有可见内容的用户消息（文本、图片，不仅是 tool_result 或 meta）
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // 计算具有文本内容的 assistant 消息（不仅是 tool_use）
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // 这些消息类型不计为可见的对话轮次
        break
    }
  }
  return count
}
