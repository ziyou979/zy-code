import type { TreeSitterAnalysis } from '../../shell-eval/bash/treeSitterAnalysis.js'

export type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** stripSafeRedirections 之前的 fullyUnquoted，供 validateBraceExpansion 使用，
   * 避免移除重定向后形成相邻反斜杠而导致假阴性 */
  fullyUnquotedPreStrip: string
  /** 与 fullyUnquotedPreStrip 类似，但保留引号字符 ('/")：例如
   * echo 'x'# → echo ''#（引号仍保留，可暴露它与 # 相邻） */
  unquotedKeepQuoteChars: string
  /** 可用时提供 Tree-sitter 分析数据。validator 可据此进行更准确的分析，
   * 不可用时回退到 regex。 */
  treeSitter?: TreeSitterAnalysis | null
}

export type BashSecurityCheckIds = {
  OBFUSCATED_FLAGS: number
  BACKSLASH_ESCAPED_WHITESPACE: number
  BACKSLASH_ESCAPED_OPERATORS: number
  BRACE_EXPANSION: number
  UNICODE_WHITESPACE: number
  MID_WORD_HASH: number
  COMMENT_QUOTE_DESYNC: number
  QUOTED_NEWLINE: number
  ZSH_DANGEROUS_COMMANDS: number
}

export const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

/** 检查 content 中 pos 位置的字符是否被反斜杠转义 */
export function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashes = 0
  for (let i = pos - 1; i >= 0 && content[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 1
}
