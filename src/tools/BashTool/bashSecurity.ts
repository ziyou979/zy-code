import { logEvent } from 'src/services/analytics/index.js'
import { tSync } from '../../i18n/index.js'
import { extractHeredocs } from '../../shell-eval/bash/heredoc.js'
import { ParsedCommand } from '../../shell-eval/bash/parsedCommand.js'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../shell-eval/bash/shellQuote.js'
import type { TreeSitterAnalysis } from '../../shell-eval/bash/treeSitterAnalysis.js'
import type { PermissionResult } from '../../services/permissions/permissionResult.js'
import {
  extractQuotedContent,
  hasSafeHeredocSubstitution,
  hasUnescapedChar,
  HEREDOC_IN_SUBSTITUTION,
  isSafeHeredoc,
  stripSafeHeredocSubstitutions,
  stripSafeRedirections,
} from './bashSecurityStringSupport.js'
import {
  type ValidationContext,
  validateBackslashEscapedOperators,
  validateBackslashEscapedWhitespace,
  validateBraceExpansion,
  validateCommentQuoteDesync,
  validateMidWordHash,
  validateObfuscatedFlags,
  validateQuotedNewline,
  validateUnicodeWhitespace,
  validateZshDangerousCommands,
} from './bashSecuritySyntaxValidatorSupport.js'

