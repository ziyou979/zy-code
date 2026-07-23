import type { TreeSitterAnalysis } from '../../shell-eval/bash/treeSitterAnalysis.js'

export type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** fullyUnquoted before stripSafeRedirections — used by validateBraceExpansion
   * to avoid false negatives from redirection stripping creating backslash adjacencies */
  fullyUnquotedPreStrip: string
  /** Like fullyUnquotedPreStrip but preserves quote characters ('/"): e.g.,
   * echo 'x'# → echo ''# (the quote chars remain, revealing adjacency to #) */
  unquotedKeepQuoteChars: string
  /** Tree-sitter analysis data, if available. Validators can use this for
   * more accurate analysis when present, falling back to regex otherwise. */
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
