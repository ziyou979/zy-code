import { feature } from 'bun:bundle'
import type { z } from 'zod/v4'
import { tSync } from '../../i18n/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { SandboxManager } from '../../services/sandbox/sandboxAdapter.js'
import {
  checkSemantics,
  nodeTypeId,
  type ParseForSecurityResult,
  parseForSecurityFromAst,
  type Redirect,
  type SimpleCommand,
} from '../../shell-eval/bash/ast.js'
import {
  type CommandPrefixResult,
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../shell-eval/bash/commands.js'
import { parseCommandRaw } from '../../shell-eval/bash/parser.js'
import { tryParseShellCommand } from '../../shell-eval/bash/shellQuote.js'
import type { ToolPermissionContext, ToolUseContext } from '../../tools/tool.js'
import { isAbortError } from '../../types/llm.js'
import type { PendingClassifierCheck } from '../../types/permissions.js'
import { count } from '../../utils/array.js'
import { getCwd } from '../../services/environment/cwd.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { AbortError } from '../../utils/errors.js'
import type {
  ClassifierBehavior,
  ClassifierResult,
} from '../../services/permissions/bashClassifier.js'
import {
  classifyBashCommand,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from '../../services/permissions/bashClassifier.js'
import type { PermissionDecisionReason, PermissionResult } from 'src/types/permissions.js'
import type { PermissionRule, PermissionRuleValue } from 'src/types/permissions.js'
import { extractRules } from '../../services/permissions/permissionUpdate.js'
import type { PermissionUpdate } from 'src/types/permissions.js'
import { permissionRuleValueToString } from '../../services/permissions/permissionRuleParser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForTool,
} from '../../services/permissions/permissionRuleQueries.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from '../../services/permissions/shellRuleMatching.js'
import { getPlatform } from '../../services/shell/platform.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { windowsPathToPosixPath } from '../../services/shell/windowsPaths.js'
import { BashTool } from './BashTool.js'
import { checkCommandOperatorPermissions } from './bashCommandHelpers.js'
import { bashCommandIsSafeAsync_DEPRECATED, stripSafeHeredocSubstitutions } from './bashSecurity.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkCatastrophicInsideSubstitutions, checkPathConstraints } from './pathValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import {
  commandHasAnyCd,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
} from './bashCommandDetection.js'

// DCE 临界点：Bun 的 feature() evaluator 对每个函数都有复杂度预算。
// bashToolHasPermission 已接近上限。import block 中的 `import { X as Y }` 别名也计入预算；
// 超过阈值后，Bun 无法再证明 feature('BASH_CLASSIFIER') 是常量，
// 会静默将三元表达式评估为 `false`，丢弃所有 pendingClassifierCheck spread。
// 因此别名应保留为顶层 const 重绑定。另参见下方 checkSemanticsDeny 注释。
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED

// env var 赋值前缀（VAR=value）。由三个 while loop 共享，
// 它们在提取命令名前会跳过安全 env var。
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// CC-643：面对复杂复合命令，splitCommand_DEPRECATED 可能产生极大的 subcommands
// 数组（可能呈指数增长；#21405 的 ReDoS 修复或许并不完整）。随后每个子命令都会运行
// tree-sitter 解析、约 20 个验证器和 logEvent（bashSecurity.ts）；配合已 memoize 的元数据，
// 形成的微任务链会饿死事件循环，使 REPL 在 100% CPU 下冻结。strace 显示
// /proc/self/stat 读取频率约为 127Hz，且没有 epoll_wait。50 已相当宽裕，正常用户命令
// 不会拆出这么多项；超过上限时回退到 'ask'，因为无法证明安全，应让用户确认。
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380：限制为复合命令的每个子命令建议的规则数量。
// 超出上限后，“是，且不再询问 X、Y、Z…”标签本就会退化为“类似命令”，
// 而从一次 prompt 保存 10 条以上规则更可能是噪声，而非用户意图。
// 用户很少在一个 && 列表中串联如此多写命令；必要时可单次批准并手动添加规则。
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * [INNER-ONLY] 记录 classifier 评估结果以便分析。
 * 用于了解正在评估哪些 classifier 规则，以及 classifier 如何对命令作出决策。
 */
function logClassifierResultForAnts(
  command: string,
  behavior: ClassifierBehavior,
  descriptions: string[],
  result: ClassifierResult,
): void {
  if (!isInternalBuild()) {
    return
  }

  logEvent('zy_internal_bash_classifier_result', {
    behavior: behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    descriptions: jsonStringify(
      descriptions,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    matches: result.matches,
    matchedDescription: (result.matchedDescription ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    confidence: result.confidence as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason: result.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 注意：command 包含代码/文件路径，但此逻辑仅 ANT 使用，因此可以接受
    command: command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 从原始命令字符串提取稳定的命令前缀（命令 + 子命令）。
 * 仅当前导 env var 赋值属于 SAFE_ENV_VARS（ant 用户也可属于 ANT_ONLY_SAFE_ENV_VARS）时才跳过。
 * 遇到不安全 env var 时返回 null，以回退到精确匹配；
 * 第二个 token 不像子命令（小写字母数字，如 "commit"、"run"）时也返回 null。
 *
 * Examples:
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run' (NODE_ENV is safe)
 *   'MY_VAR=val npm run build' → null (MY_VAR is not safe)
 *   'ls -la' → null (flag, not a subcommand)
 *   'cat file.txt' → null (filename, not a subcommand)
 *   'chmod 755 file' → null (number, not a subcommand)
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return null
  }

  // 跳过起始处的 env var 赋值（VAR=value），但仅限 SAFE_ENV_VARS
  //（ant 用户也可使用 ANT_ONLY_SAFE_ENV_VARS）。遇到不安全 env var 时返回 null，
  // 以回退到精确匹配。这可避免生成 Bash(npm run:*) 这类在 allow 规则检查时
  // 永远无法匹配的前缀规则，因为 stripSafeWrappers 只移除安全变量。
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe = isInternalBuild() && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) {
    return null
  }
  const subcmd = remaining[1]!
  // 第二个 token 必须像子命令（如 "commit"、"run"、"compose"），
  // 而非 flag (-rf)、文件名 (file.txt)、路径 (/tmp)、URL 或数字 (755)。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) {
    return null
  }
  return remaining.slice(0, 2).join(' ')
}

// `bash:*` 或 `sh:*` 这类裸前缀 suggestion 会通过 `-c` 允许任意代码。
// `env:*` 或 `sudo:*` 等 wrapper suggestion 也有同样问题：
// `env` 不在 SAFE_WRAPPER_PATTERNS 中，因此 `env bash -c "evil"` 经
// stripSafeWrappers 后保持不变，并会命中前缀规则匹配器中的 startsWith("env ") 检查。
// shell 列表与 src/shell-eval/shared/prefix.ts 中保护旧 Haiku 提取器的
// DANGEROUS_SHELL_PREFIXES 一致。
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // 将参数作为命令 exec 的 wrapper
  'env',
  'xargs',
  // 安全要求：checkSemantics（ast.ts）会剥离这些 wrapper 后检查被包装命令。
  // 建议 `Bash(nice:*)` 近似于建议 `Bash(*)`；用户在 prompt 后加入该规则，
  // `nice rm -rf /` 即可通过语义检查，而 deny/cd+git 关卡只会看到 'nice'
  //（此次修复前，下方 SAFE_WRAPPER_PATTERNS 不会剥离裸 `nice`）。因此禁止建议这些前缀。
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // 权限提升：从 `sudo -u foo ...` 生成的 sudo:* 会自动批准以后的任何 sudo 调用
  'sudo',
  'doas',
  'pkexec',
])

