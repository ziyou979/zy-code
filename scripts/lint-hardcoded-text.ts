/**
 * Lint：用户可见的英文硬编码文案（基于 TypeScript AST）。
 *
 * 为什么：界面语言是中文时，凡是没走 i18n（t / tSync）的用户可见文案都会漏成英文。
 * lint-architecture 的 H 项只覆盖 components/screens/commands 里的 JSX 与少数属性名；
 * 这里补上报错路径、命令输出、通知、stdio 等 —— 用户反馈最多的正是「报错还是英文」。
 *
 * 扫描的上下文（kind）：
 *   jsx-text        JSX 子节点里的字面量文本            <Text>Loading…</Text>
 *   jsx-expr        JSX 子节点里的字符串表达式          <Text>{'Done'}</Text>、{ok ? 'Yes' : 'No'}
 *   jsx-attr        文案类 JSX 属性                     title= / label= / placeholder= …
 *   ui-prop         UI 目录里文案类对象字段/变量        { label: 'Cancel' }
 *   api-error       渲染给用户的 API 错误               createAssistantAPIErrorMessage({ content })、
 *                                                       services/api 下 *_MESSAGE 常量与 get*Message() 返回值
 *   command-output  命令结果                            onDone('…')、{ type: 'text', value: '…' }
 *   notification    通知 / 状态栏                       addNotification({ text }) 等
 *   stdio           直接写终端                          process.stderr.write / writeToStderr / console.error …
 *   cli-error       CLI 层抛给用户的错误                src/cli/**、src/entrypoints/** 里 throw new Error('…')
 *
 * 不扫描（必须保持英文 / 不是用户文案）：发给模型的内容（*prompt*.ts、constants/prompts*、
 * skills 目录）、i18n 资源本身、测试；日志 / debug / telemetry 调用的参数天然不在上述上下文里。
 * 个别确实不该翻译的命中，在同一行或上一行写 `// i18n-ignore: 原因`；整文件豁免写
 * `// i18n-ignore-file: 原因`（前 10 行内）。
 *
 * 防回退：scripts/hardcoded-text-baseline.json 按「文件 × kind」记录存量条数；
 * 任一格超出基线即失败（新增文件也算）。修掉存量后用 --write-baseline 收紧。
 *
 * 用法：
 *   bun scripts/lint-hardcoded-text.ts                    # 与基线比较（默认，lint:hardcoded-text）
 *   bun scripts/lint-hardcoded-text.ts --verbose          # 同时列出超出基线文件的全部命中
 *   bun scripts/lint-hardcoded-text.ts --list [path前缀]  # 列出全部命中（不比较）
 *   bun scripts/lint-hardcoded-text.ts --report out.md    # 生成按文件 / 类别计数的审计清单
 *   bun scripts/lint-hardcoded-text.ts --write-baseline   # 重写基线
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as ts from 'typescript'

export type Kind =
  | 'jsx-text'
  | 'jsx-expr'
  | 'jsx-attr'
  | 'ui-prop'
  | 'api-error'
  | 'command-output'
  | 'notification'
  | 'stdio'
  | 'cli-error'

export const KINDS: Kind[] = [
  'api-error',
  'cli-error',
  'stdio',
  'command-output',
  'notification',
  'jsx-text',
  'jsx-expr',
  'jsx-attr',
  'ui-prop',
]

export type Hit = { file: string; line: number; kind: Kind; text: string }

const ROOT = resolve(process.env.ZY_HARDCODED_TEXT_ROOT ?? join(import.meta.dirname, '..'))
const SRC = join(ROOT, 'src')
const BASELINE_PATH = resolve(
  process.env.ZY_HARDCODED_TEXT_BASELINE ?? join(ROOT, 'scripts', 'hardcoded-text-baseline.json'),
)

// ---------------------------------------------------------------- 范围

export function isExcludedFile(rel: string): boolean {
  return (
    /\.test\.tsx?$/.test(rel) ||
    rel.endsWith('.d.ts') ||
    rel.startsWith('i18n/') ||
    // 发给模型的内容：tool / agent prompt、系统提示词、内置 skill 正文
    /(^|\/)prompts?\.tsx?$/.test(rel) ||
    /(^|\/)[A-Za-z]*Prompts?\.tsx?$/.test(rel) ||
    rel.startsWith('constants/prompts') ||
    rel.includes('/prompts/') ||
    rel.startsWith('skills/')
  )
}

/** 与 lint-architecture H 项一致的 UI 目录：对象字段 / 变量名启发式只在这里生效 */
function isUiFile(rel: string): boolean {
  return (
    rel.startsWith('components/') ||
    rel.startsWith('screens/') ||
    rel.startsWith('commands/') ||
    /(^|\/)tools\/[^/]+\/UI\.tsx$/.test(rel) ||
    rel.includes('services/permissions/') ||
    rel.includes('services/messages/') ||
    rel.includes('services/status/') ||
    rel.includes('services/notifications/')
  )
}

