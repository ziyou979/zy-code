import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildImportGraph,
  RUNTIME_INIT_KINDS,
  stronglyConnectedComponents,
} from '../../scripts/import-graph.js'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-graph-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

describe('import-graph', () => {
  it('区分 static / type / dynamic 边，并只按 static 边判环', () => {
    const root = fixture({
      'src/a.ts': "import { b } from './b.js'\nexport const a = () => b\n",
      'src/b.ts':
        "import type { T } from './c.js'\nexport const b = 1\nexport const lazy = () => import('./a.js')\n",
      'src/c.ts': "import { a } from './a.js'\nexport type T = typeof a\n",
      'src/d.ts': "export * from './e.js'\n",
      'src/e.ts': "import { x } from './d.js'\nexport const x = 1\nvoid x\n",
    })
    const graph = buildImportGraph(root, ['src'])
    const kinds = graph.edges.map((e) => `${e.from}->${e.to}:${e.kind}`).sort()
    expect(kinds).toContain('src/b.ts->src/c.ts:type')
    expect(kinds).toContain('src/b.ts->src/a.ts:dynamic')
    expect(kinds).toContain('src/d.ts->src/e.ts:static')
    const cycles = stronglyConnectedComponents(graph, ['static'])
    expect(cycles).toEqual([['src/d.ts', 'src/e.ts']])
  })

  it('顶层 require 记为 init 边并参与环检测，函数体内 require 仍是 dynamic', () => {
    const root = fixture({
      // 顶层三元 require：模块初始化时同步执行，与 b.ts 构成初始化环
      'src/a.ts':
        "const feature = (_: string) => true\nconst b = feature('X') ? require('./b.js') : null\nexport const a = 1\nvoid b\n",
      'src/b.ts': "import { a } from './a.js'\nexport const b = a\n",
      // 函数体 / 方法 / 箭头函数 / 实例字段里的 require：调用时才加载，不成环
      'src/c.ts':
        "export function load() {\n  return require('./d.js')\n}\nexport const lazy = () => require('./d.js')\nexport class K {\n  m() { return require('./d.js') }\n  f = require('./d.js')\n}\n",
      'src/d.ts': "import { load } from './c.js'\nexport const d = load\n",
      // 类的 static 字段在模块初始化时执行
      'src/e.ts': "export class S {\n  static dep = require('./f.js')\n}\n",
      'src/f.ts': "import { S } from './e.js'\nexport const f = S\n",
    })
    const graph = buildImportGraph(root, ['src'])
    const kinds = graph.edges.map((e) => `${e.from}->${e.to}:${e.kind}`)
    expect(kinds).toContain('src/a.ts->src/b.ts:init')
    expect(kinds).toContain('src/e.ts->src/f.ts:init')
    expect(kinds.filter((k) => k.startsWith('src/c.ts->src/d.ts'))).toEqual([
      'src/c.ts->src/d.ts:dynamic',
      'src/c.ts->src/d.ts:dynamic',
      'src/c.ts->src/d.ts:dynamic',
      'src/c.ts->src/d.ts:dynamic',
    ])
    const cycles = stronglyConnectedComponents(graph, RUNTIME_INIT_KINDS)
    expect(cycles.sort()).toEqual([
      ['src/a.ts', 'src/b.ts'],
      ['src/e.ts', 'src/f.ts'],
    ])
    // 只看 static 边时看不到 require 环（即修复前的行为）
    expect(stronglyConnectedComponents(graph, ['static'])).toEqual([])
  })

  it('记录仓库内解析不到的说明符', () => {
    const root = fixture({ 'src/a.ts': "import { gone } from './missing.js'\nvoid gone\n" })
    const graph = buildImportGraph(root, ['src'])
    expect(graph.unresolved.map((u) => u.specifier)).toEqual(['./missing.js'])
  })
})
