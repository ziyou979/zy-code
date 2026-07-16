import * as React from 'react'
import { filterToolProgressMessages, findToolByName, type Tools } from '../../tools/Tool.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { GroupedToolUseMessage } from '../../types/message.js'
import { buildMessageLookups } from '../../services/messages/./lookups.js'

type Props = {
  message: GroupedToolUseMessage
  tools: Tools
  lookups: ReturnType<typeof buildMessageLookups>
  inProgressToolUseIDs: Set<string>
  shouldAnimate: boolean
}
export function GroupedToolUseContent({
  message,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate,
}: Props): React.ReactNode {
  const tool = findToolByName(tools, message.toolName)
  if (!tool?.renderGroupedToolUse) {
    return null
  }

  // 构建从 tool_use_id 到结果数据的映射
  const resultsByToolUseId = new Map<
    string,
    {
      param: ToolResultBlock
      output: unknown
    }
  >()
  for (const resultMsg of message.results) {
    for (const content of resultMsg.message.content) {
      if (content.type === 'tool_result') {
        resultsByToolUseId.set(content.toolCallId, {
          param: content,
          output: resultMsg.toolUseResult,
        })
      }
    }
  }
  const toolUsesData = message.messages
    .map((msg) => {
      const contentBlocks = Array.isArray(msg.message.content) ? msg.message.content : []
      const content = contentBlocks[0]
      if (!content || typeof content === 'string' || content.type !== 'tool_call') {
        return null
      }
      const result = resultsByToolUseId.get(content.id)
      return {
        param: content,
        isResolved: lookups.resolvedToolUseIDs.has(content.id),
        isError: lookups.erroredToolUseIDs.has(content.id),
        isInProgress: inProgressToolUseIDs.has(content.id),
        progressMessages: filterToolProgressMessages(
          lookups.progressMessagesByToolUseID.get(content.id) ?? [],
        ),
        result,
      }
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
  const anyInProgress = toolUsesData.some((d) => d.isInProgress)
  return tool.renderGroupedToolUse(toolUsesData, {
    shouldAnimate: shouldAnimate && anyInProgress,
    tools,
  })
}