function isCliFile(rel: string): boolean {
  return rel.startsWith('cli/') || rel.startsWith('entrypoints/') || rel === 'main.tsx'
}

// ---------------------------------------------------------------- 文本判定

const UI_ATTR_NAMES = new Set([
  'label',
  'title',
  'subtitle',
  'description',
  'placeholder',
  'message',
  'helpText',
  'hint',
  'tooltip',
  'alt',
  'aria-label',
  'confirmLabel',
  'cancelLabel',
  'emptyText',
  'emptyMessage',
  'buttonText',
  'summary',
  'text',
  'footer',
  'header',
])

const UI_VARIABLE_NAMES = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'message',
  'helpText',
  'tooltip',
  'summary',
  'emptyText',
  'buttonText',
])

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 明显是代码 / 路径 / 标识符 / 符号的文本（沿用 lint-architecture H 的规则并略放宽） */
export function isCodeLike(text: string): boolean {
  if (!text) return true
  if (!/[A-Za-z]{2,}/.test(text)) return true
  if (/^(https?:\/\/|\/|~\/|\.{1,2}\/|[A-Za-z]:\\)/.test(text)) return true
  if (/^&[a-z]+;$/.test(text)) return true
  if (/^[A-Z0-9_]+$/.test(text)) return true
  if (/^[A-Za-z0-9_.-]+$/.test(text) && /[._-]/.test(text)) return true
  if (/^[a-z0-9_.:/#@-]+$/.test(text) && /[./:_#@-]/.test(text)) return true
  if (/^--?[a-z][\w-]*$/.test(text)) return true // CLI flag
  if (/^\{.+\}$/.test(text)) return true
  if (/^[a-z]+[A-Z]\w*$/.test(text)) return true // camelCase 标识符
  if (/^\/[a-z][\w-]*$/.test(text)) return true // /command
  return false
}

/** 非 UI 上下文（stdio / 错误 / 命令输出）要求像一句话：至少两个英文词 */
function isSentence(text: string): boolean {
  return !isCodeLike(text) && /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/.test(text) && /\s/.test(text)
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  }
  return null
}

/** 表达式里「直接作为结果」的字符串字面量：穿过 ?: / && / || / ?? / 括号 / + 拼接 */
function resultLiterals(node: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return resultLiterals(node.expression)
  if (ts.isConditionalExpression(node)) {
    return [...resultLiterals(node.whenTrue), ...resultLiterals(node.whenFalse)]
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return resultLiterals(node.right)
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return [...resultLiterals(node.left), ...resultLiterals(node.right)]
    }
    return []
  }
  if (literalText(node) !== null) return [node]
  return []
}

// ---------------------------------------------------------------- 上下文判定

function calleeName(call: ts.CallExpression): string {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) {
    const obj = e.expression
    const objName = ts.isIdentifier(obj)
      ? obj.text
      : ts.isPropertyAccessExpression(obj)
        ? `${ts.isIdentifier(obj.expression) ? obj.expression.text : '?'}.${obj.name.text}`
        : '?'
    return `${objName}.${e.name.text}`
  }
  return ''
}

const STDIO_CALLEES = new Set([
  'process.stderr.write',
  'process.stdout.write',
  'writeToStderr',
  'writeToStdout',
  'console.error',
  'console.log',
  'console.warn',
  'console.info',
  'printError',
  'exitWithError',
  'cliError',
  'cliOk',
])

function isNotificationCallee(name: string): boolean {
  const last = name.split('.').pop() ?? ''
  return /^(addNotification|notify|showNotification|enqueueNotification|pushNotification|toast|setStatusLine|showToast)$/.test(
    last,
  )
}

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    ) {
      return p.parent.name.text
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) return null
  }
  return null
}

/** 字面量 node 的上下文；不是用户可见上下文时返回 null */
function classify(
  node: ts.Expression,
  rel: string,
): { kind: Kind; ui: boolean; anchor: ts.Node } | null {
  const r = classifyInner(node, rel)
  return r
}

