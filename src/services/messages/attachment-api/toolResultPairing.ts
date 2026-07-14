import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getStrictToolResultPairing } from 'src/bootstrap/runtime/runtimeContext.js'
import { getNoContentMessage } from '../../../constants/messages.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import type {
  ContentBlock,
  ToolCallBlock,
  ToolResultBlock,
  UserContentBlock,
} from '../../../types/llm.js'
import type { AssistantMessage, UserMessage } from '../../../types/message.js'
import { logError } from '../../../utils/log.js'
import { smooshSystemReminderSiblings } from '../apiNormalize.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from '../constants.js'
import { createUserMessage } from '../constructors.js'

/**
 * 防御性验证：确保 tool_use/tool_result 配对正确。
 *
 * 处理两个方向：
 * - 正向：为缺少 result 的 tool_use 块插入合成错误 tool_result 块
 * - 反向：剥离引用不存在的 tool_use 块的孤立 tool_result 块
 *
 * 激活时记录日志以帮助识别根本原因。
 *
 * 严格模式：当 getStrictToolResultPairing() 为 true 时（HFI 在启动时启用），
 * 任何不匹配都会抛出异常而非修复。对于训练数据收集，基于合成占位符
 * 条件化的模型响应是受污染的——让轨迹失败而不是浪费标注者时间在
 * 提交时无论如何都会被拒绝的轮次上。
 */
