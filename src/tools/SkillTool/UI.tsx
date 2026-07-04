import * as React from 'react'
import { SubAgentProvider } from 'src/components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from 'src/components/FallbackToolUseRejectedMessage.js'
import type { z } from 'zod/v4'
import type { Command } from '../../commands.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import type { ToolResultBlock } from '../../types/llm.js'
import type { AssistantMessage, ProgressMessage, UserMessage } from '../../types/message.js'
import { buildSubagentLookups, EMPTY_LOOKUPS } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import type { inputSchema, Output, Progress } from './SkillTool.js'

type Input = z.infer<ReturnType<typeof inputSchema>>
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3
export function renderToolResultMessage(output: Output): React.ReactNode {
  // 处理分叉的技能结果
  if ('status' in output && output.status === 'forked') {
    return (
      <MessageResponse height={1}>
        <Text>
          <Byline>{[tSync('skill.done')]}</Byline>
        </Text>
      </MessageResponse>
    )
  }
  const parts: string[] = [tSync('skill.successfullyLoaded')]

  // 显示工具数量（仅适用于内联技能）
  if ('allowedTools' in output && output.allowedTools && output.allowedTools.length > 0) {
    const count = output.allowedTools.length
    const unitKey = count === 1 ? 'skill.toolAllowed_one' : 'skill.toolAllowed_other'
    parts.push(tSync('skill.toolAllowed', { count, unit: tSync(unitKey) }))
  }

  // 如果非默认则显示模型（仅适用于内联技能）
  if ('model' in output && output.model) {
    parts.push(output.model)
  }
  return (
    <MessageResponse height={1}>
      <Text>
        <Byline>{parts}</Byline>
      </Text>
    </MessageResponse>
  )
}
export function renderToolUseMessage(
  { skill }: Partial<Input>,
  {
    commands,
  }: {
    commands?: Command[]
  },
): React.ReactNode {
  if (!skill) {
    return null
  }
  // 查找命令以检查它是否来自旧的 /commands 文件夹
  const command = commands?.find((c) => c.name === skill)
  const displayName = command?.loadedFrom === 'commands_DEPRECATED' ? `/${skill}` : skill
  return displayName
}
export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<Progress>[],
  {
    tools,
    verbose,
  }: {
    tools: Tools
    verbose: boolean
  },
): React.ReactNode {
  if (!progressMessages.length) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{tSync('skill.initializing')}</Text>
      </MessageResponse>
    )
  }

  // 在非详细模式下仅取最后几条消息用于显示
  const displayedMessages = verbose
    ? progressMessages
    : progressMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)
  const hiddenCount = progressMessages.length - displayedMessages.length
  const { inProgressToolUseIDs } = buildSubagentLookups(
    progressMessages.map((pm) => pm.data) as { message: AssistantMessage | UserMessage }[],
  )
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {displayedMessages.map((progressMessage: ProgressMessage<Progress>) => (
            <Box key={progressMessage.uuid} height={1} overflow="hidden">
              <MessageComponent
                message={progressMessage.data.message as AssistantMessage | UserMessage}
                lookups={EMPTY_LOOKUPS}
                addMargin={false}
                tools={tools}
                commands={[]}
                verbose={verbose}
                inProgressToolUseIDs={inProgressToolUseIDs}
                progressMessagesForMessage={[]}
                shouldAnimate={false}
                shouldShowDot={false}
                style="condensed"
                isTranscriptMode={false}
                isStatic={true}
              />
            </Box>
          ))}
        </SubAgentProvider>
        {hiddenCount > 0 && (
          <Text dimColor>
            {tSync('skill.moreToolUse', {
              count: hiddenCount,
              unit: tSync(hiddenCount === 1 ? 'skill.moreToolUse_one' : 'skill.moreToolUse_other'),
            })}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}
export function renderToolUseRejectedMessage(
  _input: Input,
  {
    progressMessagesForMessage,
    tools,
    verbose,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
  },
): React.ReactNode {
  return (
    <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
      })}
      <FallbackToolUseRejectedMessage />
    </>
  )
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  {
    progressMessagesForMessage,
    tools,
    verbose,
  }: {
    progressMessagesForMessage: ProgressMessage<Progress>[]
    tools: Tools
    verbose: boolean
  },
): React.ReactNode {
  return (
    <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
        tools,
        verbose,
      })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>
  )
}
