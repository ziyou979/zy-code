/**
 * 基于 TypeScript AST 的真实 import 图。
 *
 * 供 lint-architecture.ts（层间依赖 / 环检测 / 传递依赖规则）复用，也可直接运行：
 *   bun scripts/import-graph.ts --unreferenced   # 列出从入口不可达、也无人引用的源文件
 *   bun scripts/import-graph.ts --path <from> <to>  # 打印一条运行时依赖链
 *   bun scripts/import-graph.ts --cycles             # 列出 src/ 内运行时静态 import 环（SCC）
 *
 * 收集的边：
 *   - import ... from '…' / import '…'（含 import type，标记为 type）
 *   - export ... from '…'（含 export type，标记为 type）
 *   - import x = require('…')
 *   - import('…') 动态导入、require('…')（标记为 dynamic）
 *   - typeof import('…') 类型查询（标记为 type）
 * 只解析能落到仓库内源文件的说明符（相对路径、`src/*` 别名、`@ant/*` workspace 包、
 * build.ts 插件映射的 native 包）；npm 依赖记为 external，不进入图。
 *
 * 取舍：不做 feature() 宏求值——被禁用 flag 包住的 require 仍算一条 dynamic 边。
 * 这样图偏保守（宁可多算可达），用于"确定无人引用"判断时不会误删。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import * as ts from 'typescript'

export type EdgeKind = 'static' | 'type' | 'dynamic'

export interface ImportEdge {
  /** 相对仓库根的源文件路径（正斜杠） */
  from: string
  to: string
  kind: EdgeKind
  /** 1-based 行号 */
  line: number
  specifier: string
}

export interface ImportGraph {
  root: string
  files: string[]
  edges: ImportEdge[]
  /** 能识别为仓库内路径却解析不到文件的说明符 */
  unresolved: Array<{ from: string; specifier: string; line: number }>
  /** from -> edges */
  out: Map<string, ImportEdge[]>
  /** to -> edges */
  in: Map<string, ImportEdge[]>
}

const SOURCE_DIRS = ['src', 'packages', 'tests', 'scripts']
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs)$/

/** build.ts 插件里映射到仓库源码的裸说明符 */
const PLUGIN_ALIASES: Record<string, string> = {
  'color-diff-napi': 'src/native-ts/color-diff/index.ts',
  'modifiers-napi': 'src/native-ts/modifiers/index.ts',
}

function walk(dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function loadWorkspacePackages(root: string): Map<string, string> {
  const map = new Map<string, string>()
  const pkgDir = join(root, 'packages')
  if (!existsSync(pkgDir)) return map
  for (const name of readdirSync(pkgDir)) {
    const pkgJson = join(pkgDir, name, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { name?: string; main?: string }
      if (pkg.name) map.set(pkg.name, join(pkgDir, name, pkg.main ?? 'index.ts'))
    } catch {
      // 跳过损坏的 package.json
    }
  }
  return map
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function resolveCandidates(base: string): string | null {
  const cands: string[] = []
  if (/\.(js|jsx|mjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs)$/, '')
    cands.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, base)
  } else if (/\.(ts|tsx)$/.test(base)) {
    cands.push(base)
  } else {
    cands.push(
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    )
  }
  for (const c of cands) if (isFile(c)) return c
  return null
}

/** 返回 null 表示外部依赖（不入图）；返回 'unresolved' 表示仓库内路径但找不到文件 */
function resolveSpecifier(
  root: string,
  fromAbs: string,
  spec: string,
  workspace: Map<string, string>,
): string | 'unresolved' | null {
  // 资源导入（Bun 文本/JSON 等），不是模块边
  if (/\.(json|md|txt|node|wasm|sh|py)$/.test(spec)) return null
  let base: string | null = null
  if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromAbs), spec)
  else if (spec.startsWith('src/')) base = join(root, spec)
  else if (PLUGIN_ALIASES[spec]) base = join(root, PLUGIN_ALIASES[spec])
  else if (workspace.has(spec)) base = workspace.get(spec) ?? null
  if (!base) return null
  return resolveCandidates(base) ?? 'unresolved'
}