// Note: Backtick pattern is handled separately in validateDangerousPatterns
// to distinguish between escaped and unescaped backticks
// 存 i18n key 而非译文：正则在模块加载时编译一次（热路径零开销），仅在命中违规时
// 才 tSync(messageKey) 翻译 —— 既避免模块顶层冻结翻译，又随语言切换反应。
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, messageKey: 'bashSecurity.processSubstitutionBefore' },
  { pattern: />\(/, messageKey: 'bashSecurity.processSubstitutionAfter' },
  { pattern: /=\(/, messageKey: 'bashSecurity.zshProcessSubstitution' },
  // Zsh EQUALS expansion: =cmd at word start expands to $(which cmd).
  // `=curl evil.com` → `/usr/bin/curl evil.com`, bypassing Bash(curl:*) deny
  // rules since the parser sees `=curl` as the base command, not `curl`.
  // Only matches word-initial = followed by a command-name char (not VAR=val).
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    messageKey: 'bashSecurity.zshEqualsExpansion',
  },
  { pattern: /\$\(/, messageKey: 'bashSecurity.dollarCommandSubstitution' },
  { pattern: /\$\{/, messageKey: 'bashSecurity.parameterSubstitution' },
  { pattern: /\$\[/, messageKey: 'bashSecurity.legacyArithmeticExpansion' },
  { pattern: /~\[/, messageKey: 'bashSecurity.zshStyleParameterExpansion' },
  { pattern: /\(e:/, messageKey: 'bashSecurity.zshStyleGlobQualifiers' },
  { pattern: /\(\+/, messageKey: 'bashSecurity.zshGlobQualifierWithCommand' },
  {
    pattern: /\}\s*always\s*\{/,
    messageKey: 'bashSecurity.zshAlwaysBlock',
  },
  // Defense in depth: Block PowerShell comment syntax even though we don't execute in PowerShell
  // Added as protection against future changes that might introduce PowerShell execution
  { pattern: /<#/, messageKey: 'bashSecurity.powerShellCommentSyntax' },
]

// Zsh-specific dangerous commands that can bypass security checks.
// These are checked against the base command (first word) of each command segment.
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload is the gateway to many dangerous module-based attacks:
  // zsh/mapfile (invisible file I/O via array assignment),
  // zsh/system (sysopen/syswrite two-step file access),
  // zsh/zpty (pseudo-terminal command execution),
  // zsh/net/tcp (network exfiltration via ztcp),
  // zsh/files (builtin rm/mv/ln/chmod that bypass binary checks)
  'zmodload',
  // emulate with -c flag is an eval-equivalent that executes arbitrary code
  'emulate',
  // Zsh module builtins that enable dangerous operations.
  // These require zmodload first, but we block them as defense-in-depth
  // in case zmodload is somehow bypassed or the module is pre-loaded.
  'sysopen', // Opens files with fine-grained control (zsh/system)
  'sysread', // Reads from file descriptors (zsh/system)
  'syswrite', // Writes to file descriptors (zsh/system)
  'sysseek', // Seeks on file descriptors (zsh/system)
  'zpty', // Executes commands on pseudo-terminals (zsh/zpty)
  'ztcp', // Creates TCP connections for exfiltration (zsh/net/tcp)
  'zsocket', // Creates Unix/TCP sockets (zsh/net/socket)
  'mapfile', // Not actually a command, but the associative array is set via zmodload
  'zf_rm', // Builtin rm from zsh/files
  'zf_mv', // Builtin mv from zsh/files
  'zf_ln', // Builtin ln from zsh/files
  'zf_chmod', // Builtin chmod from zsh/files
  'zf_chown', // Builtin chown from zsh/files
  'zf_mkdir', // Builtin mkdir from zsh/files
  'zf_rmdir', // Builtin rmdir from zsh/files
  'zf_chgrp', // Builtin chgrp from zsh/files
])

// Numeric identifiers for bash security checks (to avoid logging strings)
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
} as const

function validateObfuscatedFlagsWithIds(context: ValidationContext): PermissionResult {
  return validateObfuscatedFlags(context, BASH_SECURITY_CHECK_IDS)
}

function validateBackslashEscapedWhitespaceWithIds(context: ValidationContext): PermissionResult {
  return validateBackslashEscapedWhitespace(context, BASH_SECURITY_CHECK_IDS)
}

function validateBackslashEscapedOperatorsWithIds(context: ValidationContext): PermissionResult {
  return validateBackslashEscapedOperators(context, BASH_SECURITY_CHECK_IDS)
}

function validateBraceExpansionWithIds(context: ValidationContext): PermissionResult {
  return validateBraceExpansion(context, BASH_SECURITY_CHECK_IDS)
}

function validateUnicodeWhitespaceWithIds(context: ValidationContext): PermissionResult {
  return validateUnicodeWhitespace(context, BASH_SECURITY_CHECK_IDS)
}

function validateMidWordHashWithIds(context: ValidationContext): PermissionResult {
  return validateMidWordHash(context, BASH_SECURITY_CHECK_IDS)
}

function validateCommentQuoteDesyncWithIds(context: ValidationContext): PermissionResult {
  return validateCommentQuoteDesync(context, BASH_SECURITY_CHECK_IDS)
}

function validateQuotedNewlineWithIds(context: ValidationContext): PermissionResult {
  return validateQuotedNewline(context, BASH_SECURITY_CHECK_IDS)
}

function validateZshDangerousCommandsWithIds(context: ValidationContext): PermissionResult {
  return validateZshDangerousCommands(context, BASH_SECURITY_CHECK_IDS)
}

function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    }
  }
  return { behavior: 'passthrough', message: tSync('bashSecurity.empty') }
}

function validateIncompleteCommands(context: ValidationContext): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.incompleteTab'),
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.incompleteFlags'),
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.incompleteOperator'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.complete') }
}

function validateSafeCommandSubstitution(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noHeredocInSubstitution') }
  }

  if (
    isSafeHeredoc(
      originalCommand,
      (remaining) => bashCommandIsSafe_DEPRECATED(remaining).behavior === 'passthrough',
    )
  ) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Safe command substitution: cat with quoted/escaped heredoc delimiter',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.commandSubstitutionNeedsValidation'),
  }
}