function classifyInner(
  node: ts.Expression,
  rel: string,
): { kind: Kind; ui: boolean; anchor: ts.Node } | null {
  // 先爬过 ?: / && / || / + / 括号，找到真正的使用位置
  let cur: ts.Node = node
  while (
    cur.parent &&
    (ts.isParenthesizedExpression(cur.parent) ||
      (ts.isConditionalExpression(cur.parent) && cur.parent.condition !== cur) ||
      (ts.isBinaryExpression(cur.parent) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.PlusToken,
        ].includes(cur.parent.operatorToken.kind) &&
        !(
          cur.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          cur.parent.left === cur
        )))
  ) {
    cur = cur.parent
  }
  const parent = cur.parent
  if (!parent) return null

  // JSX
  if (ts.isJsxExpression(parent)) {
    if (ts.isJsxAttribute(parent.parent)) {
      const n = parent.parent.name.getText()
      return UI_ATTR_NAMES.has(n) ? { kind: 'jsx-attr', ui: true, anchor: parent } : null
    }
    if (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent)) {
      return { kind: 'jsx-expr', ui: true, anchor: parent }
    }
    return null
  }
  if (ts.isJsxAttribute(parent)) {
    return UI_ATTR_NAMES.has(parent.name.getText()) ? { kind: 'jsx-attr', ui: true, anchor: parent } : null
  }

  // 调用参数
  if (ts.isCallExpression(parent) && parent.arguments.includes(cur as ts.Expression)) {
    const name = calleeName(parent)
    if (STDIO_CALLEES.has(name)) return { kind: 'stdio', ui: false, anchor: parent }
    if (name === 'onDone' && parent.arguments[0] === cur) {
      return { kind: 'command-output', ui: false, anchor: parent }
    }
    return null
  }
  if (ts.isNewExpression(parent) && parent.arguments?.includes(cur as ts.Expression)) {
    if (
      isCliFile(rel) &&
      ts.isThrowStatement(parent.parent) &&
      ts.isIdentifier(parent.expression) &&
      /Error$/.test(parent.expression.text)
    ) {
      return { kind: 'cli-error', ui: false, anchor: parent }
    }
    return null
  }

  // 对象字段
  if (ts.isPropertyAssignment(parent) && parent.initializer === cur) {
    const key = propName(parent.name)
    const obj = parent.parent
    if (!key || !ts.isObjectLiteralExpression(obj)) return null
    const call = obj.parent
    if (ts.isCallExpression(call)) {
      const name = calleeName(call)
      if (name === 'createAssistantAPIErrorMessage' && key === 'content') {
        return { kind: 'api-error', ui: false, anchor: parent }
      }
      if (isNotificationCallee(name) && (key === 'text' || key === 'message' || key === 'title')) {
        return { kind: 'notification', ui: false, anchor: parent }
      }
    }
    // { type: 'text', value: '…' } —— 本地命令的返回结果
    if (key === 'value' && rel.startsWith('commands/')) {
      const typeProp = obj.properties.find(
        (p) => ts.isPropertyAssignment(p) && propName(p.name) === 'type',
      ) as ts.PropertyAssignment | undefined
      if (
        typeProp &&
        ts.isStringLiteral(typeProp.initializer) &&
        typeProp.initializer.text === 'text'
      ) {
        return { kind: 'command-output', ui: false, anchor: parent }
      }
    }
    if (isUiFile(rel) && UI_ATTR_NAMES.has(key) && key !== 'text' && key !== 'header') {
      return { kind: 'ui-prop', ui: true, anchor: parent }
    }
    return null
  }

  // 变量 / 常量
  if (ts.isVariableDeclaration(parent) && parent.initializer === cur && ts.isIdentifier(parent.name)) {
    const n = parent.name.text
    if (rel.startsWith('services/api/') && /(_MESSAGE|_ERROR_MESSAGE[A-Z_]*)$/.test(n)) {
      return { kind: 'api-error', ui: false, anchor: parent }
    }
    if (isUiFile(rel) && UI_VARIABLE_NAMES.has(n)) return { kind: 'ui-prop', ui: true, anchor: parent }
    return null
  }

  // services/api 下 get*Message() 的返回值
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === cur)) {
    const fn = enclosingFunctionName(cur)
    if (rel.startsWith('services/api/') && fn && /^get\w*Message$/.test(fn)) {
      return { kind: 'api-error', ui: false, anchor: parent }
    }
    return null
  }
  return null
}

// ---------------------------------------------------------------- 扫描

