/**
 * 用于命令验证的 PowerShell 专用安全分析。
 *
 * 检测代码注入、download cradle、权限提升、动态命令名、COM object 等危险模式。
 *
 * 所有检查都基于 AST。解析失败（valid=false）时，单项检查均不会匹配，
 * powershellCommandIsSafe 会返回 'ask'。
 */

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../shell-eval/powershell/dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../shell-eval/powershell/parser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from '../../shell-eval/powershell/parser.js'
import { isClmAllowedType } from './clmTypes.js'

type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}

const POWERSHELL_EXECUTABLES = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])

/**
 * 从命令提取可执行文件 basename，处理 /usr/bin/pwsh、
 * C:\Windows\...\powershell.exe、.\pwsh 等完整路径。
 */
function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // 从路径提取 basename，同时支持 / 和 \ 分隔符。
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * PowerShell 视为等同于 ASCII 连字符 U+002D 的其他参数前缀字符。PowerShell tokenizer
 *（SpecialCharacters.IsDash）和 powershell.exe 的 CommandLineParameterParser
 * 都接受四种 dash 字符，另接受 Windows PowerShell 5.1 的 `/` 参数分隔符。
 * Extent.Text 会保留原始字符；transformCommandAst 对 CommandParameterAst 元素使用
 * ce.text，因此这些字符会原样到达这里。
 */
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1 (powershell.exe, not pwsh 7+)
  '\u2013', // en-dash
  '\u2014', // em-dash
  '\u2015', // horizontal bar
])

/**
 * commandHasArgAbbreviation 的 wrapper，同时匹配 `/`、en-dash、em-dash、
 * horizontal-bar 等替代参数前缀。PowerShell tokenizer（SpecialCharacters.IsDash）
 * 对 powershell.exe 参数和 cmdlet 参数都接受这些字符，因此所有 PS 参数检查都应使用
 * 此函数，而不只用于 pwsh.exe 调用。此前多个检查直接使用
 * commandHasArgAbbreviation，导致 `Start-Process foo –Verb RunAs` 可绕过。
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // 将替代前缀规范化为 `-` 后重新检查。用规范化参数构造合成 cmd；
  // commandHasArgAbbreviation 会处理冒号值拆分。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map((a) =>
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? `-${a.slice(1)}` : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 检查 PowerShell 命令是否使用 Invoke-Expression 或其 alias iex。
 * 二者等同于 eval，可执行任意代码。
 */
