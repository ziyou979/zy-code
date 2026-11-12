/**
 * lint-hardcoded-text：用户可见英文硬编码文案的扫描与基线门禁。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isExcludedFile, scanSource } from '../../scripts/lint-hardcoded-text.js'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const lintScript = join(repoRoot, 'scripts', 'lint-hardcoded-text.ts')
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function kinds(rel: string, src: string): string[] {
  return scanSource(rel, src).map((h) => `${h.kind}:${h.text}`)
}

describe('scanSource', () => {
  test('JSX 文本 / 文案属性 / 表达式命中，t / tSync 与符号不命中', () => {
    const src = `
      import { tSync } from '../i18n/index.js'
      export function C({ ok }: { ok: boolean }) {
        return (
          <Box>
            <Text>Loading files</Text>
            <Text>{tSync('k')}</Text>
            <Text>{ok ? 'Done' : 'Failed'}</Text>
            <Dialog title="Settings Error" color="warning" />
            <Text> · </Text>
          </Box>
        )
      }`
    expect(kinds('components/C.tsx', src)).toEqual([
      'jsx-text:Loading files',
      'jsx-expr:Done',
      'jsx-expr:Failed',
      'jsx-attr:Settings Error',
    ])
  })

  test('报错路径：API 错误、stdio、命令结果、通知、CLI 抛错', () => {
    const src = `
      createAssistantAPIErrorMessage({ content: 'Request timed out badly', error: 'unknown' })
      process.stderr.write(\`Error: --foo requires --bar\\n\`)
      onDone('Theme picker dismissed', { display: 'system' })
      addNotification({ key: 'k', text: 'Esc again to clear' })
      logForDebugging('this is a debug line only')
      const re = /Prompt is too long/
      if (msg.includes('Prompt is too long')) {}`
    expect(kinds('services/api/x.ts', src)).toEqual([
      'api-error:Request timed out badly',
      'stdio:Error: --foo requires --bar',
      'command-output:Theme picker dismissed',
      'notification:Esc again to clear',
    ])
    expect(kinds('cli/x.ts', "throw new Error('--budget must be positive')")).toEqual([
      'cli-error:--budget must be positive',
    ])
    // 非 CLI 层的 throw 多是内部错误，不计入
    expect(kinds('services/x.ts', "throw new Error('--budget must be positive')")).toEqual([])
  })

  test('i18n-ignore 作用于本行与下一非注释行；i18n-ignore-file 豁免整个文件', () => {
    const src = `
      // i18n-ignore: 持久化匹配 token
      // biome-ignore lint/suspicious/noConsole: x
      console.error('Kept in English on purpose')
      console.error('This one is flagged')`
    expect(kinds('cli/x.ts', src)).toEqual(['stdio:This one is flagged'])
    expect(kinds('cli/x.ts', `// i18n-ignore-file: 桩\nconsole.error('Not implemented yet here')`)).toEqual([])
  })

  test('发给模型的文件（prompt / 系统提示词 / skills）、i18n 资源、测试不扫描', () => {
    expect(isExcludedFile('tools/BashTool/prompt.ts')).toBe(true)
    expect(isExcludedFile('constants/prompts.ts')).toBe(true)
    expect(isExcludedFile('skills/bundled/foo.ts')).toBe(true)
    expect(isExcludedFile('i18n/locales/en/errors.ts')).toBe(true)
    expect(isExcludedFile('components/Foo.test.tsx')).toBe(true)
    expect(isExcludedFile('components/Foo.tsx')).toBe(false)
  })
})

describe('基线门禁', () => {
  function fixture(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'zy-hardcoded-text-'))
    tempRoots.push(root)
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(resolve(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
    }
    mkdirSync(join(root, 'scripts'), { recursive: true })
    return root
  }
  function run(root: string, args: string[] = []) {
    const r = spawnSync(process.execPath, [lintScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ZY_HARDCODED_TEXT_ROOT: root },
      encoding: 'utf8',
    })
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` }
  }

  test('存量允许、新增失败、修掉后提示可收紧', () => {
    const root = fixture({ 'src/components/A.tsx': 'export const A = () => <Text>Old debt here</Text>\n' })
    expect(run(root, ['--write-baseline']).code).toBe(0)
    expect(run(root).code).toBe(0)

    writeFileSync(
      join(root, 'src/components/A.tsx'),
      'export const A = () => <><Text>Old debt here</Text><Text>New text added</Text></>\n',
    )
    const added = run(root)
    expect(added.code).toBe(1)
    expect(added.out).toContain('New text added')

    writeFileSync(join(root, 'src/components/A.tsx'), 'export const A = () => null\n')
    const fixed = run(root)
    expect(fixed.code).toBe(0)
    expect(fixed.out).toContain('--write-baseline')
  })

  test('基线缺失时失败（fail closed）', () => {
    const root = fixture({ 'src/components/A.tsx': 'export const A = () => null\n' })
    expect(run(root).code).toBe(1)
  })
})