function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.notGitCommit') }
  }

  // SECURITY: Backslashes can cause our regex to mis-identify quote boundaries
  // (e.g., `git commit -m "test\"msg" && evil`). Legitimate commit messages
  // virtually never contain backslashes, so bail to the full validator chain.
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.gitBackslash'),
    }
  }

  // SECURITY: The `.*?` before `-m` must NOT match shell operators. Previously
  // `.*?` matched anything except `\n`, including `;`, `&`, `|`, `` ` ``, `$(`.
  // For `git commit ; curl evil.com -m 'x'`, `.*?` swallowed `; curl evil.com `
  // leaving remainder=`` (falsy → remainder check skipped) → returned `allow`
  // for a compound command. Early-allow skips ALL main validators (line ~1908),
  // nullifying validateQuotedNewline, validateBackslashEscapedOperators, etc.
  // While splitCommand currently catches this downstream, early-allow is a
  // POSITIVE ASSERTION that the FULL command is safe — which it is NOT.
  //
  // Also: `\s+` between `git` and `commit` must NOT match `\n`/`\r` (command
  // separators in bash). Use `[ \t]+` for horizontal-only whitespace.
  //
  // The `[^;&|`$<>()\n\r]*?` class excludes shell metacharacters. We also
  // exclude `<` and `>` here (redirects) — they're allowed in the REMAINDER
  // for `--author="Name <email>"` but must not appear BEFORE `-m`.
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('zy_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: tSync('bashSecurity.gitCommitSubstitution'),
      }
    }

    // SECURITY: Check remainder for shell operators that could chain commands
    // or redirect output. The `.*` before `-m` in the regex can swallow flags
    // like `--amend`, leaving `&& evil` or `> ~/.bashrc` in the remainder.
    // Previously we only checked for $() / `` / ${} here, missing operators
    // like ; | & && || < >.
    //
    // `<` and `>` can legitimately appear INSIDE quotes in --author values
    // like `--author="Name <email>"`. An UNQUOTED `>` is a shell redirect
    // operator. Because validateGitCommit is an EARLY validator, returning
    // `allow` here short-circuits bashCommandIsSafe and SKIPS
    // validateRedirections. So we must bail to passthrough on unquoted `<>`
    // to let the main validators handle it.
    //
    // Attack: `git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit returns allow → bashCommandIsSafe short-circuits →
    //   validateRedirections NEVER runs → ~/.bashrc overwritten with git
    //   stdout containing `payload` → RCE on next shell login.
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: tSync('bashSecurity.gitRemainderMetacharacters'),
      }
    }
    if (remainder) {
      // Strip quoted content, then check for `<` or `>`. Quoted `<>` (email
      // brackets in --author) are safe; unquoted `<>` are shell redirects.
      // NOTE: This simple quote tracker has NO backslash handling. `\'`/`\"`
      // outside quotes would desync it (bash: \' = literal ', tracker: toggles
      // SQ). BUT line 584 already bailed on ANY backslash in originalCommand,
      // so we never reach here with backslashes. For backslash-free input,
      // simple quote toggling is correct (no way to escape quotes without \\).
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) {
          unquoted += c
        }
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: tSync('bashSecurity.gitRemainderRedirect'),
        }
      }
    }

    // Security hardening: block messages starting with dash
    // This catches potential obfuscation patterns like git commit -m "---"
    if (messageContent?.startsWith('-')) {
      logEvent('zy_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: tSync('bashSecurity.quotedInFlag'),
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Git commit with simple quoted message is allowed',
      },
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.gitCommitNeedsValidation') }
}

function validateJqCommand(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: tSync('bashSecurity.notJq') }
  }

  if (/\bsystem\s*\(/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.jqSystemFunction'),
    }
  }

  // File arguments are now allowed - they will be validated by path validation in readOnlyValidation.ts
  // Only block dangerous flags that could read files into jq variables
  const afterJq = originalCommand.substring(3).trim()
  if (/(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(afterJq)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.jqDangerousFlags'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.jqSafe') }
}

function validateShellMetacharacters(context: ValidationContext): PermissionResult {
  const { unquotedContent } = context
  const message = tSync('bashSecurity.shellMetacharacters')

  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 1,
    })
    return { behavior: 'ask', message }
  }

  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ]

  if (globPatterns.some((p) => p.test(unquotedContent))) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 2,
    })
    return { behavior: 'ask', message }
  }

  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 3,
    })
    return { behavior: 'ask', message }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noMetacharacters') }
}

function validateDangerousVariables(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.dangerousVariables'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noDangerousVariables') }
}

function validateDangerousPatterns(context: ValidationContext): PermissionResult {
  const { unquotedContent } = context

  // Special handling for backticks - check for UNESCAPED backticks only
  // Escaped backticks (e.g., \`) are safe and commonly used in SQL commands
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.backticks'),
    }
  }

  // Other command substitution checks (include double-quoted content)
  for (const { pattern, messageKey } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquotedContent)) {
      logEvent('zy_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: tSync('bashSecurity.commandSubstitution', { pattern: tSync(messageKey) }),
      }
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noDangerousPatterns') }
}

