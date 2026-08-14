import { execa } from 'execa'
import { logForDebugging } from '../../services/infra/debug.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { jsonParse } from '../../services/infra/slowOperations.js'
import { getCachedPowerShellPath } from '../shared/powershellDetection.js'

// ---------------------------------------------------------------------------
// 描述返回给调用方的解析结果的公共类型。
// 这些类型映射到 System.Management.Automation.Language AST 类。
// 原始内部类型（RawParsedOutput 等）在下文定义。
// ---------------------------------------------------------------------------

/**
 * 管道元素对应的 PowerShell AST 元素类型。
 * 直接映射到 System.Management.Automation.Language 中 CommandBaseAst 的派生类。
 */
type PipelineElementType = 'CommandAst' | 'CommandExpressionAst' | 'ParenExpressionAst'

/**
 * 单个命令元素（参数、表达式）的 AST 节点类型。
 * 在遍历 AST 时用于分类各元素，使 TypeScript 无需在 PowerShell 中额外调用
 * Find-AstNodes 即可推导安全 flag。
 */
type CommandElementType =
  | 'ScriptBlock'
  | 'SubExpression'
  | 'ExpandableString'
  | 'MemberInvocation'
  | 'Variable'
  | 'StringConstant'
  | 'Parameter'
  | 'Other'

/**
 * 命令元素的一层子节点。针对 CommandParameterAst → .Argument 填充
 *（如 `-InputObject:$env:SECRET` 这种冒号绑定参数）。consumer 可检查
 * `child.type` 来分类绑定值（Variable、StringConstant、Other），无需解析文本。
 */
export type CommandElementChild = {
  type: CommandElementType
  text: string
}

/**
 * PowerShell AST 语句类型。
 * 直接映射到 System.Management.Automation.Language 中 StatementAst 的派生类。
 */
type StatementType =
  | 'PipelineAst'
  | 'PipelineChainAst'
  | 'AssignmentStatementAst'
  | 'IfStatementAst'
  | 'ForStatementAst'
  | 'ForEachStatementAst'
  | 'WhileStatementAst'
  | 'DoWhileStatementAst'
  | 'DoUntilStatementAst'
  | 'SwitchStatementAst'
  | 'TryStatementAst'
  | 'TrapStatementAst'
  | 'FunctionDefinitionAst'
  | 'DataStatementAst'
  | 'UnknownStatementAst'

/**
 * 管道分段中的一次命令调用。
 */
export type ParsedCommandElement = {
  /** command/cmdlet 名称（如 "Get-ChildItem"、"git"） */
  name: string
  /** 命令名称类型：cmdlet、application（exe）或 unknown */
  nameType: 'cmdlet' | 'application' | 'unknown'
  /** PowerShell parser 返回的 AST 元素类型 */
  elementType: PipelineElementType
  /** 字符串形式的全部参数（包括 "-Recurse" 等 flag） */
  args: string[]
  /** 此命令元素的完整文本 */
  text: string
  /** 此命令中各元素（参数、表达式等）的 AST 节点类型 */
  elementTypes?: CommandElementType[]
  /**
   * 各参数的子节点，与 `args[]` 对齐，即
   * `children[i]` ↔ `args[i]` ↔ `elementTypes[i+1]`。只为带冒号绑定参数的
   * Parameter 元素填充；没有子节点的元素为 undefined。consumer 可直接检查
   * `children[i].some(c => c.type !== 'StringConstant')`，无需从参数文本解析 `:` 和 `$`。
   */
  children?: (CommandElementChild[] | undefined)[]
  /** 此命令元素上的重定向（来自 && / || 链中的嵌套命令） */
  redirections?: ParsedRedirection[]
}

/**
 * 命令中发现的重定向。
 */
type ParsedRedirection = {
  /** 重定向运算符 */
  operator: '>' | '>>' | '2>' | '2>>' | '*>' | '*>>' | '2>&1'
  /** 目标（文件路径或 stream 编号） */
  target: string
  /** 是否为 2>&1 这类合并重定向 */
  isMerging: boolean
}

/**
 * 从 PowerShell 解析出的语句，可以是管道、赋值、控制流语句等。
 */
type ParsedStatement = {
  /** PowerShell parser 返回的 AST 语句类型 */
  statementType: StatementType
  /** 此语句中的各条命令（用于管道） */
  commands: ParsedCommandElement[]
  /** 此语句上的重定向 */
  redirections: ParsedRedirection[]
  /** 语句完整文本 */
  text: string
  /**
   * 对 if、for、foreach、while、try 等控制流语句，递归查找其 body block 内的命令。
   * 使用 FindAll() 提取任意深度的全部嵌套 CommandAst 节点。
   */
  nestedCommands?: ParsedCommandElement[]
  /**
   * 无论语句类型如何，均通过对完整语句调用 FindAll() 查找与安全相关的 AST 模式。
   * 这可捕获 elementTypes 可能漏掉的模式，例如赋值内的成员调用、非管道语句中的
   * 子表达式。该值在 PS1 脚本中通过 PowerShell AST 类型系统的 instanceof 检查计算。
   */
  securityPatterns?: {
    hasMemberInvocations?: boolean
    hasSubExpressions?: boolean
    hasExpandableStrings?: boolean
    hasScriptBlocks?: boolean
  }
}

/**
 * 命令中发现的变量引用。
 */
type ParsedVariable = {
  /** 变量路径（如 "HOME"、"env:PATH"、"global:x"） */
  path: string
  /** 此变量是否使用 splatting（@var，而非 $var） */
  isSplatted: boolean
}

/**
 * PowerShell parser 返回的解析错误。
 */
type ParseError = {
  message: string
  errorId: string
}

/**
 * PowerShell AST parser 返回的完整解析结果。
 */
export type ParsedPowerShellCommand = {
  /** 命令是否解析成功（无语法错误） */
  valid: boolean
  /** 解析错误（如有） */
  errors: ParseError[]
  /** 以 ; 或换行分隔的顶层语句 */
  statements: ParsedStatement[]
  /** 找到的全部变量引用 */
  variables: ParsedVariable[]
  /** token stream 是否含 stop-parsing（--%）token */
  hasStopParsing: boolean
  /** 原始命令文本 */
  originalCommand: string
  /**
   * 在 AST 任意位置发现的全部 .NET 类型字面量（TypeExpressionAst 和
   * TypeConstraintAst）。TypeName.FullName 是原样书写的字面文本，而非解析后的
   * .NET 类型（如 [int] → "int"，而非 "System.Int32"）。
   * 由 powershellSecurity.ts 的 CLM allowlist 检查使用。
   */
  typeLiterals?: string[]
  /**
   * 命令是否包含 `using module` 或 `using assembly` 语句。它们会加载外部代码
   *（module/assembly），并执行其顶层脚本体或模块 initializer。using 语句是
   * ScriptBlockAst 上各命名 block 的同级节点而非子节点，因此 Process-BlockStatements
   * 和下游命令遍历器都无法看到它。
   */
  hasUsingStatements?: boolean
  /**
   * 命令是否包含 `#Requires` 指令（ScriptRequirements）。
   * `#Requires -Modules <name>` 会触发从 PSModulePath 加载模块。
   */
  hasScriptRequirements?: boolean
}

// ---------------------------------------------------------------------------

// 默认 5 秒足以满足交互使用（预热后的 pwsh 启动约 450ms）。Windows CI 在
// Defender/AMSI 负载下，即使 CAN_SPAWN_PARSE_SCRIPT() 已预热 JIT，连续启动仍可能
// 超过 5 秒（run 23574701241 windows-shard-5：attackVectors F1 连续两次 5 秒超时，
// 导致 valid:false，结果从 'deny' 降级为 'ask'）。测试可通过 env 覆盖。
// 根据 AGENTS.md 的 globalSettings.env 顺序要求，应在 parsePowerShellCommandImpl 内读取，
// 不能在顶层读取。
const DEFAULT_PARSE_TIMEOUT_MS = 5_000
function getParseTimeoutMs(): number {
  const env = process.env.ZY_CODE_PWSH_PARSE_TIMEOUT_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_PARSE_TIMEOUT_MS
}
// MAX_COMMAND_LENGTH 在下方脚本体定义后由 PARSE_SCRIPT_BODY.length 推导，
// 从而不会随脚本增长而失准。

/**
 * 以内联字符串常量保存的 PowerShell 解析脚本。
 * 这样运行时无需从磁盘读取文件，因为 bundled build 中该文件可能不存在。
 * 脚本使用原生 PowerShell AST parser 分析命令并输出结构化 JSON。
 */
