import * as React from 'react'
import type { Command } from '../commands.js'
import { Box } from '../ink.js'
import type { Screen } from '../screens/REPL.js'
import type { Tools } from '../Tool.js'
import type {
  AssistantMessage,
  CollapsedReadSearchGroup,
  GroupedToolUseMessage,
  GroupedToolUseMessageWithMessages,
  RenderableMessage,
  UserMessage,
} from '../types/message.js'
import {
  getDisplayMessageFromCollapsed,
  getToolSearchOrReadInfo,
  getToolUseIdsFromCollapsedGroup,
  hasAnyToolInProgress,
} from '../utils/collapseReadSearch.js'
import {
  type buildMessageLookups,
  EMPTY_STRING_SET,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDsFromLookup,
  getToolUseID,
} from '../utils/messages.js'
import { hasThinkingContent, Message } from './Message.js'
import { MessageModel } from './MessageModel.js'
import { shouldRenderStatically } from './Messages.js'
import { MessageTimestamp } from './MessageTimestamp.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'
export type Props = {
  message: RenderableMessage
  /** Whether the previous message in renderableMessages is also a user message. */
  isUserContinuation: boolean
  /**
   * Whether there is non-skippable content after this message in renderableMessages.
   * Only needs to be accurate for `collapsed_read_search` messages — used to decide
   * if the collapsed group spinner should stay active. Pass `false` otherwise.
   */
  hasContentAfter: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  streamingToolUseIDs: Set<string>
  screen: Screen
  canAnimate: boolean
  onOpenRateLimitOptions?: () => void
  lastThinkingBlockId: string | null
  latestBashOutputUUID: string | null
  columns: number
  isLoading: boolean
  lookups: ReturnType<typeof buildMessageLookups>
}

/**
 * Scans forward from `index+1` to check if any "real" content follows. Used to
 * decide whether a collapsed read/search group should stay in its active
 * (grey dot, present-tense "Reading…") state while the query is still loading.
 *
 * Exported so Messages.tsx can compute this once per message and pass the
 * result as a boolean prop — avoids passing the full `renderableMessages` array
 * to each MessageRow (which React Compiler would pin in the fiber's memoCache,
 * accumulating every historical version of the array ≈ 1-2MB over a 7-turn session).
 */
export function hasContentAfterIndex(
  messages: RenderableMessage[],
  index: number,
  tools: Tools,
  streamingToolUseIDs: Set<string>,
): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const content = msg.message.content[0]
      if (content && (content.type === 'thinking' || content.type === 'redacted_thinking')) {
        continue
      }
      if (content && content.type === 'tool_call') {
        if (getToolSearchOrReadInfo(content.name, content.input, tools).isCollapsible) {
          continue
        }
        // 不可折叠的工具调用出现在 syntheticStreamingToolUseMessages 中
        // 在其 ID 添加到 inProgressToolUseIDs 之前。流式处理期间跳过以避免
        // 短暂 finalize read 组。
        if (streamingToolUseIDs.has(content.id)) {
          continue
        }
      }
      return true
    }
    if (msg?.type === 'system' || msg?.type === 'attachment') {
      continue
    }
    if (msg?.type === 'user') {
      const content = (msg as UserMessage).message.content[0]
      if (content?.type === 'tool_result') {
        continue
      }
    }
    if (msg?.type === 'grouped_tool_use') {
      const grouped = msg as GroupedToolUseMessage | GroupedToolUseMessageWithMessages
      const firstBlock = grouped.messages[0]?.message.content[0]
      const firstInput = firstBlock?.type === 'tool_call' ? firstBlock.input : undefined
      if (
        getToolSearchOrReadInfo('toolName' in grouped ? grouped.toolName : '', firstInput, tools)
          .isCollapsible
      ) {
        continue
      }
    }
    return true
  }
  return false
}
function MessageRowImpl({
  message: msg,
  isUserContinuation,
  hasContentAfter,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  screen,
  canAnimate,
  onOpenRateLimitOptions,
  lastThinkingBlockId,
  latestBashOutputUUID,
  columns,
  isLoading,
  lookups,
}: Props) {
  const isTranscriptMode = screen === 'transcript'
  const isGrouped = msg.type === 'grouped_tool_use'
  const isCollapsed = msg.type === 'collapsed_read_search'
  const isActiveCollapsedGroup =
    isCollapsed &&
    (hasAnyToolInProgress(msg as CollapsedReadSearchGroup, inProgressToolUseIDs) ||
      (isLoading && !hasContentAfter))
  const displayMsg = isGrouped
    ? (msg as GroupedToolUseMessage).displayMessage
    : isCollapsed
      ? getDisplayMessageFromCollapsed(msg as CollapsedReadSearchGroup)
      : (msg as AssistantMessage)
  const progressMessagesForMessage =
    isGrouped || isCollapsed ? [] : getProgressMessagesFromLookup(msg as AssistantMessage, lookups)
  const siblingToolUseIDs =
    isGrouped || isCollapsed
      ? EMPTY_STRING_SET
      : getSiblingToolUseIDsFromLookup(msg as AssistantMessage, lookups)
  const isStatic = shouldRenderStatically(
    msg as AssistantMessage,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    siblingToolUseIDs,
    screen,
    lookups,
  )
  let shouldAnimate = false
  if (canAnimate) {
    if (isGrouped) {
      const grouped = msg as GroupedToolUseMessage
      shouldAnimate = grouped.messages.some((m) => {
        const content = m.message.content[0]
        return content?.type === 'tool_call' && inProgressToolUseIDs.has(content.id)
      })
    } else {
      if (isCollapsed) {
        shouldAnimate = hasAnyToolInProgress(msg as CollapsedReadSearchGroup, inProgressToolUseIDs)
      } else {
        const toolUseID = getToolUseID(msg as AssistantMessage)
        shouldAnimate = !toolUseID || inProgressToolUseIDs.has(toolUseID)
      }
    }
  }
  const hasMetadata =
    isTranscriptMode &&
    displayMsg.type === 'assistant' &&
    (displayMsg as AssistantMessage).message.content.some((c) => c.type === 'text') &&
    ((displayMsg as AssistantMessage).timestamp || (displayMsg as AssistantMessage).message.model)
  const messageEl = (
    <Message
      message={msg as AssistantMessage}
      lookups={lookups}
      addMargin={!hasMetadata}
      containerWidth={hasMetadata ? undefined : columns}
      tools={tools}
      commands={commands}
      verbose={verbose}
      inProgressToolUseIDs={inProgressToolUseIDs}
      progressMessagesForMessage={progressMessagesForMessage}
      shouldAnimate={shouldAnimate}
      shouldShowDot={true}
      isTranscriptMode={isTranscriptMode}
      isStatic={isStatic}
      onOpenRateLimitOptions={onOpenRateLimitOptions}
      isActiveCollapsedGroup={isActiveCollapsedGroup}
      isUserContinuation={isUserContinuation}
      lastThinkingBlockId={lastThinkingBlockId}
      latestBashOutputUUID={latestBashOutputUUID}
    />
  )
  if (!hasMetadata) {
    return <OffscreenFreeze>{messageEl}</OffscreenFreeze>
  }
  return (
    <OffscreenFreeze>
      <Box width={columns} flexDirection="column">
        {
          <Box flexDirection="row" justifyContent="flex-end" gap={1} marginTop={1}>
            <MessageTimestamp
              message={displayMsg as AssistantMessage}
              isTranscriptMode={isTranscriptMode}
            />
            <MessageModel
              message={displayMsg as AssistantMessage}
              isTranscriptMode={isTranscriptMode}
            />
          </Box>
        }
        {messageEl}
      </Box>
    </OffscreenFreeze>
  )
}

