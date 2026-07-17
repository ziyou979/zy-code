import { basename } from 'node:path'
import * as React from 'react'
import { tSync } from 'src/i18n/index.js'
import type { DiffStats } from 'src/services/file-persistence/fileHistory.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { COMMAND_MESSAGE_TAG } from '../constants/xml.js'
import { Box, Text } from '../ink/index.js'
import type { ContentBlock, TextBlock } from '../types/llm.js'
import type { UserMessage } from '../types/message.js'
import { stripDisplayTags } from '../utils/xmlTagUtils.js'
import { extractTag, isEmptyMessageText } from '../services/messages/./predicates.js'
import { truncate } from '../utils/format.js'
import type { RestoreOption } from './messageSelectorUtils.js'
import { isSummarizeOption } from './messageSelectorUtils.js'

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

function getRestoreOptionConversationText(option: RestoreOption): string {
  switch (option) {
    case 'summarize':
      return tSync('messageSelector.messagesAfterSummarized')
    case 'summarize_up_to':
      return tSync('messageSelector.precedingMessagesSummarized')
    case 'both':
    case 'conversation':
      return tSync('messageSelector.conversationWillBeForked')
    case 'code':
    case 'nevermind':
      return tSync('messageSelector.conversationUnchanged')
  }
}

export function DiffStatsText({ diffStats }: { diffStats: DiffStats | undefined }) {
  if (!diffStats?.filesChanged) {
    return null
  }
  return (
    <>
      <Text color="diffAddedWord">+{diffStats.insertions} </Text>
      <Text color="diffRemovedWord">-{diffStats.deletions}</Text>
    </>
  )
}

function RestoreCodeConfirmation({ diffStatsForRestore }: { diffStatsForRestore?: DiffStats }) {
  if (diffStatsForRestore === undefined) {
    return null
  }
  if (!diffStatsForRestore.filesChanged?.[0]) {
    return <Text dimColor>{tSync('messageSelector.codeNotChanged')}</Text>
  }
  const numFilesChanged = diffStatsForRestore.filesChanged.length
  let fileLabel: string
  if (numFilesChanged === 1) {
    fileLabel = basename(diffStatsForRestore.filesChanged[0] || '')
  } else if (numFilesChanged === 2) {
    const file1 = basename(diffStatsForRestore.filesChanged[0] || '')
    const file2 = basename(diffStatsForRestore.filesChanged[1] || '')
    fileLabel = `${file1} and ${file2}`
  } else {
    const file1 = basename(diffStatsForRestore.filesChanged[0] || '')
    fileLabel = tSync('messageSelector.fileAndOtherFiles', {
      file1,
      count: diffStatsForRestore.filesChanged.length - 1,
    })
  }
  return (
    <Text dimColor>
      {tSync('messageSelector.codeWillBeRestored')}{' '}
      <DiffStatsText diffStats={diffStatsForRestore} />{' '}
      {tSync('messageSelector.inFiles', { fileLabel })}
    </Text>
  )
}

export function RestoreOptionDescription({
  selectedRestoreOption,
  canRestoreCode,
  diffStatsForRestore,
}: {
  selectedRestoreOption: RestoreOption
  canRestoreCode: boolean
  diffStatsForRestore?: DiffStats
}) {
  const showCodeRestore =
    canRestoreCode && (selectedRestoreOption === 'both' || selectedRestoreOption === 'code')

  return (
    <Box flexDirection="column">
      <Text dimColor>{getRestoreOptionConversationText(selectedRestoreOption)}</Text>
      {!isSummarizeOption(selectedRestoreOption) &&
        (showCodeRestore ? (
          <RestoreCodeConfirmation diffStatsForRestore={diffStatsForRestore} />
        ) : (
          <Text dimColor>{tSync('messageSelector.codeUnchanged')}</Text>
        ))}
    </Box>
  )
}

export function UserMessageOption({
  userMessage,
  color,
  dimColor,
  isCurrent,
  paddingRight,
}: {
  userMessage: UserMessage
  color?: React.ComponentProps<typeof Text>['color']
  dimColor?: boolean
  isCurrent: boolean
  paddingRight?: number
}) {
  const { columns } = useTerminalSize()
  if (isCurrent) {
    return (
      <Box width="100%">
        <Text italic color={color} dimColor={dimColor}>
          {tSync('messageSelector.currentLabel')}
        </Text>
      </Box>
    )
  }

  const content = userMessage.message.content
  const lastBlock = content[content.length - 1]
  const rawMessageText = lastBlock?.type === 'text' ? lastBlock.text.trim() : '(no prompt)'
  const messageText = stripDisplayTags(rawMessageText)

  if (isEmptyMessageText(messageText)) {
    return (
      <Box flexDirection="row" width="100%">
        <Text italic color={color} dimColor={dimColor}>
          {tSync('messageSelector.emptyMessage')}
        </Text>
      </Box>
    )
  }

  if (messageText.includes('<bash-input>')) {
    const input = extractTag(messageText, 'bash-input')
    if (input) {
      return (
        <Box flexDirection="row" width="100%">
          <Text color="bashBorder">!</Text>
          <Text color={color} dimColor={dimColor}>
            {' '}
            {input}
          </Text>
        </Box>
      )
    }
  }

  if (messageText.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    const commandMessage = extractTag(messageText, COMMAND_MESSAGE_TAG)
    const args = extractTag(messageText, 'command-args')
    const isSkillFormat = extractTag(messageText, 'skill-format') === 'true'
    if (commandMessage) {
      return (
        <Box flexDirection="row" width="100%">
          <Text color={color} dimColor={dimColor}>
            {isSkillFormat ? `Skill(${commandMessage})` : `/${commandMessage} ${args}`}
          </Text>
        </Box>
      )
    }
  }

  const displayText = paddingRight
    ? truncate(messageText, columns - paddingRight, true)
    : messageText.slice(0, 500).split('\n').slice(0, 4).join('\n')

  return (
    <Box flexDirection="row" width="100%">
      <Text color={color} dimColor={dimColor}>
        {displayText}
      </Text>
    </Box>
  )
}
