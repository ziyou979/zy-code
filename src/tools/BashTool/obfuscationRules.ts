import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../../i18n/index.js'
import type { PermissionResult } from 'src/types/permissions.js'
import { type ValidationContext, type BashSecurityCheckIds } from './securityTypes.js'

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

  return { behavior: 'passthrough', message: '' }
}

function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    } else if (char === '\\' && !inSingleQuote && !inDoubleQuote) {
      if (i + 1 < command.length && /\s/.test(command[i + 1])) {
        return true
      }
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
  return { behavior: 'passthrough', message: tSync('bashSecurity.noBackslashWhitespace') }
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