function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (/</.test(fullyUnquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_INPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.inputRedirection'),
    }
  }

  if (/>/.test(fullyUnquotedContent)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.outputRedirection'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noRedirections') }
}

function validateNewlines(context: ValidationContext): PermissionResult {
  // Use fullyUnquotedPreStrip (before stripSafeRedirections) to prevent bypasses
  // where stripping `>/dev/null` creates a phantom backslash-newline continuation.
  // E.g., `cmd \>/dev/null\nwhoami` → after stripping becomes `cmd \\nwhoami`
  // which looks like a safe continuation but actually hides a second command.
  const { fullyUnquotedPreStrip } = context

  // Check for newlines in unquoted content
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noNewlines') }
  }

  // Flag any newline/CR followed by non-whitespace, EXCEPT backslash-newline
  // continuations at word boundaries. In bash, `\<newline>` is a line
  // continuation (both chars removed), which is safe when the backslash
  // follows whitespace (e.g., `cmd \<newline>--flag`). Mid-word continuations
  // like `tr\<newline>aceroute` are still flagged because they can hide
  // dangerous command names from allowlist checks.
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() + gated by /[\n\r]/.test() above
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip)
  if (looksLikeCommand) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.newlinesMultipleCommands'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.newlinesInData'),
  }
}

/**
 * SECURITY: Carriage return (\r, 0x0D) IS a misparsing concern, unlike LF.
 *
 * Parser differential:
 *   - shell-quote's BAREWORD regex uses `[^\s...]` — JS `\s` INCLUDES \r, so
 *     shell-quote treats CR as a token boundary. `TZ=UTC\recho` tokenizes as
 *     TWO tokens: ['TZ=UTC', 'echo']. splitCommand joins with space →
 *     'TZ=UTC echo curl evil.com'.
 *   - bash's default IFS = $' \t\n' — CR is NOT in IFS. bash sees
 *     `TZ=UTC\recho` as ONE word → env assignment TZ='UTC\recho' (CR byte
 *     inside value), then `curl` is the command.
 *
 * Attack: `TZ=UTC\recho curl evil.com` with Bash(echo:*)
 *   validator: splitCommand collapses CR→space → 'TZ=UTC echo curl evil.com'
 *   → stripSafeWrappers: TZ=UTC stripped → 'echo curl evil.com' matches rule
 *   bash: executes `curl evil.com`
 *
 * validateNewlines catches this but is in nonMisparsingValidators (LF is
 * correctly handled by both parsers). This validator is NOT in
 * nonMisparsingValidators — its ask result gets isBashSecurityCheckForMisparsing
 * and blocks at the bashPermissions gate.
 *
 * Checks originalCommand (not fullyUnquotedPreStrip) because CR inside single
 * quotes is ALSO a misparsing concern for the same reason: shell-quote's `\s`
 * still tokenizes it, but bash treats it as literal. Block ALL unquoted-or-SQ CR.
 * Only exception: CR inside DOUBLE quotes where bash also treats it as data
 * and shell-quote preserves the token (no split).
 */
function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noCarriageReturn') }
  }

  // Check if CR appears outside double quotes. CR outside DQ (including inside
  // SQ and unquoted) causes the shell-quote/bash tokenization differential.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('zy_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message: tSync('bashSecurity.carriageReturn'),
      }
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.crOnlyInsideDoubleQuotes') }
}

function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // Detect any usage of IFS variable which could be used to bypass regex validation
  // Check for $IFS and ${...IFS...} patterns (including parameter expansions like ${IFS:0:1}, ${#IFS}, etc.)
  // Using ${[^}]*IFS to catch all parameter expansion variations with IFS
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.ifsVariable'),
    }
  }

  return { behavior: 'passthrough', message: tSync('bashSecurity.noIfsInjection') }
}

// Additional hardening against reading environment variables via /proc filesystem.
// Path validation typically blocks /proc access, but this provides defense-in-depth.
// Environment files in /proc can expose sensitive data like API keys and secrets.
function validateProcEnvironAccess(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // Check for /proc paths that could expose environment variables
  // This catches patterns like:
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ (with any PID)
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.procEnviron'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noProcEnviron'),
  }
}

