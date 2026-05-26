import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import ts from 'typescript'

/**
 * 为 god file 抽取 API 表面快照（基于 TS AST，避免字符扫描的边界陷阱）。
 *
 * 截断策略：
 * - function / class：保留签名（params + 返回类型），body 替换为 `{ ... }`
 * - const / let / var：保留名称 + 类型注解，`= ...` 占位
 * - type alias / interface / enum：完整保留
 * - export { ... } / export type { ... } / export * from：完整保留
 *
 * 运行：bun scripts/api-snapshot.ts
 * 校验：bun test tests/api-snapshot/
 */

export const GOD_FILES = [
  'src/utils/hooks.ts',
  'src/utils/sessionStorage.ts',
  'src/utils/messages.ts',
] as const

function getModifierKinds(node: ts.Node): ts.SyntaxKind[] {
  if (!ts.canHaveModifiers(node)) return []
  return (ts.getModifiers(node) ?? []).map((m) => m.kind)
}

function hasExportModifier(node: ts.Node): boolean {
  return getModifierKinds(node).includes(ts.SyntaxKind.ExportKeyword)
}

function emitDeclaration(node: ts.Node, src: string): string | null {
  const full = src.slice(node.getStart(), node.getEnd())

  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    // 截断 body：第一个 `{`（属于 body，参数已经在 () 内）
    // body 是 .body 字段，可以精确取位
    // biome-ignore lint/suspicious/noExplicitAny: 通用 Node 不暴露 .body 字段
    const body = (node as any).body as ts.Node | undefined
    if (!body) return full // ambient declaration without body
    const sigEnd = body.getStart() - node.getStart() // 相对 full 的偏移
    return `${full.slice(0, sigEnd).trimEnd()} { ... }`
  }

  if (ts.isVariableStatement(node)) {
    // export const X = ...; 多个声明合并到一个 statement
    // 取每个 VariableDeclaration 的 name + type
    const parts = node.declarationList.declarations.map((d) => {
      const name = d.name.getText()
      const type = d.type ? `: ${d.type.getText()}` : ''
      return `${name}${type} = ...`
    })
    const keyword =
      node.declarationList.flags & ts.NodeFlags.Const
        ? 'const'
        : node.declarationList.flags & ts.NodeFlags.Let
          ? 'let'
          : 'var'
    return `export ${keyword} ${parts.join(', ')}`
  }

  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return full
  }

  if (ts.isExportDeclaration(node)) {
    // export { ... } from / export type { ... } / export * from
    return full
  }

  return null
}

export function generateSnapshot(file: string): string {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const out: string[] = []

  for (const node of sf.statements) {
    // ExportDeclaration 始终是 export，不需要 modifier 检查
    if (ts.isExportDeclaration(node)) {
      const r = emitDeclaration(node, src)
      if (r) out.push(r)
      continue
    }
    if (!hasExportModifier(node)) continue
    const r = emitDeclaration(node, src)
    if (r) out.push(r)
  }

  out.sort()
  const header = `// AUTO-GENERATED snapshot of public API for ${basename(file)}.
// Regenerate: bun scripts/api-snapshot.ts
// Refactor invariant: this file should NOT diff after restructuring,
// only when exports are intentionally added/removed/renamed.

`
  return header + out.join('\n\n') + '\n'
}

if (import.meta.main) {
  for (const file of GOD_FILES) {
    const snapshot = generateSnapshot(file)
    const path = `tests/api-snapshot/${basename(file, '.ts')}.snapshot.txt`
    writeFileSync(path, snapshot)
    const count = snapshot.split('\n\n').length - 1
    console.log(`${path}: ~${count} exports`)
  }
}
