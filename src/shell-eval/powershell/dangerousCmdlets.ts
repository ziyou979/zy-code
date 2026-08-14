/**
 * 会执行任意代码的 PowerShell cmdlet 共享常量。
 *
 * 权限引擎 validator（powershellSecurity.ts）和 UI 建议关卡（staticPrefix.ts）
 * 都会使用这些列表。集中定义可避免重复和同步偏差；只需添加一次，两个 consumer
 * 都能取得新 cmdlet。
 */

import { CROSS_PLATFORM_CODE_EXEC } from '../../services/permissions/dangerousPatterns.js'
import { COMMON_ALIASES } from './parser.js'

/**
 * 接收 -FilePath（或位置路径）并把文件内容作为脚本执行的 cmdlet。
 */
export const FILEPATH_EXECUTION_CMDLETS = new Set([
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
])

/**
 * scriptblock 参数会执行任意代码的 cmdlet，不只是像 Where-Object 那样过滤或转换管道输入。
 */
export const DANGEROUS_SCRIPT_BLOCK_CMDLETS = new Set([
  'invoke-command',
  'invoke-expression',
  'start-job',
  'start-threadjob',
  'register-scheduledjob',
  'register-engineevent',
  'register-objectevent',
  'register-wmievent',
  'new-pssession',
  'enter-pssession',
])

/**
 * 加载并执行 module/script 代码的 cmdlet。`.psm1` 文件导入时会运行顶层 body，
 * 代码执行风险与 iex 相同。
 */
export const MODULE_LOADING_CMDLETS = new Set([
  'import-module',
  'ipmo',
  'install-module',
  'save-module',
  'update-module',
  'install-script',
  'save-script',
])

/**
 * shell 和进程启动器。此列表小而稳定；只有未被上方 validator 列表覆盖的 cmdlet 才加入。
 */
const SHELLS_AND_SPAWNERS = [
  'pwsh',
  'powershell',
  'cmd',
  'bash',
  'wsl',
  'sh',
  'start-process',
  'start',
  'add-type',
  'new-object',
] as const

function aliasesOf(targets: ReadonlySet<string>): string[] {
  return Object.entries(COMMON_ALIASES)
    .filter(([, target]) => targets.has(target.toLowerCase()))
    .map(([alias]) => alias)
}

/**
 * 网络 cmdlet；其通配符规则会允许不经 prompt 的数据外泄或下载，且不存在合理的窄前缀。
 */
export const NETWORK_CMDLETS = new Set(['invoke-webrequest', 'invoke-restmethod'])

/**
 * alias/变量修改 cmdlet：Set-Alias 会重新绑定命令解析，Set-Variable 可污染
 * $PSDefaultParameterValues。powershellSecurity.ts 的 checkRuntimeStateManipulation
 * validator 会在权限路径上独立设防。
 */
export const ALIAS_HIJACK_CMDLETS = new Set([
  'set-alias',
  'sal', // alias not in COMMON_ALIASES — list explicitly
  'new-alias',
  'nal', // alias not in COMMON_ALIASES — list explicitly
  'set-variable',
  'sv', // alias not in COMMON_ALIASES — list explicitly
  'new-variable',
  'nv', // alias not in COMMON_ALIASES — list explicitly
])

/**
 * WMI/CIM 进程启动：Invoke-WmiMethod -Class Win32_Process -Name Create 等同于
 * Start-Process，却能绕过 checkStartProcess。不存在合理的窄前缀，任何调用都可能启动
 * 任意进程。权限路径由 checkWmiProcessSpawn validator 设防。（security finding #34）
 */
export const WMI_CIM_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi', // alias not in COMMON_ALIASES — list explicitly
  'invoke-cimmethod',
])

/**
 * CMDLET_ALLOWLIST 中带 additionalCommandIsDangerousCallback 的 cmdlet。
 *
 * 对安全参数（StringConstant 标识符），allowlist 会自动允许这些命令。只有 callback
 * 拒绝时权限对话框才会出现，即参数包含 scriptblock、变量、子表达式等。此时若接受
 * `Cmdlet:*` 通配符，未来所有调用都会通过 prefix-startsWith 匹配，永久绕过 callback。
 * `ForEach-Object:*` 会自动允许 `ForEach-Object { Remove-Item -Recurse / }`。
 *
 * 与 readOnlyValidation.ts 保持同步；test/utils/powershell/dangerousCmdlets.test.ts
 * 会断言此集合覆盖每个 additionalCommandIsDangerousCallback 条目。
 */
export const ARG_GATED_CMDLETS = new Set([
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'measure-object',
  'write-output',
  'write-host',
  'start-sleep',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'out-string',
  'out-host',
  // 参数由 callback 设防的原生可执行文件（如拒绝 ipconfig /flushdns、允许
  // ipconfig /all）也存在相同的绕过风险。
  'ipconfig',
  'hostname',
  'route',
])

/**
 * 权限对话框中绝不能建议为通配符前缀的命令。
 *
 * 由上方 validator 列表和较小的静态 shell 列表推导。把 cmdlet 加入适当的 validator
 * 列表后会自动出现在这里，无需单独维护。
 */
export const NEVER_SUGGEST: ReadonlySet<string> = (() => {
  const core = new Set<string>([
    ...SHELLS_AND_SPAWNERS,
    ...FILEPATH_EXECUTION_CMDLETS,
    ...DANGEROUS_SCRIPT_BLOCK_CMDLETS,
    ...MODULE_LOADING_CMDLETS,
    ...NETWORK_CMDLETS,
    ...ALIAS_HIJACK_CMDLETS,
    ...WMI_CIM_CMDLETS,
    ...ARG_GATED_CMDLETS,
    // ForEach-Object 的 -MemberName（位置形式 `% Delete`）会针对运行时管道对象解析；
    // `Get-ChildItem | % Delete` 将调用 FileInfo.Delete()。StaticParameterBinder
    // 能识别 PropertyAndMethodSet 参数集，但该参数集同时处理属性和方法，参数只是普通
    // StringConstantExpressionAst，没有属性或方法信号。管道类型推断（上游 OutputType →
    // GetMember）会漏掉 ETS AliasProperty 成员，也无法处理 `$var | %` 或外部上游。
    // 它不在 ARG_GATED 中，因为没有要同步的 allowlist 条目。
    'foreach-object',
    // interpreter/runner：`node script.js` 会停在文件参数并建议裸 `node:*`，
    // 从而自动允许通过 -e/-p 执行任意代码。auto 模式 classifier 会移除这些规则
    //（isDangerousPowerShellPermission），但建议关卡此前不会。多单词条目（'npm run'）
    // 会被过滤，因为 NEVER_SUGGEST 按 cmd.name 做单名称查询。
    ...CROSS_PLATFORM_CODE_EXEC.filter((p) => !p.includes(' ')),
  ])
  return new Set([...core, ...aliasesOf(core)])
})()
