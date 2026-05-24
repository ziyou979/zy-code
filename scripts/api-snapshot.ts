import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * 为 god file 抽取 API 表面快照。
 *
 * 用途：Phase 4 拆分这些大文件时，重构前后 diff 此快照应为空——
 * 说明 export 集合 + 签名都保留。
 *
 * 实现：token 扫描跟踪 () [] {} 三种括号深度，定位 export 声明结尾：
 * - function/class/interface body 起始 `{` (depth=0) 替换为 ` { ... }`
 * - const 赋值 `=` (depth=0) 替换为 ` = ...`
 * - type alias 末尾 `;` 截断
 *
 * 运行：bun scripts/api-snapshot.ts          # 重新生成快照
 * 校验：bun test tests/api-snapshot/         # 校验快照与源码一致
 */

export const GOD_FILES = [
  'src/utils/hooks.ts',
  'src/utils/sessionStorage.ts',
  'src/utils/messages.ts',
] as const

export function stripBody(text: string): string {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false
  let cutAt = -1
  let cutKind: '{' | '=' | ';' = '{'

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLineComment) {
      if (c === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === inString) inString = null
      continue
    }
    if (c === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c
      continue
    }

    if (c === '(') parenDepth++
    else if (c === ')') parenDepth--
    else if (c === '[') bracketDepth++
    else if (c === ']') bracketDepth--
    else if (c === '{') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        cutAt = i
        cutKind = '{'
        break
      }
      braceDepth++
    } else if (c === '}') {
      braceDepth--
    } else if (
      c === '=' &&
      next !== '>' &&
      next !== '=' &&
      text[i - 1] !== '=' &&
      text[i - 1] !== '!' &&
      text[i - 1] !== '<' &&
      text[i - 1] !== '>'
    ) {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && cutAt === -1) {
        cutAt = i
        cutKind = '='
      }
    } else if (c === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      cutAt = i
      cutKind = ';'
      break
    }
  }

  if (cutAt === -1) return text.trim()
  const head = text.slice(0, cutAt).trimEnd()
  if (cutKind === '{') return `${head} { ... }`
  if (cutKind === '=') return `${head} = ...`
  return `${head};`
}

export function generateSnapshot(file: string): string {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!/^export (async )?(function|const|let|var|type|interface|enum|class)\b/.test(line)) {
      continue
    }
    const chunk = lines.slice(i, Math.min(i + 80, lines.length)).join('\n')
    out.push(stripBody(chunk))
  }

  out.sort()
  const header = `// AUTO-GENERATED snapshot of public API for ${basename(file)}.
// Regenerate: bun scripts/api-snapshot.ts
// Refactor invariant: this file should NOT diff after restructuring,
// only when exports are intentionally added/removed/renamed.

`
  return header + out.join('\n\n') + '\n'
}

// 入口（仅在直接 bun 运行时执行）
if (import.meta.main) {
  for (const file of GOD_FILES) {
    const snapshot = generateSnapshot(file)
    const path = `tests/api-snapshot/${basename(file, '.ts')}.snapshot.txt`
    writeFileSync(path, snapshot)
    const count = snapshot.split('\n\n').length - 1
    console.log(`${path}: ~${count} exports`)
  }
}