// 描述 PS 脚本 JSON 输出的原始类型（导出供测试使用）。
export type RawCommandElement = {
  type: string // .GetType().Name e.g. "StringConstantExpressionAst"
  text: string // .Extent.Text
  value?: string // .Value if available (resolves backtick escapes)
  expressionType?: string // .Expression.GetType().Name for CommandExpressionAst
  children?: { type: string; text: string }[] // CommandParameterAst.Argument, one level
}

export type RawRedirection = {
  type: string // "FileRedirectionAst" or "MergingRedirectionAst"
  append?: boolean // .Append (FileRedirectionAst only)
  fromStream?: string // .FromStream.ToString() e.g. "Output", "Error", "All"
  locationText?: string // .Location.Extent.Text (FileRedirectionAst only)
}

export type RawPipelineElement = {
  type: string // .GetType().Name e.g. "CommandAst", "CommandExpressionAst"
  text: string // .Extent.Text
  commandElements?: RawCommandElement[]
  redirections?: RawRedirection[]
  expressionType?: string // for CommandExpressionAst: .Expression.GetType().Name
}

export type RawStatement = {
  type: string // .GetType().Name e.g. "PipelineAst", "IfStatementAst", "TrapStatementAst"
  text: string // .Extent.Text
  elements?: RawPipelineElement[] // for PipelineAst: the pipeline elements
  nestedCommands?: RawPipelineElement[] // commands found via FindAll (all statement types)
  redirections?: RawRedirection[] // FileRedirectionAst found via FindAll (non-PipelineAst only)
  securityPatterns?: {
    // 通过对语句调用 FindAll 找到的安全相关 AST 节点类型。
    hasMemberInvocations?: boolean
    hasSubExpressions?: boolean
    hasExpandableStrings?: boolean
    hasScriptBlocks?: boolean
  }
}

type RawParsedOutput = {
  valid: boolean
  errors: { message: string; errorId: string }[]
  statements: RawStatement[]
  variables: { path: string; isSplatted: boolean }[]
  hasStopParsing: boolean
  originalCommand: string
  typeLiterals?: string[]
  hasUsingStatements?: boolean
  hasScriptRequirements?: boolean
}

// 这是解析脚本的唯一正式副本，不另设 .ps1 文件。
/**
 * 核心解析逻辑。命令通过 Base64 编码的 $EncodedCommand 变量传入，
 * 以避免 here-string 注入攻击。
 *
 * 安全要求——顶层 ParamBlock：ScriptBlockAst.ParamBlock 与命名 block
 *（Begin/Process/End/Clean/DynamicParam）同级，并未嵌套其中，因此
 * Process-BlockStatements 永远无法访问它。param() 默认值表达式和 attribute 参数
 *（如 [ValidateScript({...})]）内的命令此前对所有下游检查都不可见。PoC：
 *   param($x = (Remove-Item /)); Get-Process   → only Get-Process surfaced
 *   param([ValidateScript({rm /;$true})]$x='t') → rm invisible, runs on bind
 * 函数级 param() 已覆盖：对 FunctionDefinitionAst 语句调用 FindAll 会递归遍历其后代。
 * 缺口只存在于脚本级 ParamBlock。ParamBlockAst 提供 .Parameters 而非 .Statements，
 * 因此直接对它调用 FindAll，不复用 Process-BlockStatements。只有发现需报告的内容时
 * 才生成语句，以免普通 param($x) 声明产生噪声。脚本内实现保持紧凑以节省 argv 预算。
 */
/**
 * PS1 解析脚本。注释放在这里而非内联；反引号内的每个字符都会占用
 * WINDOWS_MAX_COMMAND_LENGTH（argv 预算）。
 *
 * 结构：
 * - Get-RawCommandElements：提取 CommandAst 元素数据（type、text、value、
 *   expressionType，以及冒号绑定参数 .Argument 的 children）；
 * - Get-RawRedirections：提取 FileRedirectionAst 的 operator 和 target；
 * - Get-SecurityPatterns：用 FindAll 获取安全 flag（通过 Sub/Array/ParenExpressionAst
 *   得到 hasSubExpressions，以及 hasScriptBlocks 等）；
 * - 类型字面量：生成 TypeExpressionAst 名称供 CLM allowlist 检查；
 * - --% token：PS7 为 MinusMinus，PS5.1 为 Generic kind；
 * - CommandExpressionAst.Redirections：继承自 CommandBaseAst；`1 > /tmp/x` 语句
 *   带有元素遍历会漏掉的 FileRedirectionAst；
 * - 嵌套命令：对所有语句类型（if/for/foreach/while/switch/try/function/assignment/
 *   PipelineChainAst）调用 FindAll，并跳过循环中已处理的直接管道元素。
 */
