/**
 * Lint：禁止「模块顶层」调用 i18n 的 t / tSync。
 *
 * 为什么：`const X = tSync('key')`、`const M = { a: tSync('k') }` 这类写在模块顶层
 * 的翻译会在 *import 时* 求值一次并冻结 ——
 *   1) 它不反应运行时语言切换（值算一次就定死，对标 i18next 永远在 render/调用期取值）；
 *   2) 它在模块求值阶段触达 i18n，历史上曾与 settings 形成循环初始化（TDZ 崩溃）。
 *
 * 正确写法（都会被本规则放行，因为 t/tSync 调用落在函数体内 → 调用期才求值）：
 *   - 组件内：`function C(){ const label = tSync('k'); ... }`
 *   - getter：`const getLabel = () => tSync('k')`，用到时 `getLabel()`
 *   - 默认参数：`function f(msg = tSync('k')){}`（每次调用求值）
 *   - 表/映射：`const getMap = () => ({ a: tSync('k') })`
 *   - 静态结构 + 用时翻译：存 `messageKey`，命中时 `tSync(messageKey)`
 *
 * 精确性：只针对「从 .../i18n 模块导入的 t / tSync 本地绑定名」（支持 `as` 别名），
 * 因此不会误报无关的同名函数（如某些库的 `t(...)`）。
 *
 * 运行：`bun scripts/lint-no-toplevel-i18n.ts`（命中即以非零码退出）。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'

const FN_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
])

type Hit = { file: string; line: number; name: string; text: string }

function collectI18nBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue
    }
    // 仅认 i18n 模块（i18n/index、i18n/index.js 等）。
    if (!/(^|\/)i18n(\/|$)/.test(stmt.moduleSpecifier.text)) {
      continue
    }
    const bindings = stmt.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text // 原始导出名
      if (imported === 't' || imported === 'tSync') {
        names.add(el.name.text) // 本地绑定名（可能是别名）
      }
    }
  }
  return names
}

function scanFile(file: string): Hit[] {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const i18nNames = collectI18nBindings(sf)
  if (i18nNames.size === 0) {
    return []
  }
  const hits: Hit[] = []
  let fnDepth = 0
  const visit = (node: ts.Node) => {
    const isFn = FN_KINDS.has(node.kind)
    if (isFn) {
      fnDepth++
    }
    if (fnDepth === 0 && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (i18nNames.has(name)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
        hits.push({
          file,
          line: line + 1,
          name,
          text: src.split('\n')[line]?.trim().slice(0, 100) ?? '',
        })
      }
    }
    ts.forEachChild(node, visit)
    if (isFn) {
      fnDepth--
    }
  }
  visit(sf)
  return hits
}

// 列出 src 下所有受 git 跟踪的文件（含根目录直属与任意深度子目录），再按扩展名过滤。
// 注意：不要用 `git ls-files "src/**/*.ts"` —— 其 `**/` 段要求至少一层子目录，会漏掉
// src/ 根目录直属的 *.ts（如 src/commands.ts）。
const files = execSync('git ls-files src', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))

const hits = files.flatMap(scanFile).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

if (hits.length === 0) {
  console.log('✓ 没有模块顶层的 t/tSync 调用。')
  process.exit(0)
}

console.error(`✗ 发现 ${hits.length} 处模块顶层 t/tSync 调用（会冻结翻译、且有循环初始化风险）：\n`)
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.name}]  ${h.text}`)
}
console.error(
  '\n请改为「调用期求值」：移进组件/函数体、改 getter（() => tSync(k)）、用作默认参数，' +
    '或对静态结构改存 messageKey 并在用时翻译。详见本脚本头部注释。',
)
process.exit(1)
