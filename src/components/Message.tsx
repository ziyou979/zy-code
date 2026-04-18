import { feature } from 'bun:bundle';
import * as React from 'react';
import type { Command } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box } from '../ink.js';
import type { Tools } from '../Tool.js';
import { isConnectorTextBlock } from '../types/connectorText.js';
import type { AssistantMessage, AttachmentMessage as AttachmentMessageType, CollapsedReadSearchGroup as CollapsedReadSearchGroupType, GroupedToolUseMessage as GroupedToolUseMessageType, NormalizedUserMessage, ProgressMessage, SystemMessage } from '../types/message.js';
import { isAdvisorBlock } from '../utils/advisor.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { logError } from '../utils/log.js';
import type { buildMessageLookups } from '../utils/messages.js';
import { CompactSummary } from './CompactSummary.js';
import { AdvisorMessage } from './messages/AdvisorMessage.js';
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js';
import { AssistantTextMessage } from './messages/AssistantTextMessage.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js';
import { AttachmentMessage } from './messages/AttachmentMessage.js';
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js';
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js';
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js';
import { SystemTextMessage } from './messages/SystemTextMessage.js';
import { UserImageMessage } from './messages/UserImageMessage.js';
import { UserTextMessage } from './messages/UserTextMessage.js';
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js';
export type Props = {
  message: NormalizedUserMessage | AssistantMessage | AttachmentMessageType | SystemMessage | GroupedToolUseMessageType | CollapsedReadSearchGroupType;
  lookups: ReturnType<typeof buildMessageLookups>;
  // TODO: Find a way to remove this, and leave spacing to the consumer
  /** 容器 Box 的绝对宽度。提供后，调用方可以省略包装 Box。 */
  containerWidth?: number;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  style?: 'condensed';
  width?: number | string;
  isTranscriptMode: boolean;
  isStatic: boolean;
  onOpenRateLimitOptions?: () => void;
  isActiveCollapsedGroup?: boolean;
  isUserContinuation?: boolean;
  /** 最后一个 thinking 块的 ID (uuid:index)，用于在 transcript 模式下隐藏过去的 thinking */
  lastThinkingBlockId?: string | null;
  /** 最新的 user bash output 消息的 UUID（用于自动展开） */
  latestBashOutputUUID?: string | null;
};
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
  latestBashOutputUUID
}: Props) {
  switch (message.type) {
    case "attachment":
      {
        let t2;
        t2 = <AttachmentMessage addMargin={addMargin} attachment={message.attachment as any} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
        return t2;
      }
    case "assistant":
      {
        const t2 = containerWidth ?? "100%";
        let t3;
        let t4;
        t4 = (_, index_0) => <AssistantMessageBlock key={index_0} param={_ as any} addMargin={addMargin} tools={tools} commands={commands} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={progressMessagesForMessage} shouldAnimate={shouldAnimate} shouldShowDot={shouldShowDot} width={width} inProgressToolCallCount={inProgressToolUseIDs.size as any} isTranscriptMode={isTranscriptMode} lookups={lookups} onOpenRateLimitOptions={onOpenRateLimitOptions} thinkingBlockId={`${message.uuid}:${index_0}` as any} lastThinkingBlockId={lastThinkingBlockId as any} advisorModel={(message as any).advisorModel} />;
        t3 = message.message.content.map(t4);
        let t5;
        t5 = <Box flexDirection="column" width={t2}>{t3}</Box>;
        return t5;
      }
    case "user":
      {
        if (message.isCompactSummary) {
          const t2 = isTranscriptMode ? "transcript" : "prompt";
          let t3;
          t3 = <CompactSummary message={message as any} screen={t2} />;
          return t3;
        }
        let imageIndices;
        imageIndices = [];
        let imagePosition = 0;
        for (const param of message.message.content) {
          if (param.type === "image") {
            const id = message.imagePasteIds?.[imagePosition];
            imagePosition++;
            imageIndices.push(id ?? imagePosition);
          } else {
            imageIndices.push(imagePosition);
          }
        }
        const isLatestBashOutput = latestBashOutputUUID === message.uuid;
        const t2 = containerWidth ?? "100%";
        let t3;
        t3 = message.message.content.map((param_0, index) => <UserMessage key={index} message={message as any} addMargin={addMargin} tools={tools} progressMessagesForMessage={progressMessagesForMessage} param={param_0 as any} style={style} verbose={verbose} imageIndex={imageIndices[index] as any} isUserContinuation={isUserContinuation} lookups={lookups} isTranscriptMode={isTranscriptMode} />);
        let t4;
        t4 = <Box flexDirection="column" width={t2}>{t3}</Box>;
        const content = t4;
        let t5;
        t5 = isLatestBashOutput ? <ExpandShellOutputProvider>{content}</ExpandShellOutputProvider> : content;
        return t5;
      }
    case "system":
      {
        if (message.subtype === "compact_boundary") {
          if (isFullscreenEnvEnabled()) {
            return null;
          }
          let t2;
          t2 = <CompactBoundaryMessage />;
          return t2;
        }
        if (message.subtype === "microcompact_boundary") {
          return null;
        }
        if (feature("HISTORY_SNIP")) {
          const {
            isSnipBoundaryMessage
          } = require("../services/compact/snipProjection.js") as typeof import('../services/compact/snipProjection.js');
          const {
            isSnipMarkerMessage
          } = require("../services/compact/snipCompact.js") as typeof import('../services/compact/snipCompact.js');
          if (isSnipBoundaryMessage(message)) {
            let t2;
            t2 = require("./messages/SnipBoundaryMessage.js");
            const {
              SnipBoundaryMessage
            } = t2 as typeof import('./messages/SnipBoundaryMessage.js');
            let t3;
            t3 = <SnipBoundaryMessage message={message} />;
            return t3;
          }
          if (isSnipMarkerMessage(message)) {
            return null;
          }
        }
        if (message.subtype === "local_command") {
          let t2;
          t2 = {
            type: "text",
            text: message.content
          };
          let t3;
          t3 = <UserTextMessage addMargin={addMargin} param={t2} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
          return t3;
        }
        let t2;
        t2 = <SystemTextMessage message={message} addMargin={addMargin} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
        return t2;
      }
    case "grouped_tool_use":
      {
        let t2;
        t2 = <GroupedToolUseContent message={message} tools={tools} lookups={lookups} inProgressToolUseIDs={inProgressToolUseIDs} shouldAnimate={shouldAnimate} />;
        return t2;
      }
    case "collapsed_read_search":
      {
        const t2 = verbose || isTranscriptMode;
        let t3;
        t3 = <OffscreenFreeze><CollapsedReadSearchContent message={message} inProgressToolUseIDs={inProgressToolUseIDs} shouldAnimate={shouldAnimate} verbose={t2} tools={tools} lookups={lookups} isActiveGroup={isActiveCollapsedGroup} /></OffscreenFreeze>;
        return t3;
      }
  }
}
function UserMessage({
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
  isTranscriptMode
}: any) {
  const {
    columns
  } = useTerminalSize();
  switch (param.type) {
    case "text":
      {
        let t1;
        t1 = <UserTextMessage addMargin={addMargin} param={param as any} verbose={verbose} planContent={(message as any).planContent} isTranscriptMode={isTranscriptMode} timestamp={message.timestamp} />;
        return t1;
      }
    case "image":
      {
        const t1 = addMargin && !isUserContinuation;
        let t2;
        t2 = <UserImageMessage imageId={(imageIndex as any)} addMargin={t1} />;
        return t2;
      }
    case "tool_result":
      {
        const t1 = columns - 5;
        let t2;
        t2 = <UserToolResultMessage param={param as any} message={message as any} lookups={lookups} progressMessagesForMessage={progressMessagesForMessage} style={style} tools={tools} verbose={verbose} width={t1} isTranscriptMode={isTranscriptMode} />;
        return t2;
      }
    default:
      {
        return;
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
  advisorModel
}: any) {
  if (feature("CONNECTOR_TEXT")) {
    if (isConnectorTextBlock(param)) {
      return <AssistantTextMessage param={{
        type: "text",
        text: param.connector_text
      }} addMargin={addMargin} shouldShowDot={shouldShowDot} verbose={verbose} width={width} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
    }
  }
  switch (param.type) {
    case "tool_use":
      {
        let t1;
        t1 = <AssistantToolUseMessage param={param} addMargin={addMargin} tools={tools} commands={commands} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={progressMessagesForMessage} shouldAnimate={shouldAnimate} shouldShowDot={shouldShowDot} inProgressToolCallCount={inProgressToolCallCount} lookups={lookups} isTranscriptMode={isTranscriptMode} />;
        return t1;
      }
    case "text":
      {
        let t1;
        t1 = <AssistantTextMessage param={param} addMargin={addMargin} shouldShowDot={shouldShowDot} verbose={verbose} width={width} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
        return t1;
      }
    case "redacted_thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        let t1;
        t1 = <AssistantRedactedThinkingMessage addMargin={addMargin} />;
        return t1;
      }
    case "thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        const isLastThinking = !lastThinkingBlockId || thinkingBlockId === lastThinkingBlockId;
        const t1 = isTranscriptMode && !isLastThinking;
        let t2;
        t2 = <AssistantThinkingMessage addMargin={addMargin} param={param} isTranscriptMode={isTranscriptMode} verbose={verbose} hideInTranscript={t1} />;
        return t2;
      }
    case "server_tool_use":
    case "advisor_tool_result":
      {
        if (isAdvisorBlock(param)) {
          const t1 = verbose || isTranscriptMode;
          let t2;
          t2 = <AdvisorMessage block={param} addMargin={addMargin} resolvedToolUseIDs={lookups.resolvedToolUseIDs} erroredToolUseIDs={lookups.erroredToolUseIDs} shouldAnimate={shouldAnimate} verbose={t1} advisorModel={advisorModel} />;
          return t2;
        }
        logError(new Error(`Unable to render server tool block: ${param.type}`));
        return null;
      }
    default:
      {
        logError(new Error(`Unable to render message type: ${param.type}`));
        return null;
      }
  }
}
export function hasThinkingContent(m: {
  type: string;
  message?: {
    content: Array<{
      type: string;
    }>;
  };
}): boolean {
  if (m.type !== 'assistant' || !m.message) return false;
  return m.message.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking');
}