/**
 * Detects commands with malformed tokens (unbalanced delimiters) combined with
 * command separators. This catches potential injection patterns where ambiguous
 * shell syntax could be exploited.
 *
 * Security: This check catches the eval bypass discovered in HackerOne review.
 * When shell-quote parses ambiguous patterns like `echo {"hi":"hi;evil"}`,
 * it may produce unbalanced tokens (e.g., `{hi:"hi`). Combined with command
 * separators, this can lead to unintended command execution via eval re-parsing.
 *
 * By forcing user approval for these patterns, we ensure the user sees exactly
 * what will be executed before approving.
 */
function validateMalformedTokenInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // Parse failed - this is handled elsewhere (bashToolHasPermission checks this)
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.parseFailed'),
    }
  }

  const parsed = parseResult.tokens

  // Check for command separators (;, &&, ||)
  const hasCommandSeparator = parsed.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noCommandSeparators') }
  }

  // Check for malformed tokens (unbalanced delimiters)
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.ambiguousSeparators'),
    }
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.noMalformedToken'),
  }
}

/**
 * Detects a backslash immediately preceding a shell operator outside of quotes.
 *
 * SECURITY: splitCommand normalizes `\;` to a bare `;` in its output string.
 * When downstream code (checkReadOnlyConstraints, checkPathConstraints, etc.)
 * re-parses that normalized string, the bare `;` is seen as an operator and
 * causes a false split. This enables arbitrary file read bypassing path checks:
 *
 *   cat safe.txt \; echo ~/.ssh/id_rsa
 *
 * In bash: ONE cat command reading safe.txt, ;, echo, ~/.ssh/id_rsa as files.
 * After splitCommand normalizes: "cat safe.txt ; echo ~/.ssh/id_rsa"
 * Nested re-parse: ["cat safe.txt", "echo ~/.ssh/id_rsa"] — both segments
 * pass isCommandReadOnly, sensitive path hidden in echo segment is never
 * validated by path constraints. Auto-allowed. Private key leaked.
 *
 * This check flags any \<operator> regardless of backslash parity. Even counts
 * (\\;) are dangerous in bash (\\ → \, ; separates). Odd counts (\;) are safe
 * in bash but trigger the double-parse bug above. Both must be flagged.
 *
 * Known false positive: `find . -exec cmd {} \;` — users will be prompted once.
 *
 * Note: `(` and `)` are NOT in this set — splitCommand preserves `\(` and `\)`
 * in its output (round-trip safe), so they don't trigger the double-parse bug.
 * This allows `find . \( -name x -o -name y \)` to pass without false positives.
 */
/**
 * Detects when a `#` comment contains quote characters that would desync
 * downstream quote trackers (like extractQuotedContent).
 *
 * In bash, everything after an unquoted `#` on a line is a comment — quote
 * characters inside the comment are literal text, not quote toggles. But our
 * quote-tracking functions don't handle comments, so a `'` or `"` after `#`
 * toggles their quote state. Attackers can craft `# ' "` sequences that
 * precisely desync the tracker, causing subsequent content (on following
 * lines) to appear "inside quotes" when it's actually unquoted in bash.
 *
 * Example attack:
 *   echo "it's" # ' " <<'MARKER'\n
 *   rm -rf /\n
 *   MARKER
 * In bash: `#` starts a comment, `rm -rf /` executes on line 2.
 * In extractQuotedContent: the `'` at position 14 (after #) opens a single
 * quote, and the `'` before MARKER closes it. But the `'` after MARKER opens
 * ANOTHER single quote, swallowing the newline and `rm -rf /`, so
 * validateNewlines sees no unquoted newlines.
 *
 * Defense: If we see an unquoted `#` followed by any quote character on the
 * same line, treat it as a misparsing concern. Legitimate commands rarely
 * have quote characters in their comments (and if they do, the user can
 * approve manually).
 */
