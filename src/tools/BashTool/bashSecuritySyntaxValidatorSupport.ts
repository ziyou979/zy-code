import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../../i18n/index.js'
import type { TreeSitterAnalysis } from '../../shell-eval/bash/treeSitterAnalysis.js'
import type { PermissionResult } from '../../services/permissions/permissionResult.js'

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

type BashSecurityCheckIds = {
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

const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'mapfile',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

export function validateObfuscatedFlags(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  const { originalCommand, baseCommand } = context
  const hasShellOperators = /[|&;]/.test(originalCommand)
  if (baseCommand === 'echo' && !hasShellOperators) {
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.echoSafe'),
    }
  }

  if (/\$'[^']*'/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 5,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.ansiCQuoting'),
    }
  }

  if (/\$"[^"]*"/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 6,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.localeQuoting'),
    }
  }

  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 9,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.emptySpecialQuotesBeforeDash'),
    }
  }

  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 7,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.emptyQuotesBeforeDashAlt'),
    }
  }

  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 10,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.emptyQuotePairDash'),
    }
  }

  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 11,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.consecutiveQuotes'),
    }
  }

  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]
    const nextChar = originalCommand[i + 1]

    if (escaped) {
      escaped = false
      continue
    }

    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    if (currentChar && nextChar && /\s/.test(currentChar) && /['"`]/.test(nextChar)) {
      const quoteChar = nextChar
      let j = i + 2
      let insideQuote = ''

      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!
        j++
      }

      const charAfterQuote = originalCommand[j + 1]
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote)
      const flagContinuationChars = /[a-zA-Z0-9\\${`-]/
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        flagContinuationChars.test(charAfterQuote)
      const hasFlagCharsInNextQuote =
        (insideQuote === '' || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1
          let combinedContent = insideQuote
          while (pos < originalCommand.length && /['"`]/.test(originalCommand[pos]!)) {
            const segQuote = originalCommand[pos]!
            let end = pos + 1
            while (end < originalCommand.length && originalCommand[end] !== segQuote) {
              end++
            }
            const segment = originalCommand.slice(pos + 1, end)
            combinedContent += segment

            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) {
              return true
            }

            const priorContent =
              segment.length > 0 ? combinedContent.slice(0, -segment.length) : combinedContent
            if (/^-+$/.test(priorContent) && /[a-zA-Z0-9$`]/.test(segment)) {
              return true
            }

            if (end >= originalCommand.length) {
              break
            }
            pos = end + 1
          }
          if (pos < originalCommand.length && flagContinuationChars.test(originalCommand[pos]!)) {
            if (/^-+$/.test(combinedContent) || combinedContent === '') {
              const next = originalCommand[pos]!
              if (next === '-') {
                return true
              }
              if (/[a-zA-Z0-9\\${`]/.test(next) && combinedContent !== '') {
                return true
              }
            }
            if (/^-/.test(combinedContent)) {
              return true
            }
          }
          return false
        })()
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside || hasFlagCharsContinuing || hasFlagCharsInNextQuote)
      ) {
        logEvent('zy_bash_security_check_triggered', {
          checkId: securityCheckIds.OBFUSCATED_FLAGS,
          subId: 4,
        })
        return {
          behavior: 'ask',
          message: tSync('bashSecurity.quotedInFlag'),
        }
      }
    }

    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === '-') {
      let j = i + 1
      let flagContent = ''

      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]
        if (!flagChar) {
          break
        }

        if (/[\s=]/.test(flagChar)) {
          break
        }
        if (/['"`]/.test(flagChar)) {
          if (baseCommand === 'cut' && flagContent === '-d' && /['"`]/.test(flagChar)) {
            break
          }
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              break
            }
          }
        }
        flagContent += flagChar
        j++
      }

      if (flagContent.includes('"') || flagContent.includes("'")) {
        logEvent('zy_bash_security_check_triggered', {
          checkId: securityCheckIds.OBFUSCATED_FLAGS,
          subId: 1,
        })
        return {
          behavior: 'ask',
          message: tSync('bashSecurity.quotedInFlag'),
        }
      }
    }
  }

  if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.quotedInFlag'),
    }
  }

  if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.OBFUSCATED_FLAGS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.quotedInFlag'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noObfuscatedFlags') }
}

function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    }
  }

  return false
}

export function validateBackslashEscapedWhitespace(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.backslashWhitespace'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noBackslashWhitespace'),
  }
}

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      i++
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    }
  }

  return false
}

export function validateBackslashEscapedOperators(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noOperatorNodes') }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.backslashOperator'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noBackslashOperators'),
  }
}

function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

export function validateBraceExpansion(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  const content = context.fullyUnquotedPreStrip
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.braceExcessClosing'),
    }
  }

  if (unescapedOpenBraces > 0 && /['"][{}]['"]/.test(context.originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.BRACE_EXPANSION,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.braceQuotedInside'),
    }
  }

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{' || isEscapedAtPosition(content, i)) {
      continue
    }

    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) {
      continue
    }

    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (ch === ',' || (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')) {
          logEvent('zy_bash_security_check_triggered', {
            checkId: securityCheckIds.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message: tSync('bashSecurity.braceExpansion'),
          }
        }
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noBraceExpansion'),
  }
}

export function validateUnicodeWhitespace(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  if (UNICODE_WS_RE.test(context.originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.unicodeWhitespace'),
    }
  }
  return { behavior: 'passthrough', message: tSync('bashSecurity.noUnicodeWhitespace') }
}

export function validateMidWordHash(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  const joined = context.unquotedKeepQuoteChars.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (/\S(?<!\$\{)#/.test(context.unquotedKeepQuoteChars) || /\S(?<!\$\{)#/.test(joined)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.midWordHash'),
    }
  }
  return { behavior: 'passthrough', message: tSync('bashSecurity.noMidWordHash') }
}

export function validateCommentQuoteDesync(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.treeSitterAuthoritative'),
    }
  }

  const { originalCommand } = context
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false
      }
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false
      }
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('zy_bash_security_check_triggered', {
          checkId: securityCheckIds.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message: tSync('bashSecurity.commentQuoteDesync'),
        }
      }
      if (lineEnd === -1) {
        break
      }
      i = lineEnd
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noCommentQuoteDesync') }
}

export function validateQuotedNewline(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noNewlineOrHash') }
  }

  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('zy_bash_security_check_triggered', {
          checkId: securityCheckIds.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message: tSync('bashSecurity.quotedNewlineHash'),
        }
      }
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noQuotedNewlineHash') }
}

export function validateZshDangerousCommands(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  const trimmed = context.originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  const zshPrecommandModifiers = new Set(['command', 'builtin', 'noglob', 'nocorrect'])
  let baseCmd = ''
  for (const token of tokens) {
    if (/^[A-Za-z_]\w*=/.test(token)) {
      continue
    }
    if (zshPrecommandModifiers.has(token)) {
      continue
    }
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.zshDangerousCommand', { baseCmd }),
    }
  }

  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: securityCheckIds.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.fcEditor'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noZshDangerousCommands'),
  }
}