function stringArg(node: ts.CallExpression): string | null {
  const arg = node.arguments[0]
  if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return arg.text
  return null
}

interface RawImport {
  specifier: string
  kind: EdgeKind
  pos: number
}

/** 从单个文件收集所有模块说明符 */
export function collectImports(file: string, content: string): RawImport[] {
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.(js|mjs)$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const out: RawImport[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      // import type {…} 或每个具名导入都带 type 修饰时视为纯类型边
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)))
      out.push({
        specifier: node.moduleSpecifier.text,
        kind: typeOnly ? 'type' : 'static',
        pos: node.getStart(sf),
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly =
        node.isTypeOnly ||
        (!!node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((e) => e.isTypeOnly))
      out.push({
        specifier: node.moduleSpecifier.text,
        kind: typeOnly ? 'type' : 'static',
        pos: node.getStart(sf),
      })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push({
        specifier: node.moduleReference.expression.text,
        kind: node.isTypeOnly ? 'type' : 'static',
        pos: node.getStart(sf),
      })
    } else if (ts.isImportTypeNode(node)) {
      const lit = node.argument
      if (ts.isLiteralTypeNode(lit) && ts.isStringLiteral(lit.literal)) {
        out.push({ specifier: lit.literal.text, kind: 'type', pos: node.getStart(sf) })
      }
    } else if (ts.isCallExpression(node)) {
      const spec = stringArg(node)
      if (spec !== null) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          out.push({ specifier: spec, kind: 'dynamic', pos: node.getStart(sf) })
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          out.push({ specifier: spec, kind: 'dynamic', pos: node.getStart(sf) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // 行号在调用方按需计算
  return out.map((r) => ({ ...r, pos: sf.getLineAndCharacterOfPosition(r.pos).line + 1 }))
}

export function buildImportGraph(rootDir: string, dirs: string[] = SOURCE_DIRS): ImportGraph {
  const root = resolve(rootDir)
  const workspace = loadWorkspacePackages(root)
  const abs: string[] = []
  for (const d of dirs) walk(join(root, d), abs)
  for (const extra of ['build.ts']) if (isFile(join(root, extra))) abs.push(join(root, extra))
  const rel = (p: string) => toPosix(relative(root, p))
  const edges: ImportEdge[] = []
  const unresolved: ImportGraph['unresolved'] = []
  for (const file of abs) {
    const content = readFileSync(file, 'utf-8')
    for (const imp of collectImports(file, content)) {
      const target = resolveSpecifier(root, file, imp.specifier, workspace)
      if (target === null) continue
      if (target === 'unresolved') {
        unresolved.push({ from: rel(file), specifier: imp.specifier, line: imp.pos })
        continue
      }
      edges.push({
        from: rel(file),
        to: rel(target),
        kind: imp.kind,
        line: imp.pos,
        specifier: imp.specifier,
      })
    }
  }
  const out = new Map<string, ImportEdge[]>()
  const inn = new Map<string, ImportEdge[]>()
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from)?.push(e)
    if (!inn.has(e.to)) inn.set(e.to, [])
    inn.get(e.to)?.push(e)
  }
  return { root, files: abs.map(rel).sort(), edges, unresolved, out, in: inn }
}

/** 从起点出发的可达集合；kinds 限定沿哪些边走 */
export function reachable(
  graph: ImportGraph,
  starts: string[],
  kinds: EdgeKind[] = ['static', 'dynamic', 'type'],
): Set<string> {
  const seen = new Set<string>(starts)
  const stack = [...starts]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const e of graph.out.get(cur) ?? []) {
      if (!kinds.includes(e.kind) || seen.has(e.to)) continue
      seen.add(e.to)
      stack.push(e.to)
    }
  }
  return seen
}