// 导出供测试使用。
export const PARSE_SCRIPT_BODY = `
if (-not $EncodedCommand) {
    Write-Output '{"valid":false,"errors":[{"message":"No command provided","errorId":"NoInput"}],"statements":[],"variables":[],"hasStopParsing":false,"originalCommand":""}'
    exit 0
}

$Command = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($EncodedCommand))

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $Command,
    [ref]$tokens,
    [ref]$parseErrors
)

$allVariables = [System.Collections.ArrayList]::new()

function Get-RawCommandElements {
    param([System.Management.Automation.Language.CommandAst]$CmdAst)
    $elems = [System.Collections.ArrayList]::new()
    foreach ($ce in $CmdAst.CommandElements) {
        $ceData = @{ type = $ce.GetType().Name; text = $ce.Extent.Text }
        if ($ce.PSObject.Properties['Value'] -and $null -ne $ce.Value -and $ce.Value -is [string]) {
            $ceData.value = $ce.Value
        }
        if ($ce -is [System.Management.Automation.Language.CommandExpressionAst]) {
            $ceData.expressionType = $ce.Expression.GetType().Name
        }
        $a=$ce.Argument;if($a){$ceData.children=@(@{type=$a.GetType().Name;text=$a.Extent.Text})}
        [void]$elems.Add($ceData)
    }
    return $elems
}

function Get-RawRedirections {
    param($Redirections)
    $result = [System.Collections.ArrayList]::new()
    foreach ($redir in $Redirections) {
        $redirData = @{ type = $redir.GetType().Name }
        if ($redir -is [System.Management.Automation.Language.FileRedirectionAst]) {
            $redirData.append = [bool]$redir.Append
            $redirData.fromStream = $redir.FromStream.ToString()
            $redirData.locationText = $redir.Location.Extent.Text
        }
        [void]$result.Add($redirData)
    }
    return $result
}

function Get-SecurityPatterns($A) {
    $p = @{}
    foreach ($n in $A.FindAll({ param($x)
        $x -is [System.Management.Automation.Language.MemberExpressionAst] -or
        $x -is [System.Management.Automation.Language.SubExpressionAst] -or
        $x -is [System.Management.Automation.Language.ArrayExpressionAst] -or
        $x -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -or
        $x -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
        $x -is [System.Management.Automation.Language.ParenExpressionAst]
    }, $true)) { switch ($n.GetType().Name) {
        'InvokeMemberExpressionAst' { $p.hasMemberInvocations = $true }
        'MemberExpressionAst' { $p.hasMemberInvocations = $true }
        'SubExpressionAst' { $p.hasSubExpressions = $true }
        'ArrayExpressionAst' { $p.hasSubExpressions = $true }
        'ParenExpressionAst' { $p.hasSubExpressions = $true }
        'ExpandableStringExpressionAst' { $p.hasExpandableStrings = $true }
        'ScriptBlockExpressionAst' { $p.hasScriptBlocks = $true }
    }}
    if ($p.Count -gt 0) { return $p }
    return $null
}

$varExprs = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)
foreach ($v in $varExprs) {
    [void]$allVariables.Add(@{
        path = $v.VariablePath.ToString()
        isSplatted = [bool]$v.Splatted
    })
}

$typeLiterals = [System.Collections.ArrayList]::new()
foreach ($t in $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.TypeExpressionAst] -or
    $n -is [System.Management.Automation.Language.TypeConstraintAst]
}, $true)) { [void]$typeLiterals.Add($t.TypeName.FullName) }

$hasStopParsing = $false
$tk = [System.Management.Automation.Language.TokenKind]
foreach ($tok in $tokens) {
    if ($tok.Kind -eq $tk::MinusMinus) { $hasStopParsing = $true; break }
    if ($tok.Kind -eq $tk::Generic -and ($tok.Text -replace '[\u2013\u2014\u2015]','-') -eq '--%') {
        $hasStopParsing = $true; break
    }
}

$statements = [System.Collections.ArrayList]::new()

function Process-BlockStatements {
    param($Block)
    if (-not $Block) { return }

    foreach ($stmt in $Block.Statements) {
        $statement = @{
            type = $stmt.GetType().Name
            text = $stmt.Extent.Text
        }

        if ($stmt -is [System.Management.Automation.Language.PipelineAst]) {
            $elements = [System.Collections.ArrayList]::new()
            foreach ($element in $stmt.PipelineElements) {
                $elemData = @{
                    type = $element.GetType().Name
                    text = $element.Extent.Text
                }

                if ($element -is [System.Management.Automation.Language.CommandAst]) {
                    $elemData.commandElements = @(Get-RawCommandElements -CmdAst $element)
                    $elemData.redirections = @(Get-RawRedirections -Redirections $element.Redirections)
                } elseif ($element -is [System.Management.Automation.Language.CommandExpressionAst]) {
                    $elemData.expressionType = $element.Expression.GetType().Name
                    $elemData.redirections = @(Get-RawRedirections -Redirections $element.Redirections)
                }

                [void]$elements.Add($elemData)
            }
            $statement.elements = @($elements)

            $allNestedCmds = $stmt.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nestedCmds = [System.Collections.ArrayList]::new()
            foreach ($cmd in $allNestedCmds) {
                if ($cmd.Parent -eq $stmt) { continue }
                $nested = @{
                    type = $cmd.GetType().Name
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                }
                [void]$nestedCmds.Add($nested)
            }
            if ($nestedCmds.Count -gt 0) {
                $statement.nestedCommands = @($nestedCmds)
            }
            $r = $stmt.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) {
                $rr = @(Get-RawRedirections -Redirections $r)
                $statement.redirections = if ($statement.redirections) { @($statement.redirections) + $rr } else { $rr }
            }
        } else {
            $nestedCmdAsts = $stmt.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nested = [System.Collections.ArrayList]::new()
            foreach ($cmd in $nestedCmdAsts) {
                [void]$nested.Add(@{
                    type = 'CommandAst'
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                })
            }
            if ($nested.Count -gt 0) {
                $statement.nestedCommands = @($nested)
            }
            $r = $stmt.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) { $statement.redirections = @(Get-RawRedirections -Redirections $r) }
        }

        $sp = Get-SecurityPatterns $stmt
        if ($sp) { $statement.securityPatterns = $sp }

        [void]$statements.Add($statement)
    }

    if ($Block.Traps) {
        foreach ($trap in $Block.Traps) {
            $statement = @{
                type = 'TrapStatementAst'
                text = $trap.Extent.Text
            }
            $nestedCmdAsts = $trap.FindAll(
                { param($node) $node -is [System.Management.Automation.Language.CommandAst] },
                $true
            )
            $nestedCmds = [System.Collections.ArrayList]::new()
            foreach ($cmd in $nestedCmdAsts) {
                $nested = @{
                    type = $cmd.GetType().Name
                    text = $cmd.Extent.Text
                    commandElements = @(Get-RawCommandElements -CmdAst $cmd)
                    redirections = @(Get-RawRedirections -Redirections $cmd.Redirections)
                }
                [void]$nestedCmds.Add($nested)
            }
            if ($nestedCmds.Count -gt 0) {
                $statement.nestedCommands = @($nestedCmds)
            }
            $r = $trap.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
            if ($r.Count -gt 0) { $statement.redirections = @(Get-RawRedirections -Redirections $r) }
            $sp = Get-SecurityPatterns $trap
            if ($sp) { $statement.securityPatterns = $sp }
            [void]$statements.Add($statement)
        }
    }
}

Process-BlockStatements -Block $ast.BeginBlock
Process-BlockStatements -Block $ast.ProcessBlock
Process-BlockStatements -Block $ast.EndBlock
Process-BlockStatements -Block $ast.CleanBlock
Process-BlockStatements -Block $ast.DynamicParamBlock

if ($ast.ParamBlock) {
  $pb = $ast.ParamBlock
  $pn = [System.Collections.ArrayList]::new()
  foreach ($c in $pb.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]}, $true)) {
    [void]$pn.Add(@{type='CommandAst';text=$c.Extent.Text;commandElements=@(Get-RawCommandElements -CmdAst $c);redirections=@(Get-RawRedirections -Redirections $c.Redirections)})
  }
  $pr = $pb.FindAll({param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst]}, $true)
  $ps = Get-SecurityPatterns $pb
  if ($pn.Count -gt 0 -or $pr.Count -gt 0 -or $ps) {
    $st = @{type='ParamBlockAst';text=$pb.Extent.Text}
    if ($pn.Count -gt 0) { $st.nestedCommands = @($pn) }
    if ($pr.Count -gt 0) { $st.redirections = @(Get-RawRedirections -Redirections $pr) }
    if ($ps) { $st.securityPatterns = $ps }
    [void]$statements.Add($st)
  }
}

$hasUsingStatements = $ast.UsingStatements -and $ast.UsingStatements.Count -gt 0
$hasScriptRequirements = $ast.ScriptRequirements -ne $null

$output = @{
    valid = ($parseErrors.Count -eq 0)
    errors = @($parseErrors | ForEach-Object {
        @{
            message = $_.Message
            errorId = $_.ErrorId
        }
    })
    statements = @($statements)
    variables = @($allVariables)
    hasStopParsing = $hasStopParsing
    originalCommand = $Command
    typeLiterals = @($typeLiterals)
    hasUsingStatements = [bool]$hasUsingStatements
    hasScriptRequirements = [bool]$hasScriptRequirements
}

$output | ConvertTo-Json -Depth 10 -Compress
`

// ---------------------------------------------------------------------------
// Windows CreateProcess 的命令行上限为 32,767 个字符。编码链如下：
//   command (N UTF-8 bytes) → Base64 (~4N/3 chars) → $EncodedCommand = '...'\n
//   → full script (wrapper + PARSE_SCRIPT_BODY) → UTF-16LE (2× bytes)
//   → Base64 (4/3× chars) → -EncodedCommand argv
// 最终 cmdline ≈ argv_overhead + (wrapper + 4N/3 + body) × 8/3
//
// 在 32,767 上限下求解 N（UTF-8 字节数）：
//   script_budget   = (32767 - argv_overhead) × 3/8
//   cmd_b64_budget  = script_budget - PARSE_SCRIPT_BODY.length - wrapper
//   N               = cmd_b64_budget × 3/4 - safety_margin
//
// 安全要求：N 是 UTF-8 字节预算，而非 UTF-16 code unit 预算。长度关卡必须使用
// Buffer.byteLength(command, 'utf8')，不能使用 command.length。U+0800–U+FFFF
// 范围内的 BMP 字符（CJK 字符及大多数非拉丁文字）只占 1 个 UTF-16 code unit，
// 却占 3 个 UTF-8 字节。当 PARSE_SCRIPT_BODY ≈ 10.6K 时，N ≈ 1,092 字节。
// 若与 .length 比较，会允许含 1,092 个 code unit 的纯 CJK 命令（约 3,276 UTF-8
// 字节），使内层 base64 约 4,368 字符，最终 argv 约 40K 字符，超限约 7.4K。
// CreateProcess 随即失败并返回 valid:false，导致解析失败降级，deny 规则被悄然降为 ask。
// Finding #36。
//
// 此值由 PARSE_SCRIPT_BODY.length 计算，避免失准。此前硬编码的 4,500 基于约 6K 的
//脚本体估算，但实际脚本体约 11K 字符，因此真实上限约为 1,850。长度在 1,850–4,500
// 之间的命令能通过此关卡，却会在 Windows 上启动 CreateProcess 失败，返回
// valid=false，并跳过所有基于 AST 的安全检查。
//
// Unix 的 argv 上限通常为 2MB 以上（ARG_MAX），单参数上限约 128KB
//（Linux 的 MAX_ARG_STRLEN；macOS 在 ARG_MAX 以下没有单参数上限）。MAX=4,500 时，
// -EncodedCommand 参数约 45KB，远低于这些限制。在 Unix 套用 Windows 推导出的上限会
// 造成回归：约 1K–4.5K 的命令此前可以成功解析，并进入 powershellPermissions.ts 的
// 子命令 deny 循环；若在启动前拒绝，脚本中部藏有被 deny cmdlet 的复合命令会使用户配置的
// deny 规则降级为 ask。因此 Windows 上限必须按平台启用。
//
// 如果 Windows 上限过于严格，可对大输入改用 -File 和临时文件。
// ---------------------------------------------------------------------------
const WINDOWS_ARGV_CAP = 32_767
// pwsh path + " -NoProfile -NonInteractive -NoLogo -EncodedCommand " +
// argv 引号。较长的 Windows pwsh 路径（C:\Program Files\PowerShell\7\pwsh.exe）
// 加 flag 约 95 字符；预留 200 可兼容非常规安装路径。
const FIXED_ARGV_OVERHEAD = 200
// "$EncodedCommand = '" + "'\n" wrapper around the user command's base64
const ENCODED_CMD_WRAPPER = `$EncodedCommand = ''\n`.length
// 为两层 base64 padding 舍入（每层不超过 4 字符）和少量估算偏差预留空间。
// 此处不吸收多字节膨胀；关卡通过 Buffer.byteLength 测量实际 UTF-8 字节，
// 而非 code unit。
const SAFETY_MARGIN = 100
const SCRIPT_CHARS_BUDGET = ((WINDOWS_ARGV_CAP - FIXED_ARGV_OVERHEAD) * 3) / 8
const CMD_B64_BUDGET = SCRIPT_CHARS_BUDGET - PARSE_SCRIPT_BODY.length - ENCODED_CMD_WRAPPER
// 导出供防失准测试使用（容易失准的是 Windows 值）。单位为 UTF-8 字节，
// 应与 Buffer.byteLength 比较，而非 .length。
export const WINDOWS_MAX_COMMAND_LENGTH = Math.max(
  0,
  Math.floor((CMD_B64_BUDGET * 3) / 4) - SAFETY_MARGIN,
)
// 这是已知可在 Unix 工作的既有值。为何不能在此套用 Windows 推导值，参见上文。
// 单位为 UTF-8 字节；常见的 ASCII 命令满足 bytes==chars，因此无回归；多字节命令的
// 限制略严，但仍远低于 Unix ARG_MAX（单参数约 128KB），不会导致 argv 启动溢出。
const UNIX_MAX_COMMAND_LENGTH = 4_500
// 单位：UTF-8 字节（参见上方安全说明）。
export const MAX_COMMAND_LENGTH =
  process.platform === 'win32' ? WINDOWS_MAX_COMMAND_LENGTH : UNIX_MAX_COMMAND_LENGTH