/**
 * 仅 UI 使用的回退：getSimpleCommandPrefix 拒绝时只提取首个单词。
 * 外部 build 中 TREE_SITTER_BASH 关闭，BashPermissionRequest 的异步 tree-sitter 优化永远不会触发。
 * 如无此回退，pipe 和复合命令会被原样填入可编辑字段。
 *
 * suggestionForExactCommand 有意不使用此函数：后端建议的 `Bash(rm:*)` 范围过宽，
 * 不适合自动生成，但作为可编辑起点符合用户预期
 *（Slack C07VBSHV7EV/p1772670433193449）。
 *
 * 复用与 getSimpleCommandPrefix 相同的 SAFE_ENV_VARS 关卡；由于
 * stripSafeWrappers 不会剥离 RUN，`Bash(python3:*)` 之类规则在检查时绝不可能
 * 匹配 `RUN=/path python3 ...`。
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe = isInternalBuild() && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) {
    return null
  }
  // 与 getSimpleCommandPrefix 中的子命令 regex 使用相同形状检查：
  // 拒绝路径（./script.sh、/usr/bin/python）、flag、数字和文件名。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) {
    return null
  }
  if (BARE_SHELL_PREFIXES.has(cmd)) {
    return null
  }
  return cmd
}

function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // Heredoc 命令包含每次调用都会变化的多行内容，使精确匹配规则毫无用处。
  // 提取 heredoc operator 前的稳定前缀，改为建议前缀规则。
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) {
    return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)
  }

  // 不含 heredoc 的多行命令也不适合精确匹配规则。
  // 保存完整多行文本可能产生中间含 `:*` 的模式，导致 permission 校验失败并损坏 settings 文件。
  // 因此改用首行作为前缀规则。
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) {
      return sharedSuggestionForPrefix(BashTool.name, firstLine)
    }
  }

  // 单行命令：提取两个单词的前缀，以便规则重用。
  // 否则会保存精确匹配规则，而它永远无法匹配以后使用不同参数的调用。
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BashTool.name, prefix)
  }

  return sharedSuggestionForExactCommand(BashTool.name, command)
}

/**
 * 命令包含 heredoc (<<) 时，提取其前的命令前缀。
 * 返回 heredoc operator 前的首个或前几个单词作为稳定前缀；
 * 命令不含 heredoc 时返回 null。
 *
 * Examples:
 *   'git commit -m "$(cat <<\'EOF\'\n...\nEOF\n)"' → 'git commit'
 *   'cat <<EOF\nhello\nEOF' → 'cat'
 *   'echo hello' → null (no heredoc)
 */
function extractPrefixBeforeHeredoc(command: string): string | null {
  if (!command.includes('<<')) {
    return null
  }

  const idx = command.indexOf('<<')
  if (idx <= 0) {
    return null
  }

  const before = command.substring(0, idx).trim()
  if (!before) {
    return null
  }

  const prefix = getSimpleCommandPrefix(before)
  if (prefix) {
    return prefix
  }

  // 回退：跳过安全 env var 赋值，最多取两个 token。
  // 这会保留 flag token（如 "python3 -c" 仍为 "python3 -c"，而非只剩 "python3"），
  // 并跳过 "NODE_ENV=test" 等安全 env var 前缀。遇到不安全 env var 时返回 null，
  // 避免生成永远无法匹配的前缀规则，理由与 getSimpleCommandPrefix 相同。
  const tokens = before.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe = isInternalBuild() && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }
  if (i >= tokens.length) {
    return null
  }
  return tokens.slice(i, i + 2).join(' ') || null
}

function suggestionForPrefix(prefix: string): PermissionUpdate[] {
  return sharedSuggestionForPrefix(BashTool.name, prefix)
}

/**
 * 可从命令中安全移除的环境变量 allowlist。
 * 这些变量无法执行代码或加载库。
 *
 * 安全要求：绝不能把以下变量加入白名单：
 * - PATH、LD_PRELOAD、LD_LIBRARY_PATH、DYLD_*（执行或库加载）
 * - PYTHONPATH、NODE_PATH、CLASSPATH、RUBYLIB（模块加载）
 * - GOFLAGS、RUSTFLAGS、NODE_OPTIONS（可能包含代码执行 flag）
 * - HOME、TMPDIR、SHELL、BASH_ENV（影响系统行为）
 */
let SAFE_ENV_VARS: Set<string>
SAFE_ENV_VARS = new Set([
  // Go：仅 build/运行时设置
  'GOEXPERIMENT', // experimental features
  'GOOS', // target OS
  'GOARCH', // target architecture
  'CGO_ENABLED', // enable/disable CGO
  'GO111MODULE', // module mode

  // Rust：仅日志/debug
  'RUST_BACKTRACE', // backtrace verbosity
  'RUST_LOG', // logging filter

  // Node：仅环境名（不包括 NODE_OPTIONS）
  'NODE_ENV',

  // Python：仅行为 flag（不包括 PYTHONPATH）
  'PYTHONUNBUFFERED', // disable buffering
  'PYTHONDONTWRITEBYTECODE', // no .pyc files

  // Pytest：测试配置
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', // disable plugin loading
  'PYTEST_DEBUG', // debug output

  // API key 和身份验证
  'ZY_API_KEY', // API authentication

  // locale 和字符编码
  'LANG', // default locale
  'LANGUAGE', // language preference list
  'LC_ALL', // override all locale settings
  'LC_CTYPE', // character classification
  'LC_TIME', // time format
  'CHARSET', // character set preference

  // 终端和显示
  'TERM', // terminal type
  'COLORTERM', // color terminal indicator
  'NO_COLOR', // disable color output (universal standard)
  'FORCE_COLOR', // force color output
  'TZ', // timezone

  // 各类 Tool 的颜色配置
  'LS_COLORS', // colors for ls (GNU)
  'LSCOLORS', // colors for ls (BSD/macOS)
  'GREP_COLOR', // grep match color (deprecated)
  'GREP_COLORS', // grep color scheme
  'GCC_COLORS', // GCC diagnostic colors

  // 显示格式
  'TIME_STYLE', // time display format for ls
  'BLOCK_SIZE', // block size for du/df
  'BLOCKSIZE', // alternative block size
])

/**
 * 可安全地从命令中剥离、仅供 ANT 使用的环境变量。
 * 只在 USER_TYPE === 'zy-super' 时启用。
 *
 * 安全要求：这些环境变量会在权限规则匹配前剥离，因此
 * `DOCKER_HOST=tcp://evil.com docker ps` 剥离后会匹配 `Bash(docker ps:*)`。
 * 此行为有意仅供 ANT 使用（约 380 行处设有开关），绝不能交付外部用户。
 * DOCKER_HOST 会改写 Docker daemon endpoint；剥离它会向权限检查隐藏网络 endpoint，
 * 从而破坏基于前缀的权限限制。KUBECONFIG 同样控制 kubectl 连接的 cluster。
 * 这是为接受该风险的内部高级用户提供的便利处理。
 *
 * 根据 30 天的 zy_internal_bash_tool_use_permission_request 事件分析得出。
 */
let ANT_ONLY_SAFE_ENV_VARS: Set<string>
ANT_ONLY_SAFE_ENV_VARS = new Set([
  // Kubernetes 和容器配置（配置文件指针，不涉及执行）。
  'KUBECONFIG', // kubectl config file path — controls which cluster kubectl uses
  'DOCKER_HOST', // Docker daemon socket/endpoint — controls which daemon docker talks to

  // 云服务商 project/profile 选择（仅名称或标识符）。
  'AWS_PROFILE', // AWS profile name selection
  'CLOUDSDK_CORE_PROJECT', // GCP project ID
  'CLUSTER', // generic cluster name

  // Anthropic 内部 cluster 选择（仅名称或标识符）。
  'COO_CLUSTER', // coo cluster name
  'COO_CLUSTER_NAME', // coo cluster name (alternate)
  'COO_NAMESPACE', // coo namespace
  'COO_LAUNCH_YAML_DRY_RUN', // dry run mode

  // Feature flag（仅布尔或字符串 flag）。
  'SKIP_NODE_VERSION_CHECK', // skip version check
  'EXPECTTEST_ACCEPT', // accept test expectations
  'CI', // CI environment indicator
  'GIT_LFS_SKIP_SMUDGE', // skip LFS downloads

  // GPU/设备选择（仅设备 ID）。
  'CUDA_VISIBLE_DEVICES', // GPU device selection
  'JAX_PLATFORMS', // JAX platform selection

  // 显示和终端设置。
  'COLUMNS', // terminal width
  'TMUX', // TMUX socket info

  // 测试和调试配置。
  'POSTGRESQL_VERSION', // postgres version string
  'FIRESTORE_EMULATOR_HOST', // emulator host:port
  'HARNESS_QUIET', // quiet mode flag
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE', // test update flag
  'DBT_PER_DEVELOPER_ENVIRONMENTS', // DBT config
  'STATSIG_FORD_DB_CHECKS', // statsig DB check flag

  // 构建配置。
  'ANT_ENVIRONMENT', // Anthropic environment name
  'ANT_SERVICE', // Anthropic service name
  'MONOREPO_ROOT_DIR', // monorepo root path

  // 版本选择器。
  'PYENV_VERSION', // Python version selection

  // 凭据（经批准的子集，不会改变数据外泄风险）。
  'PGPASSWORD', // Postgres password
  'GH_TOKEN', // GitHub token
  'GROWTHBOOK_API_KEY', // self-hosted growthbook
])

