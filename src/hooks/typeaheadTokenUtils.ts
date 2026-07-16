import { logEvent } from 'src/services/analytics/index.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { isCommandInput } from '../services/suggestions/commandSuggestions.js'
import {
  getShellCompletions,
  type ShellCompletionType,
} from '../shell-eval/bash/shellCompletion.js'
import { quote } from '../shell-eval/bash/shellQuote.js'

// Unicode-aware character class for file path tokens:
// \p{L} = letters (CJK, Latin, Cyrillic, etc.)
// \p{N} = numbers (incl. fullwidth)
// \p{M} = combining marks (macOS NFD accents, Devanagari vowel signs)
export const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u
export const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u
const TOKEN_WITH_AT_RE = /(@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u
const TOKEN_WITHOUT_AT_RE = /[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+$/u
export const HAS_AT_SYMBOL_RE = /(^|\s)@([\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|"[^"]*"?)$/u
export const HASH_CHANNEL_RE = /(^|\s)#([a-z0-9][a-z0-9_-]*)$/

// Type guard for path completion metadata
export function isPathMetadata(metadata: unknown): metadata is {
  type: 'directory' | 'file'
} {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'type' in metadata &&
    (metadata.type === 'directory' || metadata.type === 'file')
  )
}

// Helper to determine selectedSuggestion when updating suggestions
export function getPreservedSelection(
  prevSuggestions: SuggestionItem[],
  prevSelection: number,
  newSuggestions: SuggestionItem[],
): number {
  // No new suggestions
  if (newSuggestions.length === 0) {
    return -1
  }

  // No previous selection
  if (prevSelection < 0) {
    return 0
  }

  // Get the previously selected item
  const prevSelectedItem = prevSuggestions[prevSelection]
  if (!prevSelectedItem) {
    return 0
  }

  // Try to find the same item in the new list by ID
  const newIndex = newSuggestions.findIndex((item) => item.id === prevSelectedItem.id)

  // Return the new index if found, otherwise default to 0
  return newIndex >= 0 ? newIndex : 0
}

export function buildResumeInputFromSuggestion(suggestion: SuggestionItem): string {
  const metadata = suggestion.metadata as
    | {
        sessionId: string
      }
    | undefined
  return metadata?.sessionId ? `/resume ${metadata.sessionId}` : `/resume ${suggestion.displayText}`
}

/**
 * Extract search token from a completion token by removing @ prefix and quotes
 * @param completionToken The completion token
 * @returns The search token with @ and quotes removed
 */
export function extractSearchToken(completionToken: { token: string; isQuoted?: boolean }): string {
  if (completionToken.isQuoted) {
    // Remove @" prefix and optional closing "
    return completionToken.token.slice(2).replace(/"$/, '')
  } else if (completionToken.token.startsWith('@')) {
    return completionToken.token.substring(1)
  } else {
    return completionToken.token
  }
}

/**
 * Format a replacement value with proper @ prefix and quotes based on context
 * @param options Configuration for formatting
 * @param options.displayText The text to display
 * @param options.mode The current mode (bash or prompt)
 * @param options.hasAtPrefix Whether the original token has @ prefix
 * @param options.needsQuotes Whether the text needs quotes (contains spaces)
 * @param options.isQuoted Whether the original token was already quoted (user typed @"...)
 * @param options.isComplete Whether this is a complete suggestion (adds trailing space)
 * @returns The formatted replacement value
 */
export function formatReplacementValue(options: {
  displayText: string
  mode: string
  hasAtPrefix: boolean
  needsQuotes: boolean
  isQuoted?: boolean
  isComplete: boolean
}): string {
  const { displayText, mode, hasAtPrefix, needsQuotes, isQuoted, isComplete } = options
  const space = isComplete ? ' ' : ''
  if (isQuoted || needsQuotes) {
    // Use quoted format
    return mode === 'bash' ? `"${displayText}"${space}` : `@"${displayText}"${space}`
  } else if (hasAtPrefix) {
    return mode === 'bash' ? `${displayText}${space}` : `@${displayText}${space}`
  } else {
    return displayText
  }
}

/**
 * Apply a shell completion suggestion by replacing the current word
 */
export function applyShellSuggestion(
  suggestion: SuggestionItem,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  const beforeCursor = input.slice(0, cursorOffset)
  const afterCursor = input.slice(cursorOffset)
  const wordStart = findShellTokenStart(beforeCursor)
  const needsTrailingSpace = !/^\s/.test(afterCursor)

  // Prepare the replacement text based on completion type
  let replacementText: string
  if (completionType === 'variable') {
    replacementText = `$${suggestion.displayText}${needsTrailingSpace ? ' ' : ''}`
  } else if (completionType === 'command') {
    replacementText = `${suggestion.displayText}${needsTrailingSpace ? ' ' : ''}`
  } else {
    // 文件候选以空格标记普通文件，以斜杠标记目录；引用时保留该交互后缀。
    const hasTrailingSpace = suggestion.displayText.endsWith(' ')
    const path = hasTrailingSpace ? suggestion.displayText.slice(0, -1) : suggestion.displayText
    replacementText = `${quote([path])}${hasTrailingSpace && needsTrailingSpace ? ' ' : ''}`
  }
  const newInput = input.slice(0, wordStart) + replacementText + afterCursor
  onInputChange(newInput)
  setCursorOffset(wordStart + replacementText.length)
}

/**
 * 找到光标前当前 shell token 的起点，兼容引号内空格和紧邻的命令操作符。
 */
export function findShellTokenStart(input: string): number {
  let tokenStart = 0
  let quoteChar: "'" | '"' | null = null
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoteChar !== "'") {
      escaped = true
      continue
    }
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quoteChar = char
      continue
    }
    if (/\s/.test(char ?? '') || '|;&<>'.includes(char ?? '')) {
      tokenStart = index + 1
    }
  }

  return tokenStart
}

