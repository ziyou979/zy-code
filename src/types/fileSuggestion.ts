import type { BaseHookInput } from './hooks/payloads.js'

// File Suggestion Types

export interface FileSuggestion {
  path: string
  score: number
}

/** fileSuggestion.type === 'command' 时传给自定义命令（stdin JSON）的输入 */
export type FileSuggestionCommandInput = BaseHookInput & {
  query: string
}
