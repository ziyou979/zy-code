import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../../i18n/index.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { type ValidationContext, type BashSecurityCheckIds } from './securityTypes.js'

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
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
    if (!inSingleQuote && !inDoubleQuote && char === '\\' && i + 1 < command.length) {
      const next = command[i + 1]
      if (/[|&;<>`$(){}[\]]/.test(next)) {
        return true
      }
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

  return { behavior: 'passthrough', message: tSync('bashSecurity.noBackslashOperators') }
}

export function validateCommentQuoteDesync(
  context: ValidationContext,
  securityCheckIds: BashSecurityCheckIds,
): PermissionResult {
  if (context.treeSitter) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.treeSitterAuthoritative') }
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
