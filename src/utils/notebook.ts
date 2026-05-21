import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { formatOutput } from '../tools/BashTool/utils.js'
import type { ImageBlock, TextBlock, ToolResultBlock } from '../types/llm.js'
import type { NotebookCell, NotebookContent } from '../types/notebook.js'

// Local type declarations for missing exports
type NotebookCellOutput = any
type NotebookCellSource = any
type NotebookCellSourceOutput = any
type NotebookOutputImage = any

import { getFsImplementation } from './fsOperations.js'
import { expandPath } from './path.js'
import { jsonParse } from './slowOperations.js'

const LARGE_OUTPUT_THRESHOLD = 10000

function isLargeOutputs(outputs: (NotebookCellSourceOutput | undefined)[]): boolean {
  let size = 0
  for (const o of outputs) {
    if (!o) {
      continue
    }
    size += (o.text?.length ?? 0) + (o.image?.image_data.length ?? 0)
    if (size > LARGE_OUTPUT_THRESHOLD) {
      return true
    }
  }
  return false
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) {
    return ''
  }
  const rawText = Array.isArray(text) ? text.join('') : text
  const { truncatedContent } = formatOutput(rawText)
  return truncatedContent
}

function extractImage(data: Record<string, unknown>): NotebookOutputImage | undefined {
  if (typeof data['image/png'] === 'string') {
    return {
      image_data: data['image/png'].replace(/\s/g, ''),
      mediaType: 'image/png',
    }
  }
  if (typeof data['image/jpeg'] === 'string') {
    return {
      image_data: data['image/jpeg'].replace(/\s/g, ''),
      mediaType: 'image/jpeg',
    }
  }
  return undefined
}

function processOutput(output: NotebookCellOutput) {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      }
    case 'execute_result':
    case 'display_data':
      return {
        output_type: output.output_type,
        text: processOutputText(output.data?.['text/plain']),
        image: output.data && extractImage(output.data),
      }
    case 'error':
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${output.traceback.join('\n')}`,
        ),
      }
  }
}

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): NotebookCellSource {
  const cellId = cell.id ?? `cell-${index}`
  const cellData: NotebookCellSource = {
    cellType: (cell as any).cell_type,
    source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    execution_count:
      (cell as any).cell_type === 'code' ? (cell as any).execution_count || undefined : undefined,
    cell_id: cellId,
  }
  // Avoid giving text cells the code language.
  if ((cell as any).cell_type === 'code') {
    cellData.language = codeLanguage
  }

  if ((cell as any).cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput)
    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      cellData.outputs = [
        {
          output_type: 'stream',
          text: `Outputs are too large to include. Use ${BASH_TOOL_NAME} with: cat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ]
    } else {
      cellData.outputs = outputs
    }
  }

  return cellData
}

function cellContentToToolResult(cell: NotebookCellSource): TextBlock {
  const metadata = []
  if (cell.cellType !== 'code') {
    metadata.push(`<cell_type>${cell.cellType}</cell_type>`)
  }
  if (cell.language !== 'python' && cell.cellType === 'code') {
    metadata.push(`<language>${cell.language}</language>`)
  }
  const cellContent = `<cell id="${cell.cell_id}">${metadata.join('')}${cell.source}</cell id="${cell.cell_id}">`
  return {
    text: cellContent,
    type: 'text',
  }
}

function cellOutputToToolResult(output: NotebookCellSourceOutput) {
  const outputs: (TextBlock | ImageBlock)[] = []
  if (output.text) {
    outputs.push({
      text: `\n${output.text}`,
      type: 'text',
    })
  }
  if (output.image) {
    outputs.push({
      type: 'image',
      mimeType: output.image.mediaType,
      data: output.image.image_data,
    })
  }
  return outputs
}

function getToolResultFromCell(cell: NotebookCellSource) {
  const contentResult = cellContentToToolResult(cell)
  const outputResults = cell.outputs?.flatMap(cellOutputToToolResult)
  return [contentResult, ...(outputResults ?? [])]
}

/**
 * Reads and parses a Jupyter notebook file into processed cell data
 */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<NotebookCellSource[]> {
  const fullPath = expandPath(notebookPath)
  const buffer = await getFsImplementation().readFileBytes(fullPath)
  const content = buffer.toString('utf-8')
  const notebook = jsonParse(content) as NotebookContent
  const language = (notebook.metadata as any)?.language_info?.name ?? 'python'
  if (cellId) {
    const cell = notebook.cells.find((c) => c.id === cellId)
    if (!cell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`)
    }
    return [processCell(cell, notebook.cells.indexOf(cell), language, true)]
  }
  return notebook.cells.map((cell, index) => processCell(cell, index, language, false))
}

/**
 * Maps notebook cell data to tool result block parameters with sophisticated text block merging
 */
export function mapNotebookCellsToToolResult(
  data: NotebookCellSource[],
  toolUseID: string,
): ToolResultBlock {
  const allResults = data.flatMap(getToolResultFromCell)

  // Merge adjacent text blocks
  return {
    toolCallId: toolUseID,
    type: 'tool_result' as const,
    content: allResults.reduce<(TextBlock | ImageBlock)[]>((acc, curr) => {
      if (acc.length === 0) {
        return [curr]
      }

      const prev = acc[acc.length - 1]
      if (prev && prev.type === 'text' && curr.type === 'text') {
        // Merge the text blocks
        prev.text += `\n${curr.text}`
        return acc
      }

      acc.push(curr)
      return acc
    }, []),
  }
}

export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/)
  if (match?.[1]) {
    const index = parseInt(match[1], 10)
    return Number.isNaN(index) ? undefined : index
  }
  return undefined
}