/**
 * Checks if a message is "streaming" - i.e., its content may still be changing.
 * Exported for testing.
 */

export function isMessageStreaming(
  msg: RenderableMessage,
  streamingToolUseIDs: Set<string>,
): boolean {
  if (msg.type === 'grouped_tool_use') {
    return (msg as GroupedToolUseMessage).messages.some((m) => {
      const content = m.message.content[0]
      return content?.type === 'tool_call' && streamingToolUseIDs.has(content.id)
    })
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg as CollapsedReadSearchGroup)
    return toolIds.some((id) => streamingToolUseIDs.has(id))
  }
  const toolUseID = getToolUseID(msg as AssistantMessage)
  return !!toolUseID && streamingToolUseIDs.has(toolUseID)
}

/**
 * Checks if all tools in a message are resolved.
 * Exported for testing.
 */
export function allToolsResolved(msg: RenderableMessage, resolvedToolUseIDs: Set<string>): boolean {
  if (msg.type === 'grouped_tool_use') {
    return (msg as GroupedToolUseMessage).messages.every((m) => {
      const content = m.message.content[0]
      return content?.type === 'tool_call' && resolvedToolUseIDs.has(content.id)
    })
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg as CollapsedReadSearchGroup)
    return toolIds.every((id) => resolvedToolUseIDs.has(id))
  }
  if (msg.type === 'assistant') {
    const block = (msg as AssistantMessage).message.content[0]
    if ((block as { type: string }).type === 'server_tool_use') {
      return resolvedToolUseIDs.has((block as { id: string }).id)
    }
  }
  const toolUseID = getToolUseID(msg as AssistantMessage)
  return !toolUseID || resolvedToolUseIDs.has(toolUseID)
}

/**
 * Conservative memo comparator that only bails out when we're CERTAIN
 * the message won't change. Fails safe by re-rendering when uncertain.
 *
 * Exported for testing.
 */
export function areMessageRowPropsEqual(prev: Props, next: Props): boolean {
  // 不同的消息引用 = 内容可能已更改，必须重新渲染
  if (prev.message !== next.message) {
    return false
  }

  // 屏幕模式变化 = 重新渲染
  if (prev.screen !== next.screen) {
    return false
  }

  // verbose 切换改变思考块的可见性
  if (prev.verbose !== next.verbose) {
    return false
  }

  // collapsed_read_search is never static in prompt mode (matches shouldRenderStatically)
  if (prev.message.type === 'collapsed_read_search' && next.screen !== 'transcript') {
    return false
  }

  // 宽度变化影响 Box 布局
  if (prev.columns !== next.columns) {
    return false
  }

  // latestBashOutputUUID affects rendering (full vs truncated output)
  const prevIsLatestBash = prev.latestBashOutputUUID === prev.message.uuid
  const nextIsLatestBash = next.latestBashOutputUUID === next.message.uuid
  if (prevIsLatestBash !== nextIsLatestBash) {
    return false
  }

  // lastThinkingBlockId affects thinking block visibility — but only for
  // messages that HAVE thinking content. Checking unconditionally busts the
  // memo for every scrollback message whenever thinking starts/stops (CC-941).
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    hasThinkingContent(next.message as AssistantMessage)
  ) {
    return false
  }

  const isStreaming = isMessageStreaming(prev.message, prev.streamingToolUseIDs)
  const isResolved = allToolsResolved(prev.message, prev.lookups.resolvedToolUseIDs)

  // 仅对真正静态的消息才跳出
  if (isStreaming || !isResolved) {
    return false
  }

  // 静态消息——可以安全跳过重新渲染
  return true
}
export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual)