const INVALID_RESULT_BASE: Omit<ParsedPowerShellCommand, 'errors' | 'originalCommand'> = {
  valid: false,
  statements: [],
  variables: [],
  hasStopParsing: false,
}

function makeInvalidResult(
  command: string,
  message: string,
  errorId: string,
): ParsedPowerShellCommand {
  return {
    ...INVALID_RESULT_BASE,
    errors: [{ message, errorId }],
    originalCommand: command,
  }
}

/**
 * 将字符串按 UTF-16LE 编码为 Base64；PowerShell 的 -EncodedCommand 参数要求此编码。
 */
function toUtf16LeBase64(text: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf16le').toString('base64')
  }
  // 非 Node 环境的回退实现。
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes.push(code & 0xff, (code >> 8) & 0xff)
  }
  return btoa(bytes.map((b) => String.fromCharCode(b)).join(''))
}

/**
 * 构建用于解析命令的完整 PowerShell 脚本。用户命令先以 UTF-8 做 Base64 编码，
 * 再嵌入变量，以防止注入攻击。
 */
function buildParseScript(command: string): string {
  const encoded =
    typeof Buffer !== 'undefined'
      ? Buffer.from(command, 'utf8').toString('base64')
      : btoa(new TextEncoder().encode(command).reduce((s, b) => s + String.fromCharCode(b), ''))
  return `$EncodedCommand = '${encoded}'\n${PARSE_SCRIPT_BODY}`
}

/**
 * 确保值为数组。PowerShell 5.1 的 ConvertTo-Json 可能把单元素数组展开成普通对象。
 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/** 将原始 .NET AST 类型名映射到 StatementType 联合类型。 */
// 导出供测试使用。
export function mapStatementType(rawType: string): StatementType {
  switch (rawType) {
    case 'PipelineAst':
      return 'PipelineAst'
    case 'PipelineChainAst':
      return 'PipelineChainAst'
    case 'AssignmentStatementAst':
      return 'AssignmentStatementAst'
    case 'IfStatementAst':
      return 'IfStatementAst'
    case 'ForStatementAst':
      return 'ForStatementAst'
    case 'ForEachStatementAst':
      return 'ForEachStatementAst'
    case 'WhileStatementAst':
      return 'WhileStatementAst'
    case 'DoWhileStatementAst':
      return 'DoWhileStatementAst'
    case 'DoUntilStatementAst':
      return 'DoUntilStatementAst'
    case 'SwitchStatementAst':
      return 'SwitchStatementAst'
    case 'TryStatementAst':
      return 'TryStatementAst'
    case 'TrapStatementAst':
      return 'TrapStatementAst'
    case 'FunctionDefinitionAst':
      return 'FunctionDefinitionAst'
    case 'DataStatementAst':
      return 'DataStatementAst'
    default:
      return 'UnknownStatementAst'
  }
}

/** 将原始 .NET AST 类型名映射到 CommandElementType 联合类型。 */
// 导出供测试使用。
export function mapElementType(rawType: string, expressionType?: string): CommandElementType {
  switch (rawType) {
    case 'ScriptBlockExpressionAst':
      return 'ScriptBlock'
    case 'SubExpressionAst':
    case 'ArrayExpressionAst':
      // 安全要求：ArrayExpressionAst（@()）与 SubExpressionAst 同级，并非其子类。
      // 二者都会求值可能带副作用的任意管道：Get-ChildItem @(Remove-Item ./data)
      // 会在 @() 中运行 Remove-Item。将二者都映射为 SubExpression，使
      // hasSubExpressions 生效并由 isReadOnlyCommand 拒绝；后者只检查
      // pipeline.commands[]，不检查 nestedCommands。
      return 'SubExpression'
    case 'ExpandableStringExpressionAst':
      return 'ExpandableString'
    case 'InvokeMemberExpressionAst':
    case 'MemberExpressionAst':
      return 'MemberInvocation'
    case 'VariableExpressionAst':
      return 'Variable'
    case 'StringConstantExpressionAst':
    case 'ConstantExpressionAst':
      // ConstantExpressionAst 涵盖数字字面量（5、3.14）。就权限而言，数字字面量
      // 与字符串字面量同样安全：它是不执行的值，不是代码。缺少此映射时，
      // `-Seconds:5` 会生成 children[0].type='Other'，consumer 检查
      // `children.some(c => c.type !== 'StringConstant')` 时会把无害数字参数误报为 ask。
      return 'StringConstant'
    case 'CommandParameterAst':
      return 'Parameter'
    case 'ParenExpressionAst':
      return 'SubExpression'
    case 'CommandExpressionAst':
      // 委托给被包装的表达式类型，以捕获 SubExpressionAst、
      // ExpandableStringExpressionAst、ScriptBlockExpressionAst 等，
      // 无需维护手工列表。内部类型无法识别时落到 'Other'。
      if (expressionType) {
        return mapElementType(expressionType)
      }
      return 'Other'
    default:
      return 'Other'
  }
}

