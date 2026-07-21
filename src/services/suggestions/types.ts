import type { Theme } from '../environment/theme.js'

/** 补全服务与展示组件之间共享的候选项契约。 */
export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
  matchedAlias?: string
  /** 用于在展示文本中高亮匹配片段的原始查询。 */
  query?: string
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'