/**
 * 从命令中移除整行注释。
 * 用于处理 AI 在 bash 命令中添加注释的情况，例如：
 *   "# Check the logs directory\nls /home/user/logs"
 * Should be stripped to: "ls /home/user/logs"
 *
 * 仅移除整行注释（整行都是注释），
 * 不移除同一行命令后的内联注释。
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter((line) => {
    const trimmed = line.trim()
    // 保留非空且不以 # 开头的行
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  // 所有行都是注释/空行时，返回原始命令
  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

export function stripSafeWrappers(command: string): string {
  // 安全：使用 [ \t]+ 而非 \s+；\s 会匹配 bash 命令分隔符 \n/\r。
  // 跨换行匹配会移除一行中的 wrapper，却留下下一行的不同命令供 bash 执行。
  //
  // SECURITY: `(?:--[ \t]+)?` consumes the wrapper's own `--` so
  // `nohup -- rm -- -/../foo` strips to `rm -- -/../foo` (not `-- rm ...`
  // which would skip path validation with `--` as an unknown baseCmd).
  const SAFE_WRAPPER_PATTERNS = [
    // timeout：枚举 GNU 长 flag，包括无值形式（--foreground、--preserve-status、--verbose），
    // 以及使用 = 连写或空格分隔的带值形式。短 flag 包括无参数 -v，
    // 以及值可分离或连写的 -k/-s。
    // SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] (signals are
    // TERM/KILL/9, durations are 5/5s/10.5). Previously [^ \t]+ matched
    // $ ( ) ` | ; & — `timeout -k$(id) 10 ls` stripped to `ls`, matched
    // Bash(ls:*), while bash expanded $(id) during word splitting BEFORE
    // timeout ran. Contrast ENV_VAR_PATTERN below which already allowlists.
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // 安全：必须与 checkSemantics wrapper 移除（ast.ts 约 1990–2080 行）
    // 以及 stripWrappersFromArgv（pathValidation.ts 约 1260 行）保持同步。
    // Previously this pattern REQUIRED `-n N`; checkSemantics already handled
    // bare `nice` and legacy `-N`. Asymmetry meant checkSemantics exposed the
    // wrapped command to semantic checks but deny-rule matching and the cd+git
    // gate saw the wrapper name. `nice rm -rf /` with Bash(rm:*) deny became
    // ask instead of deny; `cd evil && nice git status` skipped the bare-repo
    // RCE gate. PR #21503 fixed stripWrappersFromArgv; this was missed.
    // Now matches: `nice cmd`, `nice -n N cmd`, `nice -N cmd` (all forms
    // checkSemantics strips).
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf：仅处理连写短 flag（-o0、-eL）。checkSemantics 可处理更多形式，
    // 但上方对其他形式会 fail closed，因此此处不过度移除是安全的。
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // 环境变量模式：
  // ^([A-Za-z_][A-Za-z0-9_]*)  - Variable name (standard identifier)
  // =                           - Equals sign
  // ([A-Za-z0-9_./:-]+)         - Value: alphanumeric + safe punctuation only
  // [ \t]+                      - Required HORIZONTAL whitespace after value
  //
  // 安全：仅匹配由安全字符组成的未引用值（不含 $()、`、$var、;|&）。
  //
  // SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
  // \s matches \n/\r. If reconstructCommand emits an unquoted newline between
  // `TZ=UTC` and `echo`, \s+ would match across it and strip `TZ=UTC<NL>`,
  // leaving `echo curl evil.com` to match Bash(echo:*). But bash treats the
  // newline as a command separator. Defense-in-depth with needsQuoting fix.
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // 阶段 1：仅移除前导 env var 和注释。
  // bash 中命令前的 env var 赋值（VAR=val cmd）是真正的 shell 级赋值，
  // 可为 permission 匹配安全移除。
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      const isAntOnlySafe = isInternalBuild() && ANT_ONLY_SAFE_ENV_VARS.has(varName)
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

  // 阶段 2：仅移除 wrapper 命令和注释，不移除 env var。
  // wrapper 命令（timeout、time、nice、nohup）使用 execvp 运行参数，
  // 因此 wrapper 后的 VAR=val 会被视为要执行的命令，而非 env var 赋值。
  // 此处移除 env var 会导致 parser 看到的内容与实际执行内容不一致。
  // (HackerOne #3543050)
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

// SECURITY: allowlist for timeout flag VALUES (signals are TERM/KILL/9,
// durations are 5/5s/10.5). Rejects $ ( ) ` | ; & and newlines that
// previously matched via [^ \t]+ — `timeout -k$(id) 10 ls` must NOT strip.
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU flag（长 + 短、连写 + 空格分隔），
 * 返回 DURATION token 的 argv 索引；flag 无法解析时返回 -1。
 * Enumerates: --foreground/--preserve-status/--verbose (no value),
 * --kill-after/--signal (value, both =fused and space-separated), -v (no
 * value), -k/-s (value, both fused and space-separated).
 *
 * 从 stripWrappersFromArgv 中抽取，以使 bashToolHasPermission 低于 Bun feature() DCE 复杂度阈值。
 * 将它内联会破坏 classifier 测试中 feature('BASH_CLASSIFIER') 的评估。
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (arg === '--foreground' || arg === '--preserve-status' || arg === '--verbose') {
      i++
    } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
      i++
    } else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    ) {
      i += 2
    } else if (arg === '--') {
      i++
      break
    } // end-of-options marker
    else if (arg.startsWith('--')) {
      return -1
    } else if (arg === '-v') {
      i++
    } else if ((arg === '-k' || arg === '-s') && next && TIMEOUT_FLAG_VALUE_RE.test(next)) {
      i += 2
    } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
      i++
    } else if (arg.startsWith('-')) {
      return -1
    } else {
      break
    }
  }
  return i
}

/**
 * stripSafeWrappers 的 argv 级对应实现。从 AST 派生 argv 中移除相同的 wrapper 命令
 *（timeout、time、nice、nohup）。env var 已分离到 SimpleCommand.envVars，因此无需移除。
 *
 * 必须与上方 SAFE_WRAPPER_PATTERNS 保持同步：在上方添加 wrapper 时，此处也必须添加。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  // SECURITY: Consume optional `--` after wrapper options, matching what the
  // wrapper does. Otherwise `['nohup','--','rm','--','-/../foo']` yields `--`
  // as baseCmd and skips path validation. See SAFE_WRAPPER_PATTERNS comment.
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
        return a
      }
      a = a.slice(i + 1)
    } else if (a[0] === 'nice' && a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
      a = a.slice(a[3] === '--' ? 4 : 3)
    } else {
      return a
    }
  }
}

/**
 * 会导致运行不同 binary 的 env var（注入或解析劫持）。
 * 仅为启发式规则：export-&& 形式可绕过，且 excludedCommands 本就不是安全边界。
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * 从命令中移除所有前导 env var 前缀，无论变量名是否位于 safe-list。
 *
 * 用于 deny/ask 规则匹配：用户拒绝 `zy` 或 `rm` 后，
 * 即使命令带有 `FOO=bar zy` 这类任意 env var 前缀，也应继续被阻止。
 * stripSafeWrappers 的 safe-list 限制对 allow 规则是正确的，但 deny 规则必须更难绕过。
 *
 * 也用于 sandbox.excludedCommands 匹配（它不是安全边界，permission prompt 才是），
 * 此时使用 BINARY_HIJACK_VARS 作为 blocklist。
 *
 * 安全：使用比 stripSafeWrappers 更宽的值模式。该模式仅排除真正的 shell 注入字符
 * 和空白。=、+、@、~、, 等字符在未引用 env var 赋值位置中无害，必须匹配，
 * 以防 `FOO=a=b denied_command` 之类的简单绕过。
 *
 * @param blocklist - optional regex tested against each var name; matching vars
 *   are NOT stripped (and stripping stops there). Omit for deny rules; pass
 *   BINARY_HIJACK_VARS for excludedCommands.
 */
export function stripAllLeadingEnvVars(command: string, blocklist?: RegExp): string {
  // Broader value pattern for deny-rule stripping. Handles:
  //
  // - Standard assignment (FOO=bar), append (FOO+=bar), array (FOO[0]=bar)
  // - Single-quoted values: '[^'\n\r]*' — bash suppresses all expansion
  // - Double-quoted values with backslash escapes: "(?:\\.|[^"$`\\\n\r])*"
  //   In bash double quotes, only \$, \`, \", \\, and \newline are special.
  //   Other \x sequences are harmless, so we allow \. inside double quotes.
  //   We still exclude raw $ and ` (without backslash) to block expansion.
  // - Unquoted values: excludes shell metacharacters, allows backslash escapes
  // - Concatenated segments: FOO='x'y"z" — bash concatenates adjacent segments
  //
  // SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
  //
  // The outer * matches one atomic unit per iteration: a complete quoted
  // string, a backslash-escape pair, or a single unquoted safe character.
  // The inner double-quote alternation (?:...|...)* is bounded by the
  // closing ", so it cannot interact with the outer * for backtracking.
  //
  // Note: $ is excluded from unquoted/double-quoted value classes to block
  // dangerous forms like $(cmd), ${var}, and $((expr)). This means
  // FOO=$VAR is not stripped — adding $VAR matching creates ReDoS risk
  // (CodeQL #671) and $VAR bypasses are low-priority.
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) {
      continue
    }
    if (blocklist?.test(m[1]!)) {
      break
    }
    stripped = stripped.slice(m[0].length)
  }

  return stripped.trim()
}