/** 将命令名称分类为 cmdlet、application 或 unknown。 */
// 导出供测试使用。
export function classifyCommandName(name: string): 'cmdlet' | 'application' | 'unknown' {
  if (/^[A-Za-z]+-[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return 'cmdlet'
  }
  if (/[.\\/]/.test(name)) {
    return 'application'
  }
  return 'unknown'
}

/** 从命令名剥离模块前缀（如 "Microsoft.PowerShell.Utility\\Invoke-Expression" -> "Invoke-Expression"）。 */
// 导出供测试使用。
export function stripModulePrefix(name: string): string {
  const idx = name.lastIndexOf('\\')
  if (idx < 0) {
    return name
  }
  // 不剥离文件路径：盘符（C:\...）、UNC 路径（\\server\...）或相对路径（.\、..\）。
  if (
    /^[A-Za-z]:/.test(name) ||
    name.startsWith('\\\\') ||
    name.startsWith('.\\') ||
    name.startsWith('..\\')
  ) {
    return name
  }
  return name.substring(idx + 1)
}

/** 将原始 CommandAst 管道元素转换为 ParsedCommandElement。 */
// 导出供测试使用。
export function transformCommandAst(raw: RawPipelineElement): ParsedCommandElement {
  const cmdElements = ensureArray(raw.commandElements)
  let name = ''
  const args: string[] = []
  const elementTypes: CommandElementType[] = []
  const children: (CommandElementChild[] | undefined)[] = []
  let hasChildren = false

  // 安全要求：nameType 必须根据 stripModulePrefix 之前的原始名称计算。
  // classifyCommandName('scripts\\Get-Process') 会返回 'application'（含 \\），这是正确结果，
  // 因为 PowerShell 会把它解析为文件路径。剥离后会变成 'Get-Process' 并归类为 'cmdlet'，
  // 这是错误的，且会被 allowlist 检查信任。自动允许路径通过
  // nameType !== 'application' 关卡捕获此情况。剥离后的 name 仍用于对称的 deny 规则匹配，
  // 这是关闭失败的：deny 规则只会过度匹配（Module\\Remove-Item 仍命中 Remove-Item deny），
  // allow 规则则另由 nameType 设防。
  let nameType: 'cmdlet' | 'application' | 'unknown' = 'unknown'
  if (cmdElements.length > 0) {
    const first = cmdElements[0]!
    // 安全要求：只有字符串字面量元素且 .value 也是字符串时才信任 .value。
    // 数字 ConstantExpressionAst（如 `& 1`）会生成整数 .value，使
    // stripModulePrefix() 崩溃，parser 随后落到 passthrough。非字符串字面量或
    // 非字符串 .value 应使用 .text。
    const isFirstStringLiteral =
      first.type === 'StringConstantExpressionAst' || first.type === 'ExpandableStringExpressionAst'
    const rawNameUnstripped =
      isFirstStringLiteral && typeof first.value === 'string' ? first.value : first.text
    // 安全要求：剥离命令名外围引号。当 .value 不可用（原始节点无 StaticType）时，
    // .text 会保留引号；`& 'Invoke-Expression' 'x'` 将得到 "'Invoke-Expression'"。
    // 在源头剥离后，所有读取 element.name 的下游逻辑（deny 规则匹配、
    // GIT_SAFETY_WRITE_CMDLETS 查询、resolveToCanonical 等）都能看到裸 cmdlet 名。
    // .value 已剥离时此操作无影响。
    const rawName = rawNameUnstripped.replace(/^['"]|['"]$/g, '')
    // 安全要求：PowerShell 内置 cmdlet 名只含 ASCII。cmdlet 位置出现非 ASCII 字符
    // 本身就可疑；根据 UnicodeData.txt SimpleUppercaseMapping，.NET OrdinalIgnoreCase
    // 会把 U+017F（ſ）折叠为 S、U+0131（ı）折叠为 I，因此 PowerShell 运行时可能把
    // `ſtart-proceſſ` 解析为 Start-Process。JS .toLowerCase() 不会折叠这些字符
    //（ſ 已是小写），导致所有下游名称比较（NEVER_SUGGEST、deny 规则 strEquals、
    // resolveToCanonical、安全 validator）漏判。强制归类为 'application'，由
    // nameType !== 'application' 检查阻止自动允许。Finding #31。
    // 已在 Windows（pwsh 7.x，2026-03）验证：ſtart-proceſſ 当前无法解析。
    // 仍保留此纵深防御，以应对未来 .NET/PS 行为变化或模块提供的命令解析 hook。
    if (/[\u0080-\uFFFF]/.test(rawName)) {
      nameType = 'application'
    } else {
      nameType = classifyCommandName(rawName)
    }
    name = stripModulePrefix(rawName)
    elementTypes.push(mapElementType(first.type, first.expressionType))

    for (let i = 1; i < cmdElements.length; i++) {
      const ce = cmdElements[i]!
      // 字符串常量使用解析后的 .value（剥离引号并解析 `n 等反引号转义为换行），
      // 参数、变量和其他非字符串类型则保留原始 .text；参数的 .value 会丢失短横线前缀，
      // 如 '-Path' -> 'Path'。
      const isStringLiteral =
        ce.type === 'StringConstantExpressionAst' || ce.type === 'ExpandableStringExpressionAst'
      args.push(isStringLiteral && ce.value != null ? ce.value : ce.text)
      elementTypes.push(mapElementType(ce.type, ce.expressionType))
      // 通过 mapElementType 映射原始 children（CommandParameterAst.Argument），
      // 让 consumer 看到 'Variable'、'StringConstant' 等类型。
      const rawChildren = ensureArray(ce.children)
      if (rawChildren.length > 0) {
        hasChildren = true
        children.push(
          rawChildren.map((c) => ({
            type: mapElementType(c.type),
            text: c.text,
          })),
        )
      } else {
        children.push(undefined)
      }
    }
  }

  const result: ParsedCommandElement = {
    name,
    nameType,
    elementType: 'CommandAst',
    args,
    text: raw.text,
    elementTypes,
    ...(hasChildren ? { children } : {}),
  }

  // 保留嵌套命令中的重定向（如 && / || 链）。
  const rawRedirs = ensureArray(raw.redirections)
  if (rawRedirs.length > 0) {
    result.redirections = rawRedirs.map(transformRedirection)
  }

  return result
}

/** 将非 CommandAst 管道元素转换为 ParsedCommandElement。 */
// 导出供测试使用。
export function transformExpressionElement(raw: RawPipelineElement): ParsedCommandElement {
  const elementType: PipelineElementType =
    raw.type === 'ParenExpressionAst' ? 'ParenExpressionAst' : 'CommandExpressionAst'
  const elementTypes: CommandElementType[] = [mapElementType(raw.type, raw.expressionType)]

  return {
    name: raw.text,
    nameType: 'unknown',
    elementType,
    args: [],
    text: raw.text,
    elementTypes,
  }
}

/** 将原始重定向映射为 ParsedRedirection。 */
// 导出供测试使用。
export function transformRedirection(raw: RawRedirection): ParsedRedirection {
  if (raw.type === 'MergingRedirectionAst') {
    return { operator: '2>&1', target: '', isMerging: true }
  }

  const append = raw.append ?? false
  const fromStream = raw.fromStream ?? 'Output'

  let operator: ParsedRedirection['operator']
  if (append) {
    switch (fromStream) {
      case 'Error':
        operator = '2>>'
        break
      case 'All':
        operator = '*>>'
        break
      default:
        operator = '>>'
        break
    }
  } else {
    switch (fromStream) {
      case 'Error':
        operator = '2>'
        break
      case 'All':
        operator = '*>'
        break
      default:
        operator = '>'
        break
    }
  }

  return { operator, target: raw.locationText ?? '', isMerging: false }
}

/** 将原始语句转换为 ParsedStatement。 */
// 导出供测试使用。
export function transformStatement(raw: RawStatement): ParsedStatement {
  const statementType = mapStatementType(raw.type)
  const commands: ParsedCommandElement[] = []
  const redirections: ParsedRedirection[] = []

  if (raw.elements) {
    // PipelineAst：遍历管道元素。
    for (const elem of ensureArray(raw.elements)) {
      if (elem.type === 'CommandAst') {
        commands.push(transformCommandAst(elem))
        for (const redir of ensureArray(elem.redirections)) {
          redirections.push(transformRedirection(redir))
        }
      } else {
        commands.push(transformExpressionElement(elem))
        // 安全要求：CommandExpressionAst 也带有从 CommandBaseAst 继承的 .Redirections。
        // `1 > /tmp/evil.txt` 是带 FileRedirectionAst 的 CommandExpressionAst。
        // 必须在此提取，否则 getFileRedirections() 会漏掉它，使
        // `Get-ChildItem; 1 > /tmp/x` 等复合命令在第 5 步被自动允许，因为只检查了
        // Get-ChildItem。
        for (const redir of ensureArray(elem.redirections)) {
          redirections.push(transformRedirection(redir))
        }
      }
    }
    // 安全要求：PS1 的 PipelineAst 分支会深度 FindAll FileRedirectionAst，
    // 以捕获隐藏在以下位置的重定向：
    //  - colon-bound ParenExpressionAst args: -Name:('payload' > file)
    //  - hashtable value statements: @{k='payload' > ~/.bashrc}
    // 二者在元素级都不可见，因为重定向的 parent 是 CommandParameterAst /
    // CommandExpressionAst 的子节点，而非独立管道元素。因此合并到语句级重定向。
    //
    // FindAll 还会再次发现上方逐元素循环已捕获的直接元素重定向。
    // 按（operator、target）去重，让测试和 consumer 看到真实数量。
    const seen = new Set(redirections.map((r) => `${r.operator}\0${r.target}`))
    for (const redir of ensureArray(raw.redirections)) {
      const r = transformRedirection(redir)
      const key = `${r.operator}\0${r.target}`
      if (!seen.has(key)) {
        seen.add(key)
        redirections.push(r)
      }
    }
  } else {
    // 非管道语句：添加包含完整文本的合成命令条目。
    commands.push({
      name: raw.text,
      nameType: 'unknown',
      elementType: 'CommandExpressionAst',
      args: [],
      text: raw.text,
    })
    // 安全要求：PS1 的 else 分支会直接递归 FindAll FileRedirectionAst，以捕获控制流
    //（if/for/foreach/while/switch/try/trap/&& 和 ||）中的表达式重定向。上方针对
    // CommandAst 的 FindAll 无法看到它们：在 if ($x) { 1 > /tmp/evil } 中，带重定向的
    // 字面量 1 是 CommandExpressionAst；它在类型层级中与 CommandAst 同级，并非其子类。
    // 因此 nestedCommands 永远不会包含它。若不提升，getFileRedirections 看不到该重定向，
    // 第 4.6 步会漏判，使 `Get-Process && 1 > /tmp/evil` 等复合命令在第 5 步自动允许，
    // 因为只检查且 allowlist 允许了 Get-Process。
    //
    // 直接查找 FileRedirectionAst，而非查找 CommandExpressionAst 后提取 .Redirections，
    // 既更简单也更稳健；它能捕获任何节点类型上的重定向，包括尚未知晓的类型。
    //
    // 这会重复计算嵌套 CommandAst 命令上已有的重定向；它们约在 395 行提取到
    // nestedCommands[i].redirections，并在此再次发现。该重复无害：第 4.6 步只检查
    // fileRedirections.length > 0，不依赖精确数量，也没有代码会对重定向数量做运算。
    //
    // PS1 大小说明：完整理由放在这里（TS），而非 PS1 脚本中，因为 PS1 注释会增大
    // -EncodedCommand payload，逼近 Windows CreateProcess 的 32K 上限。
    // PS1 注释应保持简短并指向此处。
    for (const redir of ensureArray(raw.redirections)) {
      redirections.push(transformRedirection(redir))
    }
  }

  let nestedCommands: ParsedCommandElement[] | undefined
  const rawNested = ensureArray(raw.nestedCommands)
  if (rawNested.length > 0) {
    nestedCommands = rawNested.map(transformCommandAst)
  }

  const result: ParsedStatement = {
    statementType,
    commands,
    redirections,
    text: raw.text,
    nestedCommands,
  }

  if (raw.securityPatterns) {
    result.securityPatterns = raw.securityPatterns
  }

  return result
}

/** 将完整的原始 PS 输出转换为 ParsedPowerShellCommand。 */
function transformRawOutput(raw: RawParsedOutput): ParsedPowerShellCommand {
  const result: ParsedPowerShellCommand = {
    valid: raw.valid,
    errors: ensureArray(raw.errors),
    statements: ensureArray(raw.statements).map(transformStatement),
    variables: ensureArray(raw.variables),
    hasStopParsing: raw.hasStopParsing,
    originalCommand: raw.originalCommand,
  }
  const tl = ensureArray(raw.typeLiterals)
  if (tl.length > 0) {
    result.typeLiterals = tl
  }
  if (raw.hasUsingStatements) {
    result.hasUsingStatements = true
  }
  if (raw.hasScriptRequirements) {
    result.hasScriptRequirements = true
  }
  return result
}

/**
 * 使用原生 AST parser 解析 PowerShell 命令。启动 pwsh 解析命令并返回结构化结果。
 * 结果按命令字符串 memoize。
 *
 * @param command - 要解析的 PowerShell 命令
 * @returns 解析后的命令结构；失败时返回 valid=false 的结果
 */
async function parsePowerShellCommandImpl(command: string): Promise<ParsedPowerShellCommand> {
  // SECURITY: MAX_COMMAND_LENGTH is a UTF-8 BYTE budget (see derivation at the
  // constant definition). command.length counts UTF-16 code units; a CJK
  // character is 1 code unit but 3 UTF-8 bytes, so .length under-reports by
  // up to 3× and allows argv overflow on Windows → CreateProcess fails →
  // valid:false → deny rules degrade to ask. Finding #36.
  const commandBytes = Buffer.byteLength(command, 'utf8')
  if (commandBytes > MAX_COMMAND_LENGTH) {
    logForDebugging(
      `PowerShell parser: command too long (${commandBytes} bytes, max ${MAX_COMMAND_LENGTH})`,
    )
    return makeInvalidResult(
      command,
      `Command too long for parsing (${commandBytes} bytes). Maximum supported length is ${MAX_COMMAND_LENGTH} bytes.`,
      'CommandTooLong',
    )
  }

  const pwshPath = await getCachedPowerShellPath()
  if (!pwshPath) {
    return makeInvalidResult(command, 'PowerShell is not available', 'NoPowerShell')
  }

  const script = buildParseScript(command)

  // 通过 -EncodedCommand 将脚本传给 PowerShell。-EncodedCommand 接收以 UTF-16LE
  // 做 Base64 编码的字符串并执行，可避免：(1) -File - 在 stdin 交互模式下向 stdout
  // 输出 PS prompt 和 ANSI 转义；(2) 命令行转义问题；(3) 临时文件。脚本虽大，
  // 仍远低于 OS 参数上限（Windows 为 32K 字符，Unix 通常为 2MB 以上）。
  const encodedScript = toUtf16LeBase64(script)
  const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encodedScript]

  // Spawn pwsh with one retry on timeout. On loaded CI runners (Windows
  // especially), pwsh spawn + .NET JIT + ParseInput occasionally exceeds 5s
  // even after CAN_SPAWN_PARSE_SCRIPT() warms the JIT. execa kills the process
  // but exitCode is undefined, which the old code reported as the misleading
  // "pwsh exited with code 1:" with empty stderr. A single retry absorbs
  // transient load spikes; a double timeout is reported as PwshTimeout.
  const parseTimeoutMs = getParseTimeoutMs()
  let stdout = ''
  let stderr = ''
  let code: number | null = null
  let timedOut = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await execa(pwshPath, args, {
        timeout: parseTimeoutMs,
        reject: false,
      })
      stdout = result.stdout
      stderr = result.stderr
      timedOut = result.timedOut
      code = result.failed ? (result.exitCode ?? 1) : 0
    } catch (e: unknown) {
      logForDebugging(
        `PowerShell parser: failed to spawn pwsh: ${e instanceof Error ? e.message : e}`,
      )
      return makeInvalidResult(
        command,
        `Failed to spawn PowerShell: ${e instanceof Error ? e.message : e}`,
        'PwshSpawnError',
      )
    }
    if (!timedOut) {
      break
    }
    logForDebugging(
      `PowerShell parser: pwsh timed out after ${parseTimeoutMs}ms (attempt ${attempt + 1})`,
    )
  }

  if (timedOut) {
    return makeInvalidResult(
      command,
      `pwsh timed out after ${parseTimeoutMs}ms (2 attempts)`,
      'PwshTimeout',
    )
  }

  if (code !== 0) {
    logForDebugging(`PowerShell parser: pwsh exited with code ${code}, stderr: ${stderr}`)
    return makeInvalidResult(command, `pwsh exited with code ${code}: ${stderr}`, 'PwshError')
  }

  const trimmed = stdout.trim()
  if (!trimmed) {
    logForDebugging('PowerShell parser: empty stdout from pwsh')
    return makeInvalidResult(command, 'No output from PowerShell parser', 'EmptyOutput')
  }

  try {
    const raw = jsonParse(trimmed) as RawParsedOutput
    return transformRawOutput(raw)
  } catch {
    logForDebugging(`PowerShell parser: invalid JSON output: ${trimmed.slice(0, 200)}`)
    return makeInvalidResult(command, 'Invalid JSON from PowerShell parser', 'InvalidJson')
  }
}

