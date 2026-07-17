import { feature } from 'bun:bundle'
import * as React from 'react'
import { SentryErrorBoundary } from 'src/components/SentryErrorBoundary.js'
import { TICK } from '../../../constants/figures.js'
import { tSync } from '../../../i18n/index.js'
import { Box, Text, useTheme } from '../../../ink/index.js'
import { useAppState } from '../../../state/AppState.js'
import { filterToolProgressMessages, type Tool, type Tools } from '../../../tools/tool.js'
import type { ProgressMessage, UserMessage } from '../../../types/message.js'
import {
  deleteClassifierApproval,
  getClassifierApproval,
  getYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js'
import { buildMessageLookups } from '../../../services/messages/./lookups.js'
import { MessageResponse } from '../../MessageResponse.js'
import { HookProgressMessage } from '../HookProgressMessage.js'

type Props = {
  message: UserMessage
  lookups: ReturnType<typeof buildMessageLookups>
  toolUseID: string
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tool?: Tool
  tools: Tools
  verbose: boolean
  width: number | string
  isTranscriptMode?: boolean
}
export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode,
}: Props): React.ReactNode {
  const [theme] = useTheme()
  // Hook 保留在 feature() 三元表达式内部，这样外部构建不会为每条
  // 回滚消息承担 store 订阅开销——与 UserPromptMessage.tsx 模式相同。
  const isBriefOnly =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s) => s.isBriefOnly)
      : false

  // 在 mount 时捕获一次 classifier approval，然后从 Map 中删除以防止线性增长。
  // useState 惰性初始化器确保该值在多次 re-render 之间持久化。
  const [classifierRule] = React.useState(() => getClassifierApproval(toolUseID))
  const [yoloReason] = React.useState(() => getYoloClassifierApproval(toolUseID))
  React.useEffect(() => {
    deleteClassifierApproval(toolUseID)
  }, [toolUseID])
  if (!message.toolUseResult || !tool) {
    return null
  }

  // 恢复的转录通过 raw JSON.parse（无验证的 parseJSONL）反序列化 toolUseResult。
  // 不完整/损坏/旧格式的结果会在首次访问字段时导致渲染崩溃（anthropics/zy-code#39817）。
  // 在渲染前用 outputSchema 验证——与 CollapsedReadSearchContent 一致。
  const parsedOutput = tool.outputSchema?.safeParse(message.toolUseResult)
  if (parsedOutput && !parsedOutput.success) {
    return null
  }
  const toolResult = parsedOutput?.data ?? message.toolUseResult
  const renderedMessage =
    tool.renderToolResultMessage?.(
      toolResult as never,
      filterToolProgressMessages(progressMessagesForMessage),
      {
        style,
        theme,
        tools,
        verbose,
        isTranscriptMode,
        isBriefOnly,
        input: lookups.toolUseByToolUseID.get(toolUseID)?.input,
      },
    ) ?? null

  // 如果工具结果消息为 null，则不渲染任何内容
  if (renderedMessage === null) {
    return null
  }

  // 从 userFacingName 返回 '' 的工具选择不使用工具外框，
  // 渲染为纯 assistant 文本。跳过工具结果宽度约束，
  // 以便 MarkdownTable 的 SAFETY_MARGIN=4（针对 assistant-text 的 2 列
  // 点状沟槽调优）生效——否则表格会换行其制表符。
  const rendersAsAssistantText = tool.userFacingName(undefined) === ''
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" width={rendersAsAssistantText ? undefined : width}>
        {renderedMessage}
        {feature('BASH_CLASSIFIER')
          ? classifierRule && (
              <MessageResponse height={1}>
                <Text dimColor>
                  <Text color="success">{TICK}</Text>{' '}
                  {tSync('permission.autoApprovedMatched', { rule: classifierRule })}
                </Text>
              </MessageResponse>
            )
          : null}
        {true
          ? yoloReason && (
              <MessageResponse height={1}>
                <Text dimColor>{tSync('permission.allowedByAutoModeClassifier')}</Text>
              </MessageResponse>
            )
          : null}
      </Box>
      <SentryErrorBoundary>
        <HookProgressMessage
          hookEvent="PostToolUse"
          lookups={lookups}
          toolUseID={toolUseID}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      </SentryErrorBoundary>
    </Box>
  )
}
