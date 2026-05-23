// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import React, { useMemo } from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type { Attachment } from 'src/utils/attachments.js'
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js'
import { useAppState } from '../../state/AppState.js'
import { getDisplayPath } from 'src/utils/file.js'
import { formatFileSize } from 'src/utils/format.js'
import { MessageResponse } from '../MessageResponse.js'
import { basename, sep } from 'node:path'
import { UserTextMessage } from './UserTextMessage.js'
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js'
import { getContentText } from 'src/utils/messages.js'
import { tSync } from '../../i18n/index.js'
import { UserImageMessage } from './UserImageMessage.js'
import { toInkColor } from '../../utils/ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  tryRenderPlanApprovalMessage,
  formatTeammateMessageContent,
} from './PlanApprovalMessage.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { TeammateMessageContent } from './UserTeammateMessage.js'
import { isShutdownApproved } from '../../utils/teammateMailbox.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { FilePathLink } from '../FilePathLink.js'
import { feature } from 'bun:bundle'
import { useSelectedMessageBg } from '../messageActions.js'
type Props = {
  addMargin: boolean
  attachment: Attachment
  verbose: boolean
  isTranscriptMode?: boolean
}
export function AttachmentMessage({
  attachment,
  addMargin,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg()
  // 提升至 mount 阶段——每条消息的组件在每个滚动周期都会重新渲染。
  const isDemoEnv = feature('EXPERIMENTAL_SKILL_SEARCH')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useMemo(() => isEnvTruthy(process.env.IS_DEMO), [])
    : false
  // 在 switch 之前处理 teammate_mailbox
  if (isAgentSwarmsEnabled() && attachment.type === 'teammate_mailbox') {
    // 在计数之前过滤掉 idle 通知——它们在 UI 中隐藏，
    // 因此在计数中显示它们会造成混淆（"mailbox 中有 2 条消息"但什么都不显示）
    const visibleMessages = attachment.messages.filter((msg) => {
      if (isShutdownApproved(msg.text)) {
        return false
      }
      try {
        const parsed = jsonParse(msg.text)
        return parsed?.type !== 'idle_notification' && parsed?.type !== 'teammate_terminated'
      } catch {
        return true // Non-JSON messages are visible
      }
    })
    if (visibleMessages.length === 0) {
      return null
    }
    return (
      <Box flexDirection="column">
        {visibleMessages.map((msg_0, idx) => {
          // 尝试解析为 JSON 以处理 task_assignment 消息
          let parsedMsg: {
            type?: string
            taskId?: string
            subject?: string
            assignedBy?: string
          } | null = null
          try {
            parsedMsg = jsonParse(msg_0.text)
          } catch {
            // Not JSON, treat as plain text
          }
          if (parsedMsg?.type === 'task_assignment') {
            return (
              <Box key={idx} paddingLeft={2}>
                <Text>{BLACK_CIRCLE} </Text>
                <Text>Task assigned: </Text>
                <Text bold>#{parsedMsg.taskId}</Text>
                <Text> - {parsedMsg.subject}</Text>
                <Text dimColor> (from {parsedMsg.assignedBy || msg_0.from})</Text>
              </Box>
            )
          }

          // 注意：idle_notification 消息已在上面过滤掉

          // 尝试渲染为 plan approval 消息（请求或响应）
          const planApprovalElement = tryRenderPlanApprovalMessage(msg_0.text, msg_0.from)
          if (planApprovalElement) {
            return <React.Fragment key={idx}>{planApprovalElement}</React.Fragment>
          }

          // 纯文本消息——发件人头部带箭头，截断的内容
          const inkColor = toInkColor(msg_0.color)
          const formattedContent = formatTeammateMessageContent(msg_0.text) ?? msg_0.text
          return (
            <TeammateMessageContent
              key={idx}
              displayName={msg_0.from}
              inkColor={inkColor}
              content={formattedContent}
              summary={msg_0.summary}
              isTranscriptMode={isTranscriptMode}
            />
          )
        })}
      </Box>
    )
  }

  // skill_discovery 在这里渲染（不在 switch 中），这样 'skill_discovery'
  // 字符串字面量保留在 feature() 保护的代码块内。case 标签不能被
  // 条件性消除；而 if 主体可以。
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    if (attachment.type === 'skill_discovery') {
      if (attachment.skills.length === 0) {
        return null
      }
      // Ant users get shortIds inline so they can /skill-feedback while the
      // turn is still fresh. External users (when this un-gates) just see
      // names — shortId is undefined outside ant builds anyway.
      const names = attachment.skills
        .map((s) => (s.shortId ? `${s.name} [${s.shortId}]` : s.name))
        .join(', ')
      const firstId = attachment.skills[0]?.shortId
      const hint =
        isInternalBuild() && !isDemoEnv && firstId
          ? ` · /skill-feedback ${firstId} 1=wrong 2=noisy 3=good [comment]`
          : ''
      return (
        <Line>
          <Text bold>{attachment.skills.length}</Text> relevant{' '}
          {plural(attachment.skills.length, 'skill')}: {names}
          {hint && <Text dimColor>{hint}</Text>}
        </Line>
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- teammate_mailbox/skill_discovery handled before switch
  switch (attachment.type) {
    case 'directory':
      return (
        <Line>
          Listed directory <Text bold>{attachment.displayPath + sep}</Text>
        </Line>
      )
    case 'file':
    case 'already_read_file':
      if (attachment.content.type === 'notebook') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> ({attachment.content.file.cells.length}{' '}
            cells)
          </Line>
        )
      }
      if (attachment.content.type === 'file_unchanged') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </Line>
        )
      }
      return (
        <Line>
          Read <Text bold>{attachment.displayPath}</Text> (
          {attachment.content.type === 'text'
            ? `${attachment.content.file.numLines}${attachment.truncated ? '+' : ''} lines`
            : formatFileSize(attachment.content.file.originalSize)}
          )
        </Line>
      )
    case 'compact_file_reference':
      return (
        <Line>
          Referenced file <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    case 'pdf_reference':
      return (
        <Line>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> ({attachment.pageCount} pages)
        </Line>
      )
    case 'selected_lines_in_ide':
      return (
        <Line>
          ⧉ Selected <Text bold>{attachment.lineEnd - attachment.lineStart + 1}</Text> lines from{' '}
          <Text bold>{attachment.displayPath}</Text> in {attachment.ideName}
        </Line>
      )
    case 'nested_memory':
      return (
        <Line>
          Loaded <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    case 'relevant_memories':
      // 通常被吸收到 CollapsedReadSearchGroup（collapseReadSearch.ts）中，
      // 因此仅在前一个工具不可折叠（Edit、Write）且没有打开组时才渲染。
      // 匹配 CollapsedReadSearchContent 的样式：
      // 2 空格缩进、dim 文本、仅计数——文件名/内容在 ctrl+o 中查看。
      return (
        <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg as any}>
          <Box flexDirection="row">
            <Box minWidth={2} />
            <Text dimColor>
              Recalled <Text bold>{attachment.memories.length}</Text>{' '}
              {attachment.memories.length === 1 ? 'memory' : 'memories'}
              {!isTranscriptMode && (
                <>
                  {' '}
                  <CtrlOToExpand />
                </>
              )}
            </Text>
          </Box>
          {(verbose || isTranscriptMode) &&
            attachment.memories.map((m) => (
              <Box key={m.path} flexDirection="column">
                <MessageResponse>
                  <Text dimColor>
                    <FilePathLink filePath={m.path}>{basename(m.path)}</FilePathLink>
                  </Text>
                </MessageResponse>
                {isTranscriptMode && (
                  <Box paddingLeft={5}>
                    <Text>
                      <Ansi>{m.content}</Ansi>
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
        </Box>
      )
    case 'dynamic_skill': {
      const skillCount = attachment.skillNames.length
      return (
        <Line>
          Loaded{' '}
          <Text bold>
            {skillCount} {plural(skillCount, 'skill')}
          </Text>{' '}
          from <Text bold>{attachment.displayPath}</Text>
        </Line>
      )
    }
    case 'skill_listing': {
      if (attachment.isInitial) {
        return null
      }
      return (
        <Line>
          <Text bold>{attachment.skillCount}</Text> {plural(attachment.skillCount, 'skill')}{' '}
          available
        </Line>
      )
    }
    case 'agent_listing_delta': {
      if (attachment.isInitial || attachment.addedTypes.length === 0) {
        return null
      }
      const count = attachment.addedTypes.length
      return (
        <Line>
          <Text bold>{count}</Text> agent {plural(count, 'type')} available
        </Line>
      )
    }
    case 'queued_command': {
      const text =
        typeof attachment.prompt === 'string'
          ? attachment.prompt
          : getContentText(attachment.prompt) || ''
      const hasImages = attachment.imagePasteIds && attachment.imagePasteIds.length > 0
      return (
        <Box flexDirection="column">
          <UserTextMessage
            addMargin={addMargin}
            param={{
              text,
              type: 'text',
            }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
          {hasImages &&
            attachment.imagePasteIds?.map((id) => <UserImageMessage key={id} imageId={id} />)}
        </Box>
      )
    }
    case 'plan_file_reference':
      return <Line>Plan file referenced ({getDisplayPath(attachment.planFilePath)})</Line>
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return null
      }
      const skillNames = attachment.skills.map((s_0) => s_0.name).join(', ')
      return <Line>Skills restored ({skillNames})</Line>
    }
    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />
    case 'mcp_resource':
      return (
        <Line>
          Read MCP resource <Text bold>{attachment.name}</Text> from {attachment.server}
        </Line>
      )
    case 'command_permissions':
      // command_permissions 的成功消息由 SkillTool 的 renderToolResultMessage 渲染，
      // 因此这里不渲染任何内容以避免重复消息。
      return null
    case 'async_hook_response': {
      // SessionStart hook 完成仅在 verbose 模式下显示
      if (attachment.hookEvent === 'SessionStart' && !verbose) {
        return null
      }
      // 通常隐藏 async hook 完成消息，除非在 verbose 模式下
      if (!verbose && !isTranscriptMode) {
        return null
      }
      return (
        <Line>
          Async hook <Text bold>{attachment.hookEvent}</Text> completed
        </Line>
      )
    }
    case 'hook_blocking_error': {
      // Stop hook 在 SystemStopHookSummaryMessage 中渲染为摘要
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      // 向用户显示 stderr 以便他们理解 hook 为什么阻止了继续执行
      const stderr = attachment.blockingError.blockingError.trim()
      return (
        <>
          <Line color="error">{attachment.hookName} hook returned blocking error</Line>
          {stderr ? <Line color="error">{stderr}</Line> : null}
        </>
      )
    }
    case 'hook_non_blocking_error': {
      // Stop hook 在 SystemStopHookSummaryMessage 中渲染为摘要
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug 日志
      return <Line color="error">{attachment.hookName} hook error</Line>
    }
    case 'hook_error_during_execution':
      // Stop hook 在 SystemStopHookSummaryMessage 中渲染为摘要
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug 日志
      return <Line>{attachment.hookName} hook warning</Line>
    case 'hook_success':
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug 日志
      return null
    case 'hook_stopped_continuation':
      // Stop hook 在 SystemStopHookSummaryMessage 中渲染为摘要
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null
      }
      return (
        <Line color="warning">
          {attachment.hookName} hook stopped continuation: {attachment.message}
        </Line>
      )
    case 'hook_system_message':
      return (
        <Line>
          {attachment.hookName} says: {attachment.content}
        </Line>
      )
    case 'hook_permission_decision': {
      const action = attachment.decision === 'allow' ? 'Allowed' : 'Denied'
      return (
        <Line>
          {action} by <Text bold>{attachment.hookEvent}</Text> hook
        </Line>
      )
    }
    case 'task_status':
      return <TaskStatusMessage attachment={attachment} />
    case 'teammate_shutdown_batch':
      return (
        <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg as any}>
          <Text dimColor>{BLACK_CIRCLE} </Text>
          <Text dimColor>
            {attachment.count} {plural(attachment.count, 'teammate')} shut down gracefully
          </Text>
        </Box>
      )
    default:
      // 穷尽性检查：到达这里的每个类型都必须在 NULL_RENDERING_TYPES 中。
      // 如果 TS 报错，说明添加了新的 Attachment 类型但没有 case 分支，也
      // 没有在此数组中添加条目——需要决定：渲染某些内容（添加 case）还是不渲染
      //（添加到数组）。Messages.tsx 预先过滤了这些，所以此分支是其他渲染路径的
      // 深度防御。
      //
      // skill_discovery 和 teammate_mailbox 在 switch 之前的
      // 运行时门控块中处理（feature() / isAgentSwarmsEnabled()），TS 无法
      // 对其进行窄化——在此处通过类型联合排除（仅编译时，无 emit）。
      ;(attachment as any).type satisfies
        | NullRenderingAttachmentType
        | 'skill_discovery'
        | 'teammate_mailbox'
      return null
  }
}
type TaskStatusAttachment = Extract<
  Attachment,
  {
    type: 'task_status'
  }
>
function TaskStatusMessage({ attachment }: any) {
  if (false && attachment.status === 'killed') {
    return null
  }
  if (isAgentSwarmsEnabled() && attachment.taskType === 'in_process_teammate') {
    return <TeammateTaskStatus attachment={attachment} />
  }
  return <GenericTaskStatus attachment={attachment} />
}
function GenericTaskStatus({ attachment }) {
  const bg = useSelectedMessageBg()
  const statusText =
    attachment.status === 'completed'
      ? tSync('attachment.completed')
      : attachment.status === 'killed'
        ? tSync('attachment.stopped')
        : attachment.status === 'running'
          ? tSync('attachment.stillRunning')
          : attachment.status
  return (
    <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg as any}>
      {<Text dimColor={true}>{BLACK_CIRCLE} </Text>}
      {
        <Text dimColor={true}>
          Task "{<Text bold={true}>{attachment.description}</Text>}" {statusText}
        </Text>
      }
    </Box>
  )
}
function TeammateTaskStatus({ attachment }) {
  const bg = useSelectedMessageBg()
  const task = useAppState((s) => s.tasks[attachment.taskId])
  if (task?.type !== 'in_process_teammate') {
    return <GenericTaskStatus attachment={attachment} />
  }
  const agentColor = toInkColor(task.identity.color)
  const statusText = attachment.status === 'completed' ? 'shut down gracefully' : attachment.status
  return (
    <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg as any}>
      {<Text dimColor={true}>{BLACK_CIRCLE} </Text>}
      {
        <Text dimColor={true}>
          Teammate{' '}
          {
            <Text color={agentColor} bold={true} dimColor={false}>
              @{task.identity.agentName}
            </Text>
          }{' '}
          {statusText}
        </Text>
      }
    </Box>
  )
}
// We allow setting dimColor to false here to help work around the dim-bold bug.
// https://github.com/chalk/chalk/issues/290
function Line({
  dimColor = true,
  children,
  color = undefined as any,
}: {
  dimColor?: boolean
  children: any
  color?: any
}) {
  const bg = useSelectedMessageBg()
  return (
    <Box backgroundColor={bg as any}>
      {
        <MessageResponse>
          <Text color={color as any} dimColor={dimColor} wrap="wrap">
            {children}
          </Text>
        </MessageResponse>
      }
    </Box>
  )
}