function filterRulesByContentsMatchingInput(
  input: z.infer<typeof BashTool.inputSchema>,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  {
    stripAllEnvVars = false,
    skipCompoundCheck = false,
  }: { stripAllEnvVars?: boolean; skipCompoundCheck?: boolean } = {},
): PermissionRule[] {
  const command = input.command.trim()

  // 为 permission 匹配移除输出重定向。
  // 这使 Bash(python:*) 等规则可匹配 "python script.py > output.txt"。
  // 重定向目标的安全校验由 checkPathConstraints 单独执行。
  const commandWithoutRedirections = extractOutputRedirections(command).commandWithoutRedirections

  // 精确匹配时，同时尝试原始命令（保留引号）和移除重定向的命令
  //（允许不带重定向的规则匹配）。前缀匹配时仅使用移除重定向的命令。
  const commandsForMatching =
    matchMode === 'exact' ? [command, commandWithoutRedirections] : [commandWithoutRedirections]

  // 为了匹配，移除安全 wrapper 命令（timeout、time、nice、nohup）和 env var。
  // 这使 Bash(npm install:*) 等规则可匹配 "timeout 10 npm install foo" 或 "GOOS=linux go build"。
  const commandsToTry = commandsForMatching.flatMap((cmd) => {
    const strippedCommand = stripSafeWrappers(cmd)
    return strippedCommand !== cmd ? [cmd, strippedCommand] : [cmd]
  })

  // SECURITY: For deny/ask rules, also try matching after stripping ALL leading
  // env var prefixes. This prevents bypass via `FOO=bar denied_command` where
  // FOO is not in the safe-list. The safe-list restriction in stripSafeWrappers
  // is intentional for allow rules (see HackerOne #3543050), but deny rules
  // must be harder to circumvent — a denied command should stay denied
  // regardless of env var prefixes.
  //
  // We iteratively apply both stripping operations to all candidates until no
  // new candidates are produced (fixed-point). This handles interleaved patterns
  // like `nohup FOO=bar timeout 5 zy` where:
  //   1. stripSafeWrappers strips `nohup` → `FOO=bar timeout 5 zy`
  //   2. stripAllLeadingEnvVars strips `FOO=bar` → `timeout 5 zy`
  //   3. stripSafeWrappers strips `timeout 5` → `zy` (deny match)
  //
  // Without iteration, single-pass compositions miss multi-layer interleaving.
  if (stripAllEnvVars) {
    const seen = new Set(commandsToTry)
    let startIdx = 0

    // 迭代直到不再产生新候选（不动点）
    while (startIdx < commandsToTry.length) {
      const endIdx = commandsToTry.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = commandsToTry[i]
        if (!cmd) {
          continue
        }
        // 尝试移除 env var
        const envStripped = stripAllLeadingEnvVars(cmd)
        if (!seen.has(envStripped)) {
          commandsToTry.push(envStripped)
          seen.add(envStripped)
        }
        // 尝试移除安全 wrapper
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          commandsToTry.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }
  }

  // 预先计算每个候选的复合命令状态，避免在规则过滤 loop 内重新解析。
  // 否则 splitCommand 调用量会按 rules.length × commandsToTry.length 增长。
  // 复合检查仅适用于 'prefix' 模式的前缀/wildcard 匹配，且仅适用于 allow 规则。
  // 安全：deny/ask 规则必须匹配复合命令，防止用复合表达式包装被拒命令来绕过。
  const isCompoundCommand = new Map<string, boolean>()
  if (matchMode === 'prefix' && !skipCompoundCheck) {
    for (const cmd of commandsToTry) {
      if (!isCompoundCommand.has(cmd)) {
        isCompoundCommand.set(cmd, splitCommand(cmd).length > 1)
      }
    }
  }

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      // 兼容 Tool(param:value) 语法：如果规则内容以 "command:" 开头则剥离
      // 例如 Bash(command:npm install) → npm install
      const strippedContent = ruleContent.startsWith('command:')
        ? ruleContent.slice('command:'.length)
        : ruleContent
      const bashRule = parsePermissionRule(strippedContent)

      return commandsToTry.some((cmdToMatch) => {
        switch (bashRule.type) {
          case 'exact':
            return bashRule.command === cmdToMatch
          case 'prefix':
            switch (matchMode) {
              // 'exact' 模式下，仅在命令与前缀规则完全匹配时返回 true
              case 'exact':
                return bashRule.prefix === cmdToMatch
              case 'prefix': {
                // SECURITY: Don't allow prefix rules to match compound commands.
                // e.g., Bash(cd:*) must NOT match "cd /path && python3 evil.py".
                // In the normal flow commands are split before reaching here, but
                // shell escaping can defeat the first splitCommand pass — e.g.,
                //   cd src\&\& python3 hello.py  →  splitCommand  →  ["cd src&& python3 hello.py"]
                // which then looks like a single command that starts with "cd ".
                // Re-splitting the candidate here catches those cases.
                if (isCompoundCommand.get(cmdToMatch)) {
                  return false
                }
                // 确保单词边界：前缀后必须是空格或字符串末尾，
                // 防止 "ls:*" 匹配 "lsof" 或 "lsattr"。
                if (cmdToMatch === bashRule.prefix) {
                  return true
                }
                if (cmdToMatch.startsWith(`${bashRule.prefix} `)) {
                  return true
                }
                // Also match "xargs <prefix>" for bare xargs with no flags.
                // This allows Bash(grep:*) to match "xargs grep pattern",
                // and deny rules like Bash(rm:*) to block "xargs rm file".
                // Natural word-boundary: "xargs -n1 grep" does NOT start with
                // "xargs grep " so flagged xargs invocations are not matched.
                const xargsPrefix = `xargs ${bashRule.prefix}`
                if (cmdToMatch === xargsPrefix) {
                  return true
                }
                return cmdToMatch.startsWith(`${xargsPrefix} `)
              }
            }
            break
          case 'wildcard':
            // SECURITY FIX: In exact match mode, wildcards must NOT match because we're
            // checking the full unparsed command. Wildcard matching on unparsed commands
            // allows "foo *" to match "foo arg && curl evil.com" since .* matches operators.
            // Wildcards should only match after splitting into individual subcommands.
            if (matchMode === 'exact') {
              return false
            }
            // SECURITY: Same as for prefix rules, don't allow wildcard rules to match
            // compound commands in prefix mode. e.g., Bash(cd *) must not match
            // "cd /path && python3 evil.py" even though "cd *" pattern would match it.
            if (isCompoundCommand.get(cmdToMatch)) {
              return false
            }
            // In prefix mode (after splitting), wildcards can safely match subcommands
            return matchWildcardPattern(bashRule.pattern, cmdToMatch)
        }
      })
    })
    .map(([, rule]) => rule)
}

function matchingRulesForInput(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
  { skipCompoundCheck = false }: { skipCompoundCheck?: boolean } = {},
) {
  const denyRuleByContents = getRuleByContentsForTool(toolPermissionContext, BashTool, 'deny')
  // 安全：Deny/ask 规则使用更激进的 env var 移除，
  // 使 `FOO=bar denied_command` 仍可匹配 `denied_command` 的 deny 规则。
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const askRuleByContents = getRuleByContentsForTool(toolPermissionContext, BashTool, 'ask')
  const matchingAskRules = filterRulesByContentsMatchingInput(input, askRuleByContents, matchMode, {
    stripAllEnvVars: true,
    skipCompoundCheck: true,
  })

  const allowRuleByContents = getRuleByContentsForTool(toolPermissionContext, BashTool, 'allow')
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    { skipCompoundCheck },
  )

  return {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  }
}

/**
 * 检查子命令是否与 permission 规则精确匹配。
 */
export const bashToolCheckExactMatchPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'exact',
  )

  // 1. 精确命令被拒时返回 deny
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: tSync('bash.permission.denied', { tool: BashTool.name, command }),
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2. 精确命令位于 ask 规则中时询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 精确命令已允许时返回 allow
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 4. 其他情况 passthrough
  const decisionReason = {
    type: 'other' as const,
    reason: tSync('bash.permission.requiresApproval'),
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 向用户建议精确匹配规则；
    // 该 suggestion 可能被 `checkCommandAndSuggestRules()` 中的前缀 suggestion 覆盖。
    suggestions: suggestionForExactCommand(command),
  }
}