/** BFS 最短依赖链（含起止） */
export function shortestPath(
  graph: ImportGraph,
  from: string,
  isTarget: (file: string) => boolean,
  kinds: EdgeKind[] = ['static'],
): string[] | null {
  const prev = new Map<string, string | null>([[from, null]])
  const queue = [from]
  while (queue.length) {
    const cur = queue.shift() as string
    if (cur !== from && isTarget(cur)) {
      const path: string[] = []
      for (let n: string | null = cur; n !== null; n = prev.get(n) ?? null) path.unshift(n)
      return path
    }
    for (const e of graph.out.get(cur) ?? []) {
      if (!kinds.includes(e.kind) || prev.has(e.to)) continue
      prev.set(e.to, cur)
      queue.push(e.to)
    }
  }
  return null
}

/**
 * Tarjan 强连通分量（迭代实现，避免深递归栈溢出）。只返回大小 > 1 或自环的分量。
 */
export function stronglyConnectedComponents(
  graph: ImportGraph,
  kinds: EdgeKind[] = ['static'],
  filter: (file: string) => boolean = () => true,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []
  let counter = 0
  const succ = (n: string) =>
    (graph.out.get(n) ?? []).filter((e) => kinds.includes(e.kind) && filter(e.to)).map((e) => e.to)
  for (const start of graph.files) {
    if (!filter(start) || index.has(start)) continue
    const work: Array<{ node: string; it: string[]; i: number }> = []
    const push = (n: string) => {
      index.set(n, counter)
      low.set(n, counter)
      counter++
      stack.push(n)
      onStack.add(n)
      work.push({ node: n, it: succ(n), i: 0 })
    }
    push(start)
    while (work.length) {
      const frame = work[work.length - 1]
      if (frame.i < frame.it.length) {
        const w = frame.it[frame.i++]
        if (!index.has(w)) push(w)
        else if (onStack.has(w))
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(w) ?? 0))
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent) ?? 0, low.get(frame.node) ?? 0))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop() as string
          onStack.delete(w)
          comp.push(w)
        } while (w !== frame.node)
        const selfLoop = comp.length === 1 && succ(comp[0]).includes(comp[0])
        if (comp.length > 1 || selfLoop) result.push(comp.sort())
      }
    }
  }
  return result
}

// --------------- CLI ---------------

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = resolve(join(import.meta.dirname, '..'))
  const graph = buildImportGraph(root)
  if (args[0] === '--unreferenced') {
    // 入口：build.ts 唯一 entry + dev preload；测试与脚本不算根，但被它们引用的文件单独标出
    const entries = ['src/entrypoints/cli.tsx', 'src/entrypoints/devPreload.ts']
    const live = reachable(graph, entries)
    const srcFiles = graph.files.filter((f) => f.startsWith('src/') || f.startsWith('packages/'))
    for (const f of srcFiles) {
      if (live.has(f)) continue
      const users = (graph.in.get(f) ?? []).map((e) => e.from).filter((u) => u !== f)
      const label = users.length === 0 ? 'NO_REFS' : `ONLY:${[...new Set(users)].join(',')}`
      console.log(`${f}\t${label}`)
    }
  } else if (args[0] === '--path' && args[1] && args[2]) {
    const target = args[2]
    const path = shortestPath(graph, args[1], (f) => f.includes(target), ['static'])
    console.log(path ? path.join('\n  -> ') : '(no static path)')
  } else if (args[0] === '--cycles') {
    const sccs = stronglyConnectedComponents(graph, ['static'], (f) => f.startsWith('src/'))
    sccs.sort((a, b) => b.length - a.length)
    console.log(`cycles=${sccs.length} files=${sccs.reduce((n, c) => n + c.length, 0)}`)
    for (const comp of sccs)
      console.log(`[${comp.length}] ${comp.slice(0, 8).join(' ')}${comp.length > 8 ? ' …' : ''}`)
  } else if (args[0] === '--unresolved') {
    for (const u of graph.unresolved) console.log(`${u.from}:${u.line}\t${u.specifier}`)
  } else {
    const counts = { static: 0, type: 0, dynamic: 0 }
    for (const e of graph.edges) counts[e.kind]++
    console.log(
      `files=${graph.files.length} edges=${graph.edges.length} ${JSON.stringify(counts)} unresolved=${graph.unresolved.length}`,
    )
  }
}
