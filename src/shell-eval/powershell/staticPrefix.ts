/**
 * PowerShell 静态命令前缀提取。
 *
 * 对应 bash 的 getCommandPrefixStatic / getCompoundCommandPrefixesStatic
 *（src/utils/bash/prefix.ts），但使用 PowerShell AST parser 而非 tree-sitter。
 * AST 已提供拆分后的 cmd.name 和 cmd.args；对于外部命令，将其交给 bash 使用的同一
 * fig-spec walker（src/utils/shell/specPrefix.ts），因为 git/npm/kubectl CLI 与 shell 无关。
 *
 * 为权限对话框中“允许，且不再询问：___”的可编辑输入提供内容；静态提取器给出
 * 最合理的前缀，用户可按需缩减。
 */

import { countCharInString } from '../../utils/stringUtils.js'
import { getCommandSpec } from '../bash/registry.js'
import { buildPrefix, DEPTH_RULES } from '../shared/specPrefix.js'
import { NEVER_SUGGEST } from './dangerousCmdlets.js'
import { getAllCommands, type ParsedCommandElement, parsePowerShellCommand } from './parser.js'

/**
 * 从单个已解析命令元素提取静态前缀。对于不应建议的命令（shell、eval cmdlet、
 * 路径式调用）或无法提取有意义前缀的命令，返回 null。
 */
async function extractPrefixFromElement(cmd: ParsedCommandElement): Promise<string | null> {
  // nameType === 'application' 表示原始名称含路径字符（./x、x\y、x.exe）；
  // PowerShell 将运行文件，而非具名 cmdlet，因此不要给出建议。
  // 理由与权限引擎的 nameType 关卡相同（PR #20096）。
  if (cmd.nameType === 'application') {
    return null
  }

  const name = cmd.name
  if (!name) {
    return null
  }

  if (NEVER_SUGGEST.has(name.toLowerCase())) {
    return null
  }

  // 对 Cmdlet（Verb-Noun），只取名称就是合适的前缀粒度。
  // Get-Process -Name pwsh → Get-Process，因为不存在子命令概念。
  if (cmd.nameType === 'cmdlet') {
    return name
  }

  // 外部命令：传给 buildPrefix 前先保护 argv。
  //
  // elementTypes[0]（命令名）必须是字面量。`& $cmd status` 的
  // elementTypes[0]='Variable'、name='$cmd'，会因不含路径字符而归类为 'unknown'，
  // 通过 NEVER_SUGGEST，随后 getCommandSpec('$cmd')=null，返回裸 '$cmd'，形成无效规则。
  // 在此拦截成本很低。
  //
  // elementTypes[1..]（参数）必须全部为 StringConstant 或 Parameter。任何动态类型
  //（Variable/SubExpression/ScriptBlock/ExpandableString）都会把 `$foo`/`$(...)`
  // 嵌入前缀，形成无效规则。
  if (cmd.elementTypes?.[0] !== 'StringConstant') {
    return null
  }
  for (let i = 0; i < cmd.args.length; i++) {
    const t = cmd.elementTypes[i + 1]
    if (t !== 'StringConstant' && t !== 'Parameter') {
      return null
    }
  }

  // 查询 bash 使用的同一 fig spec。若 git spec 声明 -C 接收值，buildPrefix 会跳过
  // -C /repo，并把 `status` 识别为子命令。查询时转为小写：fig spec 是文件系统路径
  //（git.js），在 Linux 区分大小写；PowerShell 不区分大小写（Git === git），因此 `Git`
  // 必须解析到 git spec。macOS 的大小写不敏感文件系统会掩盖此问题。
  // 无条件调用 buildPrefix；calculateDepth 会先查询 DEPTH_RULES，再走自身的
  // `if (!spec) return 2` 回退，因此即便没有加载 spec，gcloud/aws/kubectl/az 也能获得
  // 感知深度的前缀。旧的 `if (!spec) return name` 提前返回会生成裸 `gcloud:*`，
  // 从而永久自动允许所有 gcloud 子命令。
  const nameLower = name.toLowerCase()
  const spec = await getCommandSpec(nameLower)
  const prefix = await buildPrefix(name, cmd.args, spec)

  // buildPrefix 后的单词完整性：buildPrefix 会用空格连接已消费参数并生成前缀字符串。
  // parser.ts:685 对单引号字面量保存去除引号后的 .value：
  // git 'push origin' → args=['push origin']。若消费此参数，buildPrefix 会生成
  // 'git push origin'，悄然把 1 个 argv 元素提升为 3 个前缀单词。这样规则
  // PowerShell(git push origin:*) 会匹配含 3 个 argv 元素的
  // `git push origin --force`，并非用户批准的内容。
  //
  // 旧的集合成员检查（`!cmd.args.includes(word)`）可被诱饵参数绕过：
  // `git 'push origin' push origin` → args=['push origin', 'push', 'origin']，
  // prefix='git push origin'。每个单词都存在于 args 中（索引 1、2 的诱饵满足
  // .includes()），因而通过。现在改为按位置遍历 args：每个前缀单词必须精确匹配
  // 下一个非 flag 参数；位置参数不匹配，说明 buildPrefix 拆开了它。flag 及其值会跳过
  //（buildPrefix 也会跳过），所以 `git -C '/my repo' status` 和
  // `git commit -m 'fix typo'` 仍能通过。拒绝反斜杠（C:\repo），以免产生无效且过细的规则。
  let argIdx = 0
  for (const word of prefix.split(' ').slice(1)) {
    if (word.includes('\\')) {
      return null
    }
    while (argIdx < cmd.args.length) {
      const a = cmd.args[argIdx]!
      if (a === word) {
        break
      }
      if (a.startsWith('-')) {
        argIdx++
        // 仅当 spec 声明此 flag 接收值参数时，才跳过该值。没有 spec 信息时视为
        // 不带值的 switch；这种关闭失败策略可避免多跳过位置参数。（bug #16）
        if (
          spec?.options &&
          argIdx < cmd.args.length &&
          cmd.args[argIdx] !== word &&
          !cmd.args[argIdx]!.startsWith('-')
        ) {
          const flagLower = a.toLowerCase()
          const opt = spec.options.find((o) =>
            Array.isArray(o.name) ? o.name.includes(flagLower) : o.name === flagLower,
          )
          if (opt?.args) {
            argIdx++
          }
        }
        continue
      }
      // 位置参数不是预期单词，说明参数被拆开了。
      return null
    }
    if (argIdx >= cmd.args.length) {
      return null
    }
    argIdx++
  }

  // 裸根命令保护：若 `git` 未找到子命令（参数为空或只有全局 flag），buildPrefix
  // 会返回 'git'，范围过宽，会永久自动允许 `git push --force`。bash 提取器尚未设置
  // 此关卡（bash/prefix.ts:363，需另行修复）。对于 spec 声明子命令，或具有
  // DEPTH_RULES 条目（gcloud、aws、kubectl 等，即便未加载 spec 也暗示子命令结构）的命令，
  // 拒绝单词结果。（bug #17）
  if (!prefix.includes(' ') && (spec?.subcommands?.length || DEPTH_RULES[nameLower])) {
    return null
  }
  return prefix
}