function checkInvokeExpression(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message: 'Command uses Invoke-Expression which can execute arbitrary code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查命令名本身为无法静态解析表达式的动态命令调用。
 *
 * PoCs:
 *   & ${function:Invoke-Expression} 'payload'  — VariableExpressionAst
 *   & ('iex','x')[0] 'payload'                 — IndexExpressionAst → 'Other'
 *   & ('i'+'ex') 'payload'                     — BinaryExpressionAst → 'Other'
 *
 * 在所有情况下，cmd.name 都是字面 extent 文本，无法匹配
 * hasCommandNamed('Invoke-Expression')。运行时 PowerShell 会把表达式求值为命令名并调用。
 *
 * 合法命令名始终是 StringConstantExpressionAst（映射为 'StringConstant'），
 * 如 `Get-Process`、`git`、`ls`。名称位置的其他元素类型都是动态的。与其建立脆弱的
 * 动态类型 denylist（mapElementType 默认会把未知 AST 类型映射为 'Other'，
 * `=== 'Variable'` 检查会漏掉），这里将 'StringConstant' 加入 allowlist。
 *
 * elementTypes[0] 是命令名元素；transformCommandAst 会在参数元素前先加入它。
 * elementTypes 缺失时，`!== undefined` 关卡保持 fail-open，因为解析细节不可用；
 * 若解析彻底失败，链路上游已因 valid=false 返回 'ask'。
 */
function checkDynamicCommandName(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
    const nameElementType = cmd.elementTypes?.[0]
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message: 'Command name is a dynamic expression which cannot be statically validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查会掩盖意图的编码命令参数；恶意软件常用它们绕过安全工具。
 */
function checkEncodedCommand(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: 'Command uses encoded parameters which obscure intent',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 PowerShell 再调用（嵌套 pwsh/powershell 进程）。
 *
 * 命令位置出现任何 PowerShell 可执行文件都会被标记，而不只检查 -Command/-File。
 * 裸 `pwsh` 接收 stdin（`Get-Content x | pwsh`）或位置脚本路径时，不带任何显式 flag
 * 也能执行任意代码。理由与 checkStartProcess 向量 2 相同：嵌套进程不可验证，
 * 无法静态分析子进程将运行什么。
 */
function checkPwshCommandOrFile(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message: 'Command spawns a nested PowerShell process which cannot be validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 download cradle 模式，即下载并执行远程代码的常见恶意软件技术。
 *
 * Per-statement: catches piped cradles (`IWR ... | IEX`).
 * Cross-statement: catches split cradles (`$r = IWR ...; IEX $r.Content`).
 * The cross-statement case is already blocked by checkInvokeExpression (which
 * scans all statements), but this check improves the warning message.
 */
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // MITRE T1197
])

function isDownloader(name: string): boolean {
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

function isIex(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

function checkDownloadCradles(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  // 逐语句：管道 cradle（IWR ... | IEX）。
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
    const hasDownloader = cmds.some((cmd) => isDownloader(cmd.name))
    const hasIex = cmds.some((cmd) => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'ask',
        message: 'Command downloads and executes remote code',
      }
    }
  }

  // 跨语句：拆分 cradle（$r = IWR ...; IEX $r.Content）。不会新增误报；
  // 只要存在 IEX，checkInvokeExpression 本就会 ask。
  const all = getAllCommands(parsed)
  if (all.some((c) => isDownloader(c.name)) && all.some((c) => isIex(c.name))) {
    return {
      behavior: 'ask',
      message: 'Command downloads and executes remote code',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 检查独立下载工具，即常用于获取 payload 的 LOLBAS 工具。checkDownloadCradles
 * 要求管道内同时出现下载和 IEX，而此检查会标记下载操作本身。
 *
 * Start-BitsTransfer: always a file transfer (MITRE T1197).
 * certutil -urlcache: classic LOLBAS download. Only flagged with -urlcache;
 * bare `certutil` has many legitimate cert-management uses.
 * bitsadmin /transfer: legacy BITS download (pre-PowerShell).
 */
function checkDownloadUtilities(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // Start-BitsTransfer 专用于文件传输，不存在安全变体。
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: 'Command downloads files via BITS transfer',
      }
    }
    // certutil / certutil.exe — only when -urlcache is present. certutil has
    // many non-download uses (cert store queries, encoding, etc.).
    // certutil.exe accepts both -urlcache and /urlcache per standard Windows
    // utility convention — check both forms (bitsadmin below does the same).
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some((a) => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: 'Command uses certutil to download from a URL',
        }
      }
    }
    // bitsadmin /transfer — legacy BITS CLI, same threat as Start-BitsTransfer.
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some((a) => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: 'Command downloads files via BITS transfer',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 Add-Type 使用；它会在运行时编译并加载 .NET 代码，可用于执行任意编译代码。
 */
function checkAddType(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: 'Command compiles and loads .NET code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 New-Object -ComObject。WScript.Shell、
 * Shell.Application、MMC20.Application、Schedule.Service、Msxml2.XMLHTTP
 * 自带执行或下载能力，无需 IEX。
 *
 * 无法穷举所有危险 ProgID，因此标记任何 -ComObject。单纯创建 object 不会执行操作，
 * 但 prompt 应提醒用户 COM 实例化是执行 primitive。对结果调用 .Run()、.Exec() 等
 * 方法会另由 checkMemberInvocations 捕获。
 */
function checkComObject(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // -ComObject min abbrev is -com (New-Object params: -TypeName, -ComObject,
    // -ArgumentList, -Property, -Strict; -co is ambiguous in PS5.1 due to
    // common params like -Confirm, so use -com).
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message: 'Command instantiates a COM object which may have execution capabilities',
      }
    }
    // SECURITY: checkTypeLiterals only sees [bracket] syntax from
    // parsed.typeLiterals. `New-Object System.Net.WebClient` passes the type
    // as a STRING ARG (StringConstantExpressionAst), not a TypeExpressionAst,
    // so CLM never fires. Extract -TypeName (named, colon-bound, or
    // positional-0) and run through isClmAllowedType. Closes attackVectors D4.
    let typeName: string | undefined
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // -TypeName abbrev: -t is unambiguous (no other New-Object -t* params).
      // Handle colon-bound form first: -TypeName:Foo.Bar
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // Space-separated form: -TypeName Foo.Bar
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // Positional-0 binds to -TypeName (NetParameterSet default). Named params
    // (-Strict, -ArgumentList, -Property, -ComObject) may appear before the
    // positional TypeName, so scan past them to find the first non-consumed arg.
    if (typeName === undefined) {
      // New-Object named params that consume a following value argument
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // Switch params (no value argument)
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // Skip -TypeName variants (already handled by named-param loop above)
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // skip value
            continue
          }
          // Colon-bound form: -Param:Value (single token, no skip needed)
          if (lower.includes(':')) {
            continue
          }
          if (SWITCH_PARAMS.has(lower)) {
            continue
          }
          if (VALUE_PARAMS.has(lower)) {
            i++ // skip value
            continue
          }
          // Unknown param — skip conservatively
          continue
        }
        // First non-dash arg is the positional TypeName
        typeName = a
        break
      }
    }
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object instantiates .NET type '${typeName}' outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查通过 -FilePath 或 -LiteralPath 调用的 DANGEROUS_SCRIPT_BLOCK_CMDLETS。
 * 它们会运行脚本文件，在 AST 中没有 ScriptBlockAst 的情况下执行任意代码。
 *
 * checkScriptBlockInjection 只在 hasScriptBlocks 为 true 时触发。使用 -FilePath 时
 * 不存在 ScriptBlockAst，因此不会查询 DANGEROUS_SCRIPT_BLOCK_CMDLETS。
 * 此检查补上 -FilePath 向量的缺口。
 *
 * Cmdlets in DANGEROUS_SCRIPT_BLOCK_CMDLETS that accept -FilePath:
 *   Invoke-Command   -FilePath             (icm alias via COMMON_ALIASES)
 *   Start-Job        -FilePath, -LiteralPath
 *   Start-ThreadJob  -FilePath
 *   Register-ScheduledJob -FilePath
 * The *-PSSession and Register-*Event entries do not accept -FilePath.
 *
 * -f is unambiguous for -FilePath on all four (no other -f* params).
 * -l is unambiguous for -LiteralPath on Start-Job; harmless no-op on the
 * others (no -l* params to collide with).
 */

