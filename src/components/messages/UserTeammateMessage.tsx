import * as React from 'react'
import { POINTER } from '../../constants/figures.js'
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import { Ansi, Box, Text, type TextProps } from '../../ink/index.js'
import type { TextBlock } from '../../types/llm.js'
import { toInkColor } from '../../services/environment/ink.js'
import { jsonParse } from '../../services/infra/slowOperations.js'
import { isShutdownApproved } from '../../services/swarm/teammateMailboxMessages.js'
import { MessageResponse } from '../MessageResponse.js'
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js'
import { tryRenderShutdownMessage } from './ShutdownMessage.js'
import { tryRenderTaskAssignmentMessage } from './TaskAssignmentMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlock
  isTranscriptMode?: boolean
}
type ParsedMessage = {
  teammateId: string
  content: string
  color?: string
  summary?: string
}
const TEAMMATE_MSG_REGEX = new RegExp(
  `<${TEAMMATE_MESSAGE_TAG}\\s+teammate_id="([^"]+)"(?:\\s+color="([^"]+)")?(?:\\s+summary="([^"]+)")?>\\n?([\\s\\S]*?)\\n?<\\/${TEAMMATE_MESSAGE_TAG}>`,
  'g',
)

/**
 * Parse all teammate messages from XML format:
 * <teammate-message teammate_id="alice" color="red" summary="Brief update">message content</teammate-message>
 * Supports multiple messages in a single text block.
 */
function parseTeammateMessages(text: string): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  // Use matchAll to find all matches (this is a RegExp method, not child_process)
  for (const match of text.matchAll(TEAMMATE_MSG_REGEX)) {
    if (match[1] && match[4]) {
      messages.push({
        teammateId: match[1],
        color: match[2],
        // may be undefined
        summary: match[3],
        // may be undefined
        content: match[4].trim(),
      })
    }
  }
  return messages
}
function getDisplayName(teammateId: string): string {
  if (teammateId === 'leader') {
    return 'leader'
  }
  return teammateId
}
export function UserTeammateMessage({
  addMargin,
  param: { text },
  isTranscriptMode,
}: Props): React.ReactNode {
  const messages = parseTeammateMessages(text).filter((msg) => {
    // 提前过滤 shutdown 生命周期消息，避免空 wrapper
    // Box 元素在 model 轮次之间创建空行
    if (isShutdownApproved(msg.content)) {
      return false
    }
    try {
      const parsed = jsonParse(msg.content)
      if (parsed?.type === 'teammate_terminated') {
        return false
      }
    } catch {
      // Not JSON, keep the message
    }
    return true
  })
  if (messages.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      {messages.map((msg_0, index) => {
        const inkColor = toInkColor(msg_0.color)
        const displayName = getDisplayName(msg_0.teammateId)

        // 尝试渲染为 plan approval 消息（请求或响应）
        const planApprovalElement = tryRenderPlanApprovalMessage(msg_0.content, displayName)
        if (planApprovalElement) {
          return <React.Fragment key={index}>{planApprovalElement}</React.Fragment>
        }

        // 尝试渲染为 shutdown 消息（请求或拒绝）
        const shutdownElement = tryRenderShutdownMessage(msg_0.content)
        if (shutdownElement) {
          return <React.Fragment key={index}>{shutdownElement}</React.Fragment>
        }

        // 尝试渲染为 task assignment 消息
        const taskAssignmentElement = tryRenderTaskAssignmentMessage(msg_0.content)
        if (taskAssignmentElement) {
          return <React.Fragment key={index}>{taskAssignmentElement}</React.Fragment>
        }

        // 尝试解析为结构化 JSON 消息
        let parsedIdleNotification: {
          type?: string
        } | null = null
        try {
          parsedIdleNotification = jsonParse(msg_0.content)
        } catch {
          // Not JSON
        }

        // 隐藏 idle 通知——它们会被静默处理
        if (parsedIdleNotification?.type === 'idle_notification') {
          return null
        }

        // 任务完成通知——显示哪个任务已完成
        if (parsedIdleNotification?.type === 'task_completed') {
          const taskCompleted = parsedIdleNotification as {
            type: string
            from: string
            taskId: string
            taskSubject?: string
          }
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Text color={inkColor}>{`@${displayName}${POINTER}`}</Text>
              <MessageResponse>
                <Text color="success">✓</Text>
                <Text>
                  {' '}
                  Completed task #{taskCompleted.taskId}
                  {taskCompleted.taskSubject && (
                    <Text dimColor> ({taskCompleted.taskSubject})</Text>
                  )}
                </Text>
              </MessageResponse>
            </Box>
          )
        }

        // 默认：纯文本消息（已截断）
        return (
          <TeammateMessageContent
            key={index}
            displayName={displayName}
            inkColor={inkColor}
            content={msg_0.content}
            summary={msg_0.summary}
            isTranscriptMode={isTranscriptMode}
          />
        )
      })}
    </Box>
  )
}
type TeammateMessageContentProps = {
  displayName: string
  inkColor: TextProps['color']
  content: string
  summary?: string
  isTranscriptMode?: boolean
}
export function TeammateMessageContent({
  displayName,
  inkColor,
  content,
  summary,
  isTranscriptMode,
}: TeammateMessageContentProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {
        <Box>
          {<Text color={inkColor}>{`@${displayName}${POINTER}`}</Text>}
          {summary && <Text> {summary}</Text>}
        </Box>
      }
      {isTranscriptMode && (
        <Box paddingLeft={2}>
          <Text>
            <Ansi>{content}</Ansi>
          </Text>
        </Box>
      )}
    </Box>
  )
}