/**
 * 为 PowerShell 命令提取前缀建议。
 *
 * 解析命令并取首个 CommandAst，返回适合权限对话框“不再询问：___”可编辑输入的前缀。
 * 无法安全提取前缀时返回 null，例如解析失败、shell 调用、路径式名称，
 * 或只有裸根名称但具有子命令结构的命令。
 */
export async function getCommandPrefixStatic(
  command: string,
): Promise<{ commandPrefix: string | null } | null> {
  const parsed = await parsePowerShellCommand(command)
  if (!parsed.valid) {
    return null
  }

  // 查找第一条实际命令（CommandAst）。getAllCommands 会遍历 statement.commands 和
  // statement.nestedCommands（用于 &&/||/if/for）。跳过合成的 CommandExpressionAst
  // 条目（表达式管道源和非 PipelineAst 语句占位符）。
  const firstCommand = getAllCommands(parsed).find((cmd) => cmd.elementType === 'CommandAst')
  if (!firstCommand) {
    return { commandPrefix: null }
  }

  return { commandPrefix: await extractPrefixFromElement(firstCommand) }
}

/**
 * 为复合 PowerShell 命令中的所有子命令提取前缀。
 *
 * 对 `Get-Process; git status && npm test` 返回逐子命令前缀。
 * 跳过 `excludeSubcommand` 返回 true 的子命令（如已为只读或自动允许），
 * 因为无需为其建议规则。共享根命令的前缀通过单词对齐的 LCP 合并：
 * `npm run test && npm run lint` → `npm run`.
 *
 * 过滤器接收 ParsedCommandElement 而非 cmd.text，因为 PowerShell 只读检查
 *（isAllowlistedCommand）需要元素的结构化字段（nameType、args）。若传入文本，
 * 就必须重新解析，并为每个子命令启动一次 pwsh.exe；此处已有解析结果，这样做既昂贵
 * 又浪费。Bash 对应实现传入文本，是因为 BashTool.isReadOnly 基于 regex/pattern，
 * 而非已解析 AST。
 */