// makeInvalidResult 中表示瞬时进程失败的错误 ID。应将其从 cache 移除，
// 让后续调用可以重试。确定性失败（CommandTooLong、成功解析后发现的语法错误）
// 应继续缓存，因为重试会得到相同结果。
const TRANSIENT_ERROR_IDS = new Set([
  'PwshSpawnError',
  'PwshError',
  'PwshTimeout',
  'EmptyOutput',
  'InvalidJson',
])

const parsePowerShellCommandCached = memoizeWithLRU(
  (command: string) => {
    const promise = parsePowerShellCommandImpl(command)
    // 解析完成后移除瞬时失败，以便重试。本次调用方仍收到已缓存的 Promise，
    // 确保并发调用方共享同一结果。
    void promise.then((result) => {
      if (!result.valid && TRANSIENT_ERROR_IDS.has(result.errors[0]?.errorId ?? '')) {
        parsePowerShellCommandCached.cache.delete(command)
      }
    })
    return promise
  },
  (command: string) => command,
  256,
)

export { parsePowerShellCommandCached as parsePowerShellCommand }

// ---------------------------------------------------------------------------
// 从已解析 AST 结构推导的分析 helper。
// ---------------------------------------------------------------------------

/**
 * 从已解析 AST 推导的安全相关 flag。
 */