export function ensureToolResultPairing(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  let repaired = false

  // 跨消息 tool_use ID 追踪。下方每条消息的 seenToolUseIds 仅捕获单个 assistant
  // 内容数组内的重复（normalizeMessagesForAPI 合并的情况）。当两个具有不同
  // message.id 的 assistant 携带相同的 tool_use ID 时 — 例如 orphan handler 重新推送
  // 已存在于 mutableMessages 中但带有新 message.id 的 assistant，或
  // normalizeMessagesForAPI 的向后遍历被 intervening user 消息打断 — 该重复会
  // 存在于不同的 result 条目中，API 会以 "tool_use ids must be unique" 拒绝，
  // 导致会话死锁（CC-1212）。
  const allSeenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.type !== 'assistant') {
      // 输出中带有 tool_result 但没有前置 assistant 消息的 user 消息具有孤立的 tool_result。
      // 下方的 assistant 前瞻仅验证 assistant→user 相邻；它永远不会看到索引 0 的 user 消息
      // 或在另一个 user 之前的 user 消息。这在恢复时发生，当 transcript 在轮次中间开始
      //（例如 messages[0] 是一个 tool_result，其 assistant 配对被之前的 compact 丢弃
      // — API 会以 "messages.0.content: unexpected tool_use_id" 拒绝）。
      if (
        msg.type === 'user' &&
        Array.isArray(msg.message.content) &&
        result.at(-1)?.type !== 'assistant'
      ) {
        const stripped = msg.message.content.filter(
          (block) =>
            !(typeof block === 'object' && 'type' in block && block.type === 'tool_result'),
        )
        if (stripped.length !== msg.message.content.length) {
          repaired = true
          // 如果剥离后消息为空且尚未推送任何内容，保留占位符使 payload 仍以 user
          // 消息开头（normalizeMessagesForAPI 在我们之前运行，所以 messages[1]
          // 是 assistant — 完全丢弃 messages[0] 会导致 payload 以 assistant 开头，
          // 这是另一种 400）。
          const content =
            stripped.length > 0
              ? stripped
              : result.length === 0
                ? [
                    {
                      type: 'text' as const,
                      text: '[Orphaned tool result removed due to conversation resume]',
                    },
                  ]
                : null
          if (content !== null) {
            result.push({
              ...msg,
              message: { ...msg.message, content },
            })
          }
          continue
        }
      }
      result.push(msg)
      continue
    }

    // 收集服务端 tool result ID（*_tool_result 块包含 toolCallId）。
    const serverResultIds = new Set<string>()
    if (Array.isArray(msg.message.content)) {
      for (const c of msg.message.content) {
        if ('toolCallId' in c && typeof c.toolCallId === 'string') {
          serverResultIds.add(c.toolCallId)
        }
      }
    }

    // 按 ID 去重 tool_use 块。对照跨消息的 allSeenToolUseIds Set 检查，
    // 因此后续 assistant（不同 message.id，未被 normalizeMessagesForAPI 合并）
    // 中的重复也会被剥离。每条消息的 seenToolUseIds 仅追踪此 assistant 的存活 ID
    // — 下方的 orphan/missing-result 检测需要每条消息的视图，而非累积视图。
    //
    // 同时剥离孤立的服务端 tool use 块（mcp_tool_use），
    // 其 result 块位于同一 assistant 消息中。如果流在 result 到达前中断，
    // use 块没有匹配的 *_tool_result，API 会拒绝。
    const seenToolUseIds = new Set<string>()
    const finalContent = Array.isArray(msg.message.content)
      ? msg.message.content.filter((block) => {
          if (block.type === 'tool_call') {
            if (allSeenToolUseIds.has(block.id)) {
              repaired = true
              return false
            }
            allSeenToolUseIds.add(block.id)
            seenToolUseIds.add(block.id)
          }
          if (
            (block.type as string) === 'mcp_tool_use' &&
            !serverResultIds.has((block as { id: string }).id)
          ) {
            repaired = true
            return false
          }
          return true
        })
      : msg.message.content

    const assistantContentChanged = finalContent.length !== msg.message.content.length

    // 如果剥离孤立服务端 tool use 后内容数组为空，插入占位符使 API 不拒绝空 assistant 内容。
    if (Array.isArray(finalContent) && finalContent.length === 0) {
      finalContent.push({
        type: 'text' as const,
        text: '[Tool use interrupted]',
      })
    }

    const assistantMsg = assistantContentChanged
      ? {
          ...msg,
          message: { ...msg.message, content: finalContent },
        }
      : msg

    result.push(assistantMsg)

    // 从此 assistant 消息收集 tool_use ID
    const toolUseIds = [...seenToolUseIds]

    // 检查下一条消息是否有匹配的 tool_result。同时追踪重复的 tool_result 块
    //（相同 tool_use_id 出现两次） — 对于在 Fix 1 之前损坏的 transcript，
    // orphan handler 会完整运行多次，产生 [asst(X), user(tr_X), asst(X), user(tr_X)]，
    // normalizeMessagesForAPI 合并为 [asst([X,X]), user([tr_X,tr_X])]。
    // 上方的 tool_use 去重会剥离第二个 X；如果不同时剥离第二个 tr_X，
    // API 会以 duplicate-tool_result 400 拒绝，会话持续卡住。
    const nextMsg = messages[i + 1]
    const existingToolResultIds = new Set<string>()
    let hasDuplicateToolResults = false

    if (nextMsg?.type === 'user') {
      const content = nextMsg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
            const trId = (block as ToolResultBlock).toolCallId
            if (existingToolResultIds.has(trId)) {
              hasDuplicateToolResults = true
            }
            existingToolResultIds.add(trId)
          }
        }
      }
    }

    // 查找缺失的 tool_result ID（正向：有 tool_use 无 tool_result）
    const toolUseIdSet = new Set(toolUseIds)
    const missingIds = toolUseIds.filter((id) => !existingToolResultIds.has(id))

    // 查找孤立的 tool_result ID（反向：有 tool_result 无 tool_use）
    const orphanedIds = [...existingToolResultIds].filter((id) => !toolUseIdSet.has(id))

    if (missingIds.length === 0 && orphanedIds.length === 0 && !hasDuplicateToolResults) {
      continue
    }

    repaired = true

    // 为缺失 ID 构建合成错误 tool_result 块
    const syntheticBlocks: ToolResultBlock[] = missingIds.map((id) => ({
      type: 'tool_result' as const,
      toolCallId: id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      isError: true,
    }))

    if (nextMsg?.type === 'user') {
      // 下一条消息已经是 user 消息 — 修补它
      let content: (ContentBlock | ContentBlock)[] = Array.isArray(nextMsg.message.content)
        ? nextMsg.message.content
        : [{ type: 'text' as const, text: nextMsg.message.content }]

      // 剥离孤立 tool_result 并去重重复的 tool_result ID
      if (orphanedIds.length > 0 || hasDuplicateToolResults) {
        const orphanedSet = new Set(orphanedIds)
        const seenTrIds = new Set<string>()
        content = content.filter((block) => {
          if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
            const trId = (block as ToolResultBlock).toolCallId
            if (orphanedSet.has(trId)) {
              return false
            }
            if (seenTrIds.has(trId)) {
              return false
            }
            seenTrIds.add(trId)
          }
          return true
        })
      }

      const patchedContent = [...syntheticBlocks, ...content]

      // 如果剥离孤立后内容为空，跳过该 user 消息
      if (patchedContent.length > 0) {
        const patchedNext: UserMessage = {
          ...nextMsg,
          message: {
            ...nextMsg.message,
            content: patchedContent as UserContentBlock[],
          },
        }
        i++
        // 将合成块前置到现有内容可能产生 [tool_result, text] 兄弟节点，
        // normalize 内的 smoosh 从未处理过（配对在 normalize 之后运行）。
        // 对此单条消息重新 smoosh。
        result.push(
          checkStatsigFeatureGate_CACHED_MAY_BE_STALE('zy_sysreminder_smoosh')
            ? smooshSystemReminderSiblings([patchedNext])[0]!
            : patchedNext,
        )
      } else {
        // 剥离孤立 tool_result 后内容为空。我们仍需要此处有一个 user 消息来维持角色交替
        // — 否则刚推送的 assistant 占位符会紧跟下一条 assistant 消息，
        // API 会以角色交替 400 拒绝（而非我们处理的重复 ID 400）。
        i++
        result.push(
          createUserMessage({
            content: [{ type: 'text' as const, text: getNoContentMessage() }],
            isMeta: true,
          }),
        )
      }
    } else {
      // 没有后续 user 消息 — 插入合成 user 消息（仅在有缺失 ID 时）
      if (syntheticBlocks.length > 0) {
        result.push(
          createUserMessage({
            content: syntheticBlocks,
            isMeta: true,
          }),
        )
      }
    }
  }

  if (repaired) {
    // 捕获诊断信息以帮助识别根本原因
    const messageTypes = messages.map((m, idx) => {
      if (m.type === 'assistant') {
        const content = m.message.content
        const toolUses = Array.isArray(content)
          ? content
              .filter((b) => b.type === 'tool_call')
              .map((b) => (b as ToolCallBlock | ToolCallBlock).id)
          : []
        const mcpToolUses = Array.isArray(content)
          ? content
              .filter((b) => (b.type as string) === 'mcp_tool_use')
              .map((b) => (b as { id: string }).id)
          : []
        const parts = [`id=${m.message.id}`, `tool_uses=[${toolUses.join(',')}]`]
        if (mcpToolUses.length > 0) {
          parts.push(`mcp_tool_uses=[${mcpToolUses.join(',')}]`)
        }
        return `[${idx}] assistant(${parts.join(', ')})`
      }
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        const toolResults = m.message.content
          .filter((b) => typeof b === 'object' && 'type' in b && b.type === 'tool_result')
          .map((b) => (b as ToolResultBlock).toolCallId)
        if (toolResults.length > 0) {
          return `[${idx}] user(tool_results=[${toolResults.join(',')}])`
        }
      }
      return `[${idx}] ${m.type}`
    })

    if (getStrictToolResultPairing()) {
      throw new Error(
        `ensureToolResultPairing: tool_use/tool_result pairing mismatch detected (strict mode). ` +
          `Refusing to repair — would inject synthetic placeholders into model context. ` +
          `Message structure: ${messageTypes.join('; ')}. See inc-4977.`,
      )
    }

    logEvent('zy_tool_result_pairing_repaired', {
      messageCount: messages.length,
      repairedMessageCount: result.length,
      messageTypes: messageTypes.join(
        '; ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logError(
      new Error(
        `ensureToolResultPairing: repaired missing tool_result blocks (${messages.length} -> ${result.length} messages). Message structure: ${messageTypes.join('; ')}`,
      ),
    )
  }

  return result
}
