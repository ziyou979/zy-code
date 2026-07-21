import { relative } from 'node:path'
import { getCwd } from 'src/services/environment/cwd.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { HighlightedCode } from './HighlightedCode.js'
import { MessageResponse } from './MessageResponse.js'

type Props = {
  notebook_path: string
  cell_id: string | undefined
  new_source: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: 'replace' | 'insert' | 'delete'
  verbose: boolean
}
export function NotebookEditToolUseRejectedMessage({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode = 'replace',
  verbose,
}: Props) {
  const operation =
    edit_mode === 'delete'
      ? tSync('notebookEdit.rejectedDelete')
      : tSync('notebookEdit.rejectedEditCell', { mode: edit_mode })
  const displayPath = verbose ? notebook_path : relative(getCwd(), notebook_path)
  return (
    <MessageResponse>
      <Box flexDirection="column">
        {
          <Box flexDirection="row">
            {<Text color="subtle">{operation} </Text>}
            {
              <Text bold={true} color="subtle">
                {displayPath}
              </Text>
            }
            {<Text color="subtle"> {tSync('notebookEdit.atCell', { cellId: cell_id ?? '' })}</Text>}
          </Box>
        }
        {edit_mode !== 'delete' && (
          <Box marginTop={1} flexDirection="column">
            <HighlightedCode
              code={new_source}
              filePath={cell_type === 'markdown' ? 'file.md' : 'file.py'}
              dim={true}
            />
          </Box>
        )}
      </Box>
    </MessageResponse>
  )
}