type SecurityFlags = {
  /** 包含 $(...) 子表达式 */
  hasSubExpressions: boolean
  /** 包含 { ... } script block 表达式 */
  hasScriptBlocks: boolean
  /** 包含 @variable splatting */
  hasSplatting: boolean
  /** 包含嵌入表达式的可展开字符串（"...$()..."） */
  hasExpandableStrings: boolean
  /** 包含 .NET 方法调用（[Type]::Method 或 $obj.Method()） */
  hasMemberInvocations: boolean
  /** 包含变量赋值（$x = ...） */
  hasAssignments: boolean
  /** 使用 stop-parsing token（--%） */
  hasStopParsing: boolean
}

/**
 * 将常见 PowerShell alias 映射到规范 cmdlet 名称。
 * 使用 Object.create(null) 防止原型链污染；攻击者可控的 'constructor' 或
 * '__proto__' 等命令名必须返回 undefined，不能取得继承自 Object.prototype 的属性。
 */
export const COMMON_ALIASES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    // 目录列表。
    ls: 'Get-ChildItem',
    dir: 'Get-ChildItem',
    gci: 'Get-ChildItem',
    // 内容读取。
    cat: 'Get-Content',
    type: 'Get-Content',
    gc: 'Get-Content',
    // 目录导航。
    cd: 'Set-Location',
    sl: 'Set-Location',
    chdir: 'Set-Location',
    pushd: 'Push-Location',
    popd: 'Pop-Location',
    pwd: 'Get-Location',
    gl: 'Get-Location',
    // Item 操作。
    gi: 'Get-Item',
    gp: 'Get-ItemProperty',
    ni: 'New-Item',
    mkdir: 'New-Item',
    // `md` is PowerShell's built-in alias for `mkdir`. resolveToCanonical is
    // single-hop (no md→mkdir→New-Item chaining), so it needs its own entry
    // or `md /etc/x` falls through while `mkdir /etc/x` is caught.
    md: 'New-Item',
    ri: 'Remove-Item',
    del: 'Remove-Item',
    rd: 'Remove-Item',
    rmdir: 'Remove-Item',
    rm: 'Remove-Item',
    erase: 'Remove-Item',
    mi: 'Move-Item',
    mv: 'Move-Item',
    move: 'Move-Item',
    ci: 'Copy-Item',
    cp: 'Copy-Item',
    copy: 'Copy-Item',
    cpi: 'Copy-Item',
    si: 'Set-Item',
    rni: 'Rename-Item',
    ren: 'Rename-Item',
    // 进程。
    ps: 'Get-Process',
    gps: 'Get-Process',
    kill: 'Stop-Process',
    spps: 'Stop-Process',
    start: 'Start-Process',
    saps: 'Start-Process',
    sajb: 'Start-Job',
    ipmo: 'Import-Module',
    // 输出。
    echo: 'Write-Output',
    write: 'Write-Output',
    sleep: 'Start-Sleep',
    // 帮助。
    help: 'Get-Help',
    man: 'Get-Help',
    gcm: 'Get-Command',
    // 服务。
    gsv: 'Get-Service',
    // 变量。
    gv: 'Get-Variable',
    sv: 'Set-Variable',
    // 历史记录。
    h: 'Get-History',
    history: 'Get-History',
    // 调用。
    iex: 'Invoke-Expression',
    iwr: 'Invoke-WebRequest',
    irm: 'Invoke-RestMethod',
    icm: 'Invoke-Command',
    ii: 'Invoke-Item',
    // PSSession——远程代码执行面。
    nsn: 'New-PSSession',
    etsn: 'Enter-PSSession',
    exsn: 'Exit-PSSession',
    gsn: 'Get-PSSession',
    rsn: 'Remove-PSSession',
    // 其他。
    cls: 'Clear-Host',
    clear: 'Clear-Host',
    select: 'Select-Object',
    where: 'Where-Object',
    foreach: 'ForEach-Object',
    '%': 'ForEach-Object',
    '?': 'Where-Object',
    measure: 'Measure-Object',
    ft: 'Format-Table',
    fl: 'Format-List',
    fw: 'Format-Wide',
    oh: 'Out-Host',
    ogv: 'Out-GridView',
    // SECURITY: The following aliases are deliberately omitted because PS Core 6+
    // removed them (they collide with native executables). Our allowlist logic
    // resolves aliases BEFORE checking safety — if we map 'sort' → 'Sort-Object'
    // but PowerShell 7/Windows actually runs sort.exe, we'd auto-allow the wrong
    // program.
    //   'sc'   → sc.exe (Service Controller) — e.g. `sc config Svc binpath= ...`
    //   'sort' → sort.exe — e.g. `sort /O C:\evil.txt` (arbitrary file write)
    //   'curl' → curl.exe (shipped with Windows 10 1803+)
    //   'wget' → wget.exe (if installed)
    // Prefer to leave ambiguous aliases unmapped — users can write the full name.
    // If adding aliases that resolve to SAFE_OUTPUT_CMDLETS or
    // ACCEPT_EDITS_ALLOWED_CMDLETS, verify no native .exe collision on PS Core.
    ac: 'Add-Content',
    clc: 'Clear-Content',
    // Write/export: tee-object/export-csv are in
    // CMDLET_PATH_CONFIG so path-level Edit denies fire on the full cmdlet name,
    // but PowerShell's built-in aliases fell through to ask-then-approve because
    // resolveToCanonical couldn't resolve them). Neither tee-object nor
    // export-csv is in SAFE_OUTPUT_CMDLETS or ACCEPT_EDITS_ALLOWED_CMDLETS, so
    // the native-exe collision warning above doesn't apply — on Linux PS Core
    // where `tee` runs /usr/bin/tee, that binary also writes to its positional
    // file arg and we correctly extract+check it.
    tee: 'Tee-Object',
    epcsv: 'Export-Csv',
    sp: 'Set-ItemProperty',
    rp: 'Remove-ItemProperty',
    cli: 'Clear-Item',
    epal: 'Export-Alias',
    // 文本搜索。
    sls: 'Select-String',
  },
)

const DIRECTORY_CHANGE_CMDLETS = new Set(['set-location', 'push-location', 'pop-location'])

const DIRECTORY_CHANGE_ALIASES = new Set(['cd', 'sl', 'chdir', 'pushd', 'popd'])

/**
 * 获取所有语句、管道分段和嵌套命令中的全部命令名。
 * 返回小写名称，以便不区分大小写地比较。
 */
// 导出供测试使用。
export function getAllCommandNames(parsed: ParsedPowerShellCommand): string[] {
  const names: string[] = []
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      names.push(cmd.name.toLowerCase())
    }
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        names.push(cmd.name.toLowerCase())
      }
    }
  }
  return names
}

/**
 * 将所有管道分段展开为扁平命令列表，便于逐条独立检查。
 */
export function getAllCommands(parsed: ParsedPowerShellCommand): ParsedCommandElement[] {
  const commands: ParsedCommandElement[] = []
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      commands.push(cmd)
    }
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        commands.push(cmd)
      }
    }
  }
  return commands
}

/**
 * 获取所有语句中的全部重定向。
 */
// 导出供测试使用。
export function getAllRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  const redirections: ParsedRedirection[] = []
  for (const statement of parsed.statements) {
    for (const redir of statement.redirections) {
      redirections.push(redir)
    }
    // 包含嵌套命令中的重定向（如来自 && / || 链）。
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        if (cmd.redirections) {
          for (const redir of cmd.redirections) {
            redirections.push(redir)
          }
        }
      }
    }
  }
  return redirections
}

/**
 * 获取全部变量，可选择按 scope（如 'env'）过滤。
 * PowerShell 变量路径可带 "env:PATH"、"global:x" 等 scope。
 */
export function getVariablesByScope(
  parsed: ParsedPowerShellCommand,
  scope: string,
): ParsedVariable[] {
  const prefix = `${scope.toLowerCase()}:`
  return parsed.variables.filter((v) => v.path.toLowerCase().startsWith(prefix))
}

/**
 * 检查解析结果中是否有命令与给定名称匹配（不区分大小写），同时处理常见 alias。
 */