export const DM_MEMBER_RE = /(^|\s)@[\w-]*$/

export function applyTriggerSuggestion(
  suggestion: SuggestionItem,
  input: string,
  cursorOffset: number,
  triggerRe: RegExp,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  const m = input.slice(0, cursorOffset).match(triggerRe)
  if (!m || m.index === undefined) {
    return
  }
  const prefixStart = m.index + (m[1]?.length ?? 0)
  const before = input.slice(0, prefixStart)
  const newInput = `${before + suggestion.displayText} ${input.slice(cursorOffset)}`
  onInputChange(newInput)
  setCursorOffset(before.length + suggestion.displayText.length + 1)
}

let currentShellCompletionAbortController: AbortController | null = null

/**
 * Generate bash shell completion suggestions
 */
export async function generateBashSuggestions(
  input: string,
  cursorOffset: number,
): Promise<SuggestionItem[]> {
  try {
    if (currentShellCompletionAbortController) {
      currentShellCompletionAbortController.abort()
    }
    currentShellCompletionAbortController = new AbortController()
    const suggestions = await getShellCompletions(
      input,
      cursorOffset,
      currentShellCompletionAbortController.signal,
    )
    return suggestions
  } catch {
    // Silent failure - don't break UX
    logEvent('zy_shell_completion_failed', {})
    return []
  }
}

/**
 * Apply a directory/path completion suggestion to the input
 * Always adds @ prefix since we're replacing the entire token (including any existing @)
 *
 * @param input The current input text
 * @param suggestionId The ID of the suggestion to apply
 * @param tokenStartPos The start position of the token being replaced
 * @param tokenLength The length of the token being replaced
 * @param isDirectory Whether the suggestion is a directory (adds / suffix) or file (adds space)
 * @returns Object with the new input text and cursor position
 */