function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath executes an arbitrary script file`,
      }
    }
    // Positional binding: `Start-Job script.ps1` binds position-0 to
    // -FilePath via FilePathParameterSet resolution (ScriptBlock args select
    // ScriptBlockParameterSet instead). Same pattern as checkForEachMemberName:
    // any non-dash StringConstant is a potential -FilePath. Over-flagging
    // (e.g., `Start-Job -Name foo` where `foo` is StringConstant) is fail-safe.
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} with positional string argument binds to -FilePath and executes a script file`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 ForEach-Object -MemberName。它按字符串名称在每个管道 object 上调用方法，
 * 语义等同于 `| % { $_.Method() }`，但 AST 中没有 ScriptBlockAst 或
 * InvokeMemberExpressionAst。
 *
 * PoC：`Get-Process | ForEach-Object -MemberName Kill` 会终止所有进程。
 * checkScriptBlockInjection 会因没有 scriptblock 漏判，checkMemberInvocations 会因没有
 * .Method() 语法漏判。alias `%` 和 `foreach` 通过 COMMON_ALIASES 解析。
 */
function checkForEachMemberName(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
    // ForEach-Object params starting with -m: only -MemberName. -m is unambiguous.
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message:
          'ForEach-Object -MemberName invokes methods by string name which cannot be validated',
      }
    }
    // PS7+: `ForEach-Object Kill` binds a positional string arg to
    // -MemberName via MemberSet parameter-set resolution (ScriptBlock args
    // select ScriptBlockSet instead). Scan ALL args — `-Verbose Kill` or
    // `-ErrorAction Stop Kill` still binds Kill positionally. Any non-dash
    // StringConstant is a potential -MemberName; over-flagging is fail-safe.
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object with positional string argument binds to -MemberName and invokes methods by name',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查危险的 Start-Process 模式。
 *
 * 两种向量：
 * 1. `-Verb RunAs`——权限提升（UAC prompt）；
 * 2. 启动 PowerShell 可执行文件——嵌套调用。
 * `Start-Process pwsh -ArgumentList "-e <b64>"` 可绕过
 * checkEncodedCommand/checkPwshCommandOrFile，因为 cmd.name 是 `Start-Process`
 * 而非 `pwsh`。`-e` 位于 -ArgumentList 字符串值内，不会解析为外层命令参数。
 * 与其解析不透明字符串或数组形式的 -ArgumentList 内容，不如标记所有目标为 PS
 * 可执行文件的 Start-Process；这种嵌套调用在结构上就无法验证。
 */