export function hasCommandNamed(parsed: ParsedPowerShellCommand, name: string): boolean {
  const lowerName = name.toLowerCase()
  const canonicalFromAlias = COMMON_ALIASES[lowerName]?.toLowerCase()

  for (const cmdName of getAllCommandNames(parsed)) {
    if (cmdName === lowerName) {
      return true
    }
    // 检查命令是否为解析后等于目标名称的 alias。
    const canonical = COMMON_ALIASES[cmdName]?.toLowerCase()
    if (canonical === lowerName) {
      return true
    }
    // 检查目标名称是否为 alias，且命令是否为其规范形式。
    if (canonicalFromAlias && cmdName === canonicalFromAlias) {
      return true
    }
    // 检查二者是否解析到同一规范 cmdlet（alias 对 alias 匹配）。
    if (canonical && canonicalFromAlias && canonical === canonicalFromAlias) {
      return true
    }
  }
  return false
}

/**
 * 检查命令是否包含任何切换目录的命令。
 * (Set-Location, cd, sl, chdir, Push-Location, pushd, Pop-Location, popd)
 */
// 导出供测试使用。
export function hasDirectoryChange(parsed: ParsedPowerShellCommand): boolean {
  for (const cmdName of getAllCommandNames(parsed)) {
    if (DIRECTORY_CHANGE_CMDLETS.has(cmdName) || DIRECTORY_CHANGE_ALIASES.has(cmdName)) {
      return true
    }
  }
  return false
}

/**
 * 检查命令是否为单一简单命令（无管道、分号或运算符）。
 */
// 导出供测试使用。
export function isSingleCommand(parsed: ParsedPowerShellCommand): boolean {
  const stmt = parsed.statements[0]
  return (
    parsed.statements.length === 1 &&
    stmt !== undefined &&
    stmt.commands.length === 1 &&
    (!stmt.nestedCommands || stmt.nestedCommands.length === 0)
  )
}

/**
 * 检查特定命令是否带给定参数或 flag（不区分大小写），
 * 适合检查 "-EncodedCommand"、"-Recurse" 等。
 */
export function commandHasArg(command: ParsedCommandElement, arg: string): boolean {
  const lowerArg = arg.toLowerCase()
  return command.args.some((a) => a.toLowerCase() === lowerArg)
}

/**
 * Tokenizer-level dash characters that PowerShell's parser accepts as
 * parameter prefixes. SpecialCharacters.IsDash (CharTraits.cs) accepts exactly
 * these four: ASCII hyphen-minus, en-dash, em-dash, horizontal bar. These are
 * tokenizer-level — they apply to ALL cmdlet parameters, not just argv to
 * powershell.exe (contrast with `/` which is an argv-parser quirk of
 * powershell.exe 5.1 only; see PS_ALT_PARAM_PREFIXES in powershellSecurity.ts).
 *
 * Extent.Text preserves the raw character; transformCommandAst uses ce.text
 * for CommandParameterAst elements, so these reach callers unchanged.
 */
export const PS_TOKENIZER_DASH_CHARS = new Set([
  '-', // U+002D hyphen-minus (ASCII)
  '\u2013', // en-dash
  '\u2014', // em-dash
  '\u2015', // horizontal bar
])

/**
 * Determines if an argument is a PowerShell parameter (flag), using the AST
 * element type as ground truth when available.
 *
 * The parser maps CommandParameterAst → 'Parameter' regardless of which dash
 * character the user typed — PowerShell's tokenizer handles that. So when
 * elementType is available, it's authoritative:
 *   - 'Parameter' → true (covers `-Path`, `–Path`, `—Path`, `―Path`)
 *   - anything else → false (a quoted "-Path" is StringConstant, not a param)
 *
 * When elementType is unavailable (backward compat / no AST detail), fall back
 * to a char check against PS_TOKENIZER_DASH_CHARS.
 */
export function isPowerShellParameter(arg: string, elementType?: CommandElementType): boolean {
  if (elementType !== undefined) {
    return elementType === 'Parameter'
  }
  return arg.length > 0 && PS_TOKENIZER_DASH_CHARS.has(arg[0]!)
}

/**
 * Check if any argument on a command is an unambiguous abbreviation of a PowerShell parameter.
 * PowerShell allows parameter abbreviation as long as the prefix is unambiguous.
 * The minPrefix is the shortest unambiguous prefix for the parameter.
 * For example, minPrefix '-en' for fullParam '-encodedcommand' matches '-en', '-enc', '-enco', etc.
 */
export function commandHasArgAbbreviation(
  command: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  const lowerFull = fullParam.toLowerCase()
  const lowerMin = minPrefix.toLowerCase()
  return command.args.some((a) => {
    // Strip colon-bound value (e.g., -en:base64value -> -en)
    const colonIndex = a.indexOf(':', 1)
    const paramPart = colonIndex > 0 ? a.slice(0, colonIndex) : a
    // Strip backtick escapes — PowerShell resolves `-Member`Name` to
    // `-MemberName` but Extent.Text preserves the backtick, causing
    // prefix-comparison misses on the raw text.
    const lower = paramPart.replace(/`/g, '').toLowerCase()
    return (
      lower.startsWith(lowerMin) && lowerFull.startsWith(lower) && lower.length <= lowerFull.length
    )
  })
}

/**
 * 将已解析命令拆成管道分段，以逐段检查权限；分别返回各管道的命令。
 */
export function getPipelineSegments(parsed: ParsedPowerShellCommand): ParsedStatement[] {
  return parsed.statements
}

/**
 * 重定向目标为 PowerShell 自动变量 `$null` 时返回 true。
 * `> $null` 会丢弃输出（类似 /dev/null），并非文件系统写入。`$null` 无法重新赋值，
 * 因此可安全地视为 no-op sink。`${null}` 是花括号语法下的同一自动变量；
 * 花括号内带空格的 `${ null }` 表示另一变量，因此 regex 不匹配它。
 */
export function isNullRedirectionTarget(target: string): boolean {
  const t = target.trim().toLowerCase()
  return t === '$null' || t === '${null}'
}

/**
 * 获取输出重定向（文件重定向，不含合并重定向），只返回会写入文件的重定向。
 */
// 导出供测试使用。
export function getFileRedirections(parsed: ParsedPowerShellCommand): ParsedRedirection[] {
  return getAllRedirections(parsed).filter(
    (r) => !r.isMerging && !isNullRedirectionTarget(r.target),
  )
}

/**
 * 从已解析命令结构推导安全相关 flag。它取代此前在 PowerShell 中分别调用
 * Find-AstNodes 计算 flag 的方式；PS1 脚本会给各元素标记 AST 节点类型，
 * 此函数再遍历这些类型。
 */
// 导出供测试使用。
export function deriveSecurityFlags(parsed: ParsedPowerShellCommand): SecurityFlags {
  const flags: SecurityFlags = {
    hasSubExpressions: false,
    hasScriptBlocks: false,
    hasSplatting: false,
    hasExpandableStrings: false,
    hasMemberInvocations: false,
    hasAssignments: false,
    hasStopParsing: parsed.hasStopParsing,
  }

  function checkElements(cmd: ParsedCommandElement): void {
    if (!cmd.elementTypes) {
      return
    }
    for (const et of cmd.elementTypes) {
      switch (et) {
        case 'ScriptBlock':
          flags.hasScriptBlocks = true
          break
        case 'SubExpression':
          flags.hasSubExpressions = true
          break
        case 'ExpandableString':
          flags.hasExpandableStrings = true
          break
        case 'MemberInvocation':
          flags.hasMemberInvocations = true
          break
      }
    }
  }

  for (const stmt of parsed.statements) {
    if (stmt.statementType === 'AssignmentStatementAst') {
      flags.hasAssignments = true
    }
    for (const cmd of stmt.commands) {
      checkElements(cmd)
    }
    if (stmt.nestedCommands) {
      for (const cmd of stmt.nestedCommands) {
        checkElements(cmd)
      }
    }
    // securityPatterns provides a belt-and-suspenders check that catches
    // patterns elementTypes may miss (e.g. member invocations inside
    // assignments, subexpressions in non-pipeline statements).
    if (stmt.securityPatterns) {
      if (stmt.securityPatterns.hasMemberInvocations) {
        flags.hasMemberInvocations = true
      }
      if (stmt.securityPatterns.hasSubExpressions) {
        flags.hasSubExpressions = true
      }
      if (stmt.securityPatterns.hasExpandableStrings) {
        flags.hasExpandableStrings = true
      }
      if (stmt.securityPatterns.hasScriptBlocks) {
        flags.hasScriptBlocks = true
      }
    }
  }

  for (const v of parsed.variables) {
    if (v.isSplatted) {
      flags.hasSplatting = true
      break
    }
  }

  return flags
}

// 导出供测试使用的原始类型（函数已在上方内联导出）。
