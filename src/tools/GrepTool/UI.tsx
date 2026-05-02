import type { ToolResultBlock } from '../../types/llm.js'
import React from 'react'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { tSync } from '../../i18n/index.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { extractTag } from '../../utils/messages.js'

// 用于搜索结果摘要的可复用组件
function SearchResultSummary({
  count,
  countLabel,
  secondaryCount,
  secondaryLabel,
  content,
  verbose,
}) {
  const pluralizedLabel = count === 0 || count > 1 ? countLabel : countLabel.slice(0, -1)
  const primaryText = (
    <Text>
      {tSync('grep.found')} {<Text bold={true}>{count} </Text>}
      {pluralizedLabel}
    </Text>
  )
  const secondaryText =
    secondaryCount !== undefined && secondaryLabel ? (
      <Text>
        {' '}
        {tSync('grep.across')} <Text bold={true}>{secondaryCount} </Text>
        {secondaryCount === 0 || secondaryCount > 1 ? secondaryLabel : secondaryLabel.slice(0, -1)}
      </Text>
    ) : null
  if (verbose) {
    return (
      <Box flexDirection="column">
        {
          <Box flexDirection="row">
            <Text>
              {<Text dimColor={true}>  ⎿  </Text>}
              {primaryText}
              {secondaryText}
            </Text>
          </Box>
        }
        {
          <Box marginLeft={5}>
            <Text>{content}</Text>
          </Box>
        }
      </Box>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        {primaryText}
        {secondaryText} {count > 0 && <CtrlOToExpand />}
      </Text>
    </MessageResponse>
  )
}
type Output = {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number // For content mode
  numMatches?: number // For count mode
}
export function renderToolUseMessage(
  {
    pattern,
    path,
  }: Partial<{
    pattern: string
    path?: string
  }>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!pattern) {
    return null
  }
  const parts = [`pattern: "${pattern}"`]
  if (path) {
    parts.push(`path: "${verbose ? path : getDisplayPath(path)}"`)
  }
  return parts.join(', ')
}
export function renderToolUseErrorMessage(
  result: ToolResultBlock['content'],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error')
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">{tSync('grep.fileNotFound')}</Text>
        </MessageResponse>
      )
    }
    return (
      <MessageResponse>
        <Text color="error">{tSync('grep.errorSearching')}</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
export function renderToolResultMessage(
  { mode = 'files_with_matches', filenames, numFiles, content, numLines, numMatches }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode {
  if (mode === 'content') {
    return (
      <SearchResultSummary
        count={numLines ?? 0}
        countLabel={tSync('grep.lines_other')}
        secondaryCount={0}
        secondaryLabel=""
        content={content}
        verbose={verbose}
      />
    )
  }
  if (mode === 'count') {
    return (
      <SearchResultSummary
        count={numMatches ?? 0}
        countLabel={tSync('grep.matches_other')}
        secondaryCount={numFiles}
        secondaryLabel={tSync('grep.files_other')}
        content={content}
        verbose={verbose}
      />
    )
  }

  // files_with_matches mode
  const fileListContent = filenames.map((filename) => filename).join('\n')
  return (
    <SearchResultSummary
      count={numFiles}
      countLabel={tSync('grep.files_other')}
      secondaryCount={0}
      secondaryLabel=""
      content={fileListContent}
      verbose={verbose}
    />
  )
}
export function getToolUseSummary(
  input:
    | Partial<{
        pattern: string
        path?: string
        glob?: string
        type?: string
        output_mode?: 'content' | 'files_with_matches' | 'count'
        head_limit?: number
      }>
    | undefined,
): string | null {
  if (!input?.pattern) {
    return null
  }
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH)
}
