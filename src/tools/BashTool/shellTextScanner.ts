// 注意：反引号模式由 validateDangerousPatterns 单独处理，
// 以区分已转义和未转义的反引号
export const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

export type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** 与 fullyUnquoted 类似，但保留引号字符 ('/")：移除引号内容但保留定界符。
   * validateMidWordHash 用它检测与引号相邻的 #（如 'x'#，移除引号会隐藏这种相邻关系）。 */
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
      // 对 jq，提取时保留引号，确保正确分析内容
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
  // 安全：三个模式都必须带末尾边界 (?=\s|$)。
  // 否则 `> /dev/nullo` 会以前缀形式匹配 `/dev/null`，移除 `> /dev/null` 后留下 `o`，
  // 使 `echo hi > /dev/nullo` 变为 `echo hi o`。validateRedirections 随后看不到 `>` 并通过。
  // 通过只读路径 checkReadOnlyConstraints，对 /dev/nullo 的文件写入会被自动允许。
  // 主 bashPermissions 流程受到保护（checkPathConstraints 校验原始命令），
  // 但 speculation.ts 仅使用 checkReadOnlyConstraints。
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * 检查内容中是否存在未转义的单字符。
 * 正确处理 bash 中反斜杠转义后续字符的序列。
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
 * 检测格式正确的 $(cat <<'DELIM'...DELIM) heredoc 替换模式。
 * 返回移除已匹配 heredoc 的命令；未找到时返回 null。
 * pre-split gate 用它移除安全 heredoc，并重新检查剩余内容。
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

/** 仅用于检测：命令是否包含安全 heredoc 替换？ */
export function hasSafeHeredocSubstitution(command: string): boolean {
  return stripSafeHeredocSubstitutions(command) !== null
}

/**
 * 检查命令是否为可绕过通用 $() validator 的“安全” heredoc-in-substitution 模式。
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