function ignoredLines(src: string): { file: boolean; lines: Set<number> } {
  const lines = new Set<number>()
  const all = src.split('\n')
  const fileIgnored = all.slice(0, 10).some((l) => l.includes('i18n-ignore-file'))
  all.forEach((l, i) => {
    if (/i18n-ignore(?!-file)/.test(l)) {
      // 作用于本行，以及其后第一个非注释行（中间可隔着 eslint / biome 指令注释）
      lines.add(i + 1)
      let j = i + 1
      while (j < all.length && /^\s*(\/\/|\/\*|\*)/.test(all[j]!)) {
        lines.add(j + 1)
        j++
      }
      lines.add(j + 1)
    }
  })
  return { file: fileIgnored, lines }
}

function isTranslationCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ['t', 'tSync', 'tEn'].includes(node.expression.text)
  )
}

export function scanSource(rel: string, src: string): Hit[] {
  const ign = ignoredLines(src)
  if (ign.file) return []
  const kindOfScript = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kindOfScript)
  const hits: Hit[] = []
  const seen = new Set<ts.Node>()
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const add = (node: ts.Node, kind: Kind, text: string, anchor?: ts.Node) => {
    const line = lineOf(node)
    // i18n-ignore 作用于字面量所在行，或其使用位置（调用 / 属性 / 声明）的起始行
    if (ign.lines.has(line) || (anchor && ign.lines.has(lineOf(anchor)))) return
    hits.push({ file: rel, line, kind, text: normalize(text).slice(0, 120) })
  }

  const visit = (node: ts.Node) => {
    if (isTranslationCall(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return
    }
    if (ts.isJsxText(node)) {
      const text = normalize(node.getText(sf))
      if (!isCodeLike(text)) add(node, 'jsx-text', text)
      return
    }
    const text = literalText(node)
    if (text !== null && !seen.has(node)) {
      seen.add(node)
      const ctx = classify(node as ts.Expression, rel)
      if (ctx) {
        const t = normalize(text)
        if (ctx.ui ? !isCodeLike(t) : isSentence(t)) add(node, ctx.kind, t, ctx.anchor)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

export function scanRepo(): Hit[] {
  const hits: Hit[] = []
  for (const file of walk(SRC).sort()) {
    const rel = relative(SRC, file).split('\\').join('/')
    if (isExcludedFile(rel)) continue
    hits.push(...scanSource(rel, readFileSync(file, 'utf8')))
  }
  return hits
}

// ---------------------------------------------------------------- 基线

type Counts = Record<string, Partial<Record<Kind, number>>>
type Baseline = { generatedAt: string; note: string; totals: Partial<Record<Kind, number>>; files: Counts }

function countHits(hits: Hit[]): Counts {
  const c: Counts = {}
  for (const h of hits) {
    const f = (c[h.file] ??= {})
    f[h.kind] = (f[h.kind] ?? 0) + 1
  }
  return c
}

function totals(hits: Hit[]): Partial<Record<Kind, number>> {
  const t: Partial<Record<Kind, number>> = {}
  for (const k of KINDS) t[k] = hits.filter((h) => h.kind === k).length
  return t
}

function writeBaseline(hits: Hit[]) {
  const sortedFiles = Object.fromEntries(
    Object.entries(countHits(hits)).sort(([a], [b]) => a.localeCompare(b)),
  )
  const b: Baseline = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note: '用户可见英文硬编码文案的存量（文件 × 类别计数）。只允许下降：修掉后运行 bun scripts/lint-hardcoded-text.ts --write-baseline 收紧。',
    totals: totals(hits),
    files: sortedFiles,
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(b, null, 2)}\n`)
  console.log(`✍️  已写入基线 ${relative(ROOT, BASELINE_PATH)}：共 ${hits.length} 处`)
}

function area(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'services' || parts[0] === 'tools' || parts[0] === 'commands') {
    return parts.slice(0, 2).join('/')
  }
  return parts[0]!
}

function report(hits: Hit[], out: string) {
  const lines: string[] = []
  const t = totals(hits)
  lines.push('# 硬编码用户文案审计（scripts/lint-hardcoded-text.ts）', '')
  lines.push(`生成时间：${new Date().toISOString()}；命中总数：**${hits.length}**`, '')
  lines.push('## 按类别', '', '| 类别 | 数量 |', '|---|---:|')
  for (const k of KINDS) lines.push(`| ${k} | ${t[k]} |`)
  lines.push('', '## 按区域 × 类别', '')
  const areas = new Map<string, Hit[]>()
  for (const h of hits) {
    const a = area(h.file)
    if (!areas.has(a)) areas.set(a, [])
    areas.get(a)!.push(h)
  }
  lines.push(`| 区域 | 合计 | ${KINDS.join(' | ')} |`, `|---|---:|${KINDS.map(() => '---:').join('|')}|`)
  for (const [a, hs] of [...areas].sort((x, y) => y[1].length - x[1].length)) {
    lines.push(`| ${a} | ${hs.length} | ${KINDS.map((k) => hs.filter((h) => h.kind === k).length || '').join(' | ')} |`)
  }
  lines.push('', '## 按文件（命中数降序）', '', '| 文件 | 合计 | 类别分布 |', '|---|---:|---|')
  const counts = countHits(hits)
  for (const [f, c] of Object.entries(counts).sort(
    (x, y) =>
      Object.values(y[1]).reduce((a, b) => a + (b ?? 0), 0) -
      Object.values(x[1]).reduce((a, b) => a + (b ?? 0), 0),
  )) {
    const sum = Object.values(c).reduce((a, b) => a + (b ?? 0), 0)
    lines.push(`| src/${f} | ${sum} | ${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ')} |`)
  }
  lines.push('', '## 非 UI 类别明细（api-error / cli-error / stdio / command-output / notification）', '')
  for (const h of hits.filter((x) => !['jsx-text', 'jsx-expr', 'jsx-attr', 'ui-prop'].includes(x.kind))) {
    lines.push(`- \`src/${h.file}:${h.line}\` [${h.kind}] ${h.text.replace(/\|/g, '\\|')}`)
  }
  writeFileSync(out, `${lines.join('\n')}\n`)
  console.log(`📝 审计清单已写入 ${out}（${hits.length} 处）`)
}

function compare(hits: Hit[], verbose: boolean): number {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`❌ 基线不存在：${relative(ROOT, BASELINE_PATH)}（运行 --write-baseline 生成）`)
    return 1
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  const cur = countHits(hits)
  const over: string[] = []
  let shrinkable = 0
  for (const [file, kinds] of Object.entries(cur)) {
    for (const [kind, n] of Object.entries(kinds) as [Kind, number][]) {
      const base = baseline.files[file]?.[kind] ?? 0
      if (n > base) over.push(`${file}|${kind}|${n}|${base}`)
    }
  }
  for (const [file, kinds] of Object.entries(baseline.files)) {
    for (const [kind, n] of Object.entries(kinds) as [Kind, number][]) {
      const now = cur[file]?.[kind] ?? 0
      if (now < n) shrinkable += n - now
    }
  }
  const baseTotal = Object.values(baseline.totals).reduce((a, b) => a + (b ?? 0), 0)
  if (over.length) {
    console.error('❌ 新增了用户可见的硬编码英文文案（请改用 t / tSync，并在 en 与 zh-CN 两个 locale 加 key）：\n')
    for (const o of over) {
      const [file, kind, n, base] = o.split('|')
      console.error(`  src/${file} [${kind}] ${n} 处（基线 ${base}）`)
      for (const h of hits.filter((x) => x.file === file && x.kind === kind)) {
        if (verbose || Number(n) - Number(base) <= 10) {
          console.error(`      L${h.line}: ${h.text}`)
        }
      }
    }
    console.error(
      '\n  确实不该翻译的（发给模型 / 协议字段 / 日志）在该行或上一行加 `// i18n-ignore: 原因`。',
    )
    return 1
  }
  console.log(
    `✅ 硬编码用户文案未超出基线：当前 ${hits.length} 处（基线 ${baseTotal}，基线日期 ${baseline.generatedAt}）`,
  )
  if (shrinkable > 0) {
    console.log(`   🟢 已修掉 ${shrinkable} 处存量，可运行 --write-baseline 收紧基线`)
  }
  return 0
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const hits = scanRepo()
  if (args.includes('--write-baseline')) {
    writeBaseline(hits)
  } else if (args.includes('--report')) {
    report(hits, args[args.indexOf('--report') + 1] ?? 'hardcoded-text-audit.md')
  } else if (args.includes('--list')) {
    const prefix = args[args.indexOf('--list') + 1]
    for (const h of hits.filter((x) => !prefix || prefix.startsWith('--') || x.file.startsWith(prefix.replace(/^src\//, '')))) {
      console.log(`src/${h.file}:${h.line}\t${h.kind}\t${h.text}`)
    }
  } else {
    process.exit(compare(hits, args.includes('--verbose')))
  }
}
