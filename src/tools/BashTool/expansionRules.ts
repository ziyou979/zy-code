import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../../i18n/index.js'
import type { PermissionResult } from 'src/types/permissions.js'
import {
  type ValidationContext,
  type BashSecurityCheckIds,
  isEscapedAtPosition,
} from './securityTypes.js'

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

  return { behavior: 'passthrough', message: tSync('bashSecurity.noBraceExpansion') }
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

  return { behavior: 'passthrough', message: tSync('bashSecurity.noZshDangerousCommands') }
}