/**
 * Detects a newline inside a quoted string where the NEXT line would be
 * stripped by stripCommentLines (trimmed line starts with `#`).
 *
 * In bash, `\n` inside quotes is a literal character and part of the argument.
 * But stripCommentLines (called by stripSafeWrappers in bashPermissions before
 * path validation and rule matching) processes commands LINE-BY-LINE via
 * `command.split('\n')` without tracking quote state. A quoted newline lets an
 * attacker position the next line to start with `#` (after trim), causing
 * stripCommentLines to drop that line entirely — hiding sensitive paths or
 * arguments from path validation and permission rule matching.
 *
 * Example attack (auto-allowed in acceptEdits mode without any Bash rules):
 *   mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir
 * Bash: moves ./decoy AND ~/.ssh/id_rsa into ./exfil_dir/ (errors on `\n#`).
 * stripSafeWrappers: line 2 starts with `#` → stripped → "mv ./decoy '".
 * shell-quote: drops unbalanced trailing quote → ["mv", "./decoy"].
 * checkPathConstraints: only sees ./decoy (in cwd) → passthrough.
 * acceptEdits mode: mv with all-cwd paths → ALLOW. Zero clicks, no warning.
 *
 * Also works with cp (exfil), rm/rm -rf (delete arbitrary files/dirs).
 *
 * Defense: block ONLY the specific stripCommentLines trigger — a newline inside
 * quotes where the next line starts with `#` after trim. This is the minimal
 * check that catches the parser differential while preserving legitimate
 * multi-line quoted arguments (echo 'line1\nline2', grep patterns, etc.).
 * Safe heredocs ($(cat <<'EOF'...)) and git commit -m "..." are handled by
 * early validators and never reach this check.
 *
 * This validator is NOT in nonMisparsingValidators — its ask result gets
 * isBashSecurityCheckForMisparsing: true, causing an early block in the
 * permission flow at bashPermissions.ts before any line-based processing runs.
 */
/**
 * Validates that the command doesn't use Zsh-specific dangerous commands that
 * can bypass security checks. These commands provide capabilities like loading
 * kernel modules, raw file I/O, network access, and pseudo-terminal execution
 * that circumvent normal permission checks.
 *
 * Also catches `fc -e` which can execute arbitrary editors on command history,
 * and `emulate` which with `-c` is an eval-equivalent.
 */
