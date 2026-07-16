// Note: Backtick pattern is handled separately in validateDangerousPatterns
// to distinguish between escaped and unescaped backticks
export const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

export type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** Like fullyUnquoted but preserves quote characters ('/"): strips quoted
   * content while keeping the delimiters. Used by validateMidWordHash to detect
   * quote-adjacent # (e.g., 'x'# where quote stripping would hide adjacency). */
  unquotedKeepQuoteChars: string
}

export function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) {
        withDoubleQuotes += char
      }
      if (!inSingleQuote && !inDoubleQuote) {
        fullyUnquoted += char
      }
      if (!inSingleQuote && !inDoubleQuote) {
        unquotedKeepQuoteChars += char
      }
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) {
        withDoubleQuotes += char
      }
      if (!inSingleQuote && !inDoubleQuote) {
        fullyUnquoted += char
      }
      if (!inSingleQuote && !inDoubleQuote) {
        unquotedKeepQuoteChars += char
      }
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // For jq, include quotes in extraction to ensure content is properly analyzed
      if (!isJq) {
        continue
      }
    }

    if (!inSingleQuote) {
      withDoubleQuotes += char
    }
    if (!inSingleQuote && !inDoubleQuote) {
      fullyUnquoted += char
    }
    if (!inSingleQuote && !inDoubleQuote) {
      unquotedKeepQuoteChars += char
    }
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

export function stripSafeRedirections(content: string): string {
  // SECURITY: All three patterns MUST have a trailing boundary (?=\s|$).
  // Without it, `> /dev/nullo` matches `/dev/null` as a PREFIX, strips
  // `> /dev/null` leaving `o`, so `echo hi > /dev/nullo` becomes `echo hi o`.
  // validateRedirections then sees no `>` and passes. The file write to
  // /dev/nullo is auto-allowed via the read-only path (checkReadOnlyConstraints).
  // Main bashPermissions flow is protected (checkPathConstraints validates the
  // original command), but speculation.ts uses checkReadOnlyConstraints alone.
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * Checks if content contains an unescaped occurrence of a single character.
 * Handles bash escape sequences correctly where a backslash escapes the following character.
 *
 * IMPORTANT: This function only handles single characters, not strings. If you need to extend
 * this to handle multi-character strings, be EXTREMELY CAREFUL about shell ANSI-C quoting
 * (e.g., $'\n', $'\x41', $'\u0041') which can encode arbitrary characters and strings in ways
 * that are very difficult to parse correctly. Incorrect handling could introduce security
 * vulnerabilities by allowing attackers to bypass security checks.
 *
 * @param content - The string to search (typically from extractQuotedContent)
 * @param char - Single character to search for (e.g., '`')
 * @returns true if unescaped occurrence found, false otherwise
 *
 * Examples:
 *   hasUnescapedChar("test \`safe\`", '`') → false (escaped backticks)
 *   hasUnescapedChar("test `dangerous`", '`') → true (unescaped backticks)
 *   hasUnescapedChar("test\\`date`", '`') → true (escaped backslash + unescaped backtick)
 */
export function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error('hasUnescapedChar only works with single characters')
  }

  let i = 0
  while (i < content.length) {
    // If we see a backslash, skip it and the next character (they form an escape sequence)
    if (content[i] === '\\' && i + 1 < content.length) {
      i += 2
      continue
    }

    if (content[i] === char) {
      return true
    }

    i++
  }

  return false
}

/**
 * Detects well-formed $(cat <<'DELIM'...DELIM) heredoc substitution patterns.
 * Returns the command with matched heredocs stripped, or null if none found.
 * Used by the pre-split gate to strip safe heredocs and re-check the remainder.
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) {
    return null
  }

  const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') {
      continue
    }
    const delimiter = match[2] || match[3]
    if (!delimiter) {
      continue
    }
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) {
      continue
    }
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) {
      continue
    }

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart = bodyStart + bodyLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart = bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) {
    return null
  }
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!
    result = result.slice(0, range.start) + result.slice(range.end)
  }
  return result
}

/** Detection-only check: does the command contain a safe heredoc substitution? */
export function hasSafeHeredocSubstitution(command: string): boolean {
  return stripSafeHeredocSubstitutions(command) !== null
}

/**
 * Checks if a command is a "safe" heredoc-in-substitution pattern that can
 * bypass the generic $() validator.
 */
export function isSafeHeredoc(
  command: string,
  validateRemaining: (remaining: string) => boolean,
): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) {
    return false
  }

  const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  if (safeHeredocs.length === 0) {
    return false
  }

  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) {
      return false
    }
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) {
      return false
    }

    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    let closingLineIdx = -1
    let closeParenLineIdx = -1
    let closeParenColIdx = -1

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      if (line === delimiter) {
        closingLineIdx = i
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) {
          return false
        }
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) {
          return false
        }
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length
        break
      }

      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx = tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false
        }
      }
    }

    if (closingLineIdx === -1) {
      return false
    }

    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1
    }
    endPos += closeParenColIdx + 1

    verified.push({ start, end: endPos })
  }

  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) {
        continue
      }
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  const sortedVerified = [...verified].sort((left, right) => right.start - left.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    const firstHeredocStart = Math.min(...verified.map((item) => item.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      return false
    }
  }

  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) {
    return false
  }

  if (!validateRemaining(remaining)) {
    return false
  }

  return true
}
