import * as React from 'react'
import type { Command } from '../commands.js'
import { Box } from '../ink.js'
import type { Screen } from '../screens/REPL.js'
import type { Tools } from '../Tool.js'
import type { RenderableMessage } from '../types/message.js'
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
    // 工具结果在折叠组仍在构建时到达
    if (msg?.type === 'user') {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      const content = (msg as any).message.content[0]
      if (content?.type === 'tool_result') {
        continue
      }
    }
    // 可折叠的 grouped_tool_use 消息在合并到下一个渲染周期的当前折叠组之前短暂出现
    if (msg?.type === 'grouped_tool_use') {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      const firstInput = (msg as any).messages[0]?.message.content[0]?.input
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      if (getToolSearchOrReadInfo((msg as any).toolName, firstInput, tools).isCollapsible) {
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
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const isGrouped = (msg as any).type === 'grouped_tool_use'
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const isCollapsed = (msg as any).type === 'collapsed_read_search'
  const isActiveCollapsedGroup =
    isCollapsed &&
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    (hasAnyToolInProgress(msg as any, inProgressToolUseIDs) || (isLoading && !hasContentAfter))
  const displayMsg = isGrouped
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    ? (msg as any).displayMessage
    : isCollapsed
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      ? getDisplayMessageFromCollapsed(msg as any)
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      : (msg as any)
  const progressMessagesForMessage =
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    isGrouped || isCollapsed ? [] : getProgressMessagesFromLookup(msg as any, lookups)
  const siblingToolUseIDs =
    isGrouped || isCollapsed
      ? EMPTY_STRING_SET
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      : getSiblingToolUseIDsFromLookup(msg as any, lookups)
  const isStatic = shouldRenderStatically(
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    msg as any,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    siblingToolUseIDs,
    screen,
    lookups,
  )
  let shouldAnimate = false
  if (canAnimate) {
    if (isGrouped) {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      shouldAnimate = (msg as any).messages.some((m: any) => {
        const content = m.message.content[0]
        return content?.type === 'tool_use' && inProgressToolUseIDs.has(content.id)
      })
    } else {
      if (isCollapsed) {
        // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
        shouldAnimate = hasAnyToolInProgress(msg as any, inProgressToolUseIDs)
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
        const toolUseID = getToolUseID(msg as any)
        shouldAnimate = !toolUseID || inProgressToolUseIDs.has(toolUseID)
      }
    }
  }
  const hasMetadata =
    isTranscriptMode &&
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    (displayMsg as any).type === 'assistant' &&
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    (displayMsg as any).message.content.some((c: any) => c.type === 'text') &&
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    ((displayMsg as any).timestamp || (displayMsg as any).message.model)
  const messageEl = (
    <Message
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      message={msg as any}
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
            {/* biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容 */}
            <MessageTimestamp message={displayMsg as any} isTranscriptMode={isTranscriptMode} />
            {/* biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容 */}
            <MessageModel message={displayMsg as any} isTranscriptMode={isTranscriptMode} />
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
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((msg as any).type === 'grouped_tool_use') {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    return (msg as any).messages.some((m: any) => {
      const content = m.message.content[0]
      return content?.type === 'tool_call' && streamingToolUseIDs.has(content.id)
    })
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((msg as any).type === 'collapsed_read_search') {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const toolIds = getToolUseIdsFromCollapsedGroup(msg as any)
    return toolIds.some((id) => streamingToolUseIDs.has(id))
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const toolUseID = getToolUseID(msg as any)
  return !!toolUseID && streamingToolUseIDs.has(toolUseID)
}

/**
 * Checks if all tools in a message are resolved.
 * Exported for testing.
 */
export function allToolsResolved(msg: RenderableMessage, resolvedToolUseIDs: Set<string>): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((msg as any).type === 'grouped_tool_use') {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    return (msg as any).messages.every((m: any) => {
      const content = m.message.content[0]
      return content?.type === 'tool_call' && resolvedToolUseIDs.has(content.id)
    })
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((msg as any).type === 'collapsed_read_search') {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const toolIds = getToolUseIdsFromCollapsedGroup(msg as any)
    return toolIds.every((id) => resolvedToolUseIDs.has(id))
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((msg as any).type === 'assistant') {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const block = (msg as any).message.content[0]
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    if ((block as any)?.type === 'server_tool_use') {
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      return resolvedToolUseIDs.has((block as any).id)
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const toolUseID = getToolUseID(msg as any)
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
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    hasThinkingContent(next.message as any)
  ) {
    return false
  }

  // 检查此消息是否仍在"传输中"
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const isStreaming = isMessageStreaming(prev.message as any, prev.streamingToolUseIDs)
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const isResolved = allToolsResolved(prev.message as any, prev.lookups.resolvedToolUseIDs)

  // 仅对真正静态的消息才跳出
  if (isStreaming || !isResolved) {
    return false
  }

  // 静态消息——可以安全跳过重新渲染
  return true
}
export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual)
