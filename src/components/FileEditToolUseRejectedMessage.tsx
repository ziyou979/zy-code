import { relative } from 'node:path'
import type { StructuredPatchHunk } from 'diff'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { getCwd } from 'src/services/environment/cwd.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { HighlightedCode } from './HighlightedCode.js'
import { MessageResponse } from './MessageResponse.js'
import { StructuredDiffList } from './StructuredDiffList.js'

const MAX_LINES_TO_RENDER = 10
type Props = {
  file_path: string
  operation: 'write' | 'update'
  // 对于更新——显示 diff
  patch?: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
  // 对于新文件创建——显示内容预览
  content?: string
  style?: 'condensed'
  verbose: boolean
}
export function FileEditToolUseRejectedMessage({
  file_path,
  operation,
  patch,
  firstLine,
  fileContent,
  content,
  style,
  verbose,
}: Props) {
  const { columns } = useTerminalSize()
  const displayFilePath = verbose ? file_path : relative(getCwd(), file_path)
  const text = (
    <Box flexDirection="row">
      {
        <Text color="subtle">
          {operation === 'write'
            ? tSync('fileEdit.rejectedWrite')
            : tSync('fileEdit.rejectedUpdate')}{' '}
        </Text>
      }
      {
        <Text bold={true} color="subtle">
          {displayFilePath}
        </Text>
      }
    </Box>
  )
  if (style === 'condensed' && !verbose) {
    return <MessageResponse>{text}</MessageResponse>
  }
  if (operation === 'write' && content !== undefined) {
    const lines = content.split('\n')
    const numLines = lines.length
    const plusLines = numLines - MAX_LINES_TO_RENDER
    const truncatedContent = verbose ? content : lines.slice(0, MAX_LINES_TO_RENDER).join('\n')
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {text}
          {
            <HighlightedCode
              code={truncatedContent || tSync('fileEdit.noContent')}
              filePath={file_path}
              width={columns - 12}
              dim={true}
            />
          }
          {!verbose && plusLines > 0 && (
            <Text dimColor={true}>{tSync('fileEdit.plusLines', { count: plusLines })}</Text>
          )}
        </Box>
      </MessageResponse>
    )
  }
  if (!patch || patch.length === 0) {
    return <MessageResponse>{text}</MessageResponse>
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {text}
        {
          <StructuredDiffList
            hunks={patch}
            dim={true}
            width={columns - 12}
            filePath={file_path}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        }
      </Box>
    </MessageResponse>
  )
}