export const bashToolCheckPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
): PermissionResult => {
  const command = input.command.trim()

  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(input, toolPermissionContext)

  // 1a. 精确命令有规则时返回 deny/ask
  if (exactMatchResult.behavior === 'deny' || exactMatchResult.behavior === 'ask') {
    return exactMatchResult
  }

  // 2. 查找所有匹配规则（前缀或精确）。
  // 安全修复：在路径约束之前检查 Bash deny/ask 规则，
  // 防止通过项目目录外的绝对路径绕过（HackerOne 报告）。
  // When AST-parsed, the subcommand is already atomic — skip the legacy
  // splitCommand re-check that misparses mid-word # as compound.
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
    {
      skipCompoundCheck: astCommand !== undefined,
    },
  )

  // 2a. 命令有 deny 规则时拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: tSync('bash.permission.denied', { tool: BashTool.name, command }),
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 命令有 ask 规则时询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 检查路径约束。
  // 该检查位于 deny/ask 规则之后，使显式规则优先。
  // SECURITY: When AST-derived argv is available for this subcommand, pass
  // it through so checkPathConstraints uses it directly instead of re-parsing
  // with shell-quote (which has a single-quote backslash bug that causes
  // parseCommandArguments to return [] and silently skip path validation).
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    toolPermissionContext,
    compoundCommandHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 4. 命令有精确匹配 allow 时允许
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 5. 命令有 allow 规则时允许
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5b. 检查 sed 约束（在模式自动 allow 前阻止危险 sed 操作）
  const sedConstraintResult = checkSedConstraints(input, toolPermissionContext)
  if (sedConstraintResult.behavior !== 'passthrough') {
    return sedConstraintResult
  }

  // 6. 检查模式专属 permission 处理
  const modeResult = checkPermissionMode(input, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // 7. 检查只读规则
  if (BashTool.isReadOnly(input)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: tSync('bash.permission.readOnlyAllowed'),
      },
    }
  }

  // 8. 无规则匹配时 passthrough，将触发 permission prompt
  const decisionReason = {
    type: 'other' as const,
    reason: tSync('bash.permission.requiresApproval'),
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // Suggest exact match rule to user
    // this may be overridden by prefix suggestions in `checkCommandAndSuggestRules()`
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 处理单个子命令，并应用前缀检查和 suggestion。
 */
export async function checkCommandAndSuggestRules(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult> {
  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(input, toolPermissionContext)
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  // 2. 检查命令前缀
  const permissionResult = bashToolCheckPermission(
    input,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  // 2a. 命令被显式 deny/ask 时返回对应结果
  if (permissionResult.behavior === 'deny' || permissionResult.behavior === 'ask') {
    return permissionResult
  }

  // 3. Ask for permission if command injection is detected. Skip when the
  // AST parse already succeeded — tree-sitter has verified there are no
  // hidden substitutions or structural tricks, so the legacy regex-based
  // validators (backslash-escaped operators, etc.) would only add FPs.
  if (!astParseSucceeded && !isEnvTruthy(process.env.ZY_CODE_DISABLE_COMMAND_INJECTION_CHECK)) {
    const safetyResult = await bashCommandIsSafeAsync(input.command)

    if (safetyResult.behavior !== 'passthrough') {
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason:
          safetyResult.behavior === 'ask' && safetyResult.message
            ? safetyResult.message
            : 'This command contains patterns that could pose security risks and requires approval',
      }

      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        decisionReason,
        suggestions: [], // Don't suggest saving a potentially dangerous command
      }
    }
  }

  // 4. 命令已允许时返回 allow
  if (permissionResult.behavior === 'allow') {
    return permissionResult
  }

  // 5. 可用时建议前缀，否则建议精确命令
  const suggestedUpdates = commandPrefixResult?.commandPrefix
    ? suggestionForPrefix(commandPrefixResult.commandPrefix)
    : suggestionForExactCommand(input.command)

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}

/**
 * 检查命令在 sandbox 中是否应自动允许。
 * 存在应遵守的显式 deny/ask 规则时提前返回。
 *
 * 注意：仅应在 sandbox 和 auto-allow 都启用时调用此函数。
 *
 * @param input - The bash tool input
 * @param toolPermissionContext - The permission context
 * @returns PermissionResult with:
 *   - deny/ask if explicit rule exists (exact or prefix)
 *   - allow if no explicit rules (sandbox auto-allow applies)
 *   - passthrough should not occur since we're in auto-allow mode
 */
function checkSandboxAutoAllow(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 检查整条命令的显式 deny/ask 规则（精确 + 前缀）
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 整条命令有显式 deny 规则时立即返回
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: tSync('bash.permission.denied', { tool: BashTool.name, command }),
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // SECURITY: For compound commands, check each subcommand against deny/ask
  // rules. Prefix rules like Bash(rm:*) won't match the full compound command
  // (e.g., "echo hello && rm -rf /" doesn't start with "rm"), so we must
  // check each subcommand individually.
  // IMPORTANT: Subcommand deny checks must run BEFORE full-command ask returns.
  // Otherwise a wildcard ask rule matching the full command (e.g., Bash(*echo*))
  // would return 'ask' before a prefix deny rule on a subcommand (e.g., Bash(rm:*))
  // gets checked, downgrading a deny to an ask.
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput({ command: sub }, toolPermissionContext, 'prefix')
      // Deny 优先，立即返回
      if (subResult.matchingDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: tSync('bash.permission.denied', { tool: BashTool.name, command }),
          decisionReason: {
            type: 'rule',
            rule: subResult.matchingDenyRules[0],
          },
        }
      }
      // 暂存第一个 ask 匹配，先不返回（所有子命令中的 deny 优先）
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name),
        decisionReason: {
          type: 'rule',
          rule: firstAskRule,
        },
      }
    }
  }

  // 在所有 deny 来源均已检查后，检查整条命令的 ask
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }
  // 无显式规则，因此在 sandbox 中自动 allow

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: tSync('bash.permission.sandboxAutoAllow'),
    },
  }
}

/**
 * 过滤 `cd ${cwd}` 前缀子命令，同时保持 astCommands 对齐。
 * 该逻辑被抽取出来，以使 bashToolHasPermission 低于 Bun feature() DCE 复杂度阈值。
 * 将它内联会破坏约 10 个 classifier 测试中的 pendingClassifierCheck 附加。
 */
function filterCdCwdSubcommands(
  rawSubcommands: string[],
  astCommands: SimpleCommand[] | undefined,
  cwd: string,
  cwdMingw: string,
): { subcommands: string[]; astCommandsByIdx: (SimpleCommand | undefined)[] } {
  const subcommands: string[] = []
  const astCommandsByIdx: (SimpleCommand | undefined)[] = []
  for (let i = 0; i < rawSubcommands.length; i++) {
    const cmd = rawSubcommands[i]!
    if (cmd === `cd ${cwd}` || cmd === `cd ${cwdMingw}`) {
      continue
    }
    subcommands.push(cmd)
    astCommandsByIdx.push(astCommands?.[i])
  }
  return { subcommands, astCommandsByIdx }
}

/**
 * AST too-complex 和 checkSemantics 路径的提前退出 deny 强制逻辑。
 * 精确匹配结果非 passthrough（deny/ask/allow）时直接返回，随后检查前缀/wildcard deny 规则。
 * 两者均未匹配时返回 null，表示调用方应落入 ask。
 * 抽取此逻辑是为使 bashToolHasPermission 低于 Bun feature() DCE 复杂度阈值。
 */
function checkEarlyExitDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  const exactMatchResult = bashToolCheckExactMatchPermission(input, toolPermissionContext)
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }
  const denyMatch = matchingRulesForInput(input, toolPermissionContext, 'prefix')
    .matchingDenyRules[0]
  if (denyMatch !== undefined) {
    return {
      behavior: 'deny',
      message: tSync('bash.permission.denied', { tool: BashTool.name, command: input.command }),
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }
  return null
}

/**
 * 对 checkSemantics 路径执行 deny 检查。先调用 checkEarlyExitDeny（精确匹配
 * 和完整命令的前缀 deny），再逐一用前缀 deny 规则检查每个 SimpleCommand 的
 * .text 区间。之所以需要逐子命令检查，是因为
 * filterRulesByContentsMatchingInput 带有复合命令保护：
 * splitCommand().length > 1 时，前缀规则会返回 false，导致 `Bash(eval:*)`
 * 无法匹配 `echo foo | eval rm` 这样的完整管道。每个 SimpleCommand 区间都只含
 * 一条命令，因此不会触发该保护。
 *
 * 此逻辑保留为独立 helper（不并入 checkEarlyExitDeny，也不在调用处内联），
 * 因为 bashToolHasPermission 已逼近 Bun 的 feature() DCE 复杂度阈值；
 * 即便只增加约 5 行，也会破坏 feature('BASH_CLASSIFIER') 求值，
 * 导致 pendingClassifierCheck 被移除。
 */
function checkSemanticsDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commands: readonly { text: string }[],
): PermissionResult | null {
  const fullCmd = checkEarlyExitDeny(input, toolPermissionContext)
  if (fullCmd !== null) {
    return fullCmd
  }
  for (const cmd of commands) {
    const subDeny = matchingRulesForInput(
      { ...input, command: cmd.text },
      toolPermissionContext,
      'prefix',
    ).matchingDenyRules[0]
    if (subDeny !== undefined) {
      return {
        behavior: 'deny',
        message: tSync('bash.permission.denied', { tool: BashTool.name, command: input.command }),
        decisionReason: { type: 'rule', rule: subDeny },
      }
    }
  }
  return null
}

/**
 * classifier 已启用且存在 allow description 时，构建待执行 classifier 检查元数据。
 * classifier 禁用、处于 auto 模式或不存在 allow description 时返回 undefined。
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) {
    return undefined
  }
  // auto 模式下跳过，该模式的 classifier 会处理所有 permission 决策
  if (true && toolPermissionContext.mode === 'auto') {
    return undefined
  }
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return undefined
  }

  const allowDescriptions = getBashPromptAllowDescriptions(toolPermissionContext)
  if (allowDescriptions.length === 0) {
    return undefined
  }

  return {
    command,
    cwd: getCwd(),
    descriptions: allowDescriptions,
  }
}

const speculativeChecks = new Map<string, Promise<ClassifierResult>>()

/**
 * 提前启动推测性 bash allow classifier 检查，使它与 pre-tool hook、
 * deny/ask classifier 和 permission 对话框设置并行运行。
 * 结果稍后可由 executeAsyncClassifierCheck 通过 consumeSpeculativeClassifierCheck 消费。
 */
export function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  return speculativeChecks.get(command)
}

export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // 与 buildPendingClassifierCheck 使用相同的守卫条件
  if (!isClassifierPermissionsEnabled()) {
    return false
  }
  if (true && toolPermissionContext.mode === 'auto') {
    return false
  }
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return false
  }
  const allowDescriptions = getBashPromptAllowDescriptions(toolPermissionContext)
  if (allowDescriptions.length === 0) {
    return false
  }

  const cwd = getCwd()
  const promise = classifyBashCommand(
    command,
    cwd,
    allowDescriptions,
    'allow',
    signal,
    isNonInteractiveSession,
  )
  // 防止 signal 在 promise 被消费前 abort 而产生未处理 rejection。
  // 原始 promise（可能 reject）仍保存在 Map 中，供 consumer await。
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

/**
 * 消费指定命令的推测性 classifier 检查结果。
 * promise 存在时返回并从 Map 中移除，否则返回 undefined。
 */
export function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  const promise = speculativeChecks.get(command)
  if (promise) {
    speculativeChecks.delete(command)
  }
  return promise
}

export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * 等待待执行 classifier 检查；高置信度 allow 时返回 PermissionDecisionReason，
 * 否则返回 undefined。
 *
 * swarm agent（tmux 和进程内）用它控制 permission 转发：
 * 先运行 classifier，仅在 classifier 未自动批准时才升级给 leader。
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(
        command,
        cwd,
        descriptions,
        'allow',
        signal,
        isNonInteractiveSession,
      )

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: tSync('bash.permission.allowedByPromptRule', {
        rule: classifierResult.matchedDescription ?? '',
      }),
    }
  }
  return undefined
}

type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}

