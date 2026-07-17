import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { Box, NoSelect, Text } from '../../../ink/index.js'
import { intersperse } from '../../../utils/array.js'
import { getPatchForDisplay } from '../../../services/git/diff.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'

type Props = {
  file_path: string
  content: string
  fileExists: boolean
  oldContent: string
}
export function FileWriteToolDiff({ file_path, content, fileExists, oldContent }: Props) {
  const { columns } = useTerminalSize()
  let hunks
  if (!fileExists) {
    hunks = null
  } else {
    hunks = getPatchForDisplay({
      filePath: file_path,
      fileContents: oldContent,
      edits: [
        {
          old_string: oldContent,
          new_string: content,
          replace_all: false,
        },
      ],
    })
  }
  const firstLine = content.split('\n')[0] ?? null
  const diffContent = hunks ? (
    intersperse(
      hunks.map((_) => (
        <StructuredDiff
          key={_.newStart}
          patch={_}
          dim={false}
          filePath={file_path}
          firstLine={firstLine}
          fileContent={oldContent}
          width={columns - 2}
        />
      )),
      (i) => (
        <NoSelect fromLeftEdge={true} key={`ellipsis-${i}`}>
          <Text dimColor={true}>...</Text>
        </NoSelect>
      ),
    )
  ) : (
    <HighlightedCode code={content || '(No content)'} filePath={file_path} />
  )
  return (
    <Box flexDirection="column">
      <Box
        borderColor="subtle"
        borderStyle="dashed"
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {diffContent}
      </Box>
    </Box>
  )
}
