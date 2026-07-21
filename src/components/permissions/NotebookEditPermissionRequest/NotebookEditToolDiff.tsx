import { relative } from 'node:path'
import { Suspense, use } from 'react'
import { Box, NoSelect, Text } from '../../../ink/index.js'
import type { NotebookCellType, NotebookContent } from '../../../types/notebook.js'
import { intersperse } from '../../../utils/array.js'
import { getCwd } from '../../../services/environment/cwd.js'
import { getPatchForDisplay } from '../../../services/git/diff.js'
import { getFsImplementation } from '../../../services/infra/fsOperations.js'
import { safeParseJSON } from '../../../utils/json.js'
import { parseCellId } from '../../../services/attachments/notebook.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'

type Props = {
  notebook_path: string
  cell_id: string | undefined
  new_source: string
  cell_type?: NotebookCellType
  edit_mode?: string
  verbose: boolean
  width: number
}
type InnerProps = {
  notebook_path: string
  cell_id: string | undefined
  new_source: string
  cell_type?: NotebookCellType
  edit_mode?: string
  verbose: boolean
  width: number
  promise: Promise<NotebookContent | null>
}
export function NotebookEditToolDiff(props: Props) {
  const notebookDataPromise = getFsImplementation()
    .readFile(props.notebook_path, {
      encoding: 'utf-8',
    })
    .then((content) => safeParseJSON(content) as NotebookContent | null)
    .catch(() => null)
  return (
    <Suspense fallback={null}>
      <NotebookEditToolDiffInner {...props} promise={notebookDataPromise} />
    </Suspense>
  )
}
function NotebookEditToolDiffInner({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode = 'replace',
  verbose,
  width,
  promise,
}: InnerProps) {
  const notebookData = use(promise)
  let oldSource
  if (!notebookData || !cell_id) {
    oldSource = ''
  } else {
    const cellIndex = parseCellId(cell_id)
    if (cellIndex !== undefined) {
      if (notebookData.cells[cellIndex]) {
        const source = notebookData.cells[cellIndex].source
        oldSource = Array.isArray(source) ? source.join('') : source
      } else {
        oldSource = ''
      }
    } else {
      const targetCell = notebookData.cells.find((cell) => cell.id === cell_id)
      if (!targetCell) {
        oldSource = ''
      } else {
        oldSource = Array.isArray(targetCell.source)
          ? targetCell.source.join('')
          : targetCell.source
      }
    }
  }
  let hunks
  if (!notebookData || edit_mode === 'insert' || edit_mode === 'delete') {
    hunks = null
  } else {
    hunks = getPatchForDisplay({
      filePath: notebook_path,
      fileContents: oldSource,
      edits: [
        {
          old_string: oldSource,
          new_string: new_source,
          replace_all: false,
        },
      ],
      ignoreWhitespace: false,
    })
  }
  let editTypeDescription
  switch (edit_mode) {
    case 'insert': {
      editTypeDescription = 'Insert new cell'
      break
    }
    case 'delete': {
      editTypeDescription = 'Delete cell'
      break
    }
    default: {
      editTypeDescription = 'Replace cell contents'
    }
  }
  const displayPath = verbose ? notebook_path : relative(getCwd(), notebook_path)
  const editContent =
    edit_mode === 'delete' ? (
      <Box flexDirection="column" paddingLeft={2}>
        <HighlightedCode code={oldSource} filePath={notebook_path} />
      </Box>
    ) : edit_mode === 'insert' ? (
      <Box flexDirection="column" paddingLeft={2}>
        <HighlightedCode
          code={new_source}
          filePath={cell_type === 'markdown' ? 'file.md' : notebook_path}
        />
      </Box>
    ) : hunks ? (
      intersperse(
        hunks.map((_) => (
          <StructuredDiff
            key={_.newStart}
            patch={_}
            dim={false}
            width={width}
            filePath={notebook_path}
            firstLine={new_source.split('\n')[0] ?? null}
            fileContent={oldSource}
          />
        )),
        (i) => (
          <NoSelect fromLeftEdge={true} key={`ellipsis-${i}`}>
            <Text dimColor={true}>...</Text>
          </NoSelect>
        ),
      )
    ) : (
      <HighlightedCode
        code={new_source}
        filePath={cell_type === 'markdown' ? 'file.md' : notebook_path}
      />
    )
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        {
          <Box paddingBottom={1} flexDirection="column">
            {<Text bold={true}>{displayPath}</Text>}
            {
              <Text dimColor={true}>
                {editTypeDescription} for cell {cell_id}
                {cell_type ? ` (${cell_type})` : ''}
              </Text>
            }
          </Box>
        }
        {editContent}
      </Box>
    </Box>
  )
}