/**
 * 异步执行 bash allow classifier 检查。
 * permission prompt 显示期间在后台运行。classifier 以高置信度 allow 且用户尚未交互时，自动批准。
 *
 * @param pendingCheck - bashToolHasPermission 返回的 classifier 检查元数据
 * @param signal - 中止信号
 * @param isNonInteractiveSession - 是否为非交互式会话
 * @param callbacks - 用于判断是否继续以及处理批准的回调
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)

  let classifierResult: ClassifierResult
  try {
    classifierResult = speculativeResult
      ? await speculativeResult
      : await classifyBashCommand(
          command,
          cwd,
          descriptions,
          'allow',
          signal,
          isNonInteractiveSession,
        )
  } catch (error: unknown) {
    // coordinator 会话取消时会触发中止信号，classifier API 调用随即以
    // APIUserAbortError 拒绝。这是预期行为，不应表现为未处理的 Promise 拒绝。
    if (isAbortError(error) || error instanceof AbortError) {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // 如果用户已经做出决定，或已操作权限对话框（如方向键、Tab、输入），则不要自动批准。
  if (!callbacks.shouldContinue()) {
    return
  }

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: tSync('bash.permission.allowedByPromptRule', {
        rule: classifierResult.matchedDescription ?? '',
      }),
    })
  } else {
    // 未匹配，发送通知以清除检查指示器
    callbacks.onComplete?.()
  }
}

/**
 * 检查使用指定输入调用 BashTool 是否需要请求用户 permission 的主实现。
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. 基于 AST 的安全解析。它同时取代 tryParseShellCommand
  //（shell-quote 预检查）和 bashCommandIsSafe 的误解析关卡。
  // tree-sitter 要么生成干净的 SimpleCommand[]（引号已解析，且无隐藏替换），
  // 要么返回 'too-complex'；这正是判断能否信任 splitCommand 输出所需的信号。
  //
  // 当 tree-sitter WASM 不可用，或通过环境变量禁用了注入检查时，
  // 回退到旧路径（执行约 1370 行处的 legacy 关卡）。
  const injectionCheckDisabled = isEnvTruthy(process.env.ZY_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  // shadow 模式的 GrowthBook 紧急开关；关闭时完全跳过原生解析。
  // 此值只计算一次；feature() 必须保留在下方三元表达式内联位置。
  const shadowEnabled = feature('TREE_SITTER_BASH_SHADOW')
    ? getFeatureValue_CACHED_MAY_BE_STALE('zy_birch_trellis', true)
    : false
  // 在此只解析一次；所得 AST 同时供 parseForSecurityFromAst 和
  // bashToolCheckCommandOperatorPermissions 使用。
  let astRoot = injectionCheckDisabled
    ? null
    : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
      ? null
      : await parseCommandRaw(input.command)
  let astResult: ParseForSecurityResult = astRoot
    ? parseForSecurityFromAst(input.command, astRoot)
    : { kind: 'parse-unavailable' }
  let astSubcommands: string[] | null = null
  let astRedirects: Redirect[] | undefined
  let astCommands: SimpleCommand[] | undefined
  let shadowLegacySubs: string[] | undefined
  let shadowParserAvailable: boolean | undefined

  // 对 tree-sitter 做 shadow 测试：记录其结论后，强制设为 parse-unavailable，
  // 让 legacy 路径继续作为权威结果。parseCommand 仍由 TREE_SITTER_BASH
  //（而非 SHADOW）控制，以保证 legacy 内部只使用 regex。
  // 每次 bash 调用只用一个事件同时记录分歧和不可用原因；模块加载失败则由
  // 会话级 zy_tree_sitter_load 事件单独记录。
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    const available = astResult.kind !== 'parse-unavailable'
    shadowParserAvailable = available
    let tooComplex = false
    let semanticFail = false
    let subsDiffer = false
    if (available) {
      tooComplex = astResult.kind === 'too-complex'
      semanticFail = astResult.kind === 'simple' && !checkSemantics(astResult.commands).ok
      const tsSubs = astResult.kind === 'simple' ? astResult.commands.map((c) => c.text) : undefined
      const legacySubs = splitCommand(input.command)
      shadowLegacySubs = legacySubs
      subsDiffer =
        tsSubs !== undefined &&
        (tsSubs.length !== legacySubs.length || tsSubs.some((s, i) => s !== legacySubs[i]))
    }
    logEvent('zy_tree_sitter_shadow', {
      available,
      astTooComplex: tooComplex,
      astSemanticFail: semanticFail,
      subsDiffer,
      injectionCheckDisabled,
      killswitchOff: !shadowEnabled,
      cmdOverLength: input.command.length > 10000,
    })
    // 始终强制使用 legacy 路径；shadow 模式仅用于观测。
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  if (astResult.kind === 'too-complex') {
    // 解析成功，但发现无法静态分析的结构（命令替换、展开、控制流或解析器差异）。
    // 先遵循精确匹配的 deny/ask/allow，再检查前缀或通配符 deny。
    // 仅在没有 deny 匹配时才落到 ask，不能把 deny 降级成 ask。
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) {
      return earlyExit
    }
    // P0-1：即便处于 bypass/auto 模式，也要检查命令替换中的灾难性 rm；
    // safetyCheck 原因类型会覆盖 bypass。
    {
      const catastrophicResult = checkCatastrophicInsideSubstitutions(input.command, getCwd())
      if (catastrophicResult.behavior !== 'passthrough') {
        return catastrophicResult
      }
    }
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: astResult.reason,
    }
    logEvent('zy_bash_ast_too_complex', {
      nodeTypeId: nodeTypeId(astResult.nodeType),
    })
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      suggestions: [],
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  if (astResult.kind === 'simple') {
    // 解析结果干净时，检查能够正常分词、但名称本身危险的语义问题，
    // 例如 zsh builtin、eval 等。
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      // 与 too-complex 路径执行相同的 deny 规则：配置 `Bash(eval:*)` deny 的用户
      // 期望 `eval "rm"` 被阻止，而不是被降级处理。
      const earlyExit = checkSemanticsDeny(
        input,
        appState.toolPermissionContext,
        astResult.commands,
      )
      if (earlyExit !== null) {
        return earlyExit
      }
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason: sem.reason,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        suggestions: [],
      }
    }
    // 暂存已分词的子命令供下文使用。下游代码（规则匹配、路径提取、cd 检测）
    // 仍以字符串工作，因此传递每个 SimpleCommand 的原始源码区间。下游处理
    //（stripSafeWrappers、parseCommandArguments）会再次对这些区间分词；
    // 该过程存在已知缺陷（stripCommentLines 会错误处理引号内的换行），
    // 但 checkSemantics 已捕获所有含换行的 argv 元素，因此这里不会受影响。
    // 后续提交再将下游迁移为直接处理 argv。
    astSubcommands = astResult.commands.map((c) => c.text)
    astRedirects = astResult.commands.flatMap((c) => c.redirects)
    astCommands = astResult.commands
  }

  // Legacy shell-quote 预检查。仅在 'parse-unavailable' 时进入
  //（tree-sitter 未加载或 TREE_SITTER_BASH feature 被关闭），随后继续执行
  // 下方完整的 legacy 路径。
  if (astResult.kind === 'parse-unavailable') {
    // 区分主动关闭、灰度未开启和真正的解析失败，避免把预期降级误报为运行时故障。
    if (injectionCheckDisabled) {
      logForDebugging(
        'bashToolHasPermission: AST security parsing disabled by ZY_CODE_DISABLE_COMMAND_INJECTION_CHECK, using legacy shell-quote path',
      )
    } else if (feature('TREE_SITTER_BASH')) {
      logForDebugging(
        'bashToolHasPermission: Bash AST parser unavailable, using legacy shell-quote path',
      )
    } else if (feature('TREE_SITTER_BASH_SHADOW')) {
      if (!shadowEnabled) {
        logForDebugging(
          'bashToolHasPermission: Bash AST shadow rollout disabled, using legacy shell-quote path',
        )
      } else if (shadowParserAvailable) {
        logForDebugging(
          'bashToolHasPermission: Bash AST shadow mode is observational, using legacy shell-quote path',
        )
      } else {
        logForDebugging(
          'bashToolHasPermission: Bash AST parser unavailable in shadow mode, using legacy shell-quote path',
        )
      }
    } else {
      logForDebugging(
        'bashToolHasPermission: Bash AST parser feature disabled, using legacy shell-quote path',
      )
    }
    const parseResult = tryParseShellCommand(input.command)
    if (!parseResult.success) {
      const decisionReason = {
        type: 'other' as const,
        reason: tSync('bash.permission.malformedSyntax', { error: parseResult.error }),
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 检查 sandbox 自动允许（它会遵循显式 deny/ask 规则）。
  // 仅在 sandbox 和自动允许都启用时调用。
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(input, appState.toolPermissionContext)
    if (sandboxAutoAllowResult.behavior !== 'passthrough') {
      return sandboxAutoAllowResult
    }
  }

  // 先检查精确匹配。
  const exactMatchResult = bashToolCheckExactMatchPermission(input, appState.toolPermissionContext)

  // 精确命令已被 deny。
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 并行检查 Bash prompt 的 deny 和 ask 规则（两者都使用 Haiku）。
  // deny 优先于 ask，二者又都优先于 allow 规则。
  // auto 模式下跳过，因为该模式由 classifier 处理所有权限决策。
  if (
    isClassifierPermissionsEnabled() &&
    !(true && appState.toolPermissionContext.mode === 'auto')
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(appState.toolPermissionContext)
    const askDescriptions = getBashPromptAskDescriptions(appState.toolPermissionContext)
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(input.command, 'deny', denyDescriptions, denyResult)
      }
      if (askResult) {
        logClassifierResultForAnts(input.command, 'ask', askDescriptions, askResult)
      }

      // deny 优先。
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: tSync('bash.permission.deniedByPromptRule', {
              rule: denyResult.matchedDescription ?? '',
            }),
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // 跳过 Haiku 调用；UI 会在本地计算前缀并允许用户编辑。
        // 测试覆盖注入函数时仍调用该函数。
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: tSync('bash.permission.requiredByPromptRule', {
              rule: askResult.matchedDescription ?? '',
            }),
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 检查 `>`、`|` 等不属于子命令的 Bash 运算符。
  // 必须先于危险路径检查执行，以便管道命令由运算符逻辑处理
  //（该逻辑会生成“多项操作”消息）。
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: z.infer<typeof BashTool.inputSchema>) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
    astRoot,
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // 安全修复：即使管道分段处理返回 'allow'，也仍须验证原始命令。
    // 管道分段处理会先去掉重定向再检查各段，因此如下命令：
    //   echo 'x' | xargs printf '%s' >> /tmp/file
    // 两段（echo 和 xargs printf）都会被允许，但 >> 重定向会绕过验证。必须检查：
    // 1. 输出重定向的路径约束；
    // 2. 重定向目标中的危险模式（反引号等）是否满足命令安全要求。
    if (commandOperatorResult.behavior === 'allow') {
      // 检查原始命令中的危险模式（反引号、$() 等）。这可以捕获
      // echo x | xargs echo > `pwd`/evil.txt 这类反引号位于重定向目标中、
      // 因而已从分段中剥离的情况。
      // 由 AST 控制：当 astSubcommands 非 null 时，tree-sitter 已验证结构；
      // 重定向目标中的反引号或 $() 会返回 too-complex。与约 1481、1706、1755 行
      // 的控制方式一致，可避免 `find -exec {} \; | grep x` 因反斜杠分号产生误报。
      // bashCommandIsSafe 会运行完整的 legacy regex 组合（约 20 个模式），
      // 因此只在确实会使用结果时调用。
      const safetyResult =
        astSubcommands === null ? await bashCommandIsSafeAsync(input.command) : null
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // 附加待处理的 classifier 检查，可能在用户响应前自动批准。
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason: safetyResult.message ?? tSync('bash.permission.patternsRequireApproval'),
          }),
          decisionReason: {
            type: 'other',
            reason: safetyResult.message ?? tSync('bash.permission.patternsRequireApproval'),
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // 安全要求：必须从完整命令计算 compoundCommandHasCd，不能硬编码为 false。
      // 管道处理路径此前会在此传入 `false`，从而禁用 pathValidation.ts:821 的
      // cd+redirect 检查。给 `cd .zy && echo x > settings.json` 追加
      // `| echo done` 后会以 compoundCommandHasCd=false 进入此路径，使重定向能够
      // 写入 .zy/settings.json，而不会触发 cd+redirect 阻止逻辑。
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
        astRedirects,
        astCommands,
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // 当管道分段返回 'ask'（规则未允许某些分段）时，附加待处理的 classifier 检查；
    // 它可能在用户响应前自动批准。
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // 安全要求：legacy 误解析关卡，仅在 tree-sitter 模块未加载时运行。
  // 超时或中止会通过 too-complex 关闭失败（已在上方提前返回），不会进入这里。
  // AST 解析成功时 astSubcommands 非 null，且结构已经验证，因此会完全跳过此块。
  // AST 的 'too-complex' 结果涵盖 isBashSecurityCheckForMisparsing 检查的所有情况；
  // 二者回答的是同一问题：“此输入上的 splitCommand 是否可信？”
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.ZY_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(input.command)
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // 带安全 heredoc 模式（$(cat <<'EOF'...EOF)）的复合命令会在未拆分命令上
      // 触发 $() 检查。剥离安全 heredoc 后重新检查剩余内容；如果还存在其他
      // 误解析模式（如反斜杠转义的运算符），仍必须阻止。
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult = remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' && remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // 若精确命令具有显式 allow 权限则允许；这表示用户有意允许该特定命令。
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // 附加待处理的 classifier 检查，可能在用户响应前自动批准。
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, decisionReason),
          decisionReason,
          suggestions: [], // Don't suggest saving a potentially dangerous command
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 拆分子命令。优先使用 AST 提取的区间，仅在 tree-sitter 不可用时回退到
  // splitCommand。cd-cwd 过滤器会移除模型常加上的 `cd ${cwd}` 前缀。
  const cwd = getCwd()
  const cwdMingw = getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const rawSubcommands = astSubcommands ?? shadowLegacySubs ?? splitCommand(input.command)
  const { subcommands, astCommandsByIdx } = filterCdCwdSubcommands(
    rawSubcommands,
    astCommands,
    cwd,
    cwdMingw,
  )

  // CC-643：限制子命令扇出。只有 legacy splitCommand 路径可能数量暴增；
  // AST 路径要么返回有界列表（astSubcommands !== null），要么对无法表示的结构
  // 提前返回 'too-complex'。
  if (astSubcommands === null && subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: tSync('bash.permission.tooManySubcommands', { count: subcommands.length }),
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // 存在多个 `cd` 命令时请求批准。
  const cdCommands = subcommands.filter((subCommand) => isNormalizedCdCommand(subCommand))
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason: 'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // 记录复合命令是否包含 cd，供安全验证使用。
  // 这可防止通过 cd .zy/ && mv test.txt settings.json 绕过路径检查。
  const compoundCommandHasCd = cdCommands.length > 0

  // 安全要求：阻止同时含 cd 和 git 的复合命令。这样可防止通过
  // cd /malicious/dir && git status 逃逸 sandbox，其中恶意目录包含配置了
  // core.fsmonitor 的 bare git repo。此检查必须在这里执行（早于子命令级权限检查），
  // 因为 bashToolCheckPermission 会通过 BashTool.isReadOnly() 分别检查各子命令；
  // 若只看 "git status"，会重新推导出 compoundCommandHasCd=false，
  // 从而绕过 readOnlyValidation.ts 的检查。
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some((cmd) => isNormalizedGitCommand(cmd.trim()))
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason: tSync('bash.permission.cdAndGit'),
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab

  // 安全修复：先检查 Bash deny/ask 规则，再检查路径约束。
  // 这样可确保 Bash(ls:*) 等显式 deny 规则优先于对项目外路径返回 'ask' 的
  // 路径约束检查。若顺序相反，项目外绝对路径（如 ls /home）会因
  // checkPathConstraints 先返回 'ask' 而绕过 deny 规则。
  //
  // 注意：bashToolCheckPermission 会在内部调用 checkPathConstraints，验证每个子命令的
  // 输出重定向。但 splitCommand 在到达这里前已剥离重定向，因此必须在检查 deny 规则后、
  // 返回结果前，对原始命令验证输出重定向。
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
      astCommandsByIdx[i],
    ),
  )

  // 任一子命令被 deny 时，拒绝整个命令。
  const deniedSubresult = subcommandPermissionDecisions.find((_) => _.behavior === 'deny')
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: tSync('bash.permission.denied', { tool: BashTool.name, command: input.command }),
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [subcommands[i]!, result]),
        ),
      },
    }
  }

  // 在原始命令上验证输出重定向（即 splitCommand 剥离前的内容）。
  // 必须在检查 deny 规则后、返回结果前执行。"> /etc/passwd" 等输出重定向会被
  // splitCommand 剥离，逐子命令的 checkPathConstraints 无法看到，因此在此验证原始输入。
  // 安全要求：有 AST 数据时传入从 AST 得到的重定向，使 checkPathConstraints 直接使用，
  // 避免用 shell-quote 再次解析；后者存在单引号内反斜杠误解析的已知缺陷，
  // 可能悄然隐藏重定向运算符。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
    astRedirects,
    astCommands,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find((_) => _.behavior === 'ask')
  const nonAllowCount = count(subcommandPermissionDecisions, (_) => _.behavior !== 'allow')

  // 安全要求（GH#28784）：只有没有子命令独立产生 'ask' 时，才因路径约束的 'ask'
  // 提前返回。checkPathConstraints 会对完整输入重新运行路径命令循环，因此
  // `cd <outside-project> && python3 foo.py` 只会产生 Read(<dir>/**) 建议；UI 将其显示为
  // “允许读取 <dir>/”，选择后却会悄然批准 python3。若子命令自身有 ask（例如 cd 子命令
  // 自己的路径约束 ask），则继续执行：下方要么由 askSubresult 提前返回（只有一个非 allow
  // 子命令），要么由合并流程收集每个非 allow 子命令的 Bash 规则建议。
  // bashToolCheckPermission 内逐子命令调用 checkPathConstraints 时，已经捕获该路径中
  // cd 目标的 Read 规则。
  //
  // 没有子命令提出 ask 时（全部 allow，或全部是 `printf > file` 一类 passthrough），
  // pathResult 就是唯一的 ask；返回它以呈现重定向检查结果。
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // 任一子命令需要批准（如 ls/cd 超出边界）时请求批准。
  // 仅当恰好一个子命令需要批准时才提前返回；若有多个（如项目外 cd 的 ask 加上
  // python3 passthrough），则进入合并流程，让 prompt 呈现全部 Bash 规则建议，
  // 而非只显示第一个 ask 的 Read 规则（GH#28784）。
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // 精确命令已被 allow 时允许。
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 若所有子命令都通过精确或前缀匹配得到 allow，则允许整条命令，但前提是不存在
  // 命令注入。AST 解析成功时，每个子命令均已确认安全（无隐藏替换或结构技巧），
  // 无需逐子命令复查；legacy 路径则对每个子命令重新运行 bashCommandIsSafeAsync。
  let hasPossibleCommandInjection = false
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.ZY_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    // CC-643：将分歧 telemetry 批量归入一次 logEvent。逐子命令 logEvent 曾是热路径
    // syscall 的主要来源（每次调用都会由 process.memoryUsage() 访问 /proc/self/stat）；
    // 聚合计数仍可保留该信号。
    let divergenceCount = 0
    const onDivergence = () => {
      divergenceCount++
    }
    const results = await Promise.all(
      subcommands.map((c) => bashCommandIsSafeAsync(c, onDivergence)),
    )
    hasPossibleCommandInjection = results.some((r) => r.behavior !== 'passthrough')
    if (divergenceCount > 0) {
      logEvent('zy_tree_sitter_security_divergence', {
        quoteContextDivergence: true,
        count: divergenceCount,
      })
    }
  }
  if (
    subcommandPermissionDecisions.every((_) => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [subcommands[i]!, result]),
        ),
      },
    }
  }

  // 向 Haiku 查询命令前缀。通常跳过 Haiku 调用，因为 UI 会在本地计算前缀并允许
  // 用户编辑；测试注入自定义函数时仍调用该函数。
  let commandSubcommandPrefix: Awaited<ReturnType<typeof getCommandSubcommandPrefixFn>> = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // 只有一条命令时，无需处理子命令。
  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
      astSubcommands !== null,
    )
    // 命令未获 allow 时，附加待处理的 classifier 检查。
    // 此时 'ask' 只能来自 bashCommandIsSafe（checkCommandAndSuggestRules 内的安全检查），
    // 不可能来自显式 ask 规则；后者已在第 13 步的 askSubresult 检查中滤出。
    // classifier 可以绕过安全检查。
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // 检查子命令权限结果。
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // 透传 `sandbox` 等输入参数。
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
        astSubcommands !== null,
      ),
    )
  }

  // 所有子命令都获 allow 时允许。这里与 6b 不同，因为检查的是命令注入结果。
  if (
    subcommands.every((subcommand) => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // 将 subcommandResults 保留为 PermissionResult，供 decisionReason 使用。
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // 其他情况请求权限。
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (permissionResult.behavior === 'ask' || permissionResult.behavior === 'passthrough') {
      const updates = 'suggestions' in permissionResult ? permissionResult.suggestions : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // 使用字符串表示作为去重键。
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 后续：安全检查产生的 ask（复合 cd+write、进程替换等）不带建议。
      // 对 `cd ~/out && rm -rf x` 这样的复合命令，这会导致只收集 cd 的 Read 规则，
      // UI 将 prompt 标为“允许读取 <dir>/”，完全不提 rm。这里合成 Bash(exact) 规则，
      // 让 UI 展示整条链式命令。若是显式 ask 规则（decisionReason.type 为 'rule'），
      // 用户本就希望每次审查，因此跳过。
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(suggestionForExactCommand(subcommand))) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // 注意：只收集规则，不收集模式变更等其他更新类型；这适合主要需要规则建议的
      // bash 子命令。
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380：上限为 MAX_SUGGESTED_RULES_FOR_COMPOUND。Map 保留插入顺序
  //（即子命令顺序），因此截取会保留最左侧的 N 项。
  const cappedRules = Array.from(collectedRules.values()).slice(0, MAX_SUGGESTED_RULES_FOR_COMPOUND)
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // 附加待处理的 classifier 检查，可能在用户响应前自动批准。
  // 若任一子命令为 'ask'（如路径约束或 ask 规则），整体行为也为 'ask'。
  // GH#28784 修复前，ask 子结果总会在上方提前返回，因此此路径只会看到
  // 'passthrough' 子命令，并曾将该行为硬编码。
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}
