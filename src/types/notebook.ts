// Notebook Types

export type NotebookCellType = 'code' | 'markdown'

export interface NotebookCell {
  id: string
  cellType: NotebookCellType
  source: string
  outputs?: string[]
  language?: string
}

export type NotebookContent = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

export interface Notebook {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
}