function checkStartProcess(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
    // Vector 1: -Verb RunAs (space or colon syntax).
    // Space syntax: psExeHasParamAbbreviation finds -Verb/-v, then scan args
    // for a bare 'runas' token.
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some((a) => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // Colon syntax — two layers:
    // (a) Structural: PR #23554 added children[] for colon-bound param args.
    //     children[i] = [{type, text}] for the bound value. Check if any
    //     -v*-prefixed param has a child whose text normalizes (strip
    //     quotes/backtick/whitespace) to 'runas'. Robust against arbitrary
    //     quoting the regex can't anticipate.
    // (b) Regex fallback: for parsed output without children[] or as
    //     defense-in-depth. -Verb:'RunAs', -Verb:"RunAs", -Verb:`runas all
    //     bypassed the old /...:runas$/ pattern because the quote/tick broke
    //     the match.
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
        // Strip backticks before matching param name (bug #14): -V`erb:RunAs
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-\u2013\u2014\u2015/]v[a-z]*:/i.test(argClean)) {
          continue
        }
        const kids = cmd.children[i]
        if (!kids) {
          continue
        }
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: 'Command requests elevated privileges',
            }
          }
        }
      }
    }
    if (
      cmd.args.some((a) => {
        // Strip backticks before matching (bug #14 / review nit #2)
        const clean = a.replace(/`/g, '')
        return /^[-\u2013\u2014\u2015/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(clean)
      })
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // Vector 2: Start-Process targeting a PowerShell executable.
    // Target is either the first positional arg or the value after -FilePath.
    // Scan all args — any PS-executable token present is treated as the launch
    // target. Known false-positive: path-valued params (-WorkingDirectory,
    // -RedirectStandard*) whose basename is pwsh/powershell —
    // isPowerShellExecutable extracts basenames from paths, so
    // `-WorkingDirectory C:\projects\pwsh` triggers. Accepted trade-off:
    // Start-Process is not in CMDLET_ALLOWLIST (always prompts regardless),
    // result is ask not reject, and correctly parsing Start-Process parameter
    // binding is fragile. Strip quotes the parser may have preserved.
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message: 'Start-Process launches a nested PowerShell process which cannot be validated',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * scriptblock 安全的 cmdlet（过滤或输出 cmdlet）。管道传给它们的 scriptblock
 * 只是 predicate 或 projection，不会执行任意代码。
 */
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // NOT foreach-object — its block is arbitrary script, not a predicate.
  // getAllCommands recurses so commands inside the block ARE checked, but
  // non-command AST nodes (AssignmentStatementAst etc.) are invisible to it.
  // See powershellPermissions.ts step-5 hasScriptBlocks guard.
])

/**
 * 检查 scriptblock 出现在可执行任意代码的可疑上下文中的注入模式。
 *
 * Script blocks used with safe filtering/output cmdlets (Where-Object,
 * Sort-Object, Select-Object, Group-Object) are allowed.
 * Script blocks used with dangerous cmdlets (Invoke-Command, Invoke-Expression,
 * Start-Job, etc.) are flagged.
 */
function checkScriptBlockInjection(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  const security = deriveSecurityFlags(parsed)
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // Check all commands in the parsed result. If any command is in the
  // dangerous set, flag it. If all commands with script blocks are in
  // the safe set (or the allowlist), allow it.
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command contains script block with dangerous cmdlet that may execute arbitrary code',
      }
    }
  }

  // Check if all commands are either safe script block consumers or don't use script blocks
  const allCommandsSafe = getAllCommands(parsed).every((cmd) => {
    const lower = cmd.name.toLowerCase()
    // Safe filtering/output cmdlets
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // Resolve aliases
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // Unknown command with script blocks present — flag as potentially dangerous
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: 'Command contains script block that may execute arbitrary code',
  }
}

/**
 * 仅 AST 检查：检测可能隐藏命令执行的子表达式 $()。
 */
function checkSubExpressions(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: 'Command contains subexpressions $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测嵌入 "$env:PATH" 或 "$(dangerous-command)" 等表达式的
 * 双引号可展开字符串；它们可能在字符串字面量中隐藏命令执行或变量插值。
 */
function checkExpandableStrings(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: 'Command contains expandable strings with embedded expressions',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测可能掩盖参数的 splatting（@variable）。
 */
function checkSplatting(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: 'Command uses splatting (@variable)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测会阻止继续解析的 stop-parsing token（--%）。
 */
function checkStopParsing(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: 'Command uses stop-parsing token (--%)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测可访问系统 API 的 .NET 方法调用。
 */
function checkMemberInvocations(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: 'Command invokes .NET methods',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测 Microsoft ConstrainedLanguage allowlist 之外的类型字面量。
 * CLM 会阻止除约 90 种被 Microsoft 认为可供不受信代码安全使用的 primitive/attribute
 * 外的所有 .NET 类型访问。这里将该列表作为安全边界；Reflection.Assembly、IO.Pipes、
 * Diagnostics.Process、InteropServices.Marshal 等边界外类型可访问破坏权限模型的系统 API。
 *
 * Runs AFTER checkMemberInvocations: that broadly flags any ::Method / .Method()
 * call; this check is the more specific "which types" signal. Both fire on
 * [Reflection.Assembly]::Load; CLM gives the precise message. Pure type casts
 * like [int]$x have no member invocation and only hit this check.
 */
function checkTypeLiterals(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `Command uses .NET type [${t}] outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-Item (alias ii) opens a file with its default handler (ShellExecute
 * on Windows, open/xdg-open on Unix). On an .exe/.ps1/.bat/.cmd this is RCE.
 * Bug 008: ii is in no blocklist; passthrough prompt doesn't explain the
 * exec hazard. Always ask — there is no safe variant (even opening .txt may
 * invoke a user-configured handler that accepts arguments).
 */
function checkInvokeItem(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item opens files with the default handler (ShellExecute). On executable files this runs arbitrary code.',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 计划任务持久化 primitive。Register-ScheduledJob 已由
 * DANGEROUS_SCRIPT_BLOCK_CMDLETS 阻止，但较新的 Register-ScheduledTask cmdlet
 * 和旧版 schtasks.exe /create 未被覆盖；它们可在没有解释性 prompt 的情况下创建
 * 跨会话持久化。
 */
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

function checkScheduledTask(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} creates or modifies a scheduled task (persistence primitive)`,
      }
    }
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some((a) => {
          const la = a.toLowerCase()
          return la === '/create' || la === '/change' || la === '-create' || la === '-change'
        })
      ) {
        return {
          behavior: 'ask',
          message: 'schtasks with create/change modifies scheduled tasks (persistence primitive)',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测通过 env: scope 上的 Set-Item/New-Item 修改环境变量。
 */
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // 'sc' omitted — collides with sc.exe on PS Core 7+, see COMMON_ALIASES note
  'add-content',
  'ac',
])

function checkEnvVarManipulation(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // 检查是否有命令为写入 cmdlet。
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: 'Command modifies environment variables',
      }
    }
  }
  // 若存在涉及 env 变量的赋值，也予以标记。
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: 'Command modifies environment variables',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * module 加载 cmdlet 会执行 .psm1 的顶层脚本体（Import-Module），或从任意 repository
 * 下载内容（Install-Module、Save-Module）。`Import-Module:*` 等通配 allow 规则会使
 * 攻击者提供的 .psm1 以用户权限执行，风险与 Invoke-Expression 相同。
 *
 * NEVER_SUGGEST（dangerousCmdlets.ts）由此列表推导，因此 UI 不会把这些命令作为
 * 通配符建议，但用户仍可手写 allow 规则。此检查确保权限引擎独立保护这些 cmdlet。
 */

function checkModuleLoading(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command loads, installs, or downloads a PowerShell module or script, which can execute arbitrary code',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Set-Alias/New-Alias 可劫持后续命令解析；设置 alias 后，之后的 `Get-Content $x`
 * 可能执行任意代码。Set-Variable/New-Variable 可污染 `$PSDefaultParameterValues`，
 * 改变之后每个 cmdlet 的行为。这两种影响都无法静态验证，因为需要跟踪会话中所有未来
 * 命令解析，因此始终 ask。
 */
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

function checkRuntimeStateManipulation(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    // 剥离模块限定符：`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`。
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\') ? raw.slice(raw.lastIndexOf('\\') + 1) : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command creates or modifies an alias or variable that can affect future command resolution',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-WmiMethod / Invoke-CimMethod are Start-Process equivalents via WMI.
 * `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd /c ..."`
 * spawns an arbitrary process, bypassing checkStartProcess entirely. No narrow
 * safe usage exists — -Class and -MethodName accept arbitrary strings, so
 * gating on Win32_Process specifically would miss -Class $x or other process-
 * spawning WMI classes. Returns ask on any invocation. (security finding #34)
 */
const WMI_SPAWN_CMDLETS = new Set(['invoke-wmimethod', 'iwmi', 'invoke-cimmethod'])

function checkWmiProcessSpawn(parsed: ParsedPowerShellCommand): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} can spawn arbitrary processes via WMI/CIM (Win32_Process Create)`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * PowerShell 安全验证主入口，用已知危险模式检查 PowerShell 命令。
 *
 * 所有检查都基于 AST。AST 解析失败（parsed.valid === false）时，单项检查均不会匹配，
 * 并以 'ask' 作为安全默认值返回。
 *
 * @param command - 要验证的 PowerShell 命令（未使用，仅为 API 兼容保留）
 * @param parsed - PowerShell 原生 parser 返回的已解析 AST（必需）
 * @returns 表示命令是否安全的安全检查结果
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // AST 解析失败时无法判断安全性，应询问用户。
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: 'Could not parse command for security analysis',
    }
  }

  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'ask') {
      return result
    }
  }

  // 所有检查均已通过。
  return { behavior: 'passthrough' }
}