// Matches non-printable control characters that have no legitimate use in shell
// commands: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F. Excludes tab (0x09),
// newline (0x0A), and carriage return (0x0D) which are handled by other
// validators. Bash silently drops null bytes and ignores most control chars,
// so an attacker can use them to slip metacharacters past our checks while
// bash still executes them (e.g., "echo safe\x00; rm -rf /").
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 */
export function bashCommandIsSafe_DEPRECATED(command: string): PermissionResult {
  // SECURITY: Block control characters before any other processing. Null bytes
  // and other non-printable chars are silently dropped by bash but confuse our
  // validators, allowing metacharacters adjacent to them to slip through.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.controlCharacters'),
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Detect '\' patterns that exploit shell-quote's incorrect handling
  // of backslashes inside single quotes. Must run before shell-quote parsing.
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.singleQuotedBackslash'),
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Strip heredoc bodies before running security validators.
  // Only strip bodies for quoted/escaped delimiters (<<'EOF', <<\EOF) where
  // the body is literal text — $(), backticks, and ${} are NOT expanded.
  // Unquoted heredocs (<<EOF) undergo full shell expansion, so their bodies
  // may contain executable command substitutions that validators must see.
  // When extractHeredocs bails out (can't parse safely), the raw command
  // goes through all validators — which is the safe direction.
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' || result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // Validators that don't set isBashSecurityCheckForMisparsing — their ask
  // results go through the standard permission flow rather than being blocked
  // early. LF newlines and redirections are normal patterns that splitCommand
  // handles correctly, not misparsing concerns.
  //
  // NOTE: validateCarriageReturn is NOT here — CR IS a misparsing concern.
  // shell-quote's `[^\s]` treats CR as a word separator (JS `\s` ⊃ \r), but
  // bash IFS does NOT include CR. splitCommand collapses CR→space, which IS
  // misparsing. See validateCarriageReturn for the full attack trace.
  const nonMisparsingValidators = new Set([validateNewlines, validateRedirections])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlagsWithIds,
    validateShellMetacharacters,
    validateDangerousVariables,
    // Run comment-quote-desync BEFORE validateNewlines: it detects cases where
    // the quote tracker would miss newlines due to # comment desync.
    validateCommentQuoteDesyncWithIds,
    // Run quoted-newline BEFORE validateNewlines: it detects the INVERSE case
    // (newlines INSIDE quotes, which validateNewlines ignores by design). Quoted
    // newlines let attackers split commands across lines so that line-based
    // processing (stripCommentLines) drops sensitive content.
    validateQuotedNewlineWithIds,
    // CR check runs BEFORE validateNewlines — CR is a MISPARSING concern
    // (shell-quote/bash tokenization differential), LF is not.
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespaceWithIds,
    validateBackslashEscapedOperatorsWithIds,
    validateUnicodeWhitespaceWithIds,
    validateMidWordHashWithIds,
    validateBraceExpansionWithIds,
    validateZshDangerousCommandsWithIds,
    // Run malformed token check last - other validators should catch specific patterns first
    // (e.g., $() substitution, backticks, etc.) since they have more precise error messages
    validateMalformedTokenInjection,
  ]

  // SECURITY: We must NOT short-circuit when a non-misparsing validator
  // returns 'ask' if there are still misparsing validators later in the list.
  // Non-misparsing ask results are discarded at bashPermissions.ts:~1301-1303
  // (the gate only blocks when isBashSecurityCheckForMisparsing is set). If
  // validateRedirections (index 10, non-misparsing) fires first on `>`, it
  // returns ask-without-flag — but validateBackslashEscapedOperators (index 12,
  // misparsing) would have caught `\;` WITH the flag. Short-circuiting lets a
  // payload like `cat safe.txt \; echo /etc/passwd > ./out` slip through.
  //
  // Fix: defer non-misparsing ask results. Continue running validators; if any
  // misparsing validator fires, return THAT (with the flag). Only if we reach
  // the end without a misparsing ask, return the deferred non-misparsing ask.
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.allChecksPassed'),
  }
}

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 *
 * Async version of bashCommandIsSafe that uses tree-sitter when available
 * for more accurate parsing. Falls back to the sync regex version when
 * tree-sitter is not available.
 *
 * This should be used by async callers (bashPermissions.ts, bashCommandHelpers.ts).
 * Sync callers (readOnlyValidation.ts) should continue using bashCommandIsSafe().
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // Try to get tree-sitter analysis
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // If no tree-sitter, fall back to sync version
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // Run the same security checks but with tree-sitter enriched context.
  // The early checks (control chars, shell-quote bug) don't benefit from
  // tree-sitter, so we run them identically.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('zy_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.controlCharacters'),
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.singleQuotedBackslash'),
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // Use tree-sitter quote context for more accurate analysis
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(processedCommand, baseCommand === 'jq')

  // Use tree-sitter quote context as primary, but keep regex as reference
  // for divergence logging
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // Log divergence between tree-sitter and regex quote extraction.
  // Skip for heredoc commands: tree-sitter strips (quoted) heredoc bodies
  // to nothing while the regex path replaces them with placeholder strings
  // (via extractHeredocs), so the two outputs can never match. Logging
  // divergence for every heredoc command would poison the signal.
  //
  // onDivergence callback: when called in a fanout loop (bashPermissions.ts
  // Promise.all over subcommands), the caller batches divergences into a
  // single logEvent instead of N separate calls. Each logEvent triggers
  // getEventMetadata() → buildProcessMetrics() → process.memoryUsage() →
  // /proc/self/stat read; with memoized metadata these resolve as microtasks
  // and starve the event loop (CC-643). Single-command callers omit the
  // callback and get the original per-call logEvent behavior.
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('zy_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' || result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  const nonMisparsingValidators = new Set([validateNewlines, validateRedirections])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlagsWithIds,
    validateShellMetacharacters,
    validateDangerousVariables,
    validateCommentQuoteDesyncWithIds,
    validateQuotedNewlineWithIds,
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespaceWithIds,
    validateBackslashEscapedOperatorsWithIds,
    validateUnicodeWhitespaceWithIds,
    validateMidWordHashWithIds,
    validateBraceExpansionWithIds,
    validateZshDangerousCommandsWithIds,
    validateMalformedTokenInjection,
  ]

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: tSync('bashSecurity.allChecksPassed'),
  }
}

export { hasSafeHeredocSubstitution, stripSafeHeredocSubstitutions }
