import { feature } from 'bun:bundle'
import * as React from 'react'
import type { AssistantContentBlock, TextBlock, UserContentBlock } from 'src/types/llm.ts'
import type { Attachment } from 'src/services/attachments/attachments.js'
import type { Command } from '../commands.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box } from '../ink.js'
import type { Tools } from '../tool.js'
import { isConnectorTextBlock } from '../types/connectorText.js'
import type {
  AssistantMessage,
  AttachmentMessage as AttachmentMessageType,
  CollapsedReadSearchGroup as CollapsedReadSearchGroupType,
  GroupedToolUseMessage as GroupedToolUseMessageType,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { logError } from '../utils/log.js'
import { buildMessageLookups } from '../services/messages/./lookups.js'
import { CompactSummary } from './CompactSummary.js'
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { AttachmentMessage } from './messages/AttachmentMessage.js'
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js'
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js'
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js'
import { SystemTextMessage } from './messages/SystemTextMessage.js'
import { UserImageMessage } from './messages/UserImageMessage.js'
import { UserTextMessage } from './messages/UserTextMessage.js'
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js'
import { OffscreenFreeze } from './OffscreenFreeze.js'
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js'

export type Props = {
  message:
    | UserMessage
    | AssistantMessage
    | AttachmentMessageType
    | SystemMessage
    | GroupedToolUseMessageType
    | CollapsedReadSearchGroupType
  lookups: ReturnType<typeof buildMessageLookups>
  // TODO: Find a way to remove this, and leave spacing to the consumer
  /** 容器 Box 的绝对宽度。提供后，调用方可以省略包装 Box。 */
  containerWidth?: number
  addMargin: boolean
  tools: Tools
  commands: Command[]
  verbose: boolean
  inProgressToolUseIDs: Set<string>
  progressMessagesForMessage: ProgressMessage[]
  shouldAnimate: boolean
  shouldShowDot: boolean
  style?: 'condensed'
  width?: number | string
  isTranscriptMode: boolean
  isStatic: boolean
  onOpenRateLimitOptions?: () => void
  isActiveCollapsedGroup?: boolean
  isUserContinuation?: boolean
  /** 最后一个 thinking 块的 ID (uuid:index)，用于在 transcript 模式下隐藏过去的 thinking */
  lastThinkingBlockId?: string | null
  /** 最新的 user bash output 消息的 UUID（用于自动展开） */
  latestBashOutputUUID?: string | null
  /** 正在流式输出、尚未落入消息列表的 thinking 文本 */
  streamingThinkingSummary?: string
}
function MessageImpl({
  message,
  lookups,
  containerWidth,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  style,
  width,
  isTranscriptMode,
  onOpenRateLimitOptions,
  isActiveCollapsedGroup,
  isUserContinuation = false,
  lastThinkingBlockId,
  latestBashOutputUUID,
  streamingThinkingSummary,
}: Props) {
  switch (message.type) {
    case 'attachment': {
      return (
        <AttachmentMessage
          addMargin={addMargin}
          attachment={message.attachment as Attachment}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      )
    }
    case 'assistant': {
      const assistantWidth = containerWidth ?? '100%'
      const renderAssistantBlock = (block: AssistantContentBlock, index: number) => (
        <AssistantMessageBlock
          key={index}
          param={block}
          addMargin={addMargin}
          tools={tools}
          commands={commands}
          verbose={verbose}
          inProgressToolUseIDs={inProgressToolUseIDs}
          progressMessagesForMessage={progressMessagesForMessage}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
          width={width}
          inProgressToolCallCount={inProgressToolUseIDs.size}
          isTranscriptMode={isTranscriptMode}
          lookups={lookups}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
          thinkingBlockId={`${message.uuid}:${index}`}
          lastThinkingBlockId={lastThinkingBlockId}
        />
      )
      // MessageDisplay hook 的 display-only 文本覆盖：替换文本块、保留 tool_use 等非文本块。
      // 仅影响渲染，message.message.content（上下文/转录）保持原文不变。
      const assistantBlocks =
        message.displayOverride?.text !== undefined
          ? [
              { type: 'text' as const, text: message.displayOverride.text },
              ...message.message.content.filter((b) => b.type !== 'text'),
            ]
          : message.message.content
      return (
        <Box flexDirection="column" width={assistantWidth}>
          {assistantBlocks.map(renderAssistantBlock)}
        </Box>
      )
    }
    case 'user': {
      if (message.isCompactSummary) {
        const compactScreen = isTranscriptMode ? 'transcript' : 'prompt'
        return <CompactSummary message={message} screen={compactScreen} />
      }
      const imageIndices: number[] = []
      let imagePosition = 0
      for (const param of message.message.content) {
        if (param.type === 'image') {
          const id = message.imagePasteIds?.[imagePosition]
          imagePosition++
          imageIndices.push(id ?? imagePosition)
        } else {
          imageIndices.push(imagePosition)
        }
      }
      const isLatestBashOutput = latestBashOutputUUID === message.uuid
      const userWidth = containerWidth ?? '100%'
      const userContent = message.message.content.map((contentBlock, index) => (
        <UserMessageContent
          key={index}
          message={message}
          addMargin={addMargin}
          tools={tools}
          progressMessagesForMessage={progressMessagesForMessage}
          param={contentBlock}
          style={style}
          verbose={verbose}
          imageIndex={imageIndices[index] as number}
          isUserContinuation={isUserContinuation}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      ))
      const content = (
        <Box flexDirection="column" width={userWidth}>
          {userContent}
        </Box>
      )
      return isLatestBashOutput ? (
        <ExpandShellOutputProvider>{content}</ExpandShellOutputProvider>
      ) : (
        content
      )
    }
    case 'system': {
      if (message.subtype === 'compact_boundary') {
        if (isFullscreenEnvEnabled()) {
          return null
        }
        return <CompactBoundaryMessage />
      }
      if (message.subtype === 'microcompact_boundary') {
        return null
      }
      if (message.subtype === 'local_command') {
        const localCommandContent: TextBlock = {
          type: 'text',
          text: message.content,
        }
        return (
          <UserTextMessage
            addMargin={addMargin}
            param={localCommandContent}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        )
      }
      return (
        <SystemTextMessage
          message={message}
          addMargin={addMargin}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      )
    }
    case 'grouped_tool_use': {
      return (
        <GroupedToolUseContent
          message={message}
          tools={tools}
          lookups={lookups}
          inProgressToolUseIDs={inProgressToolUseIDs}
          shouldAnimate={shouldAnimate}
        />
      )
    }
    case 'collapsed_read_search': {
      const shouldShowVerbose = verbose || isTranscriptMode
      return (
        <OffscreenFreeze>
          <CollapsedReadSearchContent
            message={message}
            inProgressToolUseIDs={inProgressToolUseIDs}
            shouldAnimate={shouldAnimate}
            verbose={shouldShowVerbose}
            tools={tools}
            lookups={lookups}
            isActiveGroup={isActiveCollapsedGroup}
            streamingThinkingSummary={streamingThinkingSummary}
          />
        </OffscreenFreeze>
      )
    }
  }
}
type UserMessageContentProps = {
  message: UserMessage
  addMargin: boolean
  tools: Tools
  progressMessagesForMessage: ProgressMessage[]
  param: UserContentBlock
  style?: 'condensed'
  verbose: boolean
  imageIndex: number
  isUserContinuation: boolean
  lookups: ReturnType<typeof buildMessageLookups>
  isTranscriptMode: boolean
}
function UserMessageContent({
  message,
  addMargin,
  tools,
  progressMessagesForMessage,
  param,
  style,
  verbose,
  imageIndex,
  isUserContinuation,
  lookups,
  isTranscriptMode,
}: UserMessageContentProps) {
  const { columns } = useTerminalSize()
  switch (param.type) {
    case 'text': {
      return (
        <UserTextMessage
          addMargin={addMargin}
          param={param as TextBlock}
          verbose={verbose}
          planContent={message.planContent}
          isTranscriptMode={isTranscriptMode}
          timestamp={message.timestamp}
        />
      )
    }
    case 'image': {
      const shouldAddMargin = addMargin && !isUserContinuation
      return <UserImageMessage imageId={imageIndex as number} addMargin={shouldAddMargin} />
    }
    case 'tool_result': {
      const toolResultWidth = columns - 5
      return (
        <UserToolResultMessage
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          param={param as any}
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          message={message as any}
          lookups={lookups}
          progressMessagesForMessage={progressMessagesForMessage}
          style={style}
          tools={tools}
          verbose={verbose}
          width={toolResultWidth}
          isTranscriptMode={isTranscriptMode}
        />
      )
    }
    default: {
      return
    }
  }
}
function AssistantMessageBlock({
  param,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  width,
  inProgressToolCallCount,
  isTranscriptMode,
  lookups,
  onOpenRateLimitOptions,
  thinkingBlockId,
  lastThinkingBlockId,
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
}: any) {
  if (feature('CONNECTOR_TEXT')) {
    if (isConnectorTextBlock(param)) {
      return (
        <AssistantTextMessage
          param={{
            type: 'text',
            text: param.connectorText,
          }}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
        />
      )
    }
  }
  switch (param.type) {
    case 'tool_use':
    case 'tool_call': {
      return (
        <AssistantToolUseMessage
          param={param}
          addMargin={addMargin}
          tools={tools}
          commands={commands}
          verbose={verbose}
          inProgressToolUseIDs={inProgressToolUseIDs}
          progressMessagesForMessage={progressMessagesForMessage}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
          inProgressToolCallCount={inProgressToolCallCount}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      )
    }
    case 'text': {
      return (
        <AssistantTextMessage
          param={param}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
        />
      )
    }
    case 'redacted_thinking': {
      if (!isTranscriptMode && !verbose) {
        return null
      }
      return <AssistantRedactedThinkingMessage addMargin={addMargin} />
    }
    case 'thinking': {
      if (!isTranscriptMode && !verbose) {
        return null
      }
      const isLastThinking = !lastThinkingBlockId || thinkingBlockId === lastThinkingBlockId
      const shouldHideThinking = isTranscriptMode && !isLastThinking
      return (
        <AssistantThinkingMessage
          addMargin={addMargin}
          param={param}
          isTranscriptMode={isTranscriptMode}
          verbose={verbose}
          hideInTranscript={shouldHideThinking}
        />
      )
    }
    default: {
      logError(new Error(`Unable to render message type: ${param.type}`))
      return null
    }
  }
}
export function hasThinkingContent(m: {
  type: string
  message?: {
    content: Array<{
      type: string
    }>
  }
}): boolean {
  if (m.type !== 'assistant' || !m.message) {
    return false
  }
  return m.message.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
}

/** 导出用于测试 */
export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) {
    return false
  }
  // 仅在 lastThinkingBlockId 变更且该消息包含 thinking 内容时才重新渲染
  // 否则每次 streaming thinking 开始/停止时，scrollback 中的每条消息都会重新渲染 (CC-941)
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    hasThinkingContent(next.message as any)
  ) {
    return false
  }
  // verbose 切换会改变 thinking 块的可见性/展开状态
  if (prev.verbose !== next.verbose) {
    return false
  }
  // 仅当该消息的"是否为最新 bash output"状态发生变化时才重新渲染，
  // 而不是当全局 latestBashOutputUUID 变为其他消息时
  const prevIsLatest = prev.latestBashOutputUUID === prev.message.uuid
  const nextIsLatest = next.latestBashOutputUUID === next.message.uuid
  if (prevIsLatest !== nextIsLatest) {
    return false
  }
  if (prev.isTranscriptMode !== next.isTranscriptMode) {
    return false
  }
  // containerWidth 在无元数据路径中是一个绝对数值（跳过了包装 Box）。
  // 静态消息必须在终端缩放时重新渲染。
  if (prev.containerWidth !== next.containerWidth) {
    return false
  }
  return prev.isStatic && next.isStatic
}
export const Message = React.memo(MessageImpl, areMessagePropsEqual)