export async function getCompoundCommandPrefixesStatic(
  command: string,
  excludeSubcommand?: (element: ParsedCommandElement) => boolean,
): Promise<string[]> {
  const parsed = await parsePowerShellCommand(command)
  if (!parsed.valid) {
    return []
  }

  const commands = getAllCommands(parsed).filter((cmd) => cmd.elementType === 'CommandAst')

  // 只有一条命令，无需进行复合命令合并。
  if (commands.length <= 1) {
    const prefix = commands[0] ? await extractPrefixFromElement(commands[0]) : null
    return prefix ? [prefix] : []
  }

  const prefixes: string[] = []
  for (const cmd of commands) {
    if (excludeSubcommand?.(cmd)) {
      continue
    }
    const prefix = await extractPrefixFromElement(cmd)
    if (prefix) {
      prefixes.push(prefix)
    }
  }

  if (prefixes.length === 0) {
    return []
  }

  // 按根命令（第一个单词）分组，再通过单词对齐的最长公共前缀合并各组。
  // `npm run test` + `npm run lint` → `npm run`。但绝不能合并成具有子命令结构的裸根：
  // `git add` + `git commit` 的 LCP 为 `git`，extractPrefixFromElement 已明确认为它
  // 范围过宽并拒绝（约 119 行）。绕过该关卡合并会建议 PowerShell(git:*)，
  // 从而永久自动允许 git push --force。当 LCP 只剩这种裸根时，直接丢弃整个分组，
  // 不建议过宽根规则，也不建议 N 条未合并规则。
  //
  // Bash 的 getCompoundCommandPrefixesStatic 有相同合并，但未设置此关卡
  //（src/utils/bash/prefix.ts:360-365）；那属于另一项修复。
  //
  // 分组和单词比较不区分大小写（PowerShell 中 Git === git、
  // Get-Process === get-process）。Map key 使用小写，输出前缀保留首次出现的大小写。
  const groups = new Map<string, string[]>()
  for (const prefix of prefixes) {
    const root = prefix.split(' ')[0]!
    const key = root.toLowerCase()
    const group = groups.get(key)
    if (group) {
      group.push(prefix)
    } else {
      groups.set(key, [prefix])
    }
  }

  const collapsed: string[] = []
  for (const [rootLower, group] of groups) {
    const lcp = wordAlignedLCP(group)
    const lcpWordCount = lcp === '' ? 0 : countCharInString(lcp, ' ') + 1
    if (lcpWordCount <= 1) {
      // LCP 合并后只剩一个单词。若该根命令的 fig spec 声明了子命令，这就属于
      // extractPrefixFromElement 拒绝的同类过宽情况（裸 `git` 会允许
      // `git push --force`），应丢弃该组。getCommandSpec 已用 LRU memoize，
      // 每个不同根命令只查询一次。
      const rootSpec = await getCommandSpec(rootLower)
      if (rootSpec?.subcommands?.length || DEPTH_RULES[rootLower]) {
        continue
      }
    }
    collapsed.push(lcp)
  }
  return collapsed
}

/**
 * 按单词对齐的最长公共前缀，不会从单词中间截断。
 * 比较不区分大小写（PowerShell 中 Git === git），输出沿用首个字符串的大小写。
 * ["npm run test", "npm run lint"] → "npm run"
 * ["Git status", "git log"] → "Git" (first-seen casing)
 * ["Get-Process"] → "Get-Process"
 */
function wordAlignedLCP(strings: string[]): string {
  if (strings.length === 0) {
    return ''
  }
  if (strings.length === 1) {
    return strings[0]!
  }

  const firstWords = strings[0]!.split(' ')
  let commonWordCount = firstWords.length

  for (let i = 1; i < strings.length; i++) {
    const words = strings[i]!.split(' ')
    let matchCount = 0
    while (
      matchCount < commonWordCount &&
      matchCount < words.length &&
      words[matchCount]!.toLowerCase() === firstWords[matchCount]!.toLowerCase()
    ) {
      matchCount++
    }
    commonWordCount = matchCount
    if (commonWordCount === 0) {
      break
    }
  }

  return firstWords.slice(0, commonWordCount).join(' ')
}