export function applyDirectorySuggestion(
  input: string,
  suggestionId: string,
  tokenStartPos: number,
  tokenLength: number,
  isDirectory: boolean,
): {
  newInput: string
  cursorPos: number
} {
  const suffix = isDirectory ? '/' : ' '
  const before = input.slice(0, tokenStartPos)
  const after = input.slice(tokenStartPos + tokenLength)
  // Always add @ prefix - if token already has it, we're replacing
  // the whole token (including @) with @suggestion.id
  const replacement = `@${suggestionId}${suffix}`
  const newInput = before + replacement + after
  return {
    newInput,
    cursorPos: before.length + replacement.length,
  }
}

/**
 * Extract a completable token at the cursor position
 * @param text The input text
 * @param cursorPos The cursor position
 * @param includeAtSymbol Whether to consider @ symbol as part of the token
 * @returns The completable token and its start position, or null if not found
 */
export function extractCompletionToken(
  text: string,
  cursorPos: number,
  includeAtSymbol = false,
): {
  token: string
  startPos: number
  isQuoted?: boolean
} | null {
  // Empty input check
  if (!text) {
    return null
  }

  // Get text up to cursor
  const textBeforeCursor = text.substring(0, cursorPos)

  // Check for quoted @ mention first (e.g., @"my file with spaces")
  if (includeAtSymbol) {
    const quotedAtRegex = /@"([^"]*)"?$/
    const quotedMatch = textBeforeCursor.match(quotedAtRegex)
    if (quotedMatch && quotedMatch.index !== undefined) {
      // Include any remaining quoted content after cursor until closing quote or end
      const textAfterCursor = text.substring(cursorPos)
      const afterQuotedMatch = textAfterCursor.match(/^[^"]*"?/)
      const quotedSuffix = afterQuotedMatch ? afterQuotedMatch[0] : ''
      return {
        token: quotedMatch[0] + quotedSuffix,
        startPos: quotedMatch.index,
        isQuoted: true,
      }
    }
  }

  // Fast path for @ tokens: use lastIndexOf to avoid expensive $ anchor scan
  if (includeAtSymbol) {
    const atIdx = textBeforeCursor.lastIndexOf('@')
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(textBeforeCursor[atIdx - 1]!))) {
      const fromAt = textBeforeCursor.substring(atIdx)
      const atHeadMatch = fromAt.match(AT_TOKEN_HEAD_RE)
      if (atHeadMatch && atHeadMatch[0].length === fromAt.length) {
        const textAfterCursor = text.substring(cursorPos)
        const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE)
        const tokenSuffix = afterMatch ? afterMatch[0] : ''
        return {
          token: atHeadMatch[0] + tokenSuffix,
          startPos: atIdx,
          isQuoted: false,
        }
      }
    }
  }

  // Non-@ token or cursor outside @ token — use $ anchor on (short) tail
  const tokenRegex = includeAtSymbol ? TOKEN_WITH_AT_RE : TOKEN_WITHOUT_AT_RE
  const match = textBeforeCursor.match(tokenRegex)
  if (!match || match.index === undefined) {
    return null
  }

  // Check if cursor is in the MIDDLE of a token (more word characters after cursor)
  // If so, extend the token to include all characters until whitespace or end of string
  const textAfterCursor = text.substring(cursorPos)
  const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE)
  const tokenSuffix = afterMatch ? afterMatch[0] : ''
  return {
    token: match[0] + tokenSuffix,
    startPos: match.index,
    isQuoted: false,
  }
}

export function extractCommandNameAndArgs(value: string): {
  commandName: string
  args: string
} | null {
  if (isCommandInput(value)) {
    const spaceIndex = value.indexOf(' ')
    if (spaceIndex === -1) {
      return {
        commandName: value.slice(1),
        args: '',
      }
    }
    return {
      commandName: value.slice(1, spaceIndex),
      args: value.slice(spaceIndex + 1),
    }
  }
  return null
}

export function hasCommandWithArguments(isAtEndWithWhitespace: boolean, value: string) {
  // If value.endsWith(' ') but the user is not at the end, then the user has
  // potentially gone back to the command in an effort to edit the command name
  // (but preserve the arguments).
  return !isAtEndWithWhitespace && value.includes(' ') && !value.endsWith(' ')
}
