import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildImportGraph, stronglyConnectedComponents } from '../../scripts/import-graph.js'

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

  it('记录仓库内解析不到的说明符', () => {
    const root = fixture({ 'src/a.ts': "import { gone } from './missing.js'\nvoid gone\n" })
    const graph = buildImportGraph(root, ['src'])
    expect(graph.unresolved.map((u) => u.specifier)).toEqual(['./missing.js'])
  })
})