/** 导出用于测试 */
export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false;
  // 仅在 lastThinkingBlockId 变更且该消息包含 thinking 内容时才重新渲染
  // 否则每次 streaming thinking 开始/停止时，scrollback 中的每条消息都会重新渲染 (CC-941)
  if (prev.lastThinkingBlockId !== next.lastThinkingBlockId && hasThinkingContent(next.message as any)) {
    return false;
  }
  // verbose 切换会改变 thinking 块的可见性/展开状态
  if (prev.verbose !== next.verbose) return false;
  // 仅当该消息的"是否为最新 bash output"状态发生变化时才重新渲染，
  // 而不是当全局 latestBashOutputUUID 变为其他消息时
  const prevIsLatest = prev.latestBashOutputUUID === prev.message.uuid;
  const nextIsLatest = next.latestBashOutputUUID === next.message.uuid;
  if (prevIsLatest !== nextIsLatest) return false;
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false;
  // containerWidth 在无元数据路径中是一个绝对数值（跳过了包装 Box）。
  // 静态消息必须在终端缩放时重新渲染。
  if (prev.containerWidth !== next.containerWidth) return false;
  if (prev.isStatic && next.isStatic) return true;
  return false;
}
export const Message = React.memo(MessageImpl, areMessagePropsEqual);
