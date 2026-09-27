import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('复合 feature 条件在开关组合下裁剪依赖并保留短路副作用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zy-feature-dce-'))
  roots.push(root)
  const entry = join(root, 'entry.ts')
  writeFileSync(join(root, 'optional.ts'), 'export const value = "OPTIONAL_MODULE_SENTINEL"')
  const cases = [
    { expression: "feature('A') || feature('B')", evaluate: (a: boolean, b: boolean) => a || b },
    { expression: "feature('A') && feature('B')", evaluate: (a: boolean, b: boolean) => a && b },
    {
      expression: "!(feature('A') || !feature('B'))",
      evaluate: (a: boolean, b: boolean) => !(a || !b),
    },
  ]
  for (const minify of [false, true]) {
    for (const a of [false, true]) {
      for (const b of [false, true]) {
        for (const { expression, evaluate } of cases) {
          for (const form of ['if', 'ternary']) {
            const condition = `(${expression}) && ready()`
            const load = "require('./optional.js').value"
            writeFileSync(
              entry,
              `import { feature } from 'bun:bundle'
              let calls = 0
              function ready() { calls++; return process.argv[2] === 'yes' }
              let result = 'off'
              ${form === 'if' ? `if (${condition}) result = ${load}` : `result = ${condition} ? ${load} : 'off'`}
              console.log(JSON.stringify({result, calls}))`,
            )
            const build = await Bun.build({
              entrypoints: [entry],
              target: 'bun',
              format: 'esm',
              minify,
              splitting: false,
              features: [...(a ? ['A'] : []), ...(b ? ['B'] : [])],
            })
            expect(build.success).toBe(true)
            const output = await build.outputs[0].text()
            expect(output.includes('OPTIONAL_MODULE_SENTINEL')).toBe(evaluate(a, b))
            const compiled = join(root, 'compiled.js')
            writeFileSync(compiled, output)
            for (const ready of [false, true]) {
              const result = spawnSync(process.execPath, [compiled, ready ? 'yes' : 'no'], {
                encoding: 'utf8',
              })
              expect(result.status).toBe(0)
              expect(JSON.parse(result.stdout)).toEqual({
                result: evaluate(a, b) && ready ? 'OPTIONAL_MODULE_SENTINEL' : 'off',
                calls: evaluate(a, b) ? 1 : 0,
              })
            }
          }
        }
      }
    }
  }
}, 60000)
